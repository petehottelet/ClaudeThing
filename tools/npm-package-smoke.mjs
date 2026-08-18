import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "claudething-npm-"));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result.stdout;
}

try {
  const packed = JSON.parse(
    run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary]),
  );
  const artifact = packed[0];
  if (artifact?.name !== "claudething" || artifact?.version !== manifest.version) {
    throw new Error(`Unexpected package identity: ${JSON.stringify(artifact)}`);
  }

  const paths = new Set(artifact.files.map((entry) => entry.path));
  const required = [
    "bin/claudething.mjs",
    "release/collector/collector.cjs",
    "release/device-ui/index.html",
    "release/install/authorize-claude.mjs",
    "release/install/install.mjs",
    "release/install/uninstall.mjs",
    "release/device/device-tool.mjs",
    "LICENSE",
    "README.md",
    "package.json",
  ];
  for (const path of required) {
    if (!paths.has(path)) throw new Error(`npm package is missing ${path}`);
  }

  const forbidden = [...paths].filter((path) =>
    /(?:^|\/)(?:pairing\.token|dashboard-config\.jsonc)$/.test(path) ||
    path.startsWith("firmware/build/") ||
    path.endsWith("-flashthing.zip"),
  );
  if (forbidden.length > 0) {
    throw new Error(`npm package contains forbidden runtime/build data: ${forbidden.join(", ")}`);
  }

  const prefix = join(temporary, "installed");
  const tarball = join(temporary, artifact.filename);
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix, tarball]);
  const cli = join(prefix, "node_modules", "claudething", "bin", "claudething.mjs");
  const help = run(process.execPath, [cli, "--help"]);
  if (!help.includes("never flashes firmware")) throw new Error("Installed CLI help lost the firmware safety boundary.");
  const installHelp = run(process.execPath, [cli, "install", "--help"]);
  if (!installHelp.includes("--pairing-token-file")) {
    throw new Error("Installed CLI cannot reach the packaged host installer.");
  }
  const authorizeHelp = run(process.execPath, [cli, "authorize-claude", "--help"]);
  if (!authorizeHelp.includes("authorize-claude")) {
    throw new Error("Installed CLI cannot reach the packaged Claude authorizer.");
  }
  const version = run(process.execPath, [cli, "--version"]).trim();
  if (version !== manifest.version) throw new Error(`Installed CLI reported ${version}, expected ${manifest.version}.`);

  console.log(
    `npm package: ${artifact.filename}, ${artifact.size} bytes compressed, ${artifact.files.length} files; installed CLI smoke passed`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
