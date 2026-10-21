# Release notes — thub for VS Code (adsystem-pro.thub-vscode)

What changed in each release, newest first. `## Unreleased` collects the changes since the version on the VS Code Marketplace; `bin/publish` turns that heading into the version and date it releases, and publishes this file as the extension's changelog.

## Unreleased

### Changed

- **Release notes:** the Marketplace's changelog is now this file, `RELEASE.md`, with one section per version (it was `CHANGELOG.md`). `bin/publish` releases the extension like the other TestHub packages: it stamps these notes, publishes to the Marketplace with `vsce publish`, and pushes the version's tag.

## 0.1.0 — 2026-10-16

First version.

- **Boards view**:
  - **My session**: the board, its countdown and link state, its UARTs, GDB port and camera, and Flash, Debug and Release.
  - **Boards**: every runner with its state (idle, mine, connecting, reserved by someone, running a job, offline, maintenance), each with its own icon and label.
  - **Recent jobs**.
- **Reserve a board**: a two-step quick pick (the board, grouped Idle now / Busy; then 30m, 2h, 4h, 8h or your own), with "Connect right away".
  - At 10 minutes left: **Extend 1h** or **Release now**.
  - When the reservation ends, everything it opened closes.
- **One `thub connect` per reservation**: pinned local ports, NDJSON events (thub CLI 1.1.24+), and a restart after 1, 2, 5, 10 s if it exits while the reservation holds.
- **Flash**:
  - A batch GDB `load` over the board's GDB port, with `compare-sections`, then reset and run (or halt).
  - It skips an image identical to the last one flashed; it reports progress and can be canceled; a failure offers "Power-cycle and retry".
  - Task type `thub` (`"action": "flash"`).
- **Flash after build**: the `thub.flashAfterBuild` setting and its settings tab (When / Where / How, a live settings.json preview, the last run, Build and flash now), plus a status bar switch and **thub: Build and flash**.
- **Debug**:
  - Debug type `thub`, which hands Cortex-Debug an external-server configuration on the board's GDB port.
  - Power-cycle in the debug toolbar.
  - **Reattach debugger** after a link drop.
- **Serial terminals** over the UART ports: timestamps, logging to a file, and reconnecting.
- **Camera tab**: in the editor (via a local ffmpeg), in an external player, or in the browser (mpegts.js); power controls; the stream's URL.
- **thub Ports panel**: UARTs, GDB and camera, with Open, Debug, Flash and Copy.
- **Status bar**: the reservation's countdown (red under 10 minutes), the link, UART and GDB.
- **Theme colours**: `thub.accent`, `thub.onAccent`, `thub.idle`, `thub.error`, `thub.ok`.
- **Not faked**: USB power works only while a job of yours runs on the board, and custom port forwards appear only with a thub CLI that has `connect --forward`.
