/**
 * Marketing screenshots: real collector (mock data mode) feeding the UI in
 * LIVE mode, captured at the device's exact 800x480. Unlike tools/shoot.mjs
 * (the state matrix, which shows the MOCK debug rail), these show the true
 * live presentation.
 * Usage: node tools/promo-shots.mjs [outDir]
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const outDir = process.argv[2] ?? "docs/media";
const PORT = 8793;
const uiBase = `http://127.0.0.1:${PORT}`;
const TOKEN = "promo_token_123456789012345678901234567890";
mkdirSync(outDir, { recursive: true });
const tokenFile = join(outDir, ".promo-token");
writeFileSync(tokenFile, `${TOKEN}\n`, { encoding: "utf8" });

const collector = spawn(
  process.execPath,
  [
    "release/collector/collector.cjs",
    "--mock", "normal",
    "--token-file", tokenFile,
    "--port", String(PORT),
    "--ui-dir", "release/device-ui",
  ],
  { stdio: "inherit" },
);

async function waitForHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/health`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("collector did not become healthy");
}

let failed = false;
try {
  await waitForHealth();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 480 } });
  await page.goto(`${uiBase}/?youtube=Your%20Channel&ga4=Your%20Website#endpoints=127.0.0.1:${PORT}&token=${TOKEN}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(
    () => document.body.innerText.includes("LIVE") && document.body.innerText.includes("Claude"),
    { timeout: 20000 },
  );
  await page.waitForTimeout(800);

  const shots = [
    { name: "overview", keys: [] },
    { name: "claude-detail", keys: ["3"] },
    { name: "codex-detail", keys: ["4"] },
    { name: "dashboard-gallery", keys: ["1"] },
    { name: "usage-by-day", keys: ["1", "Enter"] },
    { name: "youtube-analytics", keys: ["1", "ArrowRight", "Enter"] },
    { name: "ga4-analytics", keys: ["1", "ArrowRight", "ArrowRight", "Enter"] },
    { name: "market-nvda", keys: ["1", "ArrowRight", "ArrowRight", "ArrowRight", "Enter"] },
    { name: "market-sp500", keys: ["1", "ArrowRight", "ArrowRight", "ArrowRight", "Enter", "ArrowRight"] },
    { name: "system", keys: [], long4: true },
  ];
  for (const s of shots) {
    // Reload between shots so focus, chart range, and market selection are
    // deterministic instead of leaking from the preceding capture.
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(
      () => document.body.innerText.includes("LIVE") && document.body.innerText.includes("Claude"),
      { timeout: 20000 },
    );
    await page.waitForTimeout(400);
    for (const k of s.keys) {
      await page.keyboard.press(k);
      await page.waitForTimeout(250);
    }
    if (s.long4) {
      await page.keyboard.down("4");
      await page.waitForTimeout(750);
      await page.keyboard.up("4");
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, `${s.name}.png`) });
    console.log(`promo shot: ${s.name}`);
  }
  await browser.close();
} catch (err) {
  console.error("promo shots FAILED:", err.message);
  failed = true;
} finally {
  if (process.platform === "win32" && collector.pid) {
    try {
      spawnSync("taskkill", ["/pid", String(collector.pid), "/T", "/F"], { shell: true });
    } catch {
      /* best effort */
    }
    try {
      const net = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
      for (const row of (net.stdout || "").split("\n")) {
        if (row.includes(`:${PORT}`) && row.includes("LISTENING")) {
          const pid = row.trim().split(/\s+/).pop();
          if (pid && /^\d+$/.test(pid)) spawnSync("taskkill", ["/pid", pid, "/T", "/F"], { shell: true });
        }
      }
    } catch {
      /* best effort */
    }
  } else {
    collector.kill();
  }
  rmSync(tokenFile, { force: true });
}
process.exit(failed ? 1 : 0);
