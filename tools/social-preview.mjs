/**
 * Render the GitHub social-preview card from repository-owned artwork.
 * Usage: node tools/social-preview.mjs [output.png]
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? "docs/media/social-preview.png");
const dataUri = (path, mime) =>
  `data:${mime};base64,${readFileSync(resolve(root, path)).toString("base64")}`;

const wordmark = dataUri("docs/media/wordmark.svg", "image/svg+xml");
const regular = dataUri(
  "node_modules/@fontsource/nunito/files/nunito-latin-600-normal.woff2",
  "font/woff2",
);
const bold = dataUri(
  "node_modules/@fontsource/nunito/files/nunito-latin-800-normal.woff2",
  "font/woff2",
);

mkdirSync(dirname(output), { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await page.setContent(`<!doctype html>
<style>
  @font-face { font-family: Nunito; src: url(${regular}) format("woff2"); font-weight: 600; }
  @font-face { font-family: Nunito; src: url(${bold}) format("woff2"); font-weight: 800; }
  * { box-sizing: border-box; }
  html, body { width: 1280px; height: 640px; margin: 0; overflow: hidden; }
  body {
    display: flex;
    align-items: center;
    justify-content: center;
    color: #f5f3f8;
    font-family: Nunito, sans-serif;
    background:
      radial-gradient(circle at 16% 18%, rgba(217,119,87,.22), transparent 30%),
      radial-gradient(circle at 84% 82%, rgba(143,182,232,.15), transparent 34%),
      #0a0a0e;
  }
  .card {
    width: 1160px;
    height: 520px;
    padding: 42px 70px 40px;
    text-align: center;
    border: 2px solid #2c2537;
    border-radius: 34px;
    background: rgba(17,14,23,.92);
    box-shadow: 0 28px 80px rgba(0,0,0,.42);
  }
  .wordmark { display: block; width: 860px; height: auto; margin: 0 auto 25px; }
  .pitch { margin: 0 auto 28px; max-width: 950px; font-size: 31px; line-height: 1.25; font-weight: 800; }
  .chips { display: flex; justify-content: center; flex-wrap: wrap; gap: 12px; }
  .chip {
    padding: 10px 17px 9px;
    border: 1px solid #3a3247;
    border-radius: 999px;
    color: #b5afc4;
    background: #201c2a;
    font-size: 18px;
    font-weight: 800;
  }
  .chip:first-child { color: #f0b09a; border-color: #7d493a; }
  .chip:nth-child(2) { color: #f7d76d; border-color: #66572b; }
  .chip:nth-child(3) { color: #76e596; border-color: #356948; }
</style>
<main class="card">
  <img class="wordmark" src="${wordmark}" alt="ClaudeThing.ai" />
  <p class="pitch">Custom firmware that turns Spotify Car Thing into<br />your always-on metrics dashboard.</p>
  <div class="chips">
    <span class="chip">Claude + Codex usage</span>
    <span class="chip">YouTube + GA4</span>
    <span class="chip">Stocks + indexes</span>
    <span class="chip">Local-first</span>
    <span class="chip">Made to extend</span>
  </div>
</main>`);
await page.evaluate(async () => {
  if (document.fonts) await document.fonts.ready;
  await Promise.all(Array.from(document.images).map((image) => image.decode()));
});
await page.screenshot({ path: output });
await browser.close();
console.log(`social preview: ${output}`);
