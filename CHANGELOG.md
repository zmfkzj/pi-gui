# Changelog

## [Unreleased]

### Fixed

- An agent `act` paste while `/gui view` ran on the same desktop could freeze it for good: upstream pastes through the KDE portal's Clipboard, krdp reads every new selection at once for its RDP client, and xdg-desktop-portal-kde 6.6 then deadlocks. Every later call failed with "AT-SPI application discovery timed out" (screenshot-only `observe` and keyboard `act` too) and the viewer stopped taking input; only replacing the desktop (losing its apps and sign-ins) ended it. While a viewer runs, the routing hook now sends the paste as one keyboard `type` event (upstream's own non-clipboard path), on the direct tools and inside `dispatch`; text over 4,096 characters is refused before anything is sent. Live check: `npm run test:paste-view`.

### Changed

- `workerMcpExtension()` returns one process-wide factory object (`Symbol.for("pi.orche.worker-mcp-extension")`), shared with pi-codegraph: orche merges capability factories by identity, so a GUI worker that also gets CodeGraph tools loads one MCP extension, not two that would each start the computer-use server.
- Worker desktops open web browsers only with a disposable profile (Chromium-family outside snap/Flatpak). Refused, with the reason: other browser entries, profile-moving or shell/interpreter launchers, terminals and other program launchers, and unknown IDs. The desktop's default web handler is pinned to the allowed browser or a no-op (`XDG_CONFIG_DIRS`/`XDG_DATA_DIRS`/`BROWSER`). All of this is lifted only by the user's `allowWorkerUserBrowserProfiles`. `/gui status` lists the worker browsers.
- Worker desktops can run the installed snap Chromium, only through pi-gui's entry `pi-gui-chromium-temp-profile.desktop` (launches, link handler and `$BROWSER`), supervised by `bin/pi-gui-snap-chromium.mjs`. It does not use the snap launcher's `--temp-profile` (an empty `--user-data-dir` after a failed `mktemp`, and Chromium's own fallback for an uncreatable directory, both open the user's default profile): `snap run --shell chromium` runs a fixed pi-gui script inside the snap's confinement that checks the verified revision and the launch directory pi-gui created, refuses (exit 97) before Chromium starts on any failure, then moves Chromium's default profile itself (`CHROME_CONFIG_HOME`), `HOME`, cache and `TMPDIR` into the launch and execs the snap's chrome with `--user-data-dir=<launch>/config/chromium`. Offered only with a verified command chain and no profile-moving policy; worker desktops then run under `/run/user/<uid>/snap.chromium/pi-gui` so the snap can reach their sockets; no physical-session route, no session bus, no sound route; the launch's processes are a systemd scope of its own, and its launch directory (profile included) is removed on close, on desktop end, on supervisor TERM, and by the next launch after a SIGKILL. The snap's own entries stay refused. Live test: `npm run test:snap-chromium`.
- **Changed:** read-only orche roles (explore, answer, verify, or no role given) get an observe-only desktop. `act` is not in their tool list and is refused by the routing hook, direct and inside `dispatch` (malformed dispatch fails closed). GUI tasks that need clicks or typing need a writing-role worker (`orche_task` role implement, `gui: true`).

- Add /gui view to open a worker's private desktop over loopback RDP (krdp) for sign-ins and 2FA.

- The system prompt now says which desktop each computer-use tool controls: the agent's private desktop or the user's physical screen.

- /gui view connection help now tells Remmina users to pick "TLS protocol security" instead of NLA and to start the snap build with `snap run remmina`; the README explains how to check a client's H.264 support.

