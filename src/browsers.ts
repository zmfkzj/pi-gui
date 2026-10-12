import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOPS_DIR, snapChromiumReason } from "../bin/pi-gui-snap-chromium.mjs";

/**
 * Web browsers on a worker's private desktop. The private desktop has its own XDG config/data/state directories (deleted
 * with it), but `$HOME` is the user's: a browser that keeps its profile under `$HOME` (Firefox's `~/.mozilla`, snap
 * `~/snap/<name>`, Flatpak `~/.var/app`) or a launcher that names a fixed profile would open the user's own profile,
 * cookies and logins. Only Chromium-family browsers installed outside snap/Flatpak keep their default profile under
 * `$XDG_CONFIG_HOME` (`google-chrome`, `chromium`, ...), so on a private desktop they start with a fresh profile that is
 * removed with the desktop. Workers may launch only those (see {@link classifyLaunch}), and the installed snap Chromium
 * only through pi-gui's own entry {@link SNAP_CHROMIUM_ID}, which runs the snap's chrome (not its launcher) with a profile
 * pi-gui creates per launch, under a supervisor (bin/pi-gui-snap-chromium.mjs); the snap's own entries stay refused.
 */

export interface DesktopEntry {
  id: string;
  path: string;
  name?: string;
  categories: string[];
  mimeTypes: string[];
  exec?: string;
  snap: boolean;
  flatpak: boolean;
  /** DBusActivatable=true: GIO starts it through D-Bus, not through its Exec line. */
  dbus?: boolean;
}

export type BrowserVerdict =
  | { browser: true; disposable: true; entry: DesktopEntry }
  | { browser: true; disposable: false; entry: DesktopEntry; reason: string };
export type LaunchVerdict = { browser: false; entry?: DesktopEntry } | BrowserVerdict;

export interface BrowserFs {
  readFile(path: string): string;
  realpath(path: string): string;
  isFile(path: string): boolean;
  readdir(path: string): string[];
}
export const nodeFs: BrowserFs = {
  readFile: path => readFileSync(path, "utf8"),
  realpath: path => realpathSync(path),
  isFile: path => { try { return statSync(path).isFile(); } catch { return false; } },
  readdir: path => { try { return readdirSync(path); } catch { return []; } },
};

export interface BrowserEnv {
  /** XDG_DATA_DIRS of the desktop's apps (the server inherits ours). */
  dataDirs: string[];
  /** PATH for Exec programs without a directory. */
  path: string[];
  fs?: BrowserFs;
}

export function browserEnv(env: NodeJS.ProcessEnv = process.env, fs?: BrowserFs): BrowserEnv {
  const dataDirs = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean);
  return { dataDirs, path: (env.PATH ?? "").split(delimiter).filter(Boolean), ...(fs ? { fs } : {}) };
}

/** Chromium-family programs whose default profile is `$XDG_CONFIG_HOME/<name>` (disposable on a private desktop). */
const XDG_PROFILE_BROWSERS = /^(google-chrome(-stable|-beta|-unstable|-canary)?|chrome|chromium(-browser)?|microsoft-edge(-stable|-beta|-dev)?|msedge|brave(-browser)?(-stable|-beta|-nightly)?|vivaldi(-stable|-snapshot)?)$/;
/** Exec arguments or environment that pin a profile elsewhere. */
const FIXED_PROFILE = /(^|\s)(--user-data-dir(=|\s|$)|CHROME_CONFIG_HOME=|--profile(=|\s|$)|-P(\s|$))/;
/** Environment assignments in an Exec line that move a browser's profile (back) to the user's directories. */
const PROFILE_ENV = /(^|\s)(HOME|XDG_[A-Z_]+|CHROME_[A-Z_]+|[A-Z_]*PROFILE[A-Z_]*)=/;
/** Programs that run a command line or script given in the Exec line itself: what they start cannot be checked. */
const COMMAND_RUNNERS = /^(sh|bash|dash|zsh|ksh|mksh|fish|csh|tcsh|busybox|python[0-9.]*|perl|ruby|node|bun|deno|lua|php|systemd-run|setsid|nohup|exec|sudo|pkexec|su|runuser|flatpak-spawn)$/;

