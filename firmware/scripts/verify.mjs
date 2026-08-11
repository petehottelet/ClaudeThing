#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const required = [
  "LICENSE",
  "docs/INDEPENDENT_IMPLEMENTATION.md",
  "firmware/kas/claudething.yml",
  "firmware/meta-claudething/conf/distro/claudething.conf",
  "firmware/meta-claudething/recipes-core/images/claudething-dev-image.bb",
  "firmware/meta-claudething/recipes-core/images/claudething-prod-image.bb",
  "firmware/meta-claudething/recipes-core/busybox/busybox_%.bbappend",
  "firmware/meta-claudething/recipes-core/busybox/busybox/claudething-httpd.cfg",
  "assets/claw-icon.svg",
  "firmware/assets/claudething-splash.svg",
  "firmware/scripts/generate-splash.mjs",
  "firmware/meta-claudething/recipes-bsp/superbird-logo/superbird-logo.bbappend",
  "firmware/meta-claudething/recipes-bsp/superbird-logo/files/claudething-bootup.bmp",
  "firmware/meta-claudething/recipes-graphics/weston-init/superbird-weston-init_%.bbappend",
  "firmware/meta-claudething/recipes-graphics/weston-init/files/claudething-splash.png",
  "firmware/meta-claudething/recipes-claudething/claudething-ui/claudething-ui_1.0.0.bb",
  "firmware/meta-claudething/recipes-claudething/claudething-ui/files/claudething-ui.service",
  "firmware/meta-claudething/recipes-graphics/chromium-kiosk/files/claudething-ui-ready",
];

for (const relative of required) {
  const info = await stat(resolve(repository, relative));
  if (!info.isFile()) throw new Error(`Required firmware source is not a file: ${relative}`);
}

const license = await readFile(resolve(repository, "LICENSE"), "utf8");
if (!license.startsWith("MIT License\n") || !license.includes("ClaudeThing contributors")) {
  throw new Error("Root MIT license is missing or malformed.");
}

const claw = await readFile(resolve(repository, "assets/claw-icon.svg"), "utf8");
if (!claw.includes('viewBox="0 0 745 1122"') || !claw.includes('fill="#d97757"')) {
  throw new Error("ClaudeThing claw source must retain its viewBox and product orange.");
}

const wordmark = await readFile(resolve(repository, "docs/media/wordmark.svg"), "utf8");
if (!wordmark.includes('<g id="lockup">')) {
  throw new Error("The reusable wordmark lockup must remain addressable without its card background.");
}

const splashSource = await readFile(
  resolve(repository, "firmware/assets/claudething-splash.svg"),
  "utf8",
);
for (const value of [
  '<rect width="800" height="480" fill="#000000"/>',
  '<g transform="translate(40 154.286) scale(0.857142857)">',
  '<g id="lockup">',
]) {
  if (!splashSource.includes(value)) {
    throw new Error(`Firmware splash must retain its borderless solid-black composition: ${value}`);
  }
}
if (
  splashSource.includes("#0a0a0e") ||
  splashSource.includes("<image") ||
  splashSource.includes("<use")
) {
  throw new Error("Firmware splash must be self-contained without the wordmark card or its panel.");
}

const kas = await readFile(resolve(repository, "firmware/kas/claudething.yml"), "utf8");
if (!kas.includes("commit: f0e7aa50a941f28ec196312f68c454982b191fee")) {
  throw new Error("The board-support dependency must be pinned to the reviewed commit.");
}

const buildScript = await readFile(resolve(repository, "firmware/scripts/build.mjs"), "utf8");
for (const macPath of [
  "/opt/homebrew/opt/coreutils/libexec/gnubin",
  "/usr/local/opt/coreutils/libexec/gnubin",
  'join(os.homedir(), "Library", "Python")',
]) {
  if (!buildScript.includes(macPath)) {
    throw new Error(`Firmware build must discover installed macOS tooling: ${macPath}`);
  }
}

const distro = await readFile(
  resolve(repository, "firmware/meta-claudething/conf/distro/claudething.conf"),
  "utf8",
);
for (const value of [
  'DISTRO = "claudething"',
  'CHROMIUM_KIOSK_URL = "http://127.0.0.1:8080/"',
  'COPY_LIC_MANIFEST = "1"',
  'COPY_LIC_DIRS = "0"',
  'SUPERBIRD_BOOT_LOGO_NAME = "claudething-bootup.bmp"',
  'SUPERBIRD_WESTON_SPLASH_IMAGE = "claudething-splash.png"',
]) {
  if (!distro.includes(value)) throw new Error(`Missing firmware distribution invariant: ${value}`);
}

const service = await readFile(
  resolve(
    repository,
    "firmware/meta-claudething/recipes-claudething/claudething-ui/files/claudething-ui.service",
  ),
  "utf8",
);
if (!service.includes("NoNewPrivileges=yes") || !service.includes("ProtectSystem=strict")) {
  throw new Error("Dashboard service hardening was removed.");
}

const httpdConfig = await readFile(
  resolve(
    repository,
    "firmware/meta-claudething/recipes-core/busybox/busybox/claudething-httpd.cfg",
  ),
  "utf8",
);
if (!/^CONFIG_HTTPD=y$/m.test(httpdConfig)) {
  throw new Error("BusyBox httpd must be enabled for the local dashboard service.");
}

const westonSplash = await readFile(
  resolve(
    repository,
    "firmware/meta-claudething/recipes-graphics/weston-init/files/claudething-splash.png",
  ),
);
if (
  !westonSplash.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
  westonSplash.readUInt32BE(16) !== 800 ||
  westonSplash.readUInt32BE(20) !== 480
) {
  throw new Error("Weston splash must be an 800x480 PNG.");
}

const bootLogo = await readFile(
  resolve(
    repository,
    "firmware/meta-claudething/recipes-bsp/superbird-logo/files/claudething-bootup.bmp",
  ),
);
if (
  bootLogo.toString("ascii", 0, 2) !== "BM" ||
  bootLogo.readInt32LE(18) !== 480 ||
  bootLogo.readInt32LE(22) !== 800
) {
  throw new Error("Boot logo must be a bottom-up 480x800 BMP.");
}

console.log(`firmware source: ${required.length} invariants verified`);
