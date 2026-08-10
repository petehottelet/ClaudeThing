# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

A lightweight React and Vite single-page interface runs in Chromium on the ClaudeThing Linux image. A cross-platform TypeScript and Node.js collector runs on Windows and macOS and can synchronize bounded observations over the local network. ClaudeThing application code, product services, firmware integration, and artwork are authored for this repository; generic board support and Linux packages remain external dependencies under their own licenses.

## Users

The primary user is the device owner working across a Windows PC and a Mac, both running Claude Max and the highest-tier Codex subscription. They glance at a dedicated desk display while working to understand remaining AI usage without opening provider settings pages, and the display must be accurate regardless of which machine they are working on.

## Product Purpose

Replace the Spotify interface entirely with a first-party, dedicated usage dashboard for Claude and Codex. The first release must make current quota consumption, reset timing, freshness, and provider availability understandable at a glance. The product should later accept additional dashboard modules, including an advertising dashboard.

## Positioning

The product turns otherwise retired Car Thing hardware into a glanceable, physical dashboard fed by local, subscription-aware telemetry. It keeps provider credentials and detailed local session records on the computer instead of copying them to the display device.

## Operating Context

The primary supported connection is USB to either a Windows PC or Mac, using an authenticated ADB reverse tunnel to that host's collector. An optional powered local network bridge can provide an alternate path. Because the device has no battery, it displays only while powered, and the cached-snapshot experience applies when no collector is reachable. Installation requires a complete factory backup, recovery preparation, an explicitly approved ClaudeThing artifact, and post-flash provisioning.

## Capabilities and Constraints

- Replace the existing entertainment interface rather than preserving Spotify controls.
- Show Claude Max and top-tier Codex subscription usage, including current and longer-window percentages and reset countdowns when the providers expose them.
- Support detailed local token totals as a secondary view when reliable local records are available.
- Use the Car Thing's 800 by 480 landscape display, touch input, rotary dial, dial press, and hardware buttons.
- Run data collection on each work machine (Windows and macOS) because provider sessions and local logs live there, and synchronize numeric summaries between machines over the local network.
- Support both primary link modes: USB-docked at either computer, and untethered on home Wi-Fi through the USB network bridge accessory. Bluetooth tethering through a phone is an experimental third path (validated in Phase 0; reaching the collectors through it requires an Android phone sharing the home Wi-Fi over Bluetooth).
- Offer the same dashboard to a desktop browser over the local network as a secondary, token-gated surface.
- Do not store Claude session cookies, ChatGPT credentials, prompts, responses, or raw local transcripts on the Car Thing, and never transmit them between machines during sync.
- When disconnected, retain the last valid snapshot and label it with its age and offline state. A cloud relay is not part of the first release.
- Preserve a typed extension seam for later telemetry providers. A local commented config may order, enable, and select common data lanes for any registered provider without turning the 800×480 device into a layout editor.
- Offer weekly AI usage, YouTube channel, GA4 property, and market chart modules through a hardware-native dashboard gallery. Channel/property names, market selections, and rotation cadence are host-configurable; live owner analytics authenticate on the host and send only bounded chart series to the device.

## Design Direction

The usage presentation is a compact instrument panel: prominent percentages, truthfully labeled quota periods, colored progress bars with recessed tracks, reset and credit facts, a dark always-on background, and a small status rail carrying connection state and observation age. Composition is tuned for the 800 by 480 landscape display and the hardware controls; no light theme is required for the device.

## Scope Notes

- Provider telemetry comes exclusively from each provider's own local, authenticated product surfaces on the user's machines; no scraping, no shared credentials, no third-party services.
- No production advertising-dashboard schema or API contract has been supplied and must not be fabricated.

## Product Principles

- Glance first: the important limit and reset information must be readable in seconds.
- Honest freshness: missing, delayed, and disconnected data must never look current or become synthetic zero.
- Local by default: credentials and detailed usage records remain on the trusted work machines; only numeric summaries cross the home network, and nothing leaves it.
- Modular but specific: Claude and Codex ship as complete first-party modules; future dashboards use a small typed adapter contract.
- Hardware-native: touch, rotary input, and the four preset buttons are meaningful controls rather than decorative leftovers.

## Accessibility & Inclusion

Use high contrast, large numerals, clear focus states, and status labels in addition to color. All primary actions must work through touch and physical controls, and motion must remain restrained enough for a persistent desk display.
