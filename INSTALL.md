# Install, firmware, and recovery runbook

This runbook keeps host installation, firmware construction, flashing, and post-flash provisioning as separate gates. No successful build or USB probe grants permission to flash.

## 1. Prepare and certify the host release

Requirements:

- Node.js 20.19 or newer on macOS or Windows.
- Signed-in Claude Code and Codex installations for the telemetry you want to display.
- ADB for USB device work.
- Docker/Podman, `kas-container`, and the prerequisites listed in [firmware/README.md](firmware/README.md) to build firmware.

```sh
npm install
npm run verify
```

The packaged host payload is written to `release/`.

## 2. Install the collector

```sh
node release/install/install.mjs --host-name desk-mac
```

The installer creates a random pairing token, installs a per-user background collector, preserves compatible existing Claude status-line behavior, creates a commented display-configuration file, and keeps both files across upgrades. Use `--no-start`, `--no-claude-statusline`, `--no-adb`, or `--no-codex-appserver` only when that behavior is intentional.

When ADB is available, the installer records its absolute executable path so macOS and Windows startup services do not depend on an interactive shell's `PATH`; explicit `--adb-command` and `--adb-serial` selections survive upgrades. The collector automatically restores the USB reverse tunnel. After confirming the attached device reports `ID=claudething`, it also repairs a stale device clock from the host before reconnecting the dashboard.

Default token locations:

- macOS: `~/Library/Application Support/CarThingCollector/pairing.token`
- Windows: `%LOCALAPPDATA%\CarThingCollector\pairing.token`

Never put the token in chat, logs, query strings, commits, or firmware images.
Routine installs print only the token file path. `--show-pairing-url` is an explicit, private-terminal-only escape hatch because its URL contains the credential.

To add a second collector, securely copy the first host's token and pass it through `--pairing-token-file`; configure each peer with a stable local address and `--peer-host`. The installer refuses to silently replace a different installed token.

### Edit what the dashboard shows

The installer creates:

- macOS: `~/Library/Application Support/CarThingCollector/dashboard-config.jsonc`
- Windows: `%LOCALAPPDATA%\CarThingCollector\dashboard-config.jsonc`

This is JSON with `//` and `/* … */` comments. Edit or uncomment provider rows to choose their order, visibility, and reported data lanes; edit the YouTube/GA4 identifiers; and edit the market instrument list or `rotationSeconds`. Common provider lanes include `quota`, `resetCredits`, `currentTokens`, `lifetimeTokens`, `peakDailyTokens`, `streak`, `history`, and `cost`. Future adapters can advertise bounded numeric facts selected as `metric:<id>` without changing the dashboard schema. The collector validates the file every five seconds. A malformed or unsupported edit produces a health warning and leaves the last valid configuration active.

The file is deliberately non-secret. Never put OAuth credentials, cookies, API keys, refresh tokens, or the pairing token in it. Authenticated analytics adapters keep credentials on the host and publish only bounded chart data.

## 3. Establish the recovery gate

Before any persistent write:

1. Identify the exact device in its USB recovery mode.
2. Create a complete partition dump with compatible recovery tooling on macOS or Linux.
3. Verify the dump is nonempty, preserve its hashes, and store a copy off the development computer.
4. Record and understand the restore procedure.
5. Stop if device identity, backup completeness, or recovery behavior is ambiguous.

Do not use fastboot. Do not treat an application-directory backup as a substitute for the complete partition dump.

## 4. Build the firmware artifact

```sh
npm run firmware:build
```

The command stages the verified UI, checks the ClaudeThing layer invariants, runs the pinned Kas build, and writes deploy output below `firmware/build/deploy/`. It never flashes.

For the candidate ZIP, record:

```sh
shasum -a 256 firmware/build/deploy/images/superbird/*flashthing.zip
ls -l firmware/build/deploy/images/superbird/*flashthing.zip
```

Verify ZIP integrity, image metadata, partition labels/geometry, expected package manifest, bundled ClaudeThing artwork, distro identity, and the required BusyBox `httpd` applet. Generated package license manifests and license texts must accompany a distributed binary image.

