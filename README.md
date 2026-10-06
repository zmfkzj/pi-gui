# pi-gui

Give each Pi agent its own private GUI desktop. pi-gui is integration glue: it registers
[computer-use-mcp](https://github.com/mirsella/computer-use-mcp) with Pi's **built-in MCP** support and keeps every call on
a **private KDE Wayland session** that upstream starts, owns and tears down. It adds no MCP client, no desktop tools, no
session manager and no daemon.

```text
Pi session (main, or one orche worker)
└─ Pi built-in MCP (one stdio connection per session)
   └─ computer-use-mcp mcp            ← one process per session, started without the user's display/buses
      └─ background worker in upstream's private runner
         └─ private KDE Wayland session: D-Bus, KWin (--virtual), PipeWire, WirePlumber, AT-SPI, portals (+ EIS grant)
```

Each session that has the server owns one computer-use-mcp process, and that process owns one private desktop. The OS
process is the isolation boundary, so two agents never share a display, bus, compositor, portal grant, window or app:

```text
orche_task gui:true  → worker W1 session → MCP process 1 → private desktop 1
orche_task gui:true  → worker W2 session → MCP process 2 → private desktop 2
orche_task (no gui)  → worker W3 session → no MCP process, no desktop
```

## Who does what

| Responsibility | Owner |
| --- | --- |
| MCP protocol, stdio process, reconnect after a crash, stop on session shutdown (stdin close, SIGTERM, SIGKILL of the process group) | Pi built-in MCP |
| Private session lifecycle: private runtime dir, D-Bus, KWin, PipeWire, WirePlumber, AT-SPI, portals, RemoteDesktop grant, teardown | computer-use-mcp (embedded `run-isolated-session.sh`) |
| Screenshots, accessibility, click/type, app launch, waits | computer-use-mcp tools, used as they are |
| Worker sessions, their tool allowlist and their disposal | orche (`orche_task gui`) |
| Registering the server, keeping calls on the private desktop, prerequisite checks, `/gui`, the worker capability | pi-gui |

## Install

Desktop services (Debian/Ubuntu names; `/gui doctor` lists what is missing):

```sh
sudo apt install --no-install-recommends kwin-wayland kwin-common xdg-desktop-portal-kde \
  xdg-desktop-portal pipewire wireplumber at-spi2-core dbus-daemon dbus-bin libglib2.0-bin
```

`kwin-common` matters: it holds KWin's `screencast` and `eis` plugins, and `kwin-wayland` does not pull it in. Without
them every screenshot and input fails as "RemoteDesktop approval failed". The host desktop does not matter: private
desktops run their own `kwin_wayland --virtual`, also under GNOME or without a desktop at all.

The package (a git submodule of [oh-my-pi-extensions](https://github.com/zmfkzj/oh-my-pi-extensions), or alone):

```sh
pi install git:github.com/zmfkzj/pi-gui       # or: pi -e /path/to/pi-gui
```

The npm dependency `@mirsella/opencode-computer-use-mcp@0.6.0` brings the precompiled Linux x64 server (glibc ≥ 2.39), so
nothing is downloaded at run time. It is optional: other platforms install without it. Without it pi-gui uses
`computer-use-mcp` on PATH (`cargo install --locked --git https://github.com/mirsella/computer-use-mcp computer-use-mcp`),
then `npx -y @mirsella/opencode-computer-use-mcp@0.6.0`. Pi's own packages are peer dependencies and are not bundled.

Two distribution details are handled through the runner's documented program overrides (`COMPUTER_USE_MCP_*_BIN`), not by
changing upstream:

- Ubuntu installs the KDE portal backend in `/usr/lib/x86_64-linux-gnu/libexec`, which the runner does not search.
- On the private bus, D-Bus activation can start the KDE portal backend before the runner does (KWin's Qt platform
  registers with the portal at startup), and the runner's own start then fails with "portal_backend exited during
  startup". pi-gui starts it through `bin/xdg-desktop-portal-kde-replace` (`--replace`). A user's own override wins.

## Use

- **Main session:** the `computer-use` server is registered at session start when the prerequisites are present. The
  model sees `mcp__computer_use__help` and `mcp__computer_use__dispatch` (compact mode).
- **orche workers:** `orche_task { role, request, gui: true }`. pi-gui answers orche's `gui` capability request with the
  extensions for that worker's own session (Pi's MCP extension, limited to this server, plus pi-gui's routing hook), the
  tool names to allow (the six direct tools) and short instructions. Workers without `gui` get nothing: no MCP extension,
  no process.
- `/gui` or `/gui status`: enabled state, MCP connection, backend, tool mode, desktop policy, private session id, health.
- `/gui doctor`: the prerequisites with the packages to install, upstream `computer-use-mcp doctor` (host session), and a
  real private-desktop smoke test through upstream's `call` command (starts the private session, lists its windows,
  tears it down).

The status line shows `GUI: ready`, `GUI: ready · private session-…`, `GUI: starting`, `GUI: unavailable`, `GUI: error`
or `GUI: workers only`.

## Private desktop only (unless you opt in)

Upstream routes a call without a returned ID to the **foreground** desktop, the user's physical session, unless it says
`desktop: "background"`. pi-gui inverts that in two layers:

1. **Environment (hard boundary).** The server runs through `env -u WAYLAND_DISPLAY -u WAYLAND_SOCKET -u DISPLAY
   -u XAUTHORITY -u DBUS_SESSION_BUS_ADDRESS -u AT_SPI_BUS_ADDRESS -u PIPEWIRE_REMOTE -u PIPEWIRE_RUNTIME_DIR
   XDG_RUNTIME_DIR=/nonexistent/…`. Upstream's foreground route then has no display, session bus or accessibility bus to
   reach (it fails closed with "no Wayland display bound"); the private runner sets its own values for everything it
   starts.
2. **Routing hook (convenience).** A `tool_call` hook adds `desktop: "background"` where upstream accepts a selector
   (`list_desktop`, `launch_application`, a targetless `window_opened` wait; also inside compact `dispatch`), refuses an
   explicit `"foreground"` and the foreground-only `human_idle` wait with a reason the model can act on. Calls with IDs
   route by those IDs, which all come from the private desktop. MCP calls from codemode scripts pass the same hook.

`allowPhysicalDesktop: true` (user config only, main session only) skips the environment layer and lets the model pass
`desktop: "foreground"` explicitly; omitted selectors still go to the private desktop. Workers never get the physical
desktop.

Every MCP call goes through Pi's tool pipeline, so permission extensions see these tools with upstream's annotations.

**Next to a physical-desktop extension.** oh-my-pi-extensions also bundles
[@amaster.ai/pi-computer-use](https://www.npmjs.com/package/@amaster.ai/pi-computer-use), whose `computer_use_*` tools
control the user's own screen. pi-gui leaves it alone. While its server is registered, pi-gui adds a short system prompt
section saying which screen each tool reaches: `mcp__computer_use__*` is the agent's private desktop, which the user
does not see, and `computer_use_*` (mentioned only when such tools exist) is the user's screen, used only on explicit
request. orche workers load neither the physical-desktop extension nor this section; their instructions come with the
`gui` capability.

## Configuration

`~/.pi/agent/gui.config.json`, optionally overridden key by key by a trusted project's `.pi/gui.config.json` (which may not
set `allowPhysicalDesktop`, `command`, `args` or `env`). Unknown keys or wrong types reject the whole file with a warning.

```json
{
  "enabled": true,
  "mainSession": true,
  "command": null,
  "args": null,
  "mode": "compact",
  "workerMode": "direct",
  "exposure": "direct",
  "allowPhysicalDesktop": false,
  "timeoutSeconds": 150,
  "env": {}
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch for the main session and the worker capability. |
| `mainSession` | `true` | Register the server in ordinary sessions. `false`: workers only. |
| `command` | `null` | Server executable. `null`: bundled npm binary → `computer-use-mcp` on PATH → `npx`. With `npx` and no `args`, the pinned package is used. |
| `args` | `null` | Full arguments; must contain `mcp` (e.g. `["-y", "@mirsella/opencode-computer-use-mcp@0.6.0", "mcp"]`). `--compact-tools` is added in compact mode. |
| `mode` | `"compact"` | Main session tool surface. `compact`: `help` + `dispatch` (2 tools, ~0.9 KB of declarations). `direct`: the six operations (~13 KB). |
| `workerMode` | `"direct"` | Tool surface of GUI workers, which are spawned for GUI work. |
| `exposure` | `"direct"` | Pi exposure in the main session (`direct`, `deferred`, `codemode`). Workers always use `direct`. |
| `allowPhysicalDesktop` | `false` | See above. |
| `timeoutSeconds` | `150` | Pi's MCP request timeout. The first call of a session starts the private desktop (upstream allows 120 s). |
| `env` | `{}` | Extra server environment (e.g. `RUST_LOG`). Physical-session variables are still removed. |

Measured with Pi 1.0.2 and `cliproxyapi/claude-opus-5-5` (thinking low), one prompt each:

| Session | compact | direct | direct + `deferred` |
| --- | --- | --- | --- |
| No GUI use ("Reply OK"), input tokens per request | 3,895 | 8,840 | 3,997 |
| GUI task (launch editor, type, verify): requests / input tokens incl. cache | 11 / 95,695 | 7 / 80,511 | — |

Direct declarations cost ~4.9k tokens on every request of every session; compact costs ~0.3k but needs `help` round
trips when the GUI is used. Hence compact for the main session, where the GUI is occasional, and direct for GUI workers,
which exist to use it. `deferred` + `direct` costs nothing until `tool_search` loads the tools (not available in workers).

## Logs

`~/.pi/agent/gui.log` (rotated at 1 MiB): lifecycle lines only, e.g. `registered computer-use MCP`, `MCP connected`,
`background desktop ready (session-…)`, `MCP error: …`, `session shutdown`. Never tool input or output: no screenshots,
typed text, clipboard or accessibility text. Upstream keeps its own metadata-only call history
(`computer-use-mcp history`), and Pi logs MCP server notifications to `~/.pi/agent/mcp.log`.

## Known limitations

pi-gui:

- Pi's MCP extension does not publish connection state to other extensions. `/gui status` infers it from registered tools
  and the last results; `/mcp` shows the authoritative state.
- Each session with the server keeps one idle computer-use-mcp process (small); its private desktop starts on the first
  GUI call and lives until the session (or worker) ends.
- `/gui doctor`'s upstream `doctor` checks the host session; the private desktop is checked by the smoke test instead,
  because upstream ships its private-session runner only inside the binary.

Upstream (computer-use-mcp 0.6.0, see its README, MCP.md and SECURITY.md) and KWin, as seen on Ubuntu 26.04 / KWin 6.6:

- KDE Plasma Wayland only: needs `kwin_wayland`, KWin's screencast/EIS plugins and the KDE portal backend; no X11, cage or
  gamescope fallback; Linux x64 npm binary only (other architectures build from source).
- Windows are found through **AT-SPI only**: KWin does not give computer-use-mcp the restricted window protocols
  (`ext-foreign-toplevel-list-v1`, `org_kde_plasma_window_management`), so `window_opened` waits cannot match (list
  windows instead), and minimize/maximize/close and screenshot crops to a window are unavailable (full-monitor captures
  with exact coordinates instead).
- **GTK 4 apps are invisible**: the runner sets `GTK_A11Y=1`, which GTK 4 rejects, so they export no accessibility tree.
  Qt/KDE apps and GTK 3 apps work (the live tests use a small GTK 3 editor).
- Isolation is routing and process separation for cooperative same-user processes, **not a sandbox**: apps on a private
  desktop run as the user, with the user's files and network. Private desktops get private XDG config/data/state
  directories, but `$HOME` is shared (for example a browser profile under `~/.mozilla`).
- AT-SPI reads and semantic actions need no portal approval; a screenshot contains the whole (private) monitor.
- Capture uses CPU-readable PipeWire buffers only (no GPU DMA-BUF import); `changed_rect` is advisory; protected-surface
  detection is heuristic.
- `paste` uses the portal clipboard when granted and does not restore the previous clipboard.
- A private session has no persistence: windows, app state and the portal grant are gone when its process ends. After a
  crash Pi reconnects on the next call, which starts a fresh private desktop; old IDs are then stale.

## Development

```sh
npm install --legacy-peer-deps
npm run typecheck
npm test            # unit tests + real Pi sessions (faux model) with a fake computer-use-mcp
npm run test:gui    # live tests on real private desktops (needs the desktop services above)
```

`test:gui` drives real Pi sessions with a scripted model through Pi's MCP pipeline into real private desktops:

- A: one agent launches an editor, takes a screenshot, clicks, types and reads the text back.
- B: two agents act at the same time on separate desktops, and neither sees the other's window or text.
- E: no process of a server or a private desktop is connected to the user's display, session bus, accessibility bus,
  PipeWire or X11. The foreground route fails closed.
- C: ending one agent's session removes its server and desktop, and the other keeps working.
- D: a new session gets a new desktop.
- Cleanup: nothing outlives its session.

Screenshots go to `$TMPDIR/pi-gui-live/`.

## Viewing a private desktop yourself (`/gui view`)

Private desktops are invisible by design. When a worker is stuck at a step only you can do (OAuth sign-in, 2FA code,
CAPTCHA, consent screen), you can open its desktop over RDP, operate it, and hand it back.

```
/gui view [name]          start (or show again) a viewer; name = W1, W2, … or main; omitted = the only GUI worker
/gui view stop [name|all] stop it (omitted = the only running viewer)
/gui view list            desktops and running viewers
```

Procedure (worker stuck at a sign-in):

1. The worker ends its assignment reporting that user sign-in is needed (its instructions say so; it leaves the app on
   that screen). It is now idle: give it no assignment while you operate its desktop.
2. `/gui view W1` prints `127.0.0.1:<port>`, user `pi`, a one-time password and the certificate's SHA-256 fingerprint.
3. Connect with an RDP client that decodes H.264, e.g.
   `xfreerdp3 /v:127.0.0.1:<port> /u:pi /sec:tls /gfx:avc420 /cert:fingerprint:sha256:<hex>` (asks for the password), or
   Remmina (snap/Flatpak): RDP profile, server `127.0.0.1:<port>`, user `pi`, security TLS, check the fingerprint.
4. Sign in on the worker's desktop.
5. `/gui view stop W1`, then continue with `orche_task worker: "W1"`: same session, same desktop, same signed-in apps.
   orche retires an idle worker after 30 minutes (its desktop and viewer go with it), so finish within that time.

How it works: the server is KDE's `krdpserver` (krdp), started with the private session's own environment
(`XDG_RUNTIME_DIR=/tmp/computer-use-mcp-isolated-*`, `WAYLAND_DISPLAY=wayland-virtual-*`, its D-Bus, PipeWire and portal)
and without any physical-session variable. pi-gui finds that session through the server's process tree: every server gets
a random `PI_GUI_VIEW_TAG`, inherited by its private session; only descendants of this Pi process that carry the tag and
the runner's verified 0700 runtime directory (readiness marker, Wayland and bus sockets) count. krdp captures and injects
through the private session's xdg-desktop-portal RemoteDesktop, which the runner (and pi-gui, for krdp's app IDs)
pre-authorizes on the private bus only, so no consent dialog appears and the physical session's permissions are untouched.
The viewer carries the runner's isolation marker, so the runner's teardown stops it too; pi-gui stops it on
`/gui view stop`, when the worker's session ends (orche's idle retirement included), on main-session shutdown and on exit.
A second `/gui view` shows the running viewer again; if the worker's desktop was replaced, the viewer is restarted on the new one.

Why krdp: KWin offers no wlr screencopy/virtual-pointer protocols (wayvnc cannot work), krfb always listens on 0.0.0.0,
and gnome-remote-desktop needs Mutter. krdp listens on a chosen address and works through the portal.

Requirements: `sudo apt install krdp openssl` (or set `"viewerCommand"` in `~/.pi/agent/gui.config.json`, user config
only). Clients: krdp streams only H.264 (AVC420). Ubuntu's FreeRDP 3 packages are built without H.264
(`WITH_GFX_H264=OFF`), and so are the apt Remmina/KRDC that use them; use the snap/Flatpak Remmina, Flatpak
`com.freerdp.FreeRDP`, or another H.264-capable client. `/gui doctor` checks krdp, openssl and the clients it finds.

Security:
- Loopback only (`--address=127.0.0.1`), a free port picked per start, user `pi`, a random 20-character password per
  viewer (new on every start), TLS with a fresh self-signed certificate whose fingerprint is printed so you can pin it.
- The password is shown only in the `/gui view` output. It is never written to `gui.log` or any file (server output is
  redacted). krdp takes it as a command-line argument, so local processes can read it from the process list while the
  viewer runs: anyone with a shell on this machine could connect. Stop the viewer when you are done.
- The certificate and key live in a 0700 directory inside the private runtime directory and are deleted with the viewer.
- Whoever connects controls the worker's desktop, with your files and network. Do not share the connection details.
- While you operate the desktop the worker can still act on it if you give it an assignment; give it none until you stop.

