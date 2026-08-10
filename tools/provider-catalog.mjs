#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "packages", "contracts", "src", "provider-catalog.json");
const destination = path.join(root, "docs", "PROVIDER_CATALOG.md");
const configTemplate = path.join(root, "install", "dashboard-config.example.jsonc");
const catalog = JSON.parse(await readFile(source, "utf8"));

if (!Array.isArray(catalog) || catalog.length === 0) throw new Error("provider catalog is empty");
const ids = catalog.map((provider) => provider.id);
const descriptions = catalog.map((provider) => provider.description);
if (new Set(ids).size !== ids.length) throw new Error("provider catalog contains duplicate ids");
if (new Set(descriptions).size !== descriptions.length) {
  throw new Error("every provider must have an independently written description");
}
for (const provider of catalog) {
  if (!/^[a-z0-9._-]+$/.test(provider.id)) throw new Error(`unsafe provider id: ${provider.id}`);
  if (typeof provider.displayName !== "string" || provider.displayName.trim().length < 2) {
    throw new Error(`missing display name for provider: ${provider.id}`);
  }
  if (typeof provider.description !== "string" || provider.description.trim().length < 60) {
    throw new Error(`provider description is not substantive: ${provider.id}`);
  }
  if (provider.integration !== "native" && provider.integration !== "bridge") {
    throw new Error(`unknown integration type for provider: ${provider.id}`);
  }
}

const template = await readFile(configTemplate, "utf8");
const templateIds = [...template.matchAll(/"id"\s*:\s*"([a-z0-9._-]+)"/g)].map((match) => match[1]);
if (new Set(templateIds).size !== templateIds.length) {
  throw new Error("dashboard config contains duplicate provider stubs");
}
if (templateIds.length !== ids.length || ids.some((id) => !templateIds.includes(id))) {
  throw new Error("dashboard config stubs do not match the canonical provider catalog");
}
const lines = [
  "# Provider catalog",
  "",
  "ClaudeThing recognizes every provider below. Native collectors refresh directly from local sign-in state; bridge providers accept the same bounded display data from an owner-controlled local JSON integration. Authentication secrets always stay on the host.",
  "",
  "| Provider | Integration | What it can show |",
  "| --- | --- | --- |",
  ...catalog.map((provider) =>
    `| ${provider.displayName} (\`${provider.id}\`) | ${provider.integration === "native" ? "Native collector" : "JSON bridge"} | ${provider.description} |`,
  ),
  "",
  "An unlisted provider can also use the JSON bridge with a safe lowercase id. See [provider setup](PROVIDERS.md) for the contract and installation paths.",
  "",
];
const expected = lines.join("\n");

if (process.argv.includes("--write")) {
  await writeFile(destination, expected, "utf8");
  console.log(`provider catalog: wrote ${catalog.length} entries`);
} else {
  let actual = "";
  try {
    actual = await readFile(destination, "utf8");
  } catch {
    // The diagnostic below covers a missing generated document.
  }
  if (actual !== expected) {
    throw new Error("docs/PROVIDER_CATALOG.md is stale; run node tools/provider-catalog.mjs --write");
  }
  console.log(`provider catalog: ${catalog.length} unique descriptions verified`);
}
