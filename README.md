# thub for VS Code

Work on the boards in your **TestHub** lab without leaving the editor: reserve a board, flash and debug it over SWD, use its serial ports, and watch its camera.

![Workbench](docs/design/png/Main.png)

## What you need

- **The thub CLI** (the TestHub Agent) 1.1.24 or newer: `npm i -g @andrian.yablonskyy/thub-agent`. The extension runs it for everything, and offers to install it if it's missing.
- **An access key** for your Coordinator, from your dashboard profile or an admin.
- **An ARM GDB** for flashing and debugging: `arm-none-eabi-gdb` (macOS: `brew install --cask gcc-arm-embedded`), or `gdb-multiarch` (set **thub.gdbPath**).
- **[Cortex-Debug](https://marketplace.visualstudio.com/items?itemName=marus25.cortex-debug)** is installed with the extension; the `thub` debug type hands over to it.
- Optional: **ffmpeg** to show a board's camera in an editor tab. **mpv**, **ffplay** or **vlc** can play it instead, or your browser can.

## Getting started

1. Run **thub: Sign in**, then enter your Coordinator's address and your access key. The key is kept in VS Code's secret storage.
2. Open the **thub** view in the activity bar. You see **My session**, **Boards** and **Recent jobs**.
3. Click an idle board, or run **thub: Reserve board…**. Pick the board, then how long (30m, 2h, 4h, 8h or your own). Leave **Connect right away** on.
4. Once it's connected, **My session** lists its UARTs, its GDB port and its camera, with **Flash**, **Debug** and **Release board**.

While you hold the board, only your jobs run on it. Ten minutes before the reservation ends, you're offered **Extend 1h** or **Release now**. When it ends, its terminals, camera and debug session close.

## Flash

**thub: Flash** loads your ELF onto the board with GDB's `load`. The ELF is `thub.flashAfterBuild.image`, by default `${workspaceFolder}/build/${workspaceFolderBasename}.elf`.

- Each GDB connection starts its own OpenOCD on the board's Client. The OpenOCD target is **thub.defaultTarget**, or else the probe's target set on the runner card (e.g. `stm32l4x`: the script's name, not the chip's).
- The image is verified with `compare-sections`, then the board is reset and run.
- As a task, use `{"type": "thub", "action": "flash"}`, for example as a `preLaunchTask`.

### Flash after build

Run **thub: Flash after build…** to have a successful build flash the board.
- **When:** choose the build task, the firmware image, and whether to skip an image that hasn't changed.
- **Where:** your reserved board, a named one, or one with a label. You also choose what happens when none is reserved.
- **How:** verify, then reset and run, halt, or start debugging.

The status bar's **Flash after build: on/off** switches it. **thub: Build and flash** does both once.

## Debug

Press F5 with no launch configuration, or add one:

```json
{
  "type": "thub",
  "request": "launch",
  "name": "thub: Debug on reserved board",
  "executable": "${workspaceFolder}/build/${workspaceFolderBasename}.elf",
  "flash": true,
  "runToEntryPoint": "main"
}
```

The extension makes sure the board is reserved and connected, then starts Cortex-Debug against its GDB port. Add `"svdFile"` (or set **thub.debug.svdFile**) to see the chip's peripherals. If the link drops, serial terminals carry on, and you're offered **Reattach debugger**.

## Serial

**thub: Open serial terminal** opens a UART as a terminal, with timestamps (**thub.serial.timestamps**). To log everything a terminal receives to a file, set **thub.serial.logDirectory**.

The same port is a plain TCP socket, `127.0.0.1:5001` and up. Other tools can use it too, for example pyserial's `socket://127.0.0.1:5001`.

## Camera

On a board whose runner has a camera (label `video-stream`), **thub: Open camera** shows it. **thub.video.mode** chooses where:

- **In editor:** a local ffmpeg turns the stream into JPEG frames.
- **External player:** **thub.video.player** (mpv, ffplay or vlc).
- **Browser:** a local page plays it.

The stream's address is unique to your reservation and stops when the reservation ends.

## Ports

The **thub Ports** panel lists every local port of your session (UARTs, GDB, camera) with Open, Debug, Flash and Copy actions.

## Not available yet

These depend on thub features that don't exist yet. The extension says so instead of pretending:

- **USB power during a reservation.** Power-cycle, On and Off work only while a job of yours runs on the board, because `thub power` is keyed by a job.
- **Custom port forwards** (a host:port on the board's Client). They need `thub connect --forward`.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `thub.url` | | Your Coordinator. |
| `thub.cliPath` | `thub` on PATH | The thub CLI. |
| `thub.gdbPath` | `arm-none-eabi-gdb` | GDB for flashing and debugging. |
| `thub.defaultTarget` | | OpenOCD target script, e.g. `stm32l4x`. |
| `thub.defaultDuration` | `2h` | Preselected reservation length. |
| `thub.ports.uart` / `.gdb` / `.video` | 5001 / 3333 / 8090 | Local ports; the next free ones if taken. |
| `thub.video.mode` / `.player` / `.ffmpegPath` | `editor` / `mpv` / `ffmpeg` | Where the camera opens. |
| `thub.serial.timestamps` / `.logDirectory` | on / off | Serial terminals. |
| `thub.debug.svdFile` | | The chip's SVD for Cortex-Debug. |
| `thub.flashAfterBuild` | off | See Flash after build. |

Under Remote-SSH, WSL or a dev container, the extension runs where your workspace is. That way `thub`, GDB and your toolchain are all on the same machine.
