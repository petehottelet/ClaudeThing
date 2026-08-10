#!/usr/bin/env node
/**
 * Live install dashboard — the read side of the setup status feed.
 *
 * Serves http://127.0.0.1:8799 (loopback only, no auth needed because it
 * exposes nothing but local install progress: step states from
 * ~/CarThingDeploy/setup-status.jsonl plus the size of the firmware dump
 * folder). The Car Thing's screen is black for most of the device phase;
 * this page is what a person watches instead.
 *
 * Run directly (node setup/status-server.mjs) or let setup.mjs start it.
 * A second copy exits quietly if the port is already taken.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { STEPS, STATUS_FILE, STATUS_PORT } from "./status.mjs";

const BACKUP_DIR = process.env.CARTHING_BACKUP_DIR ?? path.join(os.homedir(), "CarThingBackups");
// Real Car Thing dumps measure ~3.58 GB; the estimate only drives the bar.
const TOTAL_MB = Number(process.env.CARTHING_DUMP_TOTAL_MB ?? 3600);

function readEvents() {
  try {
    return readFileSync(STATUS_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function dirMb(dir) {
  let total = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  try {
    walk(dir);
  } catch {
    return 0;
  }
  return Math.floor(total / 1048576);
}

function partFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => ({
        name: e.name,
        mb: Math.round((statSync(path.join(dir, e.name)).size / 1048576) * 10) / 10,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** The dump folder: the one setup announced, else the newest full-dump-*. */
function findDumpDir(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.step === "backup" && e.state === "info" && e.detail && existsSync(e.detail)) return e.detail;
  }
  let best = null;
  let bestTime = 0;
  try {
    for (const entry of readdirSync(BACKUP_DIR)) {
      if (!entry.startsWith("full-dump-")) continue;
      const p = path.join(BACKUP_DIR, entry);
      const st = statSync(p);
      if (st.isDirectory() && st.mtimeMs > bestTime) {
        best = p;
        bestTime = st.mtimeMs;
      }
    }
  } catch {
    /* no backups yet */
  }
  return best;
}

// Growth tracking so the page can tell "copying" from "stalled".
let lastDir = null;
let lastMb = -1;
let lastGrowthTs = 0;

