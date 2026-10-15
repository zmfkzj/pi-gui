// pi-gui: the snap Chromium of this machine, with a profile of pi-gui's own, on a worker's private desktop.
//
// Why it runs like this (see README "snap Chromium with a temporary profile"):
// - Started normally the snap opens the user's profile: snapd sets CHROME_CONFIG_HOME=$SNAP_USER_COMMON, and Chromium's
//   default profile is $CHROME_CONFIG_HOME/chromium (~/snap/chromium/common/chromium). The snap launcher's own
//   `--temp-profile` (chromium.launcher: `TEMP_PROFILE=$(mktemp -d)`, then `--user-data-dir=$TEMP_PROFILE`) falls back to
//   that profile when mktemp fails (an empty --user-data-dir), and so does Chromium itself whenever the directory given
//   with --user-data-dir cannot be created (chrome_main_delegate.cc InitializeUserDataDir: an invalid directory is
//   replaced by the default one). While the user's Chromium runs, opening the default profile also hands the URL to the
//   user's window on the user's screen. So pi-gui does not use the launcher:
// - It runs `snap run --shell chromium -c <IN_SNAP_SCRIPT>`: the same confinement and command chain as the app (snapd
//   environment, desktop-launch), but instead of the launcher, a fixed script of pi-gui's. The script checks, inside the
//   confinement, that the launch directory pi-gui made is usable, then sets CHROME_CONFIG_HOME, HOME, XDG_CACHE_HOME and
//   TMPDIR into it and execs the snap's chrome with --user-data-dir=<it>/config/chromium. Chromium's default profile is
//   then <it>/config/chromium too: no fallback of Chromium's leads to the user's profile, and a failed check means
//   Chromium is not started at all.
// - A strict snap sees neither the private desktop's /tmp (snap-private /tmp) nor sockets bound outside the paths its
//   AppArmor profile allows (it mediates a socket by the path it was bound at). Its own runtime dir
//   /run/user/<uid>/snap.chromium is allowed and shared with the host, so pi-gui starts worker desktops inside it
//   (the runner's TMPDIR=/run/user/<uid>/snap.chromium/pi-gui) when this browser is offered, keeps each launch's profile
//   in /run/user/<uid>/snap.chromium/pi-gui-launch-*, and gives the browser the private desktop's Wayland and
//   accessibility-bus sockets by absolute path. Nothing falls back to the physical session: no DISPLAY, no wayland-0, no
//   physical bus; no audio or capture devices (--disable-audio-*).
// - computer-use-mcp's runner stops every process carrying its isolation marker with TERM and, 0.1 s later, KILL. The
//   browser runs without the marker under this supervisor, which stops it when the private desktop ends and removes
//   the launch directory (profile included). Signals go only to the processes of the launch's own systemd scope.
// - Agent profile (opt-in, the user's gui.config.json `workerBrowserProfile`; PROFILE_ENV names it): the same launch,
//   but Chromium's profile is the persistent `$SNAP_USER_COMMON/pi-gui-profiles/<name>/chromium` (next to, never inside,
//   the user's own `$SNAP_USER_COMMON/chromium`). The launch directory still holds everything else and is removed as
//   above; the profile stays. One browser per profile: the supervisor holds an abstract socket named after the profile
//   for its whole life (the kernel releases it when the supervisor dies), so a launch on another desktop is refused
//   instead of Chromium handing it to the browser already running on the first desktop.
//
// Stages: the desktop entry runs this file (stage "launch", inside the private desktop, marked); it checks everything,
// then starts itself detached without the marker (stage "supervise") and exits.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync,
  statfsSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SNAP_BIN = "/snap/bin/chromium";
export const SNAP_COMMAND = "/usr/bin/snap";
export const SNAP_ROOT = "/snap/chromium/current";
export const SYSTEMD_RUN = "/usr/bin/systemd-run";
/** The browser program inside the snap (any revision): `/snap/chromium/<rev>/usr/lib/chromium-browser/chrome`. */
export const BROWSER_PROGRAM = /^\/snap\/chromium\/[^/]+\/usr\/lib\/chromium-browser\/chrome$/;
export const LAUNCH_PREFIX = "pi-gui-launch-";
export const STAGE_ENV = "PI_GUI_SNAP_CHROMIUM_STAGE";
export const MARKER_ENV = "PI_GUI_SNAP_CHROMIUM_MARKER";
export const LOG_ENV = "PI_GUI_SNAP_CHROMIUM_LOG";
/** The agent profile a launch uses (unset or empty: a temporary profile). */
export const PROFILE_ENV = "PI_GUI_SNAP_CHROMIUM_PROFILE";
const VIEW_TAG_ENV = "PI_GUI_VIEW_TAG";
const RUNNER_MARKER = "COMPUTER_USE_MCP_ISOLATION_MARKER";
/** The script's exit code when it refuses to start Chromium. */
export const REFUSED_EXIT = 97;
/** Subdirectories of a launch directory; the profile is `config/chromium`. */
export const LAUNCH_SUBDIRS = ["config", "config/chromium", "home", "cache", "tmp", "crash"];
export const profileOf = dir => join(dir, "config", "chromium");

/**
 * sha256 of the chromium app's command chain (meta/snap.yaml `apps.chromium.command-chain` and each script's content)
 * that was read and verified: it runs before pi-gui's script inside the confinement and does not touch a profile
 * (chromium snap revisions 3548 and 3554, 155.0.8059.39). A different chain is refused until it is verified again.
 */
export const VERIFIED_CHAINS = new Set(["d1d5d9a8cda1f912d212e72207a98ebfbf0613b64fbfcf1376cef1ad6aee0722"]);

