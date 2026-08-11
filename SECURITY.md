# Security and privacy model

## Trust boundary

The collector is a local companion service, not an internet service. Bind access to USB or a trusted private LAN. Anyone with the pairing token can read aggregated usage, submit a Claude status-line observation, and connect to the snapshot stream; protect the token like a local application password.

## Implemented controls

- Production tokens must be 32-256 base64url characters. The installer generates 32 random bytes.
- HTTP endpoints require `Authorization: Bearer`. Query-string tokens are rejected.
- The sole unauthenticated route is a loopback-only, bodyless transport probe used to verify an existing ADB reverse mapping without disrupting the dashboard stream. It exposes no telemetry or configuration.
- The USB supervisor writes a bounded, credential-free snapshot to a fixed file in the device's volatile loopback web root using an identity-checked, atomic temporary-file rename. A failed ADB attempt leaves the last complete snapshot intact and is retried later.
- WebSocket authentication uses a dedicated subprotocol header; the server echoes only `carthing.v1`, not the secret.
- Pairing material is accepted through a one-time URL fragment, persisted in device local storage, and immediately scrubbed from browser history/address state.
- CORS is an exact allowlist. Security headers include `no-store`, `no-referrer`, `nosniff`, and a restrictive UI Content Security Policy.
- Peer envelopes and snapshots have strict schema/version, identity, size, count, numeric, timestamp, and string bounds. Peer host identity is pinned and cannot collide with the local host.
- Status-line forwarding sends only an allowlist of model/rate-limit/context/cost fields. Paths, prompts, transcript identifiers, and workspace data are discarded before network transmission.
- Local JSONL readers emit aggregate numbers only. Raw prompts and records are never served.
- The Codex process is launched directly from a quoted argument vector, without a command shell.
- Claude OAuth renewal uses Anthropic's token endpoint and the public client identity used by the installed CLI. Rotated credentials are written back to the CLI's existing macOS Keychain item through child-process stdin, never command arguments or logs; the non-macOS credential-file fallback is replaced atomically with owner-only permissions. The collector caches a granted credential and suppresses background retries after denied or unavailable Keychain access, preventing recurring password prompts. No model prompt is sent to keep the dashboard current.
- Pairing tokens are file-backed, retained across upgrades, and protected with per-user permissions where the platform supports it.
- Device deployment requires a nonempty hashed stock-webapp backup marker and uses a fixed reboot-volatile staging/mount path.

## Deliberate tradeoffs

- Local HTTP is used for USB and private-LAN compatibility with the legacy Car Thing webview. The bearer token prevents unauthenticated reads but does not encrypt trusted-LAN traffic. Use USB, an isolated VLAN, or a local HTTPS reverse proxy where traffic confidentiality matters.
- The token provisioned into the device UI is readable to someone with filesystem access to the already-compromised/customized device. Provider account credentials and API keys are never stored on the device.
- Claude and Codex telemetry is operational rather than billing-grade. It may be absent or stale; the UI labels those conditions instead of substituting values.
- Existing command-based Claude status lines are chained through the same shell semantics Claude Code already used. Their output is bounded; their command remains user-controlled local configuration.

## Operational guidance

- Never commit or screenshot `pairing.token` or a pairing URL before its fragment is scrubbed.
- Give both peer collectors the same token through a secure local copy, not a chat message or public share.
- Do not expose port 8790 directly to the internet.
- Keep full device partition backups offline before any persistent firmware work.
- If a token is suspected to be exposed, stop both collectors, remove/replace both token files together, restart, and re-pair the device.

## Dependency surface

The production collector bundles `ws`. The device UI bundles React/ReactDOM and Nunito font assets. Build/test tooling such as Vite, TypeScript, Vitest, esbuild, and Playwright is not shipped as a runtime dependency. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
