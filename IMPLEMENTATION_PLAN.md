# Release gates

ClaudeThing is implemented as a persistent, independently authored firmware product with a local host collector. Work advances only when the preceding gate is supported by automated evidence and physical observation.

## Completed software gates

- Strict versioned snapshot contracts and honest missing/stale/offline states.
- Claude and Codex local adapters, bounded persistence, and multi-host merge semantics.
- Authenticated HTTP/WebSocket service, exact CORS policy, pairing flow, and USB tunnel supervisor.
- 800×480 dashboard, offline cache, provider/system screens, touch and physical-input mappings.
- macOS/Windows host install, upgrade, status-line preservation, and uninstall.
- Original ClaudeThing firmware layer, identity, artwork, local service, readiness ordering, and pinned board support.
- Unit, integration, installer, same-origin browser, real firmware-topology browser, and firmware source verification.

## H0 — Recovery

Pass when the exact device is identified, its complete factory partition dump is readable and stored off-device, and a compatible restore path is understood. Any ambiguity blocks persistent writes.

## H1 — Artifact certification

Pass when a reproducible development ZIP has recorded build inputs, byte size, SHA-256, integrity, metadata, GPT geometry, package/license manifests, distro identity, artwork, dashboard bundle, and required runtime applets. A source-level setting alone is not proof that the feature reached the image.

## H2 — Exact-image flash and boot

Pass when the owner approves the exact certified artifact, that artifact flashes without error, cold boot reaches ClaudeThing artwork, ADB identifies the intended device, and all component checks in `device-tool.mjs doctor` pass.

## H3 — Physical UX and telemetry

Pass when the human sees the live dashboard, local-zone clock, accurate provider windows/ages, and successful operation of touch, dial, dial press, Back, presets, and long-press. Claude last-valid quota must survive collector restart after a normal status-line event.

## H4 — Resilience

Pass after host restart/sleep, collector restart, cable removal/reconnect, device reboot, peer loss, log rotation, malformed input, clock skew, offline cache, and at least a 24-hour soak recover automatically with bounded CPU, memory, and storage writes.

## H5 — Distribution

Pass when source release provenance is clean, all authored work is covered by the root MIT license, all real dependencies and generated image licenses are shipped accurately, no secrets/factory data/build artifacts are present, recovery documentation is complete, and the production image repeats H1–H4.

Current position: software gates and initial development-image bring-up have passed; the rebuilt artifact must repeat H1–H4 before production distribution.
