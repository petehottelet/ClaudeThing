import { isProviderSnapshot, type ProviderSnapshot } from "@carthing/contracts";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ProviderAdapterError } from "./provider-poller";

const MAX_PROVIDER_FILE_BYTES = 2 * 1024 * 1024;

/** Read one owner-controlled provider bridge file. The wire contract is
 * validated before any value reaches the device, and origin fields are
 * stamped locally so a file cannot impersonate a peer collector. */
export async function readProviderJson(options: {
  directory: string;
  id: string;
  host: string;
}): Promise<ProviderSnapshot> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(options.id)) {
    throw new ProviderAdapterError("PROVIDER_ID_INVALID");
  }
  const file = path.join(options.directory, `${options.id}.json`);
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new ProviderAdapterError(`${options.id.toUpperCase()}_BRIDGE_FILE_MISSING`);
  }
  if (!info.isFile() || info.size > MAX_PROVIDER_FILE_BYTES) {
    throw new ProviderAdapterError(`${options.id.toUpperCase()}_BRIDGE_FILE_INVALID`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    throw new ProviderAdapterError(`${options.id.toUpperCase()}_BRIDGE_JSON_INVALID`);
  }
  if (!isProviderSnapshot(raw) || raw.id !== options.id) {
    throw new ProviderAdapterError(`${options.id.toUpperCase()}_BRIDGE_SCHEMA_INVALID`);
  }
  return {
    ...raw,
    host: options.host,
    source: "json-bridge",
  };
}
