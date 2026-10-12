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
  tool names to allow (the six direct tools; without `act` for read-only roles) and short instructions. Workers without `gui` get nothing: no MCP extension,
  no process. This is also the way a worker browses the web interactively (rendered pages, tabs, clicks, forms,
  sign-in): see [Workers and web browsers](#workers-and-web-browsers).
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

## Workers and web browsers

Two boundaries apply to every worker desktop (`src/policy.ts`, `src/browsers.ts`). Both are enforced by the routing hook
before a call reaches the server, on the direct tools and inside compact `dispatch`.

**Role.** Workers of read-only roles (orche's explore, answer, verify, and any request without role information) get an
**observe-only** desktop: `list_desktop`, `launch_application`, `activate_window`, `observe`, `wait_for` (and `help`).
`act` (clicks, typing, paste, `set_value`) is left out of their tool allowlist. It is also refused by the hook if called
anyway, as is any other or unknown operation and a malformed `dispatch`. The refusal tells the worker to report that the
task needs `orche_task` with role `implement` and `gui: true`, and that public pages can be read with `browser_fetch`.
`gui: true` and `allowWorkerUserBrowserProfiles` do not lift this. Writing roles (implement, game-asset, video) get `act`.
The role is part of the capability key, so a reused worker whose role changes gets a fresh desktop. *Changed:* before
this, read-only roles had `act` and were only told not to change anything; a verify or answer task that must click
or type in a GUI app now needs a writing-role worker.

**Browser profiles.** A worker's private desktop has its own XDG config/data/state directories under the runner's
runtime directory, which the runner deletes when the desktop ends (`rm -rf` in upstream's `run-isolated-session.sh`).
`$HOME` is the user's, so a browser that keeps its profile under `$HOME` would open the user's own profile, cookies and
logins. Without the user's `allowWorkerUserBrowserProfiles`, the following applies:

- **Allowed:** Chromium-family browsers installed outside snap/Flatpak (Google Chrome, Debian/Fedora `chromium`, Edge,
  Brave, Vivaldi) whose launcher does not pin or move a profile. Their default profile is `$XDG_CONFIG_HOME/<name>`,
  i.e. inside the private desktop's config directory, so they start signed out and the profile goes with the desktop.
- **Allowed: the installed snap Chromium, only as `pi-gui-chromium-temp-profile.desktop`** (see
  [snap Chromium with a temporary profile](#snap-chromium-with-a-temporary-profile)): the snap's chrome inside the
  snap's confinement, with a profile pi-gui creates for each launch and removes afterwards, under a pi-gui supervisor.
  The snap's own entries (`chromium_chromium.desktop`, its actions, `chromium-browser.desktop`) stay refused, and the
  refusal points to pi-gui's entry.
- **Refused, with the reason:**
  - Browsers that would use the user's profile: snaps (`~/snap/<name>`, including Ubuntu's `/usr/bin/firefox` and
    `/usr/bin/chromium-browser` wrappers), Flatpaks (`~/.var/app`), Firefox and other browsers with profiles under `$HOME`.
  - Browser launchers that pin or move the profile (`--user-data-dir`, `--profile`, `-P`, or `HOME` / `XDG_*` /
    `CHROME_*` / `*PROFILE*` set in `Exec`), and browsers started through D-Bus.
  - Entries whose `Exec` runs a shell or interpreter command line (`sh -c …`, `python3 -c …`).
  - Terminals, KRunner, System Settings, `kcmshell`, `kmenuedit`, `xdg-open`, `kde-open`, `kioclient` and `gio`: they
    start programs by name or change default apps.
  - Entries without an `Exec` line, and IDs not found in the desktop's application directories (fail closed).
- **Links:** the worker server gets `XDG_CONFIG_DIRS` / `XDG_DATA_DIRS` entries (under
  `~/.pi/agent/pi-gui/worker-web/<hash>/`) and `BROWSER`. These make the desktop's default handler for http(s) and HTML
  the allowed browser (a non-snap one first, else pi-gui's snap Chromium entry, whose program and `$BROWSER` are the
  same shim to the supervisor), or a no-op entry (`pi-gui-no-browser.desktop`) when there is none, and remove every
  other browser from those associations. So a link that an app opens through GIO, `xdg-open`/`xdg-mime` or `$BROWSER`
  does not start the system default (e.g. snap Firefox or the snap's own Chromium entry). The user's own settings are
  not changed.
- The worker's instructions name the allowed browser entries, or say that there is none and that one must be installed
  (on Ubuntu, for example Google Chrome's `.deb`). `/gui status` shows the same (`Worker browsers …`).
- **Sign-in** stays with the user: the worker leaves the sign-in screen open and reports it; the user signs in through
  `/gui view` on that worker's desktop and reuses the worker.
- `allowWorkerUserBrowserProfiles: true` (user config only) lifts the browser, launcher and link checks for workers; their
  instructions then say that a browser may be signed in as the user. The role boundary stays.

**What this is not.** It is not an OS sandbox. Apps on the private desktop run as the user, with the user's files and
network. The checks cover the explicit launch path and the desktop's link defaults. They do not cover:
- a program that an allowed app starts by itself, through its own means (a wrapper script that starts another
  browser, an app's "open with" dialog, an IDE's built-in terminal);
- non-browser apps that keep their own profile under `$HOME` (for example a mail client);
- KDE components that ignore `XDG_CONFIG_DIRS`.
A worker's bash tool runs on the host regardless. GIO and `xdg-mime` resolution of the pinned defaults is tested
(`test/browsers.test.ts`), and the private session's processes were seen to inherit them. KIO's resolution was not
verified on a live desktop; a full snap Chromium run on a worker desktop is (`npm run test:snap-chromium`).

### snap Chromium with a temporary profile

Ubuntu's Chromium is a snap. Started normally it always opens the user's profile: snapd sets
`CHROME_CONFIG_HOME=$SNAP_USER_COMMON` (`snap.yaml`), and Chromium's default profile is `$CHROME_CONFIG_HOME/chromium`
(`~/snap/chromium/common/chromium`); while the user's Chromium runs, a second start only hands its URL to the user's
window. The snap's launcher has `--temp-profile` (`mktemp -d`, passed as `--user-data-dir`), but it is **not used**: when
`mktemp` fails the launcher passes an empty `--user-data-dir=` and Chromium opens the default profile, the user's; and
Chromium itself replaces any `--user-data-dir` it cannot create with the default profile
(`chrome/app/chrome_main_delegate.cc`, `InitializeUserDataDir`). Instead:

- **The default profile itself is moved.** pi-gui runs `snap run --shell chromium -c <script>`: the app's confinement
  (AppArmor label, mount namespace) and command chain (`gpu-2404-wrapper`, `desktop-launch`), but pi-gui's fixed script
  (`inSnapScript` in `bin/pi-gui-snap-chromium.mjs`) instead of the launcher. The script checks, inside the confinement,
  the snap revision pi-gui verified (`$SNAP_REVISION`), and that the launch directory pi-gui created
  (exactly `/run/user/<uid>/snap.chromium/pi-gui-launch-*` of this uid, every subdirectory a real directory of this
  user, canonical, the profile directory empty, the profile, home, cache and temporary directories writable: a new file
  is created with noclobber and removed in each). The environment's shell start-up hooks (`BASH_ENV`, `ENV`,
  `SHELLOPTS`, exported functions) are removed before the snap runs. Any failure exits with 97 **before Chromium is started**. Then it sets `CHROME_CONFIG_HOME=<launch>/config`,
  `HOME`, `XDG_CACHE_HOME`, `TMPDIR` and `BREAKPAD_DUMP_LOCATION` into the launch, unsets `CHROME_USER_DATA_DIR` and
  `CHROMIUM_FLAGS`, and execs the snap's chrome with `--user-data-dir=<launch>/config/chromium`. Chromium's default
  profile is then that same directory: no fallback of Chromium's leads to the user's profile; if the directory vanished
  after the check and could not be created again, Chromium has no profile and exits. That `CHROME_CONFIG_HOME` decides
  the default profile is how the snap itself places the user's profile. The NSS certificate store (`$HOME/.pki`), the disk
  cache, the singleton socket and temporary files are in the launch as well; the snap's private `/tmp` is not used.
- **Before anything starts:** the launch directory is created (0700, every subdirectory checked) or the launch is
  refused, and the user's runtime tmpfs must have 512 MiB and 10,000 inodes free (the cache is limited to 256 MiB).
- **Offered** (`/gui status`: `Worker browsers …`) when `/usr/bin/snap`, `/snap/bin/chromium` and `systemd-run` exist,
  the revision `current` points to has the snap's chrome, its command chain is one pi-gui verified (sha256 over the app's
  `command-chain` list and every script in `snap/command-chain`, `VERIFIED_CHAINS`; a refreshed snap with a changed chain
  is refused until it is checked again), and no Chromium policy (`/var/snap/chromium/current/policies`,
  `/etc/chromium-browser/policies`, `/etc/chromium/policies`) sets `UserDataDir` or `DiskCacheDir`; a policy directory that exists but cannot be
  read is refused too. The chain sources scripts of the content snaps (`gnome-platform`, `gpu-2404`), which refresh on
  their own and are not pinned; they run before pi-gui's script, which sets the profile last. The launcher, its
  pre-start profile migration and `~/.chromium-browser.init` do not run at all. Nothing under the user's home is read.
  The entry's program must be a path without characters that need quoting (xdg-mime skips a quoted one and would fall
  back to the system default).
- **Where the desktop runs.** A strict snap reaches neither the private desktop's `/tmp` (it has its own) nor sockets
  bound outside the paths its AppArmor profile allows (it mediates a socket by the path it was bound at, so a link
  elsewhere does not help); the snap's runtime dir `/run/user/<uid>/snap.chromium` is allowed. So when the browser is
  offered, the worker's server gets `TMPDIR=/run/user/<uid>/snap.chromium/pi-gui` and the runner's **whole** private
  runtime dir is created there: the Wayland, session-bus, AT-SPI and PipeWire sockets, the desktop's
  `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME`/`KDEHOME`, and the temporary files of the desktop's apps (which inherit
  that `TMPDIR`, on the size-limited `/run/user` tmpfs). Each browser launch's profile is next to it
  (`pi-gui-launch-*`). **Trade-off:** the snap's AppArmor profile lets every process confined as
  `snap.chromium.chromium` read and write there, including the user's own Chromium. A compromised Chromium browser
  process (a sandbox escape) could therefore read a worker browser's profile or tamper with a worker desktop, e.g. plant
  an application entry or a `mimeapps.list` in that desktop's own data/config dirs, which come first in its lookup, and so
  run a program outside the snap's confinement on the worker desktop. Without the snap offered, worker desktops stay in
  `/tmp` as before.
- **Launch** (`bin/pi-gui-snap-chromium.mjs`, started by the entry, inside the private desktop): it checks that it runs on
  such a private desktop (runner marker, 0700 runtime dir of this user inside that directory, sockets inside it), then
  starts a detached supervisor without the runner's marker and exits. The supervisor runs
  `systemd-run --user --scope --unit=snap.chromium.chromium-<uuid>.scope -- /usr/bin/snap run --shell chromium -c <script> …`
  (`snap run` would create that scope over the session bus, which is not the user's here; the scope is created through
  the user's systemd directly) with: `WAYLAND_DISPLAY` and `AT_SPI_BUS_ADDRESS` as absolute paths of the private
  desktop's sockets (a relative or missing name would resolve to the snap's link to the physical `wayland-0`), no
  `DISPLAY`/`XAUTHORITY`, no session bus (Chromium aborts when its bus disconnects; accessibility is turned on with
  `ACCESSIBILITY_ENABLED=1` and `--force-renderer-accessibility`), no sound or capture devices
  (`--disable-audio-output`, `--disable-audio-input`, `--use-fake-device-for-media-stream`: the snap's `desktop-launch`
  sets `PULSE_SERVER` to the user's sound server whatever is given, and its plugs reach cameras), `--password-store=basic`.
  URLs from links come after `--`; an argument that is not a URL is refused.
- **Checks while it runs** (defense in depth; the script already decided): the browser must be a process of that scope,
  run by the verified revision, with exactly `--user-data-dir=<launch>/config/chromium`; otherwise it is killed.
- **Ownership and cleanup.** The launch's processes are the scope's; its files are its launch directory, with the record
  `owner.json` (supervisor, browser PID and start time, scope). When the browser closes, when the private desktop ends
  (the supervisor sees the runner's marker or socket disappear and sends the browser TERM), or when the supervisor gets
  TERM/INT/HUP, the browser stops gracefully, then the rest of the scope (KILL after 10 s), and the launch directory is
  removed (directories inside are made accessible first; links are removed, not followed). If the supervisor is killed
  too, the directory stays and the next launch removes it once its supervisor and scope are gone (only
  `pi-gui-launch-*` directories of this user).
- **Shared with the user's Chromium, by the snap's design** (not tabs, cookies, logins or other profile content): the
  snap's per-user files that the command chain's `desktop-launch` maintains on every start of the app
  (`~/snap/chromium/<rev>/.config` GTK, fontconfig, `dconf` and `mimeapps` links, `~/snap/chromium/common/.cache` font and
  icon caches), the snap's runtime dir, AppArmor label and mount namespace, and a systemd scope in the user's manager.
  The snap's `daemon` (kiosk) setting is not used (the launcher does not run).
- **Not covered:** a SIGKILL of the supervisor and its whole scope with no later launch leaves that launch's directory
  (the worker's own session data) in `/run/user/<uid>/snap.chromium` until the next launch or logout. Removable media
  are reachable through the snap's plugs, as for any app on the desktop. A process of the same user that already
  reaches the user's profile (including the user's own snap Chromium, which shares the AppArmor label over
  `/run/user/<uid>/snap.chromium`) could replace the launch's `config` with a link after the in-snap check and before
  Chromium starts; that is deliberate tampering by something with that access already, not a fallback of pi-gui's.
  KIO's link handling was not checked on a live desktop.

## Configuration

`~/.pi/agent/gui.config.json`, optionally overridden key by key by a trusted project's `.pi/gui.config.json` (which may not
set `allowPhysicalDesktop`, `allowWorkerUserBrowserProfiles`, `command`, `args` or `env`). Unknown keys or wrong types reject the whole file with a warning.

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
  "allowWorkerUserBrowserProfiles": false,
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
| `allowWorkerUserBrowserProfiles` | `false` | Workers may also launch browsers that use the user's own profile. See [Workers and web browsers](#workers-and-web-browsers). |
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
  directories, but `$HOME` is shared (for example a browser profile under `~/.mozilla`); worker desktops therefore open
  only browsers with a disposable profile ([Workers and web browsers](#workers-and-web-browsers)).
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
npm run test:snap-chromium  # live: the chromium snap on a worker desktop next to the user's running Chromium
```

`test:gui` drives real Pi sessions with a scripted model through Pi's MCP pipeline into real private desktops:

- A: one agent launches an editor, takes a screenshot, clicks, types and reads the text back.
- B: two agents act at the same time on separate desktops, and neither sees the other's window or text.
- E: no process of a server or a private desktop is connected to the user's display, session bus, accessibility bus,
  PipeWire or X11. The foreground route fails closed.
- C: ending one agent's session removes its server and desktop, and the other keeps working.
- D: a new session gets a new desktop.
- Cleanup: nothing outlives its session.

`test:snap-chromium` (outputs and screenshots in `$PI_GUI_LIVE_OUT`, default `./.pi-gui-live`) runs one worker (role
implement) through the real capability: S1 launches `pi-gui-chromium-temp-profile.desktop` (the snap's own entry is
refused), opens https://example.com and follows its link, and checks that the browser's only `--user-data-dir` is the
profile pi-gui created for the launch (and its singleton socket is in the launch too), that no process of its scope is
connected to the physical session's Wayland, buses, PipeWire/PulseAudio or X11 or holds a file of
`~/snap/chromium/common/chromium`, that crash databases are the launch's own, and that the user's Chromium keeps its
PID, start time and profile lock. S2 closes the window (Ctrl+Shift+W); S4 SIGKILLs the supervisor and the scope, and the
next launch removes the left launch directory; S3 ends the worker session (the desktop). After each: no process of the
scope and no launch directory left. The fail-closed start (no browser start at all when the launch's profile cannot be
created or kept, never the user's profile) is covered by `test/snap-chromium.test.ts`, including the script inside the
real snap's confinement.

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
   Remmina (snap/Flatpak): RDP profile, server `127.0.0.1:<port>`, user `pi`, Advanced > Security protocol negotiation
   "TLS protocol security", check the fingerprint. Not "Automatic" (NLA): krdp started with `--username/--password`
   has no NTLM account database, so NLA logins always fail (client log: `ERRCONNECT_LOGON_FAILURE`) and the password
   prompt comes back.
   Two different failures: the password prompt coming straight back is the NLA problem above (fix the security setting);
   signing in that then drops at once or shows no picture can mean the client cannot decode H.264 (see Clients below).
   A dark screen alone does not prove a codec problem: the worker's desktop may simply be dark or idle.
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
only).

Clients: krdp streams only H.264 (AVC420) over the RDP graphics pipeline and drops clients that cannot decode it
(krdp's own message: "Client does not support H.264 in YUV420 mode!"). What matters is the client's FreeRDP build
(`WITH_GFX_H264=ON` plus an H.264 decoder such as FFmpeg's libavcodec or OpenH264), not the Remmina version, and it
differs per distribution, release and packaging, so check the build you have:

- FreeRDP command-line clients: `xfreerdp3 /buildconfig | grep -o 'WITH_GFX_H264=[A-Z]*'`; `/gui doctor` runs this for
  the `xfreerdp3`/`sdl-freerdp3`/`wlfreerdp3` it finds. For Remmina/KRDC it only reports whether a snap, apt or Flatpak
  build is installed, not whether it decodes H.264.
- apt Remmina/KRDC use the system `libfreerdp3`. Observed on Ubuntu 26.04 (Remmina 1.4.43, `libfreerdp3-3`
  3.32.1+dfsg-0ubuntu0.26.04.1): `WITH_GFX_H264=OFF`, `WITH_FFMPEG=OFF` (Ubuntu builds FreeRDP without FFmpeg, see
  `/usr/share/doc/libfreerdp3-3/changelog.Debian.gz`). With TLS set it got past sign-in and krdp then logged it off
  during the capability exchange (`ERRINFO_LOGOFF_BY_USER`), consistent with the missing H.264. Other distributions or
  releases may differ.
- Remmina snap ([Snap Store](https://snapcraft.io/remmina), published by Remmina upstream) bundles its own FreeRDP.
  Observed in `latest/stable` v1.4.43 (rev 7392): FreeRDP 3.14.1 with `WITH_GFX_H264=ON`, `WITH_FFMPEG=on`, linked to
  a bundled `libavcodec.so.58`. Check the installed revision with
  `strings /snap/remmina/current/usr/lib/libfreerdp3.so.3 | grep -o 'WITH_GFX_H264=[A-Z]*'`.
  On the same machine the snap session stayed connected to krdp where the apt build was logged off; the picture
  itself was not checked here, and other revisions or channels may be built differently.
  Install ([Remmina install guide](https://remmina.org/how-to-install-remmina/#snap)): `sudo snap install remmina`.
  If the apt Remmina is installed too, both are called `remmina`: start the snap explicitly with `snap run remmina`
  (or `/snap/bin/remmina`, menu entry `remmina_remmina.desktop`); `which -a remmina` shows which one comes first.
  The snap keeps its own profiles and certificates under `~/snap/remmina/`, so apt profiles are not visible there.
  The guide's `sudo snap connect remmina:...` commands enable optional features (password storage via
  `password-manager-service`, audio, printing, mounts, server discovery); none of them is about H.264 decoding.
- Remmina Flatpak: the same install guide says to install `org.freedesktop.Platform.openh264` before
  `org.remmina.Remmina` if you need H.264. Flatpak `com.freerdp.FreeRDP` or any other client whose FreeRDP has H.264
  may also work; neither was checked here.

`/gui doctor` checks krdp, openssl and lists the clients it finds.

Security:
- Loopback only (`--address=127.0.0.1`), a free port picked per start, user `pi`, a random 20-character password per
  viewer (new on every start), TLS with a fresh self-signed certificate whose fingerprint is printed so you can pin it.
- The password is shown only in the `/gui view` output. It is never written to `gui.log` or any file (server output is
  redacted). krdp takes it as a command-line argument, so local processes can read it from the process list while the
  viewer runs: anyone with a shell on this machine could connect. Stop the viewer when you are done.
- The certificate and key live in a 0700 directory inside the private runtime directory and are deleted with the viewer.
- Whoever connects controls the worker's desktop, with your files and network. Do not share the connection details.
- While you operate the desktop the worker can still act on it if you give it an assignment; give it none until you stop.