/** Flags before the URLs. pi-gui's script puts `--user-data-dir=<launch>/config/chromium` first. */
export const BROWSER_FLAGS = [
  "--ozone-platform=wayland",
  "--gtk-version=3",
  // Never a keyring.
  "--password-store=basic",
  "--no-first-run",
  "--no-default-browser-check",
  // The worker finds windows and reads pages through AT-SPI; without a session bus Chromium cannot ask whether an
  // assistive technology runs, so its accessibility tree is turned on explicitly.
  "--force-renderer-accessibility",
  // Crash dumps would otherwise go to a crash database of the default profile; there is no crash handler, and
  // BREAKPAD_DUMP_LOCATION (set by the script) is the launch's own directory.
  "--disable-breakpad",
  // No sound or capture devices: the snap's desktop-launch points PULSE_SERVER at the user's sound server (it overrides
  // any value given), and the snap's plugs reach cameras directly. A fake audio manager and fake media devices instead.
  "--disable-audio-output",
  "--disable-audio-input",
  "--use-fake-device-for-media-stream",
  // The profile lives on the user's runtime tmpfs (an agent profile: in the user's home): bounded cache.
  "--disk-cache-size=268435456",
];

/** Agent profiles: `<snap user common>/pi-gui-profiles/<name>`, Chromium's profile being `<name>/chromium`. */
export const PROFILES_DIR = "pi-gui-profiles";
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * The script `snap run --shell chromium -c` runs inside the confinement, after the app's command chain:
 * `bash -c IN_SNAP_SCRIPT pi-gui-snap-chromium <revision> <launch dir> <profile name or -> <flags…> [-- URLs…]`; `revision`
 * is the one whose command chain was verified (snap run always runs `current`, which a refresh may switch at any time).
 * `-`: the profile is the launch's own empty `config/chromium`; a name: the agent profile
 * `$SNAP_USER_COMMON/pi-gui-profiles/<name>/chromium`, which pi-gui created. Any failed check exits with
 * {@link REFUSED_EXIT} before Chromium is started. Test seams: `program` (default: the snap's chrome) and `dirPrefix`
 * (a shell word for the launch directory's prefix; default: this user's snap runtime dir and {@link LAUNCH_PREFIX}).
 */
export function inSnapScript(options = {}) {
  const program = options.program ?? '"$SNAP/usr/lib/chromium-browser/chrome"';
  const dirPrefix = options.dirPrefix ?? `"/run/user/$(id -u)/snap.chromium/${LAUNCH_PREFIX}"`;
  const owned = `if [ -L "$d" ] || [ ! -d "$d" ] || [ ! -O "$d" ] || [ ! -r "$d" ] || [ ! -x "$d" ]; then fail "$d is not a directory of this user"; fi`;
  return `set -u
fail() { printf 'pi-gui: refusing to start Chromium: %s\\n' "$1" >&2; exit ${REFUSED_EXIT}; }
[ "$#" -ge 3 ] || fail "no revision, launch directory or profile"
revision=$1; dir=$2; name=$3; shift 3
[ -n "\${SNAP_REVISION:-}" ] && [ "$SNAP_REVISION" = "$revision" ] || fail "snap revision \${SNAP_REVISION:-?} is not the verified $revision"
[ "\${SNAP_INSTANCE_NAME:-}" = chromium ] || fail "not the chromium snap"
prefix=${dirPrefix}
case "$dir" in "$prefix" | "$prefix"*/*) fail "unexpected launch directory $dir" ;; "$prefix"*) ;; *) fail "unexpected launch directory $dir" ;; esac
case "$dir" in *[!A-Za-z0-9/._-]*|*/../*|*/..|*/./*) fail "unexpected launch directory $dir" ;; esac
for d in "$dir" ${LAUNCH_SUBDIRS.map(sub => `"$dir/${sub}"`).join(" ")}; do
  ${owned}
done
[ "$(cd "$dir" && pwd -P)" = "$dir" ] || fail "$dir is not a canonical path"
if [ "$name" = - ]; then
  config="$dir/config"
  entries=$(ls -A "$config/chromium") || fail "$config/chromium cannot be listed"
  [ -z "$entries" ] || fail "$config/chromium is not empty"
else
  case "$name" in [A-Za-z0-9]*) ;; *) fail "unexpected profile name $name" ;; esac
  case "$name" in *[!A-Za-z0-9_-]*) fail "unexpected profile name $name" ;; esac
  [ "\${#name}" -le 64 ] || fail "unexpected profile name $name"
  [ -n "\${SNAP_USER_COMMON:-}" ] || fail "SNAP_USER_COMMON is not set"
  config="$SNAP_USER_COMMON/${PROFILES_DIR}/$name"
  for d in "$SNAP_USER_COMMON/${PROFILES_DIR}" "$config" "$config/chromium"; do
    ${owned}
  done
  [ "$(cd "$config/chromium" && pwd -P)" = "$config/chromium" ] || fail "$config/chromium is not a canonical path"
fi
set -C
for d in "$config/chromium" "$dir/tmp" "$dir/home" "$dir/cache"; do
  probe="$d/.pi-gui-probe.$$"
  { : > "$probe" && rm -f "$probe"; } 2>/dev/null || fail "$d is not writable inside the snap"
done
# Chromium's default profile is $CHROME_CONFIG_HOME/chromium: from here on, that is this launch's profile as well.
export CHROME_CONFIG_HOME="$config" HOME="$dir/home" XDG_CACHE_HOME="$dir/cache" TMPDIR="$dir/tmp"
export BREAKPAD_DUMP_LOCATION="$dir/crash" CHROME_WRAPPER=${SNAP_BIN} CHROME_VERSION_EXTRA=snap
unset CHROME_USER_DATA_DIR CHROMIUM_FLAGS
builtin exec ${program} --user-data-dir="$config/chromium" "$@"
`;
}

// ---------------------------------------------------------------- checks shared with pi-gui (src/browsers.ts)

const sha256 = text => createHash("sha256").update(text).digest("hex");

/** The chromium app's command chain in a snap's meta/snap.yaml (the scripts that run before pi-gui's). */
export function commandChain(snapYaml) {
  const app = /^ {2}chromium:\n((?: {4}.*\n|\n)*)/m.exec(snapYaml)?.[1] ?? "";
  const chain = /^ {4}command-chain:\n((?: {4}- .*\n)*)/m.exec(app)?.[1] ?? "";
  return chain.split("\n").filter(Boolean).map(line => line.replace(/^ {4}- /, "").trim());
}

/**
 * Why a chromium snap revision's command chain is not the verified one, or undefined. Hashed: the app's chain list and
 * every script in the snap's snap/command-chain directory (the chain sources `run` from there too).
 */
export function chainReason(root, read = path => readFileSync(path, "utf8"), list = path => readdirSync(path)) {
  let yaml;
  try { yaml = read(join(root, "meta", "snap.yaml")); } catch { return `${root}/meta/snap.yaml cannot be read`; }
  const chain = commandChain(yaml);
  if (!chain.length) return `${root}/meta/snap.yaml has no command chain for the chromium app`;
  if (chain.some(entry => !/^snap\/command-chain\/[A-Za-z0-9._-]+$/.test(entry))) return `unexpected command-chain entries ${chain.join(", ")}`;
  let names;
  try { names = list(join(root, "snap", "command-chain")).sort(); } catch { return `${root}/snap/command-chain cannot be listed`; }
  const parts = [];
  for (const name of names) {
    try { parts.push([name, sha256(read(join(root, "snap", "command-chain", name)))]); } catch { return `${root}/snap/command-chain/${name} cannot be read`; }
  }
  const digest = sha256(JSON.stringify({ chain, parts }));
  if (!VERIFIED_CHAINS.has(digest)) return `its command chain (sha256 ${digest.slice(0, 16)}…) differs from the verified one`;
  return undefined;
}

/** The revision `current` points to now, or undefined. */
export function currentRevision(resolve = path => realpathSync(path)) {
  try { const revision = basename(resolve(SNAP_ROOT)); return /^[0-9]+$|^x[0-9]+$/.test(revision) ? revision : undefined; } catch { return undefined; }
}

/** Policy files that could set the profile directory (`UserDataDir`), or undefined when there are none. */
export function policyReason(fs) {
  // $SNAP_DATA/policies (the snap's own) and /etc/chromium-browser/policies (the host's /etc, as seen inside the snap).
  for (const dir of ["/var/snap/chromium/current/policies", "/etc/chromium-browser/policies", "/etc/chromium/policies"]) {
    for (const kind of ["managed", "recommended"]) {
      const path = join(dir, kind);
      let names = [];
      try { names = fs.list(path); } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue;
        return `the policy directory ${path} cannot be checked (${error?.code ?? error})`;
      }
      for (const name of names) {
        let text = "";
        try { text = fs.read(join(path, name)); } catch { return `the policy ${join(path, name)} cannot be read`; }
        if (/UserDataDir|DiskCacheDir/.test(text)) return `the policy ${join(path, name)} sets a profile or cache directory`;
      }
    }
  }
  return undefined;
}