function parseEntry(id: string, path: string, text: string): DesktopEntry {
  const values = new Map<string, string>();
  let inMain = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) { inMain = line === "[Desktop Entry]"; continue; }
    if (!inMain || !line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at > 0) { const key = line.slice(0, at).trim(); if (!values.has(key)) values.set(key, line.slice(at + 1).trim()); }
  }
  const list = (key: string) => (values.get(key) ?? "").split(";").map(item => item.trim()).filter(Boolean);
  return {
    id, path, ...(values.get("Name") ? { name: values.get("Name")! } : {}), categories: list("Categories"), mimeTypes: list("MimeType"),
    ...(values.has("Exec") ? { exec: values.get("Exec")! } : {}),
    ...(values.get("DBusActivatable") === "true" ? { dbus: true } : {}),
    snap: values.has("X-SnapInstanceName") || values.has("X-SnapAppName") || path.startsWith("/var/lib/snapd/"),
    flatpak: values.has("X-Flatpak") || path.includes("/flatpak/exports/"),
  };
}

/** Desktop ID → file, as the XDG menu spec maps them: `applications/<id>`, or `-` as subdirectory separators. */
function locate(dir: string, id: string, fs: BrowserFs): string | undefined {
  const direct = join(dir, id);
  if (fs.isFile(direct)) return direct;
  for (const sub of fs.readdir(dir)) {
    if (id.startsWith(`${sub}-`)) {
      const found = locate(join(dir, sub), id.slice(sub.length + 1), fs);
      if (found) return found;
    }
  }
  return undefined;
}

export function findDesktopEntry(desktopId: string, env: BrowserEnv): DesktopEntry | undefined {
  const fs = env.fs ?? nodeFs;
  const id = desktopId.endsWith(".desktop") ? desktopId : `${desktopId}.desktop`;
  // A desktop ID names no directory (`-` stands for one); a path would read a file outside the application dirs.
  if (id.includes("/") || id.startsWith(".")) return undefined;
  for (const dir of env.dataDirs) {
    const path = locate(join(dir, "applications"), id, fs);
    if (!path) continue;
    try { return parseEntry(id, path, fs.readFile(path)); } catch { return undefined; }
  }
  return undefined;
}

/** Programs that are web browsers whatever their desktop entry declares (a launcher may omit MimeType). */
const BROWSER_PROGRAMS = /^(google-chrome\S*|chrome|chromium\S*|microsoft-edge\S*|msedge|brave\S*|vivaldi\S*|opera\S*|firefox\S*|librewolf|waterfox|floorp|zen(-browser)?|seamonkey|palemoon|epiphany(-browser)?|falkon|konqueror|midori|qutebrowser|min)$/;

/**
 * A program that opens web pages: it handles http(s) URLs, its program is a known browser, or it is a WebBrowser that
 * opens HTML (not, e.g., KDE's bookmark editor, which is categorized WebBrowser but opens no page).
 */
export function isBrowserEntry(entry: DesktopEntry): boolean {
  const program = entry.exec ? execProgram(entry.exec) : undefined;
  return entry.mimeTypes.some(type => type === "x-scheme-handler/http" || type === "x-scheme-handler/https")
    || (program !== undefined && BROWSER_PROGRAMS.test(basename(program)))
    || entry.categories.includes("WebBrowser") && entry.mimeTypes.some(type => type === "text/html" || type === "application/xhtml+xml");
}

