import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = resolve(root, "release");

await rm(release, { recursive: true, force: true });
await mkdir(release, { recursive: true });
await cp(resolve(root, "apps/collector/dist"), resolve(release, "collector"), { recursive: true });
await cp(resolve(root, "apps/device-ui/dist"), resolve(release, "device-ui"), { recursive: true });
await cp(resolve(root, "install"), resolve(release, "install"), { recursive: true });
await cp(resolve(root, "device"), resolve(release, "device"), { recursive: true });
await cp(resolve(root, "firmware"), resolve(release, "firmware"), {
  recursive: true,
  filter: (source) => {
    const normalized = source.replaceAll("\\", "/");
    return (
      !normalized.includes("/firmware/build") &&
      !normalized.includes("/claudething-ui/files/bundle")
    );
  },
});
await cp(resolve(root, "README.md"), resolve(release, "README.md"));
await cp(resolve(root, "INSTALL.md"), resolve(release, "INSTALL.md"));
await cp(resolve(root, "SECURITY.md"), resolve(release, "SECURITY.md"));
await cp(resolve(root, "THIRD_PARTY_NOTICES.md"), resolve(release, "THIRD_PARTY_NOTICES.md"));
await cp(resolve(root, "LICENSE"), resolve(release, "LICENSE"));
await cp(resolve(root, "docs"), resolve(release, "docs"), { recursive: true });
await mkdir(resolve(release, "licenses"), { recursive: true });
await cp(resolve(root, "node_modules/react/LICENSE"), resolve(release, "licenses/React-MIT.txt"));
await cp(resolve(root, "node_modules/ws/LICENSE"), resolve(release, "licenses/ws-MIT.txt"));
await cp(
  resolve(root, "node_modules/@fontsource/nunito/LICENSE"),
  resolve(release, "licenses/Nunito-OFL-1.1.txt"),
);

console.log("release: collector, device UI, installers, device tool, firmware source, licenses, and runbooks");