/**
 * Why the installed snap Chromium cannot run with pi-gui's own profile here, or undefined. Nothing under the user's
 * home directory is read.
 */
export function snapChromiumReason(options = {}) {
  const fs = { exists: existsSync, read: path => readFileSync(path, "utf8"), list: path => readdirSync(path), ...options.fs };
  // `options.revision`: a test seam (default: the revision `current` points to).
  if (!fs.exists(SNAP_BIN) || !fs.exists(SNAP_COMMAND)) return "the chromium snap is not installed (/snap/bin/chromium)";
  if (!fs.exists(SYSTEMD_RUN)) return `${SYSTEMD_RUN} is missing (the snap needs a systemd scope)`;
  const revision = (options.revision ?? currentRevision)();
  if (!revision) return `${SNAP_ROOT} does not name a revision`;
  const root = `/snap/chromium/${revision}`;
  if (!fs.exists(join(root, "usr/lib/chromium-browser/chrome"))) return `${root}/usr/lib/chromium-browser/chrome is missing`;
  return chainReason(root, fs.read, fs.list) ?? policyReason(fs);
}

/**
 * Room for a launch on the user's runtime tmpfs (profile and cache live there; the cache is limited to 256 MiB).
 * Undefined when there is.
 */
export function runtimeSpaceReason(path, options = {}) {
  let stats;
  try { stats = (options.statfs ?? statfsSync)(path); } catch (error) { return `cannot check ${path}: ${error.message}`; }
  const free = Number(stats.bavail) * Number(stats.bsize);
  if (free < 512 * 1024 * 1024) return `${path} has ${Math.floor(free / 1048576)} MiB free (a worker browser needs 512 MiB there)`;
  if (Number(stats.files) > 0 && Number(stats.ffree) < 10_000) return `${path} has ${stats.ffree} free inodes`;
  return undefined;
}

// ---------------------------------------------------------------- the private desktop

const socketPath = address => /^unix:path=([^,;]+)/.exec(address ?? "")?.[1];

/**
 * The private desktop this process runs on (computer-use-mcp's runner environment), with its sockets checked: a
 * private 0700 runtime dir of this user that is not the user's runtime dir, and sockets inside it.
 */
