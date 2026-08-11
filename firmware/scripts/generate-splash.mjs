#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const wordmarkPath = resolve(repository, "docs/media/wordmark.svg");
const splashPath = resolve(repository, "firmware/assets/claudething-splash.svg");

const wordmark = await readFile(wordmarkPath, "utf8");
const lockupStart = wordmark.indexOf('  <g id="lockup">');
const lockupClose = '  </g>\n</svg>';
const lockupEnd = wordmark.lastIndexOf(lockupClose);

if (lockupStart < 0 || lockupEnd < lockupStart) {
  throw new Error("docs/media/wordmark.svg is missing its reusable lockup group.");
}

const lockup = wordmark.slice(lockupStart, lockupEnd + '  </g>'.length);
const splash = `<svg width="800" height="480" viewBox="0 0 800 480" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="ClaudeThing.ai starting">
  <rect width="800" height="480" fill="#000000"/>
  <g transform="translate(40 154.286) scale(0.857142857)">
${lockup}
  </g>
</svg>
`;

await writeFile(splashPath, splash);
console.log("generated firmware/assets/claudething-splash.svg");
