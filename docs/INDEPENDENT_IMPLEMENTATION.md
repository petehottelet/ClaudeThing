# Independent implementation policy

ClaudeThing is its own product and codebase. This policy applies to maintainers, contributors, automated coding tools, release artifacts, and firmware builds.

## What belongs in this repository

- Code, recipes, services, tests, documentation, and assets authored specifically for ClaudeThing and intentionally contributed under the MIT License.
- Dependencies consumed through documented public interfaces, with an exact version or commit and an accurate third-party license notice.
- Unmodified provider identity marks used only to label compatible data sources, clearly separated from ClaudeThing-authored artwork and covered by the trademark disclaimer and third-party notice.
- Facts about the Spotify Car Thing hardware, public protocol behavior, test results from hardware owned by a contributor, and general engineering techniques.

## What must not be copied here

- Another dashboard project's source code, recipes, patches, scripts, configuration files, artwork, firmware images, generated bundles, or release artifacts.
- Text or code transcribed, mechanically transformed, translated, or closely adapted from an unrelated implementation.
- Spotify proprietary firmware, keys, credentials, copyrighted UI assets, or partition dumps.
- Any third-party source whose license is incompatible with the intended use unless it remains an unmodified, clearly separated dependency and its distribution terms are satisfied.

Reviewing public engineering information may inform high-level requirements such as managed boot services, readiness checks, rollback, and USB networking. ClaudeThing's implementation of those requirements must be independently designed, named, structured, authored, and tested for this repository.

## Board-support boundary

ClaudeThing's firmware layer uses a pinned generic Yocto board-support project through Kas. The BSP supplies hardware enablement and standard integration interfaces; `meta-claudething` supplies the product identity, dashboard payload, startup behavior, and image composition. BSP code is not copied into this repository. Its license and all transitive image licenses remain separate from ClaudeThing's MIT License.

## Release checks

Before publishing a source release or firmware image:

1. Confirm the root `LICENSE` and package metadata declare MIT for ClaudeThing-authored work.
2. Review the change for copied third-party code or assets and record every new dependency.
3. Run `npm run verify` and `npm run firmware:verify`.
4. For firmware, archive the exact Kas lock inputs, build metadata, checksums, generated package license manifest, and corresponding license texts.
5. Never claim that the complete Linux firmware image is entirely MIT-licensed; identify MIT as the license for ClaudeThing-authored source.

This policy is an engineering and release-control boundary, not legal advice.