export function privateDesktop(env, options = {}) {
  const uid = options.uid ?? process.getuid();
  const userRuntime = options.userRuntime ?? `/run/user/${uid}`;
  const marker = env[MARKER_ENV] ?? env[RUNNER_MARKER];
  const runtime = env.XDG_RUNTIME_DIR;
  if (env.COMPUTER_USE_MCP_ISOLATED !== "1" || !marker || !runtime) return { error: "not started on a pi-gui private desktop (no computer-use-mcp isolation marker)" };
  if (!basename(runtime).startsWith("computer-use-mcp-isolated-") || runtime === userRuntime || dirname(marker) !== runtime) {
    return { error: `XDG_RUNTIME_DIR ${runtime} is not a private desktop's runtime directory` };
  }
  const display = env.WAYLAND_DISPLAY ?? "";
  if (!/^wayland-virtual-[0-9]+$/.test(display)) return { error: `WAYLAND_DISPLAY ${JSON.stringify(display)} is not a private desktop display` };
  const own = (path, kind) => {
    let stat;
    try { stat = lstatSync(path); } catch { return `${path} does not exist`; }
    if (stat.uid !== uid) return `${path} is not owned by this user`;
    if (kind === "dir" && (!stat.isDirectory() || (stat.mode & 0o077) !== 0)) return `${path} is not a private (0700) directory`;
    if (kind === "socket" && !stat.isSocket()) return `${path} is not a socket`;
    if (kind === "file" && !stat.isFile()) return `${path} is not a file`;
    return undefined;
  };
  const sockets = { wayland: join(runtime, display), bus: socketPath(env.DBUS_SESSION_BUS_ADDRESS), atspi: socketPath(env.AT_SPI_BUS_ADDRESS) };
  for (const [name, path] of Object.entries(sockets)) {
    if (!path || dirname(path) !== runtime && dirname(dirname(path)) !== runtime) return { error: `the ${name} socket ${path ?? "(unset)"} is not inside ${runtime}` };
  }
  const problem = own(runtime, "dir") ?? own(marker, "file") ?? own(sockets.wayland, "socket") ?? own(sockets.bus, "socket") ?? own(sockets.atspi, "socket");
  if (problem) return { error: problem };
  if (realpathSync(runtime) !== runtime) return { error: `${runtime} is not a canonical path` };
  return { runtime, marker, display, sockets, uid, userRuntime };
}

/** Where pi-gui starts worker desktops (the runner's TMPDIR) when snap Chromium is offered. */
export const DESKTOPS_DIR = "pi-gui";

/**
 * The snap's runtime dir `/run/user/<uid>/snap.chromium` and the check that the private desktop runs inside it: AppArmor
 * lets the snap connect only to sockets bound there (or to the physical session's), and mediates a socket by the path it
 * was bound at, so a link elsewhere does not help. pi-gui starts such worker desktops with TMPDIR=<this dir>/pi-gui.
 */
export function snapRuntimeDir(desktop) {
  const dir = join(desktop.userRuntime, "snap.chromium");
  let stat;
  try { stat = lstatSync(dir); } catch { throw new Error(`${dir} does not exist`); }
  if (!stat.isDirectory() || stat.uid !== desktop.uid || (stat.mode & 0o077) !== 0) throw new Error(`${dir} is not a private directory of this user`);
  if (dirname(desktop.runtime) !== join(dir, DESKTOPS_DIR)) {
    throw new Error(`the private desktop's runtime ${desktop.runtime} is not in ${join(dir, DESKTOPS_DIR)}, where the snap can reach its sockets (and nothing of the physical session)`);
  }
  return dir;
}

/**
 * The launch directory: record (owner.json) and everything the browser writes (profile, home, cache, temporary files,
 * crash dumps), created and checked here before anything starts. Throws (after removing what it made) when it cannot.
 */
export function launchDir(snapDir, options = {}) {
  const uid = options.uid ?? process.getuid();
  const dir = mkdtempSync(join(snapDir, LAUNCH_PREFIX));
  try {
    chmodSync(dir, 0o700);
    for (const sub of LAUNCH_SUBDIRS) mkdirSync(join(dir, sub), { mode: 0o700 });
    for (const path of [dir, ...LAUNCH_SUBDIRS.map(sub => join(dir, sub))]) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) throw new Error(`${path} is not a private directory of this user`);
    }
    if (realpathSync(dir) !== dir) throw new Error(`${dir} is not a canonical path`);
    if (!/^[A-Za-z0-9/._-]+$/.test(dir)) throw new Error(`${dir} has characters the in-snap check refuses`);
  } catch (error) {
    removeLaunchDir(dir);
    throw error;
  }
  return dir;
}

// ---------------------------------------------------------------- agent profiles (opt-in, persistent)

/** Where the agent profile `name` lives: the snap's per-user common dir (`$SNAP_USER_COMMON`, kept across refreshes). */
export function agentProfilePaths(name, home = userInfo().homedir) {
  const root = join(home, "snap", "chromium", "common", PROFILES_DIR);
  return { root, config: join(root, name), profile: join(root, name, "chromium") };
}

/**
 * Create (0700) and check the agent profile `name`: real private directories of this user on a canonical path (no link
 * anywhere, so the in-snap script and the supervisor name the same directory). Returns its paths; throws when it cannot.
 */
export function prepareAgentProfile(name, options = {}) {
  if (!PROFILE_NAME.test(name)) throw new Error(`unexpected agent profile name ${JSON.stringify(name)}`);
  const uid = options.uid ?? process.getuid();
  const paths = agentProfilePaths(name, options.home);
  mkdirSync(paths.profile, { recursive: true, mode: 0o700 });
  for (const path of [paths.root, paths.config, paths.profile]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) throw new Error(`${path} is not a private (0700) directory of this user`);
  }
  if (realpathSync(paths.profile) !== paths.profile) throw new Error(`${paths.profile} is not a canonical path`);
  if (!/^[A-Za-z0-9/._-]+$/.test(paths.profile)) throw new Error(`${paths.profile} has characters the in-snap check refuses`);
  return paths;
}

/** The abstract socket a supervisor holds while it uses the agent profile `name` (released by the kernel when it dies). */
export const profileLockName = (name, uid = process.getuid()) => `pi-gui-agent-profile/${uid}/${name}`;

/** Take the agent profile's lock: the listening server, or undefined when another process holds it. */
export function lockAgentProfile(name, uid = process.getuid()) {
  return new Promise((resolve, reject) => {
    const server = createServer(socket => socket.destroy());
    server.once("error", error => (error?.code === "EADDRINUSE" ? resolve(undefined) : reject(error)));
    server.listen(`\0${profileLockName(name, uid)}`, () => { server.unref(); resolve(server); });
  });
}

