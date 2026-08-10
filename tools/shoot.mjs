/**
 * Capture 800x480 screenshots of the device UI across fixtures and pages.
 * Usage: node tools/shoot.mjs <outDir> [baseUrl]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2] ?? "shots";
const base = process.argv[3] ?? "http://localhost:5173";
mkdirSync(outDir, { recursive: true });

const scenarios = [
  { name: "overview-normal", mock: "normal" },
  { name: "detail-claude", mock: "normal", press: ["3"] },
  { name: "detail-codex", mock: "normal", press: ["4"] },
  { name: "overview-warning", mock: "warning" },
  { name: "detail-claude-warning", mock: "warning", press: ["3"] },
  { name: "overview-exhausted", mock: "exhausted" },
  { name: "detail-claude-exhausted", mock: "exhausted", press: ["3"] },
  { name: "overview-stale", mock: "stale" },
  { name: "overview-offline", mock: "offline" },
  { name: "overview-partial-error", mock: "partialError" },
  { name: "detail-codex-partial-error", mock: "partialError", press: ["4"] },
  { name: "overview-missing", mock: "missingWindows" },
  { name: "overview-tokens-only", mock: "tokensOnly" },
  { name: "detail-claude-tokens-only", mock: "tokensOnly", press: ["3"] },
  { name: "detail-claude-history-daily", mock: "normal", press: ["3", "ArrowRight"] },
  { name: "detail-claude-history-monthly", mock: "normal", press: ["3", "ArrowRight", "ArrowRight", "ArrowRight"] },
  { name: "detail-codex-history-weekly", mock: "normal", press: ["4", "ArrowRight", "ArrowRight"] },
  { name: "overview-multi-window", mock: "multiWindow" },
  { name: "detail-multi-window-page-2", mock: "multiWindow", press: ["4", "ArrowRight"] },
  { name: "first-connect", mock: "firstConnect" },
  { name: "system", mock: "normal", longPress4: true },
  { name: "dashboard-gallery", mock: "normal", press: ["1"] },
  { name: "dashboard-usage-week", mock: "normal", press: ["1", "Enter"] },
  { name: "dashboard-youtube", mock: "normal", press: ["1", "ArrowRight", "Enter"] },
  { name: "dashboard-youtube-month", mock: "normal", press: ["1", "ArrowRight", "Enter", "ArrowRight"] },
  { name: "dashboard-ga4", mock: "normal", press: ["1", "ArrowRight", "ArrowRight", "Enter"] },
  { name: "dashboard-ga4-year", mock: "normal", press: ["1", "ArrowRight", "ArrowRight", "Enter", "ArrowRight", "ArrowRight"] },
  { name: "dashboard-markets-nvda", mock: "normal", press: ["1", "ArrowRight", "ArrowRight", "ArrowRight", "Enter"] },
  { name: "dashboard-markets-sp500", mock: "normal", press: ["1", "ArrowRight", "ArrowRight", "ArrowRight", "Enter", "ArrowRight"] },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 480 } });

for (const s of scenarios) {
  await page.goto(`${base}/?mock=${s.mock}`, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
  });
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
  await page.waitForTimeout(350);
  if (s.press) {
    for (const key of s.press) {
      await page.keyboard.press(key);
      await page.waitForTimeout(200);
    }
  }
  if (s.longPress4) {
    await page.keyboard.down("4");
    await page.waitForTimeout(750);
    await page.keyboard.up("4");
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(450);
  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    const stage = document.querySelector(".stage");
    const clipped = [];
    if (el.scrollWidth > 800 || el.scrollHeight > 480) {
      clipped.push(`document ${el.scrollWidth}x${el.scrollHeight}`);
    }
    if (stage) {
      // any descendant spilling outside the 800x480 stage box
      const sb = stage.getBoundingClientRect();
      for (const node of stage.querySelectorAll("*")) {
        const r = node.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.bottom > sb.bottom + 1 || r.right > sb.right + 1 || r.top < sb.top - 1 || r.left < sb.left - 1) {
          clipped.push(`${node.className || node.tagName} ${Math.round(r.right)}x${Math.round(r.bottom)}`);
          if (clipped.length > 4) break;
        }
      }
    }
    return clipped;
  });
  await page.screenshot({ path: join(outDir, `${s.name}.png`) });
  console.log(`shot: ${s.name}${overflow.length ? `  !! OVERFLOW: ${overflow.join(" | ")}` : ""}`);
  if (overflow.length) process.exitCode = 1;
}

await browser.close();
