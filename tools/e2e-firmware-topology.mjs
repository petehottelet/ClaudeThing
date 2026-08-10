/**
 * Release proof for the real firmware topology: the UI is served on one
 * loopback origin and talks to the authenticated collector on another.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const API_PORT = 28_000 + (process.pid % 5_000);
const UI_PORT = API_PORT + 5_000;
const TOKEN = "firmware_e2e_123456789012345678901234567890123";
const TIME_ZONE = "America/Los_Angeles";
const uiRoot = path.resolve("release/device-ui");
const temporary = await mkdtemp(path.join(os.tmpdir(), "claudething-firmware-e2e-"));
const tokenFile = path.join(temporary, "pairing.token");
await writeFile(tokenFile, `${TOKEN}\n`, { encoding: "utf8", mode: 0o600 });

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".woff2", "font/woff2"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
]);

const uiServer = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", `http://127.0.0.1:${UI_PORT}`).pathname;
    if (pathname === "/runtime-config.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(`window.__CARTHING_CONFIG__=${JSON.stringify({
        endpoints: [`127.0.0.1:${API_PORT}`],
        pairingToken: TOKEN,
        timeZone: TIME_ZONE,
        youtubeChannel: "E2E Channel",
        ga4Property: "E2E Property",
      })};\n`);
      return;
    }
    const candidate = path.resolve(uiRoot, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!candidate.startsWith(`${uiRoot}${path.sep}`)) throw new Error("path outside UI root");
    const body = await readFile(candidate);
    response.writeHead(200, { "content-type": mime.get(path.extname(candidate)) ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end("not found");
  }
});

const collector = spawn(
  process.execPath,
  [
    "release/collector/collector.cjs",
    "--mock", "normal",
    "--token-file", tokenFile,
    "--port", String(API_PORT),
    "--allowed-origins", `http://127.0.0.1:${UI_PORT}`,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

async function waitForHealth() {
  for (let index = 0; index < 40; index++) {
    try {
      const response = await fetch(`http://127.0.0.1:${API_PORT}/v1/health`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      if (response.ok) return;
    } catch {
      // Processes are still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("collector did not become healthy");
}

let browser = null;
try {
  await new Promise((resolve, reject) => {
    uiServer.once("error", reject);
    uiServer.listen(UI_PORT, "127.0.0.1", resolve);
  });
  await waitForHealth();
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 480 } });
  await page.goto(`http://127.0.0.1:${UI_PORT}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => document.body.innerText.includes("LIVE") && document.body.innerText.includes("Claude") && document.body.innerText.includes("Codex"),
    { timeout: 15_000 },
  );
  const result = await page.evaluate(() => ({
    text: document.body.innerText,
    timeZone: window.__CARTHING_CONFIG__?.timeZone,
    youtubeChannel: window.__CARTHING_CONFIG__?.youtubeChannel,
    ga4Property: window.__CARTHING_CONFIG__?.ga4Property,
  }));
  if (result.text.includes("MOCK") || result.text.includes("No collector reachable")) {
    throw new Error("firmware-topology UI did not establish a live collector connection");
  }
  if (result.timeZone !== TIME_ZONE) throw new Error("runtime time zone was not loaded");
  if (result.youtubeChannel !== "E2E Channel") throw new Error("YouTube channel config was not loaded");
  if (result.ga4Property !== "E2E Property") throw new Error("GA4 property config was not loaded");
  const brokenImages = await page.evaluate(() =>
    Array.from(document.images)
      .filter((candidate) => candidate.complete && candidate.naturalWidth === 0)
      .map((candidate) => candidate.getAttribute("src") ?? "unknown image"),
  );
  if (brokenImages.length > 0) throw new Error(`UI contains broken images: ${brokenImages.join(", ")}`);
  console.log("e2e: cross-origin firmware topology, authentication, WebSocket, and time-zone config passed");
} finally {
  if (browser) await browser.close().catch(() => {});
  await new Promise((resolve) => uiServer.close(resolve));
  collector.kill();
  await rm(temporary, { recursive: true, force: true });
}
