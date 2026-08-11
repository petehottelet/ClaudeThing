# Third-party notices

The release bundle includes or derives runtime assets from the following packages:

- React and ReactDOM - MIT License - https://github.com/facebook/react
- ws - MIT License - https://github.com/websockets/ws
- Nunito font package - SIL Open Font License 1.1 - https://fonts.google.com/specimen/Nunito
- Google Material Symbols icon path data (bar_chart, smart_display, monitoring, trending_up), inlined as SVG in the dashboard gallery - Apache License 2.0 - https://github.com/google/material-design-icons

Claude, OpenAI, Cursor, Gemini, Droid, and Copilot provider marks appear only to identify the corresponding user-selected data sources. They remain trademarks of their respective owners, are not ClaudeThing-authored artwork, and do not imply affiliation, endorsement, sponsorship, or support. They are not relicensed under the repository's MIT License.

The corresponding license texts are included in the release `licenses/` directory. Build and test dependencies are recorded in `package-lock.json` and retain their respective licenses. All application source code in this repository is original to this project. Device unlock and backup use the third-party `superbird-tool` USB utility at install time; it is downloaded separately by the installer and is not distributed with, or copied into, this repository.

## Firmware build dependencies

The `firmware/` directory contains ClaudeThing-authored metadata, scripts, service definitions, and application integration under the repository's MIT License. Firmware builds fetch pinned external projects instead of vendoring their source:

- `JoeyEamigh/yocto-superbird` - generic Car Thing board-support layer; the pinned revision and upstream license declaration are recorded in `firmware/kas/claudething.yml` and `firmware/README.md`.
- Yocto Project, OpenEmbedded, BitBake, `meta-meson`, `meta-openembedded`, `meta-browser`, Linux, Chromium, Weston, Mesa, systemd, BusyBox, BlueZ, OpenSSL, and their transitive packages - their own upstream licenses apply. BlueZ and OpenSSL are direct runtime/build dependencies of the device-side Bluetooth receiver.

Yocto generates package license manifests for each assembled image. Those manifests, rather than this summary, are the authoritative inventory for a particular firmware artifact. Distributing a firmware image requires shipping its generated license manifest and corresponding license texts. No third-party dashboard source, binary, patch, asset, or release artifact is included or required.
