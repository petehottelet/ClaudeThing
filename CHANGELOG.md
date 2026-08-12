# Changelog

## 1.1.0 — 2026-08-11

ClaudeThing.ai 1.1 makes the dashboard more reliable as an unattended desk display and introduces the project's first source-linked, ready-to-flash firmware release.

### Highlights

- Automatic Claude OAuth refresh with retained last-valid quota data and rate-limit-aware polling.
- More resilient USB snapshot mirroring and tunnel recovery after sleep, reconnects, and unreliable hub behavior.
- An authenticated Bluetooth fallback that automatically stands by while USB is healthy and resumes bounded snapshot delivery when USB data is unavailable.
- Visible USB/Bluetooth transport state plus an honest animated reconnecting status with exact last-observation times.
- All three available Claude limits in the split overview, clearer Codex account facts, and larger usage and reset typography throughout the 800×480 interface.
- Cleaner persistent boot presentation and refreshed documentation screenshots matching the shipped UI.
- A verified FlashThing-compatible firmware archive, SHA-256 checksum, build metadata, and complete generated license archive attached to the GitHub release.

### Install

Download the firmware and checksum from the [v1.1.0 release](https://github.com/petehottelet/ClaudeThing/releases/tag/v1.1.0), then follow the [installation and recovery guide](INSTALL.md). The release archive is built from the tagged public source; credentials and pairing material are provisioned locally after flashing and are not included in the image.

## 1.0.0 — 2026-08-10

ClaudeThing.ai 1.0 is the first public source release of the independent, MIT-licensed dashboard firmware project for Spotify Car Thing.

### Highlights

- Live, self-refreshing Claude and Codex usage dashboards, including current-session and weekly quota detail.
- A three-bar Claude view for Current session, All models, and model-specific limits such as Fable when the account exposes them.
- Native collectors for Claude, Codex, Cursor, Gemini, Droid, and Copilot, plus a documented 65-provider catalog and JSON/HTTP bridge for additional services.
- Dark, hardware-friendly views for daily usage, YouTube analytics, GA4 web analytics, stocks, indexes, and market data.
- Dial navigation, configurable dashboard rotation, polished transitions, device diagnostics, and branded boot/UI artwork.
- Local-first operation over authenticated USB transport, with automatic host startup, USB recovery, and device clock synchronization.
- Human-editable configuration with commented examples for providers, dashboards, symbols, channels, properties, refresh behavior, and rotation timing.
- Cross-platform setup helpers, install documentation, provider guides, security guidance, screenshots, and a full automated verification suite.

### Install

Start with the [installation guide](https://github.com/petehottelet/ClaudeThing/blob/main/INSTALL.md), or point your coding agent at this repository and ask it to install ClaudeThing.ai for your connected device.

This release contains the complete firmware and application source. A prebuilt firmware image is not attached; build and hardware-specific flashing remain explicit local steps so the exact artifact can be verified for the target device.

ClaudeThing.ai is a nonprofit open-source project. It is not affiliated with, endorsed by, or sponsored by Spotify, Anthropic, OpenAI, Google, Microsoft, Cursor, Factory, or any other provider represented by optional integrations.
