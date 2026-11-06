# Release notes — thub for VS Code (adsystem-pro.thub-vscode)

What changed in each release, newest first. `## Unreleased` collects the changes since the version on the VS Code Marketplace; `bin/publish` turns that heading into the version and date it releases, and publishes this file as the extension's changelog.

## Unreleased

### Changed

- **Ports view actions:** every row action is an icon button with a hover hint. Debug, Flash, Open terminal, Open video and Open logs no longer use the amber primary tint, so each view has one amber control at most.
- **User manual:** new `docs/user-manual.md` covering sign-in, reserving, flashing, flash after build, debugging, serial, RTT, camera, forwarded services, USB power, troubleshooting and the command reference; linked from the README.

## 0.1.11 — 2026-11-03

### Fixed

- **Debug session firmware upload:** the debug session now flashes firmware through the session that owns it.

## 0.1.10 — 2026-11-03

### Fixed

- **Flasher:** flashing fixes, including the ST-Link choice and the missing-image handling below.

### Added

- **Choose the ST-Link:** when a board has several ST-Links, flashing asks which one to use (unless a probe is given explicitly or the run is a task).
- **Pick a missing firmware file:** an interactive flash whose image is missing offers a file picker. Tasks and flash-after-build stay strict and never open a dialog.

## 0.1.9 — 2026-11-03

### Fixed

- **RTT connection:** RTT readers reconnect correctly.

## 0.1.8 — 2026-11-03

### Fixed

- **RTT logs:** fixed the log stream issue.

## 0.1.7 — 2026-11-03

### Fixed

- **RTT:** fixes to the RTT reader setup and stream.
- **Board lock in the tree:** the lock/release button on a board works again (fixed in two passes).

### Changed

- **Clearer RTT errors:** OpenOCD and ST-Link failures (no target, no ST-Link, OpenOCD not running or in use, ST-Link already in use) are shown as readable messages.

## 0.1.6 — 2026-11-02

### Changed

- **Two reservations:** one HIL and one SIL resource can be held at the same time. Switching a resource releases only that kind; the switch dialog says which one stays.
- **Debug per reservation:** each debug session belongs to its own reservation, so Reattach and the debug context work for the right board.
- **SIL features:** the feature list for SIL resources was updated (GDB and port forwarding only).

## 0.1.5 — 2026-11-02

### Fixed

- **Boards tree actions:** place Add RTT reader and Add forwarded service on the session header, and show RTT/forwarded-service row actions as icon buttons.

## 0.1.4 — 2026-11-02

### Changed

- **Ports view actions:** move Add RTT reader and Add forwarded service to the resource session header as icon buttons. RTT and forwarded-service row actions use accessible icons for open, copy, configure/update, and remove.

## 0.1.2 — 2026-11-02

### Changed

- **Agent CLI managed by the extension:** automatically install the latest Agent into VS Code extension storage and upgrade it when required features are missing. A global Agent install is no longer needed; `thub.cliPath` remains an explicit override.

## 0.1.1 — 2026-11-02

### Added

- **SEGGER RTT logs:** configure a per-resource ST-Link memory search range and up-channel, then read the UTF-8 stream in a reconnecting VS Code terminal. RTT capture reserves that probe against concurrent GDB use.
- **Named Client services:** save any number of per-resource service names and Client ports, restore them on reconnect, edit or remove them, and open forwarded web pages in a VS Code webview.

### Changed

- **Windows workstation support:** invoke the Agent's `thub.cmd` through PowerShell with arguments passed separately, UTF-8 output, and process-tree cleanup. Install Node.js 24+ and the Agent CLI before using the extension.

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
