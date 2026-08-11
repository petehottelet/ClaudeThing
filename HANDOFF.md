# Engineering handoff

Updated 2026-08-11. This is the starting point for the next agent; do not reconstruct the project from old setup notes.

## Current outcome

ClaudeThing development firmware boots on the physical Car Thing and displays live Claude and Codex data when attached directly over USB. The host collector, atomic USB snapshot mirror, loopback dashboard service, Weston, Chromium kiosk, and physical controls have all run together on hardware.

The connected unit is on the last approved development image. It powers from the user's VIA Labs hub, but macOS does not enumerate the Car Thing on that path, so ADB cannot carry data and both feeds become stale. Direct USB remains healthy. The source branch now contains an original authenticated Bluetooth Classic fallback, but that candidate has not been flashed or paired on hardware yet.

The current final candidate was built only after the full host verification passed. Its assembled root filesystem was inspected and contains the enabled Bluetooth receiver, temporary pairing service, BlueZ, OpenSSL, the expected protocol markers, and the root-only token path. A rebuild invalidates the artifact details below.

## Source completed in this branch

- Original MIT license and independent-implementation boundary.
- Original ClaudeThing Yocto distro/image layer, boot bitmap, and Weston splash.
- BusyBox configuration enabling the required local `httpd` applet.
- Dashboard service hardening and Chromium HTTP-readiness gate.
- Host provisioning with pairing token, IANA time zone, USB tunnel, service restart, and post-restart health polling.
- Firmware-aware doctor checks for identity, HTTP applet, display, UI, browser, and actual HTTP response. Remote checks carry an explicit status marker because this device's ADB daemon can return host success even when the remote command failed.
- Real two-origin browser E2E matching firmware UI/collector topology.
- Claude last-valid quota persistence after a status-line event.
- Default collector CORS permission for the device UI origin.
- Native horizontal dial-wheel handling.
- Documentation rewritten around persistent firmware rather than the obsolete temporary experiment.
- Preset-3 dashboard gallery with weekly AI usage, configurable YouTube channel views, configurable GA4 active users, and dial-selectable individual/index/total-market charts.
- Reusable SVG line/area chart geometry with Node tests and physical-resolution screenshot coverage.
- Independent Daily/Weekly/Monthly/Year analytics range state; YouTube/GA4 dial input cannot spill into Markets, whose dial remains instrument-specific.
- Automatic transport selection: atomic USB/ADB remains preferred, with a macOS Bluetooth RFCOMM fallback only while USB is unavailable.
- Universal ad-hoc-signed Intel/Apple-silicon Bluetooth sender with an embedded macOS privacy description.
- Device receiver enforcing bonded-link security, one-MiB bounds, HMAC-SHA256 authentication, replay ordering, minimal JSON envelope checks, atomic promotion, and authenticated clock repair.
- Explicit two-minute, USB-triggered Bluetooth pairing window; the device is not left permanently discoverable or pairable.

The YouTube and GA4 screens currently use built-in demonstration series. Their configured display names are provisioned through `--youtube-channel` and `--ga4-property`. Real daily YouTube Analytics is owner-authorized; real GA4 reporting requires an account or service account with property access. Implement those as host-side adapters and transmit only bounded chart series—never OAuth credentials—to the device.

## Required next actions

1. Check `git status -sb` and do not rebuild after the exact candidate has been approved.
2. Obtain approval for the exact artifact path, byte size, and SHA-256 reported in the active task. No previous hash approval carries forward.
3. Flash only that approved artifact through the compatible local-archive recovery interface.
4. Attach directly by USB, provision with the existing token file, and run `doctor`.
5. Run `device-tool.mjs bluetooth-pairing`, then have the human connect to `ClaudeThing Display` in macOS Bluetooth settings.
6. Install/restart the packaged collector so its native helper is active, approving the one-time macOS Bluetooth privacy prompt if shown.
7. Confirm both feeds are live over direct USB, then move device power to the hub and confirm health switches from USB to Bluetooth and both feeds return live.
8. Cold boot from hub power and verify the authenticated Bluetooth timestamp repairs the local clock.
9. Push only after the physical gate passes; use the configured `petehottelet` identity and never introduce commits from another account.

## Hardware acceptance still open

- Permanent boot with the rebuilt BusyBox/UI/time-zone image.
- Correct local clock after a cold boot and provisioning.
- Every button, touch gesture, dial press, and long-press on physical hardware.
- Claude quota seeding and persistence with a real event.
- Bluetooth pairing, signed snapshot acceptance, automatic USB-to-Bluetooth failover, and reconnect after reboot.
- Automatic USB restoration after host sleep and reconnect, with Bluetooth returning to standby.
- Offline cache and recovery without manual reload.
- Multi-hour stability and bounded storage writes.
- Recovery restore rehearsal and production-image decision.

## Safety state

- A complete factory partition backup exists off-device. Keep its location private and do not commit it.
- Firmware build output and factory artifacts are intentionally ignored by Git.
- No pairing token is stored in source or firmware.
- The repository has no build-and-flash command.
- Never use fastboot.
- A generic or ClaudeThing logo is not a successful acceptance result; require component health plus human-visible dashboard confirmation.

## Data behavior to remember

Codex quota is actively collected from the signed-in local app server. Claude subscription quota uses the signed-in CLI credential through a bounded OAuth poller with automatic refresh and retained last-good state; the status-line hook remains a second source. A one-time macOS Keychain authorization is expected, but denying access suppresses repeated prompts for that collector run. Do not trigger paid activity merely to make a card populate—ask the user to perform a normal interaction.
