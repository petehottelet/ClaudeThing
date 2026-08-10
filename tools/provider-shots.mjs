/**
 * Provider-platform screenshots: the packaged collector serves a purpose-built
 * fixture to the production UI at the device's exact 800x480 resolution.
 *
 * Usage: node tools/provider-shots.mjs [outDir]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const outDir = process.argv[2] ?? "docs/media";
const port = 8794;
const token = "provider_shots_123456789012345678901234";
const tempDir = mkdtempSync(join(tmpdir(), "claudething-provider-shots-"));
const tokenFile = join(tempDir, "pairing-token");
const configFile = join(tempDir, "dashboard-config.jsonc");
mkdirSync(outDir, { recursive: true });
writeFileSync(tokenFile, `${token}\n`, "utf8");
writeFileSync(
  configFile,
  JSON.stringify({
    version: 1,
    providers: ["cursor", "droid", "gemini", "copilot"].map((id) => ({
      id,
      enabled: true,
      show: ["quota", "identity", "status", "metrics", "metricHistory", "cost"],
    })),
    youtube: { channelName: "YouTube Channel", channelHandle: "" },
    ga4: { propertyName: "Website Analytics", propertyId: "" },
    markets: {
      rotationSeconds: 10,
      instruments: [{ symbol: "NVDA", name: "NVIDIA", kind: "stock" }],
    },
  }, null, 2),
  "utf8",
);

const collector = spawn(
  process.execPath,
  [
    "release/collector/collector.cjs",
    "--mock", "providerShowcase",
    "--token-file", tokenFile,
    "--dashboard-config", configFile,
    "--port", String(port),
    "--ui-dir", "release/device-ui",
  ],
  { stdio: "inherit" },
);

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) return;
    } catch {
      // The collector may still be binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("collector did not become healthy");
}

let failed = false;
try {
  await waitForHealth();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 480 } });
  await page.goto(`http://127.0.0.1:${port}/#endpoints=127.0.0.1:${port}&token=${token}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(
    () => document.body.innerText.includes("LIVE") && document.body.innerText.includes("Cursor"),
    { timeout: 20_000 },
  );
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(outDir, "provider-platform.png") });

  await page.keyboard.press("Enter");
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(outDir, "provider-rich-detail.png") });
  await browser.close();
  console.log("provider shots: overview and rich detail");
} catch (error) {
  console.error("provider shots FAILED:", error instanceof Error ? error.message : error);
  failed = true;
} finally {
  collector.kill();
  rmSync(tempDir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