/**
 * Who uses the agent profile `name` now, or undefined when nobody does: a launch whose record names it and whose
 * supervisor, launcher, browser or scope still lives (`owner`: that record, with its desktop's runtime and view tag), the
 * profile's lock (another supervisor taking it), or a browser process running with it (left by a killed supervisor).
 * `ownLock`: the caller holds the lock itself.
 */
export function agentProfileUse(name, options = {}) {
  const uid = options.uid ?? process.getuid();
  const proc = options.proc ?? "/proc";
  const snapDir = options.snapDir ?? join(`/run/user/${uid}`, "snap.chromium");
  let entries = [];
  try { entries = readdirSync(snapDir).filter(entry => entry.startsWith(LAUNCH_PREFIX)); } catch { /* none */ }
  for (const entry of entries) {
    const owner = readRecord(join(snapDir, entry));
    if (owner?.agentProfile === name && launchLives(owner, proc, options.cgroupRoot)) return { owner, dir: join(snapDir, entry) };
  }
  if (!options.ownLock) {
    let table = "";
    try { table = readFileSync(options.netUnix ?? "/proc/net/unix", "utf8"); } catch { /* unknown: the supervisor's own lock decides */ }
    if (table.split("\n").some(line => line.endsWith(` @${profileLockName(name, uid)}`))) return { lock: true };
  }
  const profile = options.profile ?? agentProfilePaths(name, options.home).profile;
  const program = options.program ?? BROWSER_PROGRAM;
  for (const pid of pids(proc)) {
    const args = cmdline(pid, proc);
    if (args[0] && program.test(args[0]) && !args.some(arg => arg.startsWith("--type=")) && args.includes(`--user-data-dir=${profile}`)) return { pid };
  }
  return undefined;
}