/** The program of an Exec line, after `env` and VAR=value prefixes (quotes removed). */
export function execProgram(exec: string): string | undefined {
  const tokens = exec.match(/"[^"]*"|\S+/g)?.map(token => token.replace(/^"|"$/g, "")) ?? [];
  let index = 0;
  if (tokens[index] === "env" || tokens[index]?.endsWith("/env")) index++;
  while (tokens[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index++;
  while (tokens[index]?.startsWith("-")) index++;
  return tokens[index];
}

function resolveProgram(program: string, env: BrowserEnv): string | undefined {
  const fs = env.fs ?? nodeFs;
  const candidates = isAbsolute(program) || program.includes("/") ? [program] : env.path.map(dir => join(dir, program));
  const found = candidates.find(candidate => fs.isFile(candidate));
  if (!found) return undefined;
  try { return fs.realpath(found); } catch { return found; }
}

/** A launcher script that hands over to a snap (Ubuntu's transitional `/usr/bin/firefox`, `/usr/bin/chromium-browser`). */
function snapWrapper(path: string, fs: BrowserFs): boolean {
  try {
    const head = fs.readFile(path).slice(0, 4096);
    return head.startsWith("#!") && /\/snap\/bin\/|\bsnap run\b/.test(head);
  } catch { return false; }
}

/**
 * Classify `desktopId` for a worker's private desktop: not a browser (`entry` absent when no such entry exists), or a
 * browser whose profile is disposable there or not. See {@link checkWorkerLaunch} for the full worker decision.
 */
export function classifyLaunch(desktopId: string, env: BrowserEnv): LaunchVerdict {
  const entry = findDesktopEntry(desktopId, env);
  if (!entry) return { browser: false };
  if (!isBrowserEntry(entry)) return { browser: false, entry };
  const fs = env.fs ?? nodeFs;
  const refuse = (reason: string): LaunchVerdict => ({ browser: true, disposable: false, entry, reason });
  if (entry.snap) return refuse("it is a snap, which keeps its profile under ~/snap (the user's own)");
  if (entry.flatpak) return refuse("it is a Flatpak, which keeps its profile under ~/.var/app (the user's own)");
  if (entry.dbus) return refuse("it is started through D-Bus, so its program and profile cannot be checked");
  if (!entry.exec) return refuse("its launcher has no Exec line to check");
  if (FIXED_PROFILE.test(entry.exec)) return refuse("its launcher names a fixed profile");
  if (PROFILE_ENV.test(entry.exec)) return refuse("its launcher sets environment variables that can move the profile (HOME, XDG_*, CHROME_*)");
  const program = execProgram(entry.exec);
  if (!program) return refuse("its launcher has no program to check");
  if (COMMAND_RUNNERS.test(basename(program))) return refuse(`its launcher runs a command through ${basename(program)}, which cannot be checked`);
  if (basename(program) === "flatpak") return refuse("it is a Flatpak, which keeps its profile under ~/.var/app (the user's own)");
  if (basename(program) === "snap" || program.startsWith("/snap/")) return refuse("it is a snap, which keeps its profile under ~/snap (the user's own)");
  const resolved = resolveProgram(program, env);
  if (!resolved) return refuse(`its program ${program} was not found`);
  if (resolved.startsWith("/snap/") || snapWrapper(resolved, fs)) return refuse("it starts a snap, which keeps its profile under ~/snap (the user's own)");
  if (!XDG_PROFILE_BROWSERS.test(basename(program)) && !XDG_PROFILE_BROWSERS.test(basename(resolved))) {
    return refuse("only Chromium-family browsers keep their profile in the private desktop's own config directory; this one may open the user's profile under $HOME");
  }
  return { browser: true, disposable: true, entry };
}

/** Every web browser entry of these data dirs, classified (for /gui status and worker instructions). */
export function listBrowsers(env: BrowserEnv): BrowserVerdict[] {
  const fs = env.fs ?? nodeFs;
  const seen = new Set<string>();
  const verdicts: BrowserVerdict[] = [];
  for (const dir of env.dataDirs) {
    for (const file of fs.readdir(join(dir, "applications"))) {
      if (!file.endsWith(".desktop") || seen.has(file)) continue;
      seen.add(file);
      const verdict = classifyLaunch(file, env);
      if (verdict.browser) verdicts.push(verdict);
    }
  }
  return verdicts;
}

/** pi-gui's entry for the installed snap Chromium with a temporary profile (bin/pi-gui-snap-chromium.mjs). */
export const SNAP_CHROMIUM_ID = "pi-gui-chromium-temp-profile.desktop";
const SNAP_CHROMIUM_HINT = ` To use Chromium, launch ${SNAP_CHROMIUM_ID}: the same snap Chromium with a temporary profile of its own, removed when it closes.`;

export function refusalText(verdict: BrowserVerdict & { disposable: false }, options: { snapChromium?: boolean } = {}): string {
  const instead = options.snapChromium
    ? SNAP_CHROMIUM_HINT
    : " Use a browser your instructions list as allowed; if there is none, report that the task needs a Chromium-family browser installed outside snap/Flatpak (e.g. Google Chrome), or the user's explicit allowWorkerUserBrowserProfiles in gui.config.json.";
  return `launch_application ${verdict.entry.id} is refused on a worker's private desktop: ${verdict.reason}. Workers launch web browsers only when the browser's default profile lies in the private desktop's own config directory, which starts empty and is deleted with the desktop, so it does not open the user's browser profile, cookies or logins.${instead}`;
}

/**
 * Apps that start other programs by name: a terminal, KRunner, or settings that change the desktop's default web
 * browser. On a worker's desktop they would bypass the browser check (typing `firefox` in a terminal opens the user's
 * profile), so workers may not launch them; a worker runs commands with its own bash tool.
 */
const TERMINALS = /^(konsole|xterm|uxterm|gnome-terminal(-server)?|kgx|ptyxis|kitty|alacritty|foot(client)?|wezterm(-gui)?|xfce4-terminal|tilix|terminator|yakuake|qterminal|lxterminal|mate-terminal|urxvt|rxvt|st|cool-retro-term|blackbox)$/;
const PROGRAM_LAUNCHERS = /^(krunner|systemsettings|kcmshell[56]?|kmenuedit|kde-open[56]?|kioclient[56]?|xdg-open|gio)$/;

export function launcherReason(entry: DesktopEntry): string | undefined {
  const program = entry.exec ? execProgram(entry.exec) : undefined;
  if (entry.categories.includes("TerminalEmulator") || (program !== undefined && TERMINALS.test(basename(program)))) {
    return "it is a terminal, which can start any program (including a browser with the user's profile); use your bash tool for commands";
  }
  if (!entry.exec && !entry.dbus) return "it has no Exec line to check";
  if (program === undefined && !entry.dbus) return "its launcher has no program to check";
  if (program !== undefined && COMMAND_RUNNERS.test(basename(program))) {
    return `its launcher runs a command line through ${basename(program)} (for example \`sh -c …\`), which can start any program`;
  }
  if (entry.exec && PROFILE_ENV.test(entry.exec)) return "its launcher sets environment variables that can move app profiles (HOME, XDG_*, CHROME_*)";
  if (program !== undefined && PROGRAM_LAUNCHERS.test(basename(program))) {
    return `it starts programs or changes the desktop's default applications (${basename(program)}), which would bypass the browser check`;
  }
  return undefined;
}

/**
 * A worker's launch decision (without the user's allowWorkerUserBrowserProfiles): refused when the ID is not an entry of
 * this desktop's application dirs (fail closed: it cannot be checked), when it starts other programs by name, or when it
 * is a browser that would open the user's profile. {@link SNAP_CHROMIUM_ID} is allowed only when this desktop offers it
 * (`snapChromium`; its entry lives in pi-gui's own data dir of the desktop, not in `env`). Undefined: allowed.
 */
export function checkWorkerLaunch(desktopId: string, env: BrowserEnv, options: { snapChromium?: boolean } = {}): string | undefined {
  if ((desktopId.endsWith(".desktop") ? desktopId : `${desktopId}.desktop`) === SNAP_CHROMIUM_ID) {
    return options.snapChromium ? undefined : `launch_application ${desktopId} is refused on a worker's private desktop: snap Chromium with a temporary profile is not offered here (see /gui status for the reason).`;
  }
  const verdict = classifyLaunch(desktopId, env);
  if (!verdict.entry) {
    return `launch_application ${desktopId} is refused on a worker's private desktop: no such application entry was found in this desktop's application directories, so it cannot be checked. Use an exact desktop_id from list_desktop {scope: "applications"}.`;
  }
  if (verdict.browser) return verdict.disposable ? undefined : refusalText(verdict, options);
  const launcher = launcherReason(verdict.entry);
  return launcher ? `launch_application ${verdict.entry.id} is refused on a worker's private desktop: ${launcher}.` : undefined;
}

/** The web MIME types whose default handler a worker desktop pins. */
export const WEB_TYPES = ["x-scheme-handler/http", "x-scheme-handler/https", "text/html", "application/xhtml+xml"] as const;
export const NO_BROWSER_ID = "pi-gui-no-browser.desktop";

/** The supervisor program behind {@link SNAP_CHROMIUM_ID}. */
export const SNAP_CHROMIUM_SUPERVISOR = fileURLToPath(new URL("../bin/pi-gui-snap-chromium.mjs", import.meta.url));

/**
 * Whether this machine can offer {@link SNAP_CHROMIUM_ID}: the chromium snap with the verified launcher, no launcher
 * pre-start step that would touch the user's profile, and the user's runtime dir `/run/user/<uid>`. Worker desktops then
 * run in {@link snapDesktopsDir} (the snap reaches only sockets bound under its own runtime dir; bin/pi-gui-snap-chromium.mjs).
 */
export function snapChromiumStatus(uid: number, check: typeof snapChromiumReason = snapChromiumReason): { ok: true; userRuntime: string } | { ok: false; reason: string } {
  const reason = check();
  if (reason) return { ok: false, reason };
  const userRuntime = `/run/user/${uid}`;
  try {
    const stat = statSync(userRuntime);
    if (!stat.isDirectory() || stat.uid !== uid) return { ok: false, reason: `${userRuntime} is not this user's runtime directory` };
  } catch {
    return { ok: false, reason: `${userRuntime} does not exist` };
  }
  return { ok: true, userRuntime };
}

/**
 * Create (like snapd, 0700) and return `<userRuntime>/snap.chromium/pi-gui`: the TMPDIR of a worker's server, so
 * the runner's private runtime dir (mktemp) and its sockets lie where the snap may connect.
 */
export function snapDesktopsDir(userRuntime: string): string {
  const snapDir = join(userRuntime, "snap.chromium");
  mkdirSync(snapDir, { recursive: true, mode: 0o700 });
  const dir = join(snapDir, DESKTOPS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const path of [snapDir, dir]) {
    const stat = statSync(path);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error(`${path} is not a private directory of this user`);
  }
  return dir;
}

/** How pi-gui starts the snap Chromium on a worker desktop: this Node runs the supervisor; it logs to `log`. */
export interface SnapChromiumLaunch { node: string; supervisor: string; log: string }

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The program of {@link SNAP_CHROMIUM_ID} and `$BROWSER`: one path, so `xdg-open`, GIO and KIO all reach the supervisor. */
export function snapChromiumShim(launch: SnapChromiumLaunch): string {
  return `#!/bin/sh\n# Written by pi-gui: snap Chromium with a temporary profile on a worker's private desktop.\nPI_GUI_SNAP_CHROMIUM_LOG=${shellQuote(launch.log)} exec ${shellQuote(launch.node)} ${shellQuote(launch.supervisor)} "$@"\n`;
}

/**
 * A program path that needs no quoting in an Exec line. xdg-mime (and so xdg-open's generic mode) skips an entry whose
 * quoted program it cannot resolve and falls back to the system default (on Ubuntu the snap's own Chromium entry), so
 * pi-gui offers its entry only at such a path.
 */
export const PLAIN_EXEC_PATH = /^\/[A-Za-z0-9_./+-]+$/;
/** Where {@link webDefaultsEnv} puts the shim under `root` (the hash part has a fixed shape). */
export const snapChromiumShimFits = (root: string) => PLAIN_EXEC_PATH.test(join(root, "0123456789abcdef", "bin", "pi-gui-snap-chromium"));

export function snapChromiumEntry(shim: string): string {
  if (!PLAIN_EXEC_PATH.test(shim)) throw new Error(`the snap Chromium shim path ${JSON.stringify(shim)} needs quoting in an Exec line`);
  return [
    "[Desktop Entry]", "Type=Application", "Name=Chromium (temporary profile)",
    "Comment=The installed snap Chromium with a temporary profile of its own (not the user's), removed when it closes",
    `Exec=${shim} %U`, "Terminal=false", "Icon=chromium", "Categories=Network;WebBrowser;",
    `MimeType=${WEB_TYPES.join(";")};`, "StartupNotify=false", "",
  ].join("\n");
}

/**
 * Files that make a worker desktop's default web handler a disposable-profile browser (a Chromium-family browser outside
 * snap/Flatpak, else pi-gui's snap Chromium entry when `snapChromium` is given), or a no-op handler when there is none,
 * and remove every other browser from those types' associations. Without them a link opened by an app (`xdg-open`, KIO,
 * GIO) would start the system default browser, which may use the user's profile (Ubuntu: snap Firefox or Chromium).
 * The files go to the desktop's `XDG_CONFIG_DIRS` (mimeapps.list) and `XDG_DATA_DIRS` (pi-gui's entries); the desktop's
 * own `XDG_CONFIG_HOME` is fresh and empty, so nothing earlier in the lookup overrides them.
 */
export function webDefaultsFiles(browsers: readonly BrowserVerdict[], noop = "/usr/bin/true", snapChromium?: string): { mimeapps: string; kdeMimeapps: string; noBrowser?: string; snapChromium?: string } {
  const allowed = browsers.find(verdict => verdict.disposable)?.entry.id ?? (snapChromium ? SNAP_CHROMIUM_ID : undefined);
  const handler = allowed ?? NO_BROWSER_ID;
  const removed = browsers.filter(verdict => !verdict.disposable).map(verdict => verdict.entry.id);
  const mimeapps = [
    "# Written by pi-gui for workers' private desktops: links open only in a browser with a disposable profile.",
    "[Default Applications]", ...WEB_TYPES.map(type => `${type}=${handler};`),
    "", "[Added Associations]", ...WEB_TYPES.map(type => `${type}=${handler};`),
    ...(removed.length ? ["", "[Removed Associations]", ...WEB_TYPES.map(type => `${type}=${removed.join(";")};`)] : []),
    "",
  ].join("\n");
  // Desktop-specific files may only set defaults (GIO ignores other groups there).
  const kdeMimeapps = [mimeapps.split("\n")[0], "[Default Applications]", ...WEB_TYPES.map(type => `${type}=${handler};`), ""].join("\n");
  const entries = snapChromium ? { snapChromium: snapChromiumEntry(snapChromium) } : {};
  if (allowed) return { mimeapps, kdeMimeapps, ...entries };
  const noBrowser = [
    "[Desktop Entry]", "Type=Application", "Name=No web browser (pi-gui worker)",
    "Comment=Workers' private desktops have no browser with a disposable profile; links are not opened.",
    `Exec=${noop} %u`, "NoDisplay=true", `MimeType=${WEB_TYPES.join(";")};`, "",
  ].join("\n");
  return { mimeapps, kdeMimeapps, noBrowser };
}

/**
 * Write {@link webDefaultsFiles} under `root/<content hash>` (idempotent, shared by workers with the same browsers) and
 * return the environment that puts them first in the desktop's lookup. With `snapChromium`, pi-gui's snap Chromium entry
 * and its program (a shim that runs the supervisor) are written too.
 */
export function webDefaultsEnv(root: string, browsers: readonly BrowserVerdict[], env: NodeJS.ProcessEnv, snapChromium?: SnapChromiumLaunch): Record<string, string> {
  // An absolute no-op program: xdg-mime accepts a handler only when its Exec resolves to a file.
  const noop = (env.PATH ?? "").split(delimiter).map(dir => join(dir, "true")).find(path => nodeFs.isFile(path)) ?? "/bin/true";
  const shimText = snapChromium ? snapChromiumShim(snapChromium) : undefined;
  const dir = join(root, createHash("sha256").update(JSON.stringify({ browsers: browsers.map(verdict => [verdict.entry.id, verdict.disposable]), noop, shimText })).digest("hex").slice(0, 16));
  const shim = join(dir, "bin", "pi-gui-snap-chromium");
  const files = webDefaultsFiles(browsers, noop, shimText ? shim : undefined);
  mkdirSync(join(dir, "config"), { recursive: true });
  // The desktop-specific file too: KDE reads kde-mimeapps.list before mimeapps.list in each directory.
  writeFileSync(join(dir, "config", "mimeapps.list"), files.mimeapps);
  writeFileSync(join(dir, "config", "kde-mimeapps.list"), files.kdeMimeapps);
  if (files.noBrowser || files.snapChromium) mkdirSync(join(dir, "data", "applications"), { recursive: true });
  if (files.noBrowser) writeFileSync(join(dir, "data", "applications", NO_BROWSER_ID), files.noBrowser);
  if (files.snapChromium && shimText) {
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(shim, shimText);
    chmodSync(shim, 0o755);
    writeFileSync(join(dir, "data", "applications", SNAP_CHROMIUM_ID), files.snapChromium);
  }
  const allowed = browsers.find(verdict => verdict.disposable);
  const program = allowed?.entry.exec ? execProgram(allowed.entry.exec) : files.snapChromium ? shim : undefined;
  return {
    // xdg-open's generic mode and many tools honour $BROWSER before any association: the allowed browser, or nothing.
    BROWSER: program ?? noop,
    XDG_CONFIG_DIRS: [join(dir, "config"), env.XDG_CONFIG_DIRS || "/etc/xdg"].join(":"),
    ...(files.noBrowser || files.snapChromium ? { XDG_DATA_DIRS: [join(dir, "data"), env.XDG_DATA_DIRS || "/usr/local/share:/usr/share"].join(":") } : {}),
  };
}