function state() {
  const events = readEvents();
  const byStep = new Map();
  let error = null;
  for (const e of events) {
    if (e.state === "error") error = { step: e.step, detail: e.detail ?? "failed" };
    if (e.state === "info") continue;
    byStep.set(e.step, e);
  }
  const steps = STEPS.map((s) => {
    const e = byStep.get(s.id);
    const st = !e ? "pending" : e.state === "start" ? "active" : e.state;
    return { ...s, state: st, detail: e?.detail };
  });

  const dumpDir = findDumpDir(events);
  const mb = dumpDir ? dirMb(dumpDir) : 0;
  const now = Date.now();
  if (dumpDir !== lastDir) {
    lastDir = dumpDir;
    lastMb = -1;
  }
  if (mb > lastMb) {
    lastMb = mb;
    lastGrowthTs = now;
  }
  const backupActive = steps.find((s) => s.id === "backup")?.state === "active";

  return {
    steps,
    error,
    done: steps.find((s) => s.id === "live")?.state === "done",
    started: events.length > 0,
    runStart: events.find((e) => e.step === "run")?.ts ?? null,
    backup: {
      dir: dumpDir,
      mb,
      total: TOTAL_MB,
      running: backupActive,
      growing: backupActive && now - lastGrowthTs < 90_000,
      files: dumpDir ? partFiles(dumpDir) : [],
    },
  };
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Car Thing setup — live</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;background:#111418;color:#e8eaed;margin:0 auto;padding:28px;max-width:760px}
h1{font-size:18px;font-weight:600;margin:0 0 4px}
.sub{color:#9aa0a6;font-size:13px;margin-bottom:24px}
.barwrap{background:#22262c;border-radius:8px;height:26px;overflow:hidden;margin:10px 0 6px}
.bar{background:#e8b339;height:100%;width:0%;transition:width .8s;border-radius:8px 0 0 8px}
.bar.done{background:#34a853}
.bar.err{background:#ea4335}
.nums{display:flex;gap:24px;font-size:13px;color:#9aa0a6;margin-bottom:26px;flex-wrap:wrap}
.nums b{color:#e8eaed;font-weight:600}
.steps{list-style:none;padding:0;margin:0 0 26px}
.steps li{display:flex;align-items:center;gap:10px;padding:7px 0;font-size:14px;border-bottom:1px solid #22262c}
.dot{width:12px;height:12px;border-radius:50%;background:#3c4043;flex:none}
.dot.done{background:#34a853}
.dot.skip{background:#2d5c39}
.dot.active{background:#e8b339;animation:pulse 1.2s infinite}
.dot.error{background:#ea4335}
.stat{margin-left:auto;color:#9aa0a6;font-size:12px;text-align:right}
@keyframes pulse{50%{opacity:.35}}
.err-banner{display:none;background:#3a1d1b;border:1px solid #ea4335;color:#f5b7b1;border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:20px;white-space:pre-wrap}
table{width:100%;border-collapse:collapse;font-size:12px;color:#9aa0a6}
td{padding:3px 0;border-bottom:1px solid #1b1f24}
td:last-child{text-align:right;color:#e8eaed}
h2{font-size:13px;color:#9aa0a6;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px}
</style></head><body>
<h1>Car Thing dashboard setup</h1>
<div class="sub" id="clock">waiting for setup to start…</div>
<div class="err-banner" id="errbox"></div>
<div class="barwrap"><div class="bar" id="bar"></div></div>
<div class="nums">
  <span>backup: <b id="mb">—</b></span>
  <span>rate: <b id="rate">—</b></span>
  <span>eta: <b id="eta">—</b></span>
</div>
<ul class="steps" id="steps"></ul>
<h2>Backup partitions</h2>
<table id="parts"></table>
<script>
let samples=[];
function fmtEta(min){if(!isFinite(min)||min<=0)return "—";if(min<1)return "<1 min";if(min<60)return Math.round(min)+" min";return (min/60).toFixed(1)+" h";}
function statText(s){return s==="pending"?"queued":s==="active"?"active":s==="skip"?"skipped":s==="error"?"failed":"done";}
async function tick(){
 let s;
 try{s=await (await fetch("/state")).json();}catch(e){document.getElementById("clock").textContent="status server unreachable — retrying";return;}
 const b=s.backup, now=Date.now();
 samples.push([now,b.mb]);samples=samples.filter(x=>now-x[0]<300000);
 let rate=null;
 if(samples.length>2){const d=samples[samples.length-1],f=samples[0];const dm=d[1]-f[1],dt=(d[0]-f[0])/60000;if(dt>0.2&&dm>0)rate=dm/dt;}
 const backupState=(s.steps.find(x=>x.id==="backup")||{}).state;
 const verifyDone=(s.steps.find(x=>x.id==="verify")||{}).state==="done";
 const pct=verifyDone||backupState==="done"||backupState==="skip"?100:Math.min(99,Math.round(100*b.mb/b.total));
 const bar=document.getElementById("bar");
 bar.style.width=pct+"%";
 bar.className="bar"+(s.error?" err":(pct===100?" done":""));
 document.getElementById("mb").textContent=b.mb+" MB / ~"+b.total+" MB ("+pct+"%)";
 document.getElementById("rate").textContent=b.running&&rate?rate.toFixed(1)+" MB/min":"—";
 document.getElementById("eta").textContent=b.running&&rate?fmtEta((b.total-b.mb)/rate):"—";
 document.getElementById("steps").innerHTML=s.steps.filter(x=>x.id!=="run").map(x=>
  '<li><span class="dot '+x.state+'"></span>'+x.label+'<span class="stat">'+statText(x.state)+'</span></li>').join("");
 const eb=document.getElementById("errbox");
 if(s.error){eb.style.display="block";eb.textContent="FAILED at \\u201c"+s.error.step+"\\u201d: "+s.error.detail+"\\nNothing risky happened past this point — fix the cause and re-run the setup; completed steps are detected and skipped.";}
 else eb.style.display="none";
 document.getElementById("parts").innerHTML=(b.files||[]).map(f=>'<tr><td>'+f.name+'</td><td>'+f.mb+' MB</td></tr>').join("");
 const phase=s.steps.find(x=>x.state==="active");
 document.getElementById("clock").textContent=(s.done?"complete":s.error?"stopped on an error":!s.started?"waiting for setup to start…":phase?("now: "+phase.label):"live")+" — updated "+new Date().toLocaleTimeString();
 if(b.running&&!b.growing){document.getElementById("clock").textContent+=" — backup folder has not grown in 90s (multi-GB copies pause between partitions; only worry after several minutes)";}
}
tick();setInterval(tick,2000);
</script></body></html>`;

const OK_HOSTS = new Set([`127.0.0.1:${STATUS_PORT}`, `localhost:${STATUS_PORT}`, "127.0.0.1", "localhost"]);

const server = http.createServer((req, res) => {
  // Loopback-bound already; Host validation additionally blocks DNS-rebinding
  // pages from reading local state. Read-only by design: GET only, no CORS.
  if (!OK_HOSTS.has(String(req.headers.host ?? ""))) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  if (req.method !== "GET") {
    res.writeHead(405);
    res.end();
    return;
  }
  if (req.url === "/state") {
    const body = JSON.stringify(state());
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PAGE);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`status server already running on ${STATUS_PORT} — reusing it.`);
    process.exit(0);
  }
  console.error(`status server error: ${err.message}`);
  process.exit(1);
});

server.listen(STATUS_PORT, "127.0.0.1", () => {
  console.log(`Setup status page: http://127.0.0.1:${STATUS_PORT}`);
});
