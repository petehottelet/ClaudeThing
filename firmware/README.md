# ClaudeThing firmware

This directory is the independently authored firmware integration for ClaudeThing. It builds a product-specific Yocto image rather than modifying the factory application partition or redistributing another dashboard firmware.

## Architecture

- `meta-claudething` owns the ClaudeThing distro identity, image composition, dashboard recipe, local HTTP service, browser readiness check, and development tools.
- The built React bundle is served only on device loopback at `127.0.0.1:8080`.
- Chromium starts after the local service passes a real HTTP readiness probe.
- The dashboard reads the collector at device loopback port `8790`. The host collector's existing supervisor maintains the authenticated ADB reverse link over USB.
- A pairing token is written after installation to `/var/lib/claudething/runtime-config.js`; it is never included in source or in a distributable firmware artifact.
- The generic board-support layer supplies the mainline kernel, U-Boot, display stack, input drivers, USB CDC-NCM/ADB gadget, recovery packaging, and A/B partition machinery.

No third-party dashboard code or artifact is used. The contribution rules are in [`docs/INDEPENDENT_IMPLEMENTATION.md`](../docs/INDEPENDENT_IMPLEMENTATION.md).

## Pinned board support

Kas fetches the external board-support layer at the exact revision recorded in `kas/claudething.yml`. The layer remains external and is not copied or relicensed by ClaudeThing. Its provenance and license metadata must be reviewed before a public binary firmware release.

Every image includes Yocto's package license manifest, while the complete package license texts remain in the build's deploy output. A binary release must include those generated files because the kernel, browser, build-system components, and other packages retain their own licenses.

## Build

Requirements:

- Node.js 20.19 or newer
- Docker Desktop on macOS; Docker or Podman on Linux
- `kas-container`
- GNU `realpath` on macOS (`brew install coreutils`)

On macOS the build script automatically discovers Homebrew's keg-only GNU
utilities and `kas-container` installed by `pip --user`, so these prerequisites
do not need to be manually added to a non-interactive `PATH`.

Build the development image:

```sh
npm install
npm run firmware:build
```

Build the production image after device bring-up passes:

```sh
npm run firmware:build -- --prod
```

The script builds and stages the dashboard, validates firmware invariants, invokes the pinned Kas graph, and mirrors macOS deployment output to `firmware/build/deploy`. macOS builds use the checked-in four-worker memory bound so Chromium can compile reliably in a 16 GiB Linux VM. The script never flashes a device.

## Flash gate

A full image replaces the device bootloader and partition table. Do not flash merely because a build completed. For each physical device:

1. Verify a complete, readable partition backup stored off-device.
2. Record the exact firmware ZIP path and SHA-256.
3. Verify a known recovery path and compatible local-archive flashing interface.
4. Obtain explicit approval for that exact ClaudeThing image.
5. Flash the development image, boot it, provision pairing and the host IANA time zone, then verify display, touch, dial, buttons, USB ADB/networking, service health, and rollback behavior before considering production firmware.

The repository deliberately has no build-and-flash command.
