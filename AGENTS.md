# Agent operating guide

Read [HANDOFF.md](HANDOFF.md), [INSTALL.md](INSTALL.md), and [docs/INDEPENDENT_IMPLEMENTATION.md](docs/INDEPENDENT_IMPLEMENTATION.md) before touching a device. GitHub is authoritative; inspect the local branch and working tree before changing files because another agent may have left useful uncommitted work.

## Project boundary

- ClaudeThing-authored code, recipes, tests, services, documentation, and artwork are MIT-licensed and independently implemented here.
- Do not copy or closely adapt another dashboard's code, configuration, patches, wording, artwork, bundles, or firmware.
- Name outside projects only when they are actual dependencies and record their licenses accurately.
- Never commit credentials, pairing tokens, provider records, factory images, partition dumps, build directories, or generated firmware ZIPs.

## Safe working sequence

1. Run `git status -sb`, inspect the diff, and preserve existing work.
2. Run `npm install` when dependencies are not present.
3. Run `npm run verify` before packaging or publishing.
4. Build firmware only with `npm run firmware:build`; this command must never flash.
5. Before any flash, confirm a complete off-device partition backup and present the exact artifact path, byte size, and SHA-256 to the owner.
6. Flash only after explicit approval for that exact artifact. A rebuild invalidates prior approval.
7. After boot, run `provision-firmware`, then `doctor`, then ask the human what is physically visible.

## Device safety

- Never use fastboot on this hardware.
- Never infer success from a boot logo, ADB alone, a build result, or a tool's success message.
- Pair every screen report with a USB/ADB probe. A logo proves only early boot/display progress.
- Do not call `adb reverse --list` on stock-derived ADB environments; reissue the known reverse mapping instead.
- Do not expose token files through command output. Pass paths, not token contents.
- Do not invent new persistent changes. Provisioning `/var/lib/claudething/runtime-config.js` on an already flashed ClaudeThing image is authorized application state; partition writes are a separate approval boundary.

## Useful commands

```sh
npm run verify
npm run firmware:build
node release/device/device-tool.mjs provision-firmware --token-file /path/to/pairing.token
node release/device/device-tool.mjs doctor
adb shell 'systemctl --failed --no-pager'
adb shell 'journalctl -u claudething-ui.service -u chromium-kiosk.service --no-pager -n 100'
```

The device tool auto-detects ClaudeThing firmware and checks the HTTP applet, display, UI, browser, and loopback response. Its result complements, but never replaces, visual confirmation.

## What we learned from physical bring-up

- Verify the contents and runtime features of the assembled image, not merely source configuration or task completion.
- The dashboard and collector use different origins on firmware (`8080` and `8790`); browser verification must exercise that topology.
- Service restart commands need readiness polling and an actionable failure, not an optimistic success message.
- Time is an IANA-zone presentation concern. Provision the host zone and keep reset math in absolute UTC.
- Event-fed quota data must preserve the last valid observation across collector restarts.
- Temporary runtime repairs are useful for diagnosis but do not become persistent until rebuilt, rehashed, approved, and flashed.
- Human pixel confirmation is a release gate because USB health cannot prove display composition.

## Publishing

Run `gh auth status` before pushing. From the default branch, publish work on an `agent/*` branch and open a draft pull request. Stage only reviewed project changes; summarize validation and any remaining physical-device gate in the PR.
