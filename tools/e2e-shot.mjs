/**
 * Packaged end-to-end proof: collector HTTP/WebSocket -> device UI.
 * Usage: node tools/e2e-shot.mjs <outDir> [uiBase]
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const outDir = process.argv[2] ?? "shots";
const PORT = Number(process.env.CARTHING_E2E_PORT ?? 18_000 + (process.pid % 10_000));
const TOKEN = "e2e_token_123456789012345678901234567890123456";
const uiBase = process.argv[3] ?? `http://127.0.0.1:${PORT}`;
const expectedVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
mkdirSync(outDir, { recursive: true });
const tokenFile = join(outDir, ".e2e-token");
writeFileSync(tokenFile, `${TOKEN}\n`, { encoding: "utf8", mode: 0o600 });

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
  let lastError = null;
  for (let index = 0; index < 40; index++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/v1/health`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      if (response.ok) {
        const health = await response.json();
        if (health.collectorVersion !== expectedVersion) {
          throw new Error(`collector reported ${health.collectorVersion}, expected ${expectedVersion}`);
        }
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (lastError instanceof Error && lastError.message.startsWith("collector reported")) {
    throw lastError;
  }
  throw new Error("collector did not become healthy");
}

let failed = false;
let browser = null;
try {
  await waitForHealth();
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 480 } });
  await page.goto(`${uiBase}/#endpoints=127.0.0.1:${PORT}&token=${TOKEN}`, {
    waitUntil: "networkidle",
  });
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
  });
  await page.waitForFunction(
    () => {
      const text = document.body.innerText;
      return text.includes("LIVE") && text.includes("Claude") && text.includes("Codex");
    },
    { timeout: 15_000 },
  );
  await page.waitForTimeout(600);
  const bodyText = await page.evaluate(() => document.body.innerText);
  if (bodyText.includes("MOCK")) throw new Error("UI is in mock mode, not live mode");
  if (bodyText.includes("No collector reachable")) throw new Error("UI did not connect");
  if (page.url().includes("token=") || page.url().includes("endpoints=")) {
    throw new Error("one-time pairing fragment was not scrubbed from the address");
  }
  const storedToken = await page.evaluate(() => localStorage.getItem("carthing.pairingToken"));
  if (storedToken !== TOKEN) throw new Error("pairing token was not stored after bootstrap");
  const brokenImages = await page.evaluate(() =>
    Array.from(document.images)
      .filter((candidate) => candidate.complete && candidate.naturalWidth === 0)
      .map((candidate) => candidate.getAttribute("src") ?? "unknown image"),
  );
  if (brokenImages.length > 0) throw new Error(`UI contains broken images: ${brokenImages.join(", ")}`);
  await page.screenshot({ path: join(outDir, "e2e-live.png") });
  console.log("e2e: authenticated packaged UI, WebSocket data, and fragment scrubbing passed");
} catch (error) {
  console.error("e2e FAILED:", error instanceof Error ? error.message : String(error));
  failed = true;
} finally {
  if (browser) await browser.close().catch(() => {});
  collector.kill();
  rmSync(tokenFile, { force: true });
}
process.exit(failed ? 1 : 0);