/** Environment of the snap: the private desktop's, with every route to the physical session or the marker removed. */
export function browserEnvironment(env, desktop, dir) {
  const out = { ...env };
  for (const name of [RUNNER_MARKER, MARKER_ENV, STAGE_ENV, LOG_ENV, PROFILE_ENV, "DISPLAY", "XAUTHORITY", "WAYLAND_SOCKET", "CHROMIUM_FLAGS", "TMPDIR",
    "CHROME_USER_DATA_DIR", "CHROME_CONFIG_HOME", "DBUS_STARTER_ADDRESS", "DBUS_STARTER_BUS_TYPE", "PULSE_SERVER", "PULSE_RUNTIME_PATH",
    // Shell start-up hooks: the command chain and pi-gui's script run under bash.
    "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "CDPATH", "GLOBIGNORE", "PROMPT_COMMAND"]) delete out[name];
  for (const name of Object.keys(out)) if (name.startsWith("BASH_FUNC_")) delete out[name];
  return {
    ...out,
    // Absolute paths: inside the snap XDG_RUNTIME_DIR is /run/user/<uid>/snap.chromium, and a relative or missing name
    // would resolve to the physical session's wayland-0 (the snap keeps a link to it there).
    WAYLAND_DISPLAY: desktop.sockets.wayland,
    // No session bus: Chromium aborts (and dumps) when its bus disconnects, which is how a private desktop ends. The
    // accessibility bus (window discovery, page text) is reached directly, and ACCESSIBILITY_ENABLED turns it on.
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(dir, "no-session-bus")}`,
    ACCESSIBILITY_ENABLED: "1",
    AT_SPI_BUS_ADDRESS: `unix:path=${desktop.sockets.atspi}`,
    PIPEWIRE_RUNTIME_DIR: desktop.runtime,
    GDK_BACKEND: "wayland",
    XDG_SESSION_TYPE: "wayland",
  };
}

/** Command-line arguments: fixed flags, then `--` and URLs only (an argument that is not a URL is refused). */
export function browserArguments(urls) {
  for (const url of urls) if (!/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]*$/.test(url)) throw new Error(`refusing a non-URL argument ${JSON.stringify(url.slice(0, 80))}`);
  return [...BROWSER_FLAGS, ...(urls.length ? ["--", ...urls] : [])];
}

/** The command that starts one launch: the snap's shell (same confinement as the app) running {@link inSnapScript}. */
/**
 * The whole command line of a launch: the snap's shell in a fresh systemd scope. systemd-run would expand `${…}` in the
 * arguments (the script's) with its own environment, so expansion is turned off.
 */
export function launchCommand(unit, revision, dir, args, profileName = "-") {
  const [snap, snapArgs] = snapCommand(revision, dir, args, inSnapScript(), profileName);
  return [SYSTEMD_RUN, ["--user", "--scope", "--quiet", "--collect", "--expand-environment=no", `--unit=${unit}`, "--", snap, ...snapArgs]];
}

/** `profileName`: an agent profile, or `-` for the launch's own temporary profile. */
export function snapCommand(revision, dir, args, script = inSnapScript(), profileName = "-") {
  return [SNAP_COMMAND, ["run", "--shell", "chromium", "-c", script, "pi-gui-snap-chromium", revision, dir, profileName, ...args]];
}

// ---------------------------------------------------------------- processes

const readProc = (proc, pid, file) => { try { return readFileSync(join(proc, String(pid), file), "utf8"); } catch { return undefined; } };
/** Parent PID and start time (clock ticks since boot) of a process, or undefined when it is gone. */
export function processInfo(pid, proc = "/proc") {
  const stat = readProc(proc, pid, "stat");
  if (!stat) return undefined;
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { ppid: Number(fields[1]), start: fields[19], state: fields[0] };
}
const alive = (pid, start, proc) => { const info = processInfo(pid, proc); return !!info && info.state !== "Z" && (start === undefined || info.start === start); };
/** Arguments of a process. Chromium rewrites its own title: one string, arguments joined by spaces. */
const cmdline = (pid, proc) => {
  const args = (readProc(proc, pid, "cmdline") ?? "").split("\0").filter(Boolean);
  return args.length === 1 ? args[0].split(" ").filter(Boolean) : args;
};
/** Signal a process only while it is the one recorded (same PID and start time). */
const signalOwned = (target, signal, proc) => { if (!target || !alive(target.pid, target.start, proc)) return false; try { process.kill(target.pid, signal); return true; } catch { return false; } };
const readExe = (pid, proc) => { try { return readlinkSync(join(proc, String(pid), "exe")); } catch { return undefined; } };
const pids = proc => { try { return readdirSync(proc).filter(name => /^\d+$/.test(name)).map(Number); } catch { return []; } };

/**
 * The browser process of a launch: the process started (`rootPid`; `snap run` execs through to chrome) or a descendant
 * running the snap's chrome without `--type=`.
 */
export function findBrowser(rootPid, proc = "/proc", program = BROWSER_PROGRAM) {
  const parents = new Map(pids(proc).map(pid => [pid, processInfo(pid, proc)]));
  const descends = pid => { for (let at = pid, depth = 0; at && depth < 9; at = parents.get(at)?.ppid, depth++) if (at === rootPid) return true; return false; };
  for (const [pid, info] of parents) {
    if (!info || !descends(pid)) continue;
    const args = cmdline(pid, proc);
    if (!args[0] || !program.test(args[0]) || args.some(arg => arg.startsWith("--type="))) continue;
    const dirs = args.filter(arg => arg.startsWith("--user-data-dir=")).map(arg => arg.slice("--user-data-dir=".length));
    return { pid, start: info.start, profiles: dirs };
  }
  return undefined;
}

// ---------------------------------------------------------------- the launch's systemd scope

export const SCOPE_PREFIX = "snap.chromium.chromium-";
const CGROUP_ROOT = "/sys/fs/cgroup";
/** The cgroup v2 path of a process, when it is the systemd scope `unit` this supervisor created. */
export function scopeOf(pid, unit, proc = "/proc") {
  const line = (readProc(proc, pid, "cgroup") ?? "").split("\n").find(entry => entry.startsWith("0::"));
  const path = line?.slice(3);
  return path && basename(path) === unit ? path : undefined;
}
/** PIDs in a scope (every process of one launch: browser, zygotes, renderers, helpers). */
export function scopeProcs(path, cgroupRoot = CGROUP_ROOT) {
  try { return readFileSync(join(cgroupRoot, path, "cgroup.procs"), "utf8").split("\n").filter(Boolean).map(Number); } catch { return []; }
}

/**
 * Remove a launch directory, whatever modes the browser left inside (directories of this user are made accessible
 * first; links are removed, never followed). False when something stays.
 */
export function removeLaunchDir(dir) {
  const uid = process.getuid();
  const open = path => {
    let stat;
    try { stat = lstatSync(path); } catch { return; }
    if (!stat.isDirectory() || stat.uid !== uid) return;
    try { chmodSync(path, 0o700); } catch { return; }
    let names = [];
    try { names = readdirSync(path); } catch { return; }
    for (const name of names) open(join(path, name));
  };
  open(dir);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* reported below */ }
  return !existsSync(dir);
}

const record = dir => join(dir, "owner.json");
export function readRecord(dir) { try { return JSON.parse(readFileSync(record(dir), "utf8")); } catch { return undefined; } }
function writeRecord(dir, value) { writeFileSync(record(dir), `${JSON.stringify(value)}\n`, { mode: 0o600 }); }
/** Whether anything of a launch still runs: its supervisor, browser, launcher or a process of its scope. */
function launchLives(owner, proc = "/proc", cgroupRoot = CGROUP_ROOT) {
  return (typeof owner.pid === "number" && alive(owner.pid, owner.start, proc)) || (owner.browser && alive(owner.browser.pid, owner.browser.start, proc))
    || (owner.launcher && alive(owner.launcher.pid, owner.launcher.start, proc))
    || (owner.scope && scopeProcs(owner.scope, cgroupRoot).length > 0);
}

/**
 * Launch directories of earlier launches whose supervisor and processes are gone (killed before it could clean up):
 * removed, profile included (an agent profile is not in it). Only `pi-gui-launch-*` directories of this user; never one
 * with a live owner.
 */
export function sweepStale(snapDir, proc = "/proc", log = () => {}, cgroupRoot = CGROUP_ROOT) {
  let entries = [];
  try { entries = readdirSync(snapDir); } catch { return; }
  for (const name of entries) {
    if (!name.startsWith(LAUNCH_PREFIX)) continue;
    const dir = join(snapDir, name);
    let stat;
    try { stat = lstatSync(dir); } catch { continue; }
    if (!stat.isDirectory() || stat.uid !== process.getuid()) continue;
    const owner = readRecord(dir);
    if (!owner || typeof owner.pid !== "number") {
      // Without its record the directory is being created, or its supervisor died before writing anything.
      if (Date.now() - stat.mtimeMs < 60_000) continue;
    } else if (launchLives(owner, proc, cgroupRoot)) {
      continue;
    }
    if (removeLaunchDir(dir)) log(`removed the stale launch directory ${dir}`);
    else log(`cannot remove the stale launch directory ${dir}`);
  }
}

// ---------------------------------------------------------------- supervisor

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Run the snap browser for one launch and clean up. Options (test seams): env, urls, snapBin (a stand-in for
 * /usr/bin/snap, run directly instead of through a systemd scope; with it, `inSnap` options for {@link inSnapScript}),
 * browserProgram, proc, cgroupRoot, uid, userRuntime, home, log, pollMs, startTimeoutMs, stopTimeoutMs, skipSnapCheck,
 * statfs, onState. `profileName`: an agent profile instead of a temporary one.
 *
 * Ownership: the processes of this launch are the systemd scope this supervisor creates (unit name with a fresh UUID),
 * or, without a scope (tests), the descendants of the process it spawned. Its files are its launch directory; an agent
 * profile is used, never removed, and held (lock, record) until everything of the launch has stopped.
 */
export async function supervise(options) {
  const env = options.env ?? process.env;
  const proc = options.proc ?? "/proc";
  const cgroupRoot = options.cgroupRoot ?? CGROUP_ROOT;
  const log = options.log ?? (() => {});
  const pollMs = options.pollMs ?? 250;
  const stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
  const desktop = privateDesktop(env, { uid: options.uid, userRuntime: options.userRuntime });
  if (desktop.error) { log(`refused: ${desktop.error}`); return 1; }
  // The revision checked here is the only one the in-snap script lets start.
  const revision = options.snapBin ? options.revision ?? "1" : currentRevision();
  if (!options.skipSnapCheck) {
    const reason = revision ? snapChromiumReason({ revision: () => revision }) : `${SNAP_ROOT} does not name a revision`;
    if (reason) { log(`refused: snap Chromium ${reason}`); return 1; }
  }
  if (!revision) { log("refused: no snap revision"); return 1; }
  let args;
  try { args = browserArguments(options.urls ?? []); } catch (error) { log(`refused: ${error.message}`); return 1; }
  let snapDir;
  try { snapDir = snapRuntimeDir(desktop); } catch (error) { log(`refused: ${error.message}`); return 1; }
  const noRoom = runtimeSpaceReason(snapDir, { statfs: options.statfs });
  if (noRoom) { log(`refused: ${noRoom}`); return 1; }
  sweepStale(snapDir, proc, log, cgroupRoot);
  const name = options.profileName || undefined;
  let agent, lock;
  if (name !== undefined) {
    try { agent = prepareAgentProfile(name, { uid: options.uid, home: options.home }); } catch (error) { log(`refused: the agent profile: ${error.message}`); return 1; }
    try { lock = await lockAgentProfile(name, desktop.uid); } catch (error) { log(`refused: cannot lock the agent profile ${name} (${error.message})`); return 1; }
    // With the lock taken by someone else, its record (when there is one yet) names the holder.
    const use = agentProfileUse(name, { uid: desktop.uid, proc, cgroupRoot, snapDir, profile: agent.profile, program: options.browserProgram ?? BROWSER_PROGRAM, ownLock: true })
      ?? (lock ? undefined : { lock: true });
    if (use) {
      lock?.close();
      const by = use.owner ? `the launch ${use.dir} on ${use.owner.display ?? use.owner.runtime}` : use.pid ? `the browser process ${use.pid}` : "another launch (it holds the profile's lock)";
      log(`refused: the agent profile ${name} is in use by ${by}; one browser per profile, so this launch would be handed to that browser`);
      return 1;
    }
  }
  let dir;
  try { dir = launchDir(snapDir, { uid: options.uid }); } catch (error) { lock?.close(); log(`refused: cannot create the launch directory (${error.message})`); return 1; }
  const profile = agent ? agent.profile : profileOf(dir);
  const state = {
    pid: process.pid, start: processInfo(process.pid, proc)?.start, runtime: desktop.runtime, profile, created: new Date().toISOString(),
    ...(agent ? { agentProfile: name, display: desktop.display, ...(env[VIEW_TAG_ENV] ? { tag: env[VIEW_TAG_ENV] } : {}) } : {}),
  };
  writeRecord(dir, state);

  // `snap run` moves itself into a transient systemd scope through the session bus, which here is not the user's (no
  // systemd); without a snap scope snap-confine refuses to start. So the scope is created beforehand, through the user's
  // systemd manager directly ($XDG_RUNTIME_DIR/systemd/private), under the name snap run itself would use.
  const unit = `${SCOPE_PREFIX}${randomUUID()}.scope`;
  const snap = options.snapBin ?? SNAP_COMMAND;
  const [command, commandArgs] = options.snapBin
    ? [options.snapBin, snapCommand(revision, dir, args, inSnapScript(options.inSnap), name ?? "-")[1]]
    : launchCommand(unit, revision, dir, args, name ?? "-");
  const childEnv = { ...browserEnvironment(env, desktop, dir), XDG_RUNTIME_DIR: desktop.userRuntime };
  const child = spawn(command, commandArgs, { env: childEnv, stdio: ["ignore", options.stdio ?? "ignore", options.stdio ?? "ignore"] });
  let exited;
  const done = new Promise(resolve => child.once("exit", (code, signal) => { exited = { code, signal }; resolve(exited); }));
  child.once("error", error => { log(`cannot start ${command}: ${error.message}`); });
  log(`started ${options.snapBin ?? snap} run --shell chromium (pid ${child.pid}${options.snapBin ? "" : `, scope ${unit}`}) on ${desktop.display} with ${dir}`);
  const launcher = { pid: child.pid, start: processInfo(child.pid, proc)?.start };
  state.launcher = launcher;
  writeRecord(dir, state);

  /** This launch's processes now: the scope's, else the spawned process's tree. */
  const owned = () => {
    if (state.scope) return scopeProcs(state.scope, cgroupRoot);
    const parents = new Map(pids(proc).map(pid => [pid, processInfo(pid, proc)?.ppid]));
    return [...parents.keys()].filter(pid => { for (let at = pid, depth = 0; at && depth < 10; at = parents.get(at), depth++) if (at === launcher.pid) return true; return false; });
  };
  const killOwned = signal => { for (const pid of owned()) { try { process.kill(pid, signal); } catch { /* gone */ } } };
  const settle = async ms => { for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(pollMs)) if (exited && owned().length === 0) return true; return exited !== undefined && owned().length === 0; };

  let stopping;
  const stop = why => {
    stopping ??= (async () => {
      log(`stopping: ${why}`);
      // The browser first (graceful), then whatever of this launch is left.
      if (state.browser) signalOwned(state.browser, "SIGTERM", proc);
      else killOwned("SIGTERM");
      if (await settle(stopTimeoutMs)) return;
      log("processes of this launch did not stop; killing them");
      killOwned("SIGKILL");
      signalOwned(launcher, "SIGKILL", proc);
      await settle(stopTimeoutMs);
    })();
    return stopping;
  };
  const onSignal = signal => { void stop(`supervisor received ${signal}`); };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, onSignal);

  try {
    // The browser: a process of this launch running the snap's chrome with exactly this launch's profile. Anything else
    // is killed at once (defense in depth: the script already makes any other profile unreachable).
    const program = options.browserProgram ?? BROWSER_PROGRAM;
    const deadline = Date.now() + (options.startTimeoutMs ?? 60_000);
    while (!exited && !state.browser && !stopping && Date.now() < deadline) {
      // The scope as soon as systemd-run has moved the process into it: from then on, ownership is the scope's.
      if (!options.snapBin && !state.scope) {
        const scope = scopeOf(launcher.pid, unit, proc);
        if (scope) { state.scope = scope; writeRecord(dir, state); }
      }
      const found = findBrowser(launcher.pid, proc, program);
      if (found) {
        const scope = options.snapBin ? undefined : scopeOf(found.pid, unit, proc);
        // Defense in depth only (the in-snap script already pinned the revision and the profile before exec).
        const running = options.snapBin ? undefined : /^\/snap\/chromium\/([^/]+)\//.exec(readExe(found.pid, proc) ?? "")?.[1];
        const problem = found.profiles.length !== 1 || found.profiles[0] !== profile ? `its profile ${JSON.stringify(found.profiles)} is not ${profile}`
          : options.snapBin ? undefined
          : !scope ? `it is not in the scope ${unit}`
          : running !== revision ? `it runs revision ${running ?? "?"}, not the verified ${revision}`
          : undefined;
        if (problem) {
          signalOwned(found, "SIGKILL", proc);
          log(`killed the browser ${found.pid}: ${problem}`);
          state.unsafe = true;
          await stop("unexpected browser");
          break;
        }
        state.browser = { pid: found.pid, start: found.start, profile };
        if (scope) state.scope = scope;
        writeRecord(dir, state);
        log(`browser ${found.pid} runs with the profile ${profile}`);
        options.onState?.({ ...state, dir });
        break;
      }
      await sleep(pollMs);
    }
    if (!exited && !state.browser && !state.unsafe) await stop("the browser did not start");
    // Until the browser exits on its own, or the private desktop ends (its runner removes the marker and sockets).
    while (!exited && !stopping) {
      if (!existsSync(desktop.marker) || !existsSync(desktop.sockets.wayland)) { await stop("the private desktop ended"); break; }
      await sleep(pollMs);
    }
    await (stopping ?? done);
    // Helpers (zygotes, utility processes) may outlive the browser by a moment.
    if (!await settle(stopTimeoutMs)) { log("processes of this launch are still running; killing them"); killOwned("SIGKILL"); await settle(stopTimeoutMs); }
    if (owned().length) state.unclean = true;
  } finally {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.off(signal, onSignal);
    if (!state.unclean && exited && !removeLaunchDir(dir)) { state.unclean = true; log(`cannot remove ${dir}`); }
    if (state.unclean || !exited) {
      // Keep the directory: a process of the launch may still use it; the next launch removes it once they are gone.
      try { writeRecord(dir, { ...state, pid: -1, supervisorExited: true }); } catch (error) { log(`cannot update the record in ${dir}: ${error.message}`); }
    }
    // Only now may another launch use the agent profile (with processes left, their record still names it).
    lock?.close();
  }
  const refused = exited?.code === REFUSED_EXIT && !state.browser;
  const kept = agent ? `removed ${dir}; the agent profile ${agent.profile} is kept` : `removed ${dir} (profile included)`;
  log(`${refused ? "the in-snap check refused to start Chromium" : `the browser exited (${exited ? exited.signal ?? `code ${exited.code}` : "unknown"})`}; ${state.unclean || !exited ? `kept ${dir}` : kept}`);
  return state.unsafe || refused || !state.browser ? 1 : exited?.code ?? 1;
}

// ---------------------------------------------------------------- entry point

function logger(env) {
  const file = env[LOG_ENV];
  return line => {
    const text = `${new Date().toISOString()} [snap-chromium ${process.pid}] ${line}\n`;
    if (file) { try { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, text); return; } catch { /* stderr below */ } }
    process.stderr.write(text);
  };
}

async function main(argv, env) {
  const log = logger(env);
  if (env[STAGE_ENV] === "supervise") {
    // The browser's own output (errors of snap, the in-snap check and Chromium) goes to the same log.
    let output = "ignore";
    try { if (env[LOG_ENV]) output = openSync(env[LOG_ENV], "a", 0o600); } catch { /* no log */ }
    return supervise({ env, urls: argv, log, stdio: output, profileName: env[PROFILE_ENV] || undefined });
  }
  // Stage "launch": check here (a refusal fails the launch), then supervise from a process without the runner's marker.
  const desktop = privateDesktop(env);
  if (desktop.error) { log(`refused: ${desktop.error}`); return 1; }
  const reason = snapChromiumReason();
  if (reason) { log(`refused: snap Chromium ${reason}`); return 1; }
  try { browserArguments(argv); } catch (error) { log(`refused: ${error.message}`); return 1; }
  if (env[PROFILE_ENV] && !PROFILE_NAME.test(env[PROFILE_ENV])) { log(`refused: unexpected agent profile name ${JSON.stringify(env[PROFILE_ENV])}`); return 1; }
  const childEnv = { ...env, [STAGE_ENV]: "supervise", [MARKER_ENV]: desktop.marker };
  delete childEnv[RUNNER_MARKER];
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv], { env: childEnv, detached: true, stdio: "ignore" });
  child.unref();
  log(`supervisor ${child.pid} started for ${argv.length} URL(s)`);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2), process.env).then(code => process.exit(code), error => { process.stderr.write(`pi-gui snap Chromium: ${error?.stack ?? error}\n`); process.exit(1); });
}
