# thub for VS Code — instructions for Claude

A VS Code extension for working with remote boards in a **TestHub (thub)** lab:
reserve and release a board, flash firmware, debug it, use its serial ports,
watch its camera, switch its USB power and forward ports from its Client —
all without leaving the editor.

UI design (source of truth for layout, states and copy):
https://claude.ai/artifact/Dosa1wGfYUMpQDWfLLdbbH — artboards 1–7.

## Core principle: wrap the `thub` CLI, don't reimplement it

The extension is a thin UI over the Agent CLI
[`@andrian.yablonskyy/thub-agent`](https://github.com/andrianyablonskyy/thub-agent).
`thub` owns auth, the Coordinator API, reconnects and tunnelling. The extension:

1. runs one-shot commands with `--json` and parses the result;
2. keeps **one long-lived `thub connect` child process per reservation**;
3. attaches VS Code UI (tree view, terminals, debugger, webviews) to the local
   ports that `thub connect` opens.

Never call the Coordinator HTTP API directly unless the CLI has no equivalent,
and then put it behind the same `ThubCli` interface so it can be swapped out.

### Spawning `thub`

- Resolve the binary from `thub.cliPath`, else `PATH`. On activation run
  `thub --version`; if missing, offer `npm i -g @andrian.yablonskyy/thub-agent`.
- Credentials: URL from `thub.url`; the access key is stored **only** in
  `context.secrets` (`thub.key`), never in settings. Pass both as `THUB_URL` /
  `THUB_KEY` in the child's env.
- Always set `THUB_NO_SELF_UPDATE=1` for child processes.
- Use `child_process.spawn` with an argument array — never a shell string.
- Exit codes: `0` ok, `1` failed, `2` infra, `3` canceled, `4` usage/auth/connection,
  `5` still running (`status --json`), `130` detached. Code `4` → show
  "Sign in to thub" with a button that runs `thub.signIn`.

### CLI commands used

| Feature | Command |
| --- | --- |
| List boards | `thub resources` (poll every 15 s while the view is visible) |
| Who am I | `thub whoami` |
| Reserve / extend | `thub reserve <client> --for <dur>` (re-reserving extends from now; max set per runner, default 8h; needs a user key, not a CI token) |
| Release | `thub release <client>` |
| Session | `thub connect <client> --target <cfg> --uart-port 5001 --gdb-port 3333 --video-port 8090` |
| Power | `thub power on\|off\|reset <jobId> [--port n] [--delay s]` — see gaps |
| Jobs | `thub run … --json --detach`, `thub status <id> --json`, `thub jobs --mine --json` |

Pin ports with the `--*-port` flags (pick free ones first) rather than scraping
them from output.

## Architecture

```
src/
  extension.ts          activate(): wire everything, nothing else
  cli/ThubCli.ts        spawn wrapper, JSON parsing, exit-code mapping
  cli/types.ts          Resource, Reservation, Job, ConnectInfo
  session/Session.ts    one per reservation: connect process, port map,
                        terminals, video, forwards, expiry timer; Disposable
  session/SessionManager.ts  current session, events (onDidChange)
  views/BoardsTree.ts   TreeDataProvider: My session + Boards (+ Recent jobs)
  views/PortsView.ts    "THUB PORTS" panel (webview view)
  views/StatusBar.ts    countdown + link/UART/GDB indicators
  serial/SerialTerminal.ts   vscode.Pseudoterminal over net.Socket
  debug/ThubDebugProvider.ts DebugConfigurationProvider for type "thub"
  flash/Flasher.ts      GDB batch load (see Flashing)
  flash/FlashAfterBuild.ts   task-end listener (see below)
  video/VideoPanel.ts   camera tab + external player / browser
  power/Power.ts
  forward/Forwards.ts
test/                   unit (mocha) + integration (@vscode/test-electron)
```

- `"extensionKind": ["workspace"]` so `thub connect`, GDB and the toolchain run
  on the same host under Remote-SSH / WSL / containers. Open local URLs with
  `vscode.env.asExternalUri`.
- Every resource a session creates is registered on the `Session` and disposed
  on release, expiry, or `thub connect` exiting for good.
- `thub connect` exits → if the reservation is still valid, restart it with
  backoff (1, 2, 5, 10 s); UART terminals reconnect, an active debug session
  must reattach (notify, button "Reattach debugger").

## Features

### Reservation
Boards tree with states: idle, mine, connecting, reserved by someone, running a
job, offline (shape + label, never colour alone). Reserve via tree item or
`thub.reserve` quick pick: step 1 board (grouped Idle / Busy), step 2 duration
(30m, 2h, 4h, 8h, Custom), checkbox "Connect right away" (default on).
Notify at 10 min left (Extend 1h / Release now). On end, close everything.

### Flashing (OpenOCD via the GDB port)
`thub connect` forwards only the GDB server; each GDB connection starts its own
OpenOCD on the Client with `target/<target>.cfg`. Flash with a batch GDB run:

```
<gdbPath> -batch <image> -ex "target extended-remote 127.0.0.1:<gdbPort>" \
  -ex "monitor reset halt" -ex "load" [-ex "compare-sections"] \
  -ex "monitor reset run" | -ex "monitor reset halt"
```

- `gdbPath` from `thub.gdbPath` (default `arm-none-eabi-gdb`).
- Flash and debug can't run at once: if a debug session is active, flash from
  it with `load` + `monitor reset`, or ask to stop debugging first.
- Expose a task type `thub` (`{"type":"thub","action":"flash"}`) so it can be a
  `preLaunchTask` or part of a compound task.
- Progress: notification with cancel; on failure show the GDB output and offer
  "Power-cycle and retry".

### Flash after build
Flash the board automatically when a build succeeds. Design: artboard 7.

Setting `thub.flashAfterBuild` (workspace scope, object):

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Master switch. |
| `buildTask` | string | `""` | Task label to watch; `""` = any task in the `build` group. |
| `image` | string | `"${workspaceFolder}/build/${workspaceFolderBasename}.elf"` | ELF to flash. Supports `${workspaceFolder}`, `${env:X}`, `${config:x}`, `${command:x}` (e.g. `${command:cmake.launchTargetPath}`). |
| `skipUnchanged` | boolean | `true` | Skip if the image's SHA-256 equals the last one flashed to this board. |
| `board` | string | `"reserved"` | `"reserved"`, a Client name, or `"label:<l>"`. |
| `whenNoBoard` | `"ask" \| "reserve" \| "skip"` | `"ask"` | No matching reservation: ask, reserve a matching idle board (default 1h), or do nothing. |
| `target` | string | `""` | OpenOCD target passed to `connect --target`; `""` = the runner card's default. |
| `powerCycle` | boolean | `false` | `thub power reset` before flashing (requires power support, see gaps). |
| `verify` | boolean | `true` | Add `compare-sections`. |
| `then` | `"run" \| "halt" \| "debug"` | `"run"` | After load: reset and run, stay halted, or start a `thub` debug session. |
| `openSerial` | boolean | `false` | Focus/clear the UART 1 terminal after flashing. |

Implementation (`flash/FlashAfterBuild.ts`):
- Listen to `vscode.tasks.onDidEndTaskProcess`. Match `e.execution.task` by
  label (`buildTask`) or by `task.group === TaskGroup.Build`. Act only on
  `exitCode === 0`. Ignore tasks of type `thub` (no loops).
- Resolve variables (`${command:…}` via `vscode.commands.executeCommand`);
  missing image → error with "Open settings".
- Serialize: one flash at a time per board; a newer build cancels a queued one.
- Status bar item "Flash after build: on/off" toggles `enabled`.
- Settings editor: a webview tab `thub: Flash after build` (command
  `thub.configureFlashAfterBuild`) with sections When / Where / How, a live
  JSON preview and "Build and flash now"; it reads and writes the setting via
  `workspace.getConfiguration` — settings.json stays the source of truth.
- Command `thub.buildAndFlash`: run the configured build task, then flash.
- Record the last run (time, build duration, flash result) for the panel.

### Debug
`DebugConfigurationProvider` for type `thub`: ensure reserved + connected, then
return a Cortex-Debug config (`servertype: "external"`,
`gdbTarget: "127.0.0.1:<gdbPort>"`, `executable`, `svdFile` if set). Declare
`marus25.cortex-debug` in `extensionDependencies`. Add a "Power-cycle board"
action to the debug toolbar.

### Serial
`vscode.Pseudoterminal` over `net.connect(uartPort)`; name `thub: <client> UART n`.
Optional timestamps and log-to-file. Also show `socket://127.0.0.1:<port>` for
pyserial / socat.

### Video
Stream: `http://127.0.0.1:<videoPort>/<reservationId>/video.ts` (MPEG-TS), only
on runners labelled `video-stream`. Three modes (`thub.video.mode`):
- `editor` (default): local `ffmpeg` transcodes to MJPEG, webview shows `<img>`;
- `player`: spawn `thub.video.player` (mpv / ffplay / vlc) on the URL;
- `browser`: serve a local page using mpegts.js and open it externally.
Raw TS does not play in a webview `<video>`; don't try.

### Power (uhubctl on the Client)
Buttons: Power-cycle, On, Off; port and off-time pickers.

### Port forwarding / URL proxy
"THUB PORTS" panel lists UARTs, GDB, video and custom forwards with Open /
Copy / Stop actions, plus a form (name, host:port on the Client, local port).
HTTP forwards get "Open in browser" and "Preview" (Simple Browser).

## Known gaps in thub (do not fake them)

- **Power during a reservation:** `thub power` is keyed by a job id and works only
  for the owner's PREPARING/RUNNING job. Until the Coordinator supports
  `thub power <client>` for the reservation holder, disable power buttons
  outside a job, with a tooltip explaining why.
- **Custom port forwards:** `thub connect` has no `--forward`. Hide the forward
  form behind a capability check (`thub connect --help` mentions `--forward`).
- **Machine-readable connect output:** prefer `thub connect --json` (NDJSON
  events) when available; otherwise rely on pinned ports.

Feature-detect each via `thub --version` / `--help`, never by guessing.

## Visual language

Dark-first, follows the ADSYSTEM.PRO palette. Use VS Code theme colours
(`var(--vscode-*)`) in webviews and contribute these as theme colours so users
can override them:

| Token | Value | Use |
| --- | --- | --- |
| `thub.accent` | `#FFAE2B` | the one primary action per view, "mine" |
| `thub.onAccent` | `#13110A` | text on amber |
| `thub.idle` | `#6EA8FE` | idle boards |
| `thub.error` | `#F2665C` | failures, expiring < 10 min |
| `thub.ok` | `#9ED9B0` | link up, verified |

Rules: one amber button per view; states differ in shape and label as well as
colour; codicons in tree/status bar, 2px stroke icons in webviews; fonts follow
the editor (`--vscode-font-family`, `--vscode-editor-font-family`).

## Settings and commands (contributes)

Settings: `thub.url`, `thub.cliPath`, `thub.gdbPath`, `thub.defaultTarget`,
`thub.defaultDuration` (`"2h"`), `thub.ports.uart` (5001), `thub.ports.gdb`
(3333), `thub.ports.video` (8090), `thub.video.mode`, `thub.video.player`,
`thub.flashAfterBuild`.

Commands (`thub.*`): `signIn`, `refresh`, `reserve`, `extend`, `release`,
`connect`, `flash`, `buildAndFlash`, `configureFlashAfterBuild`,
`toggleFlashAfterBuild`, `debug`, `openSerial`, `openVideo`, `powerCycle`,
`powerOn`, `powerOff`, `forwardPort`, `copyEndpoint`.

## Development

- TypeScript (strict), esbuild bundle to `dist/extension.js`, Node 20+,
  `engines.vscode` `^1.90.0`. Scaffold with `yo code` conventions.
- `npm run lint`, `npm test` (mocha unit tests with a fake `ThubCli`;
  integration tests via `@vscode/test-electron`), `npm run package` (`vsce`).
- Unit-test the parsers, exit-code mapping, variable resolution and the
  flash-after-build matcher without spawning real processes.
- No secrets in logs: mask `THUB_KEY` in the output channel (`thub`).
- Keep `README.md` user-facing; keep this file for implementation rules.
