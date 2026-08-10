#!/usr/bin/env node
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = resolve(repository, "apps/device-ui/dist");
const destination = resolve(
  repository,
  "firmware/meta-claudething/recipes-claudething/claudething-ui/files/bundle",
);

try {
  if (!(await stat(resolve(source, "index.html"))).isFile()) throw new Error();
} catch {
  throw new Error("Device UI build is missing. Run `npm run build -w apps/device-ui` first.");
}

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });

const indexPath = resolve(destination, "index.html");
const index = await readFile(indexPath, "utf8");
const runtimeScript = "    <script src=\"/runtime-config.js\"></script>\n";
if (!index.includes("</head>")) throw new Error("Built UI index has no closing head element.");
if (!index.includes("/runtime-config.js")) {
  await writeFile(indexPath, index.replace("</head>", `${runtimeScript}  </head>`), "utf8");
}

await writeFile(
  resolve(destination, "runtime-config.js"),
  'window.__CARTHING_CONFIG__ = { endpoints: ["127.0.0.1:8790"], youtubeChannel: "YouTube Channel", ga4Property: "Website Analytics" };\n',
  { encoding: "utf8", mode: 0o600 },
);

console.log(`Staged device UI for Yocto: ${destination}`);
