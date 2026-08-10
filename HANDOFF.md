# Engineering handoff

Updated 2026-08-09. This is the starting point for the next agent; do not reconstruct the project from old setup notes.

## Current outcome

ClaudeThing development firmware boots on the physical Car Thing, brings up USB ADB, and can display the live dashboard. Codex subscription data has been observed on-device. The dial now emits usable horizontal navigation input. The host collector, authenticated USB tunnel, loopback dashboard HTTP service, Weston, and Chromium kiosk have all run together on hardware.

The connected unit is currently on an earlier development image. Its missing BusyBox `httpd` applet and current release UI were repaired with temporary runtime bind mounts for diagnosis. The device is presently serving the release whose gallery has colored source icons and whose YouTube/GA4 dial cycles Daily, Weekly, Monthly, and Year without leaving the selected module. These repairs do not survive a power cycle. Do not describe the unit as persistently fixed until a newly built and explicitly approved image is flashed.

The reported five-hour clock error was traced to Chromium using UTC. Source now provisions the host's IANA time zone and formats both the rail clock and same-day token buckets in that zone. This source change also requires a new firmware artifact for persistence.

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

The YouTube and GA4 screens currently use built-in demonstration series. Their configured display names are provisioned through `--youtube-channel` and `--ga4-property`. Real daily YouTube Analytics is owner-authorized; real GA4 reporting requires an account or service account with property access. Implement those as host-side adapters and transmit only bounded chart series—never OAuth credentials—to the device.

## Required next actions

1. Start from the GitHub branch/PR named in the publishing handoff; check `git status -sb` before editing.
2. Confirm `npm run verify` passes in a clean checkout.
3. Build a fresh development firmware artifact with `npm run firmware:build` because the time-zone/UI and documentation release content changed after the last image build.
4. Deep-inspect the resulting ZIP and WIC: integrity, metadata, GPT labels/geometry, package manifest, `ID=claudething`, original artwork, bundled UI, and BusyBox `httpd` applet.
5. Report the new exact artifact path, byte size, and SHA-256. Obtain fresh explicit approval; no previous hash approval carries forward.
6. Flash only that approved artifact through a compatible local-archive recovery interface.
7. Power cycle, provision with the existing token file, and run `doctor`.
8. Ask the human to verify dashboard pixels, `LIVE`, local clock, Codex values, and hardware controls.
9. Produce one normal Claude Code interaction. Confirm Claude quota state appears and survives a collector restart.
10. Complete reboot, cable reconnect, offline/recovery, control matrix, and soak tests before calling a production image ready.

## Hardware acceptance still open

- Permanent boot with the rebuilt BusyBox/UI/time-zone image.
- Correct local clock after a cold boot and provisioning.
- Every button, touch gesture, dial press, and long-press on physical hardware.
- Claude quota seeding and persistence with a real event.
- Automatic tunnel restoration after host sleep and USB reconnect.
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

Codex quota is actively collected from the signed-in local service. Claude subscription quota is delivered only when Claude Code emits the relevant status-line rate-limit payload; there is no independent background quota poll in this implementation. The collector now stores the last valid rate-limit observation so a restart no longer discards it. Do not trigger paid activity merely to make the card populate—ask the user to perform a normal interaction.