## 5. Approve and flash one exact image

Approval must name the exact ZIP path, byte size, and SHA-256. Approval for an older build does not carry to a rebuilt artifact. Flash through a compatible recovery interface that accepts the local archive; keep the browser/utility output visible until it reports completion.

After power cycling, a ClaudeThing logo is evidence that early boot reached the display path. It is not proof that the dashboard service or browser started.

## 6. Provision pairing and local time zone

Once `adb devices` reports exactly the intended unit:

```sh
node release/device/device-tool.mjs provision-firmware \
  --token-file "$HOME/Library/Application Support/CarThingCollector/pairing.token" \
  --youtube-channel "My Channel" \
  --ga4-property "My Website"
```

The command:

- refuses non-ClaudeThing firmware;
- writes only `/var/lib/claudething/runtime-config.js`;
- copies the host's IANA time zone (for example `America/Los_Angeles`) unless `--time-zone` overrides it;
- stores the selected YouTube channel and GA4 property display names (1–100 characters each);
- re-establishes `adb reverse tcp:8790 tcp:8790`;
- restarts the dashboard and browser; and
- waits for active services plus a successful loopback HTTP response before reporting success.

This is application provisioning, not flashing.

Preset 3 opens the additional dashboard gallery. In YouTube and GA4, turn the dial to switch Daily, Weekly, Monthly, and Year ranges; the dial stays within that analytics module. Markets automatically advance through every configured instrument after `rotationSeconds`; turning the dial changes the instrument immediately and restarts that timer. YouTube owner analytics require OAuth access to the channel; GA4 requires a user or service account granted access to the property. Those credentials and refresh tokens belong in future host adapters and must never be copied to the device. Until an authenticated adapter supplies a series, the gallery renders its built-in demonstration data without presenting an authentication control on the 800×480 display.

## 7. Diagnose and accept the hardware

```sh
node release/device/device-tool.mjs doctor
```

On ClaudeThing firmware, the doctor independently checks distro identity, the BusyBox HTTP applet, display service, dashboard service, browser service, and dashboard HTTP response. A passing doctor must still be paired with a human screen report.

Acceptance checklist:

- ClaudeThing boot artwork transitions to the dashboard.
- Bottom rail reads `LIVE`; Codex data appears when its host source is active.
- The clock matches the provisioned zone and the System screen names that zone.
- Claude quotas appear after a Claude Code terminal-CLI status-line event (the desktop app does not emit them); until then the Claude card shows its token totals with "No quota reported". The last valid quota survives collector restart.
- Dial rotation, dial press, Back, presets, touch, and swipes work without missed or doubled actions.
- Cable removal produces an honestly aged offline view; reconnect restores live data without a page reload.
- Reboot returns to the dashboard and the host restores the USB tunnel.

## 8. Failure interpretation

| Observation | Meaning and next action |
| --- | --- |
| Black screen and no ADB | Power/display or boot failure; re-enter recovery and inspect logs before any new write. |
| ClaudeThing logo remains indefinitely | Early boot works, but userspace is not ready. Run `doctor`, then inspect failed systemd units. |
| `doctor` says `httpd applet: failed` | The built root filesystem lacks the required BusyBox feature; rebuild, inspect the actual image, and obtain new artifact approval. |
| Services are active but the screen is unchanged | Inspect loopback HTTP and kiosk logs; do not call the deployment successful until pixels change. |
| Dashboard is live but Claude quota is stale or shows "Claude login expired" | Claude quota updates via the CLI's stored login on a five-minute base cadence; provider rate limits trigger bounded Retry-After/exponential backoff, and transient failures retain the last-good observation. If the login token expires, run any `claude` command once to refresh it; the poller recovers automatically. Status-line events remain a second live source during CLI sessions. |
| Clock is UTC | Re-run `provision-firmware`; do not hard-code a numeric offset because daylight saving changes it. |

## 9. Host uninstall

```sh
node release/install/uninstall.mjs
```

The uninstaller requires the product install marker, removes its startup entry, restores only the Claude status-line field it owns, preserves unrelated settings, and removes the installed payload. Device recovery uses the separately preserved full partition dump.
