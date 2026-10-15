// snap Chromium with pi-gui's own profile (bin/pi-gui-snap-chromium.mjs).
// - Offer checks (command chain, policies), private-desktop and environment checks.
// - Fail-closed start: the in-snap script (the real text) runs under a stand-in for `snap run --shell chromium` with the
//   environment snapd gives the app (CHROME_CONFIG_HOME = the user's profile root) and a stand-in chrome that picks its
//   profile as Chromium does, including Chromium's own fallback to the default profile. Every failure to create or keep
//   the launch's profile (creation, room, races that remove/replace/symlink it, permissions, a foreign revision) ends
//   with no browser start at all, and no start ever uses the user's profile.
// - Supervisor lifecycle: close, desktop end, SIGTERM, SIGKILL + the next launch's sweep, an unexpected browser.
// - Agent profile (opt-in): kept across browser restarts and desktops, one desktop at a time (also after a killed
//   supervisor), its launch directory still removed, links or races in the profile path refused inside the snap.
// - The script inside the real chromium snap's confinement (when installed): refusal, and the environment it execs with.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  agentProfilePaths, agentProfileUse, BROWSER_FLAGS, browserArguments, browserEnvironment, chainReason, commandChain, currentRevision, findBrowser, inSnapScript, launchCommand, launchDir,
  LAUNCH_SUBDIRS, lockAgentProfile, prepareAgentProfile, privateDesktop, profileOf, readRecord, REFUSED_EXIT, runtimeSpaceReason, snapChromiumReason, snapRuntimeDir, supervise,
  VERIFIED_CHAINS, type PrivateDesktop, type SuperviseOptions,
} from "../bin/pi-gui-snap-chromium.mjs";

const fixtures = fileURLToPath(new URL("./fixtures/fake-snap-chromium/", import.meta.url));
const runSupervise = fileURLToPath(new URL("./fixtures/run-supervise.mjs", import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const servers: Server[] = [];
after(() => { for (const server of servers) server.close(); });

// ---------------------------------------------------------------- offer checks (in-memory files)
const yaml = "apps:\n  chromium:\n    command: bin/chromium.launcher\n    command-chain:\n    - snap/command-chain/gpu-2404-wrapper\n    - snap/command-chain/desktop-launch\n  chromedriver:\n    command: x\n";
const chainFiles = { "gpu-2404-wrapper": "#!/bin/bash\n# gpu\n", "desktop-launch": "#!/bin/bash\n# desktop\n", run: "#!/bin/bash\n# run\n" };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
VERIFIED_CHAINS.add(sha(JSON.stringify({ chain: commandChain(yaml), parts: Object.entries(chainFiles).sort(([a], [b]) => a.localeCompare(b)).map(([name, text]) => [name, sha(text)]) })));
const root = "/snap/chromium/9";
function snapFs(files: Record<string, string>, dirs: Record<string, string[] | Error> = {}) {
  const all: Record<string, string> = { ...files };
  return {
    exists: (path: string) => path in all,
    read: (path: string) => { if (!(path in all)) throw new Error("ENOENT"); return all[path]!; },
    list: (path: string) => {
      const entry = dirs[path];
      if (entry instanceof Error) throw entry;
      if (entry) return entry;
      if (path === `${root}/snap/command-chain`) return Object.keys(chainFiles);
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };
}
const installed: Record<string, string> = {
  "/snap/bin/chromium": "", "/usr/bin/snap": "", "/usr/bin/systemd-run": "", [`${root}/usr/lib/chromium-browser/chrome`]: "", [`${root}/meta/snap.yaml`]: yaml,
  ...Object.fromEntries(Object.entries(chainFiles).map(([name, text]) => [`${root}/snap/command-chain/${name}`, text])),
};

test("snap Chromium is offered only with a verified command chain and no policy that moves the profile; nothing of the user's is read", () => {
  const reason = (files: Record<string, string>, dirs: Record<string, string[] | Error> = {}) => snapChromiumReason({ fs: snapFs(files, dirs), revision: () => "9" });
  assert.equal(reason(installed), undefined);
  assert.match(reason({})!, /not installed/);
  assert.match(reason(Object.fromEntries(Object.entries(installed).filter(([path]) => path !== "/usr/bin/systemd-run")))!, /systemd-run is missing/);
  assert.match(reason({ ...installed, [`${root}/snap/command-chain/run`]: "#!/bin/bash\nchanged\n" })!, /command chain .* differs from the verified one/);
  assert.match(reason({ ...installed, [`${root}/meta/snap.yaml`]: yaml.replace("desktop-launch", "other") })!, /differs from the verified one|cannot be read/);
  assert.match(reason({ ...installed, [`${root}/meta/snap.yaml`]: yaml.replace("snap/command-chain/desktop-launch", "/usr/bin/evil") })!, /unexpected command-chain entries/);
  assert.match(snapChromiumReason({ fs: snapFs(installed), revision: () => undefined })!, /does not name a revision/);
  // A policy that sets the profile or cache directory; a policy directory that cannot be read (not missing) is refused.
  const policyDir = "/var/snap/chromium/current/policies/managed";
  assert.match(reason({ ...installed, [`${policyDir}/p.json`]: '{"UserDataDir": "${user_home}/x"}' }, { [policyDir]: ["p.json"] })!, /sets a profile or cache directory/);
  assert.equal(reason({ ...installed, [`${policyDir}/p.json`]: '{"HomepageLocation": "x"}' }, { [policyDir]: ["p.json"] }), undefined);
  assert.match(reason(installed, { "/etc/chromium-browser/policies/managed": Object.assign(new Error("EACCES"), { code: "EACCES" }) })!, /cannot be checked \(EACCES\)/);
  // This machine: when the snap is installed, its current revision's chain is the verified one.
  if (existsSync("/snap/chromium/current/meta/snap.yaml")) assert.equal(chainReason(`/snap/chromium/${currentRevision()}`), undefined);
});

test("room on the user's runtime tmpfs is required before anything is created", () => {
  const statfs = (bavail: number, ffree: number) => () => ({ bavail, bsize: 4096, ffree, files: 1_000_000 });
  assert.equal(runtimeSpaceReason("/run/user/1", { statfs: statfs(1 << 20, 500_000) }), undefined);
  assert.match(runtimeSpaceReason("/run/user/1", { statfs: statfs(1000, 500_000) })!, /MiB free/);
  assert.match(runtimeSpaceReason("/run/user/1", { statfs: statfs(1 << 20, 10) })!, /free inodes/);
  assert.match(runtimeSpaceReason("/run/user/1", { statfs: () => { throw new Error("EACCES"); } })!, /cannot check/);
});

test("browser arguments: no profile flag of their own, URLs only after --", () => {
  assert.ok(!BROWSER_FLAGS.some(flag => /user-data-dir|profile-directory|temp-profile|incognito/.test(flag)));
  for (const flag of ["--disable-audio-output", "--disable-audio-input", "--use-fake-device-for-media-stream", "--disable-breakpad", "--password-store=basic"]) assert.ok(BROWSER_FLAGS.includes(flag), flag);
  assert.deepEqual(browserArguments([]), BROWSER_FLAGS);
  assert.deepEqual(browserArguments(["https://example.com/a?b=c"]), [...BROWSER_FLAGS, "--", "https://example.com/a?b=c"]);
  for (const bad of ["--user-data-dir=/home/u/snap/chromium/common/chromium", "-P", "--profile-directory=Default", "/etc/passwd", "a b:c"]) {
    assert.throws(() => browserArguments([bad]), /refusing a non-URL argument/, bad);
  }
});

// ---------------------------------------------------------------- a private desktop laid out like the runner's
interface FakeDesktop { env: Record<string, string>; userRuntime: string; runtime: string; snapDir: string; marker: string }
async function fakeDesktop(options: { outside?: boolean; userRuntime?: string; display?: string } = {}): Promise<FakeDesktop> {
  // Desktops of one user share the user's runtime dir (and so the snap's runtime dir with every launch directory).
  const userRuntime = options.userRuntime ?? mkdtempSync(join(tmpdir(), "pgr-"));
  const snapDir = join(userRuntime, "snap.chromium");
  mkdirSync(join(snapDir, "pi-gui"), { recursive: true, mode: 0o700 });
  chmodSync(snapDir, 0o700);
  const runtime = mkdtempSync(join(options.outside ? userRuntime : join(snapDir, "pi-gui"), "computer-use-mcp-isolated-"));
  chmodSync(runtime, 0o700);
  mkdirSync(join(runtime, "at-spi"));
  const display = options.display ?? "wayland-virtual-4242";
  for (const name of [display, "bus", "at-spi/bus"]) {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(join(runtime, name), resolve));
    servers.push(server);
  }
  const marker = join(runtime, "isolation.ready");
  writeFileSync(marker, `runtime_dir=${runtime}\n`, { mode: 0o600 });
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/nonexistent",
    COMPUTER_USE_MCP_ISOLATED: "1", COMPUTER_USE_MCP_ISOLATION_MARKER: marker, XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: display,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`, AT_SPI_BUS_ADDRESS: `unix:path=${runtime}/at-spi/bus`,
    // Routes to the physical session and profile overrides that must not reach the browser.
    DISPLAY: ":0", XAUTHORITY: "/home/u/.Xauthority", CHROMIUM_FLAGS: "--user-data-dir=/home/u/snap/chromium/common/chromium", TMPDIR: "/tmp",
    CHROME_USER_DATA_DIR: "/home/u/snap/chromium/common/chromium",
  };
  return { env, userRuntime, runtime, snapDir, marker };
}

test("private desktop: only a runner's private desktop inside the snap's runtime dir; the browser environment has no route out", async () => {
  const desktop = await fakeDesktop();
  const found = privateDesktop(desktop.env, { userRuntime: desktop.userRuntime }) as PrivateDesktop;
  assert.ok(!("error" in found), JSON.stringify(found));
  assert.equal(snapRuntimeDir(found), desktop.snapDir);
  const env = browserEnvironment(desktop.env, found, join(desktop.snapDir, "pi-gui-launch-x"));
  assert.equal(env.WAYLAND_DISPLAY, join(desktop.runtime, "wayland-virtual-4242"), "absolute: never the snap's link to wayland-0");
  assert.equal(env.AT_SPI_BUS_ADDRESS, `unix:path=${desktop.runtime}/at-spi/bus`);
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, `unix:path=${join(desktop.snapDir, "pi-gui-launch-x", "no-session-bus")}`);
  for (const name of ["DISPLAY", "XAUTHORITY", "CHROMIUM_FLAGS", "TMPDIR", "CHROME_USER_DATA_DIR", "COMPUTER_USE_MCP_ISOLATION_MARKER"]) assert.equal(env[name], undefined, name);
  const hooks = browserEnvironment({ ...desktop.env, BASH_ENV: "/x", ENV: "/x", SHELLOPTS: "xtrace", "BASH_FUNC_exec%%": "() { :; }" }, found, "/d");
  for (const name of ["BASH_ENV", "ENV", "SHELLOPTS", "BASH_FUNC_exec%%"]) assert.equal(hooks[name], undefined, name);

  const refused = (env: Record<string, string | undefined>) => (privateDesktop(env as NodeJS.ProcessEnv, { userRuntime: desktop.userRuntime }) as { error?: string }).error;
  assert.match(refused({ ...desktop.env, COMPUTER_USE_MCP_ISOLATED: undefined })!, /not started on a pi-gui private desktop/);
  assert.match(refused({ ...desktop.env, XDG_RUNTIME_DIR: desktop.userRuntime })!, /is not a private desktop's runtime directory/);
  assert.match(refused({ ...desktop.env, WAYLAND_DISPLAY: "wayland-0" })!, /is not a private desktop display/);
  assert.match(refused({ ...desktop.env, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid!()}/bus` })!, /bus socket .* is not inside/);
  rmSync(join(desktop.runtime, "isolation.ready"));
  assert.match(refused(desktop.env)!, /isolation\.ready does not exist/);
  const outside = await fakeDesktop({ outside: true });
  const elsewhere = privateDesktop(outside.env, { userRuntime: outside.userRuntime }) as PrivateDesktop;
  assert.throws(() => snapRuntimeDir(elsewhere), /is not in .*snap\.chromium\/pi-gui/);
});

test("launch directory: created private with every subdirectory, or not at all", async () => {
  const desktop = await fakeDesktop();
  const dir = launchDir(desktop.snapDir);
  assert.match(dir, /\/pi-gui-launch-\w+$/);
  for (const sub of LAUNCH_SUBDIRS) assert.ok(existsSync(join(dir, sub)), sub);
  assert.equal(profileOf(dir), join(dir, "config", "chromium"));
  chmodSync(desktop.snapDir, 0o500);
  try { assert.throws(() => launchDir(desktop.snapDir), /EACCES/); } finally { chmodSync(desktop.snapDir, 0o700); }
  assert.throws(() => launchDir(desktop.snapDir, { uid: process.getuid!() + 1 }), /is not a private directory of this user/);
  assert.deepEqual(readdirSync(desktop.snapDir).filter(name => name.startsWith("pi-gui-launch-")), [relative(desktop.snapDir, dir)], "a failed launch directory is removed");
});

// ---------------------------------------------------------------- the stand-in snap
const tree = (path: string): string[] => existsSync(path) ? readdirSync(path, { recursive: true }).map(String).sort() : [];
interface Run { desktop: FakeDesktop; options: SuperviseOptions; starts: () => { profile: string | null; given: string; kept: boolean; env: Record<string, string | null>; args: string[] }[]; snapCalls: () => string[]; userProfile: string; userTree: string[]; snapTmp: string; home: string }
async function setup(extra: Record<string, string> = {}): Promise<Run> {
  const desktop = await fakeDesktop();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-gui-fake-snap-")));
  const snapRoot = join(base, "snap");
  mkdirSync(join(snapRoot, "usr/lib/chromium-browser"), { recursive: true });
  symlinkSync(join(fixtures, "chrome"), join(snapRoot, "usr/lib/chromium-browser/chrome"));
  // The user's snap profile root ($SNAP_USER_COMMON, ~/snap/chromium/common) with a profile in it; the snap's private /tmp.
  const home = join(base, "home");
  const userCommon = join(home, "snap", "chromium", "common");
  mkdirSync(join(userCommon, "chromium", "Default"), { recursive: true });
  writeFileSync(join(userCommon, "chromium", "Default", "Cookies"), "the user's cookies");
  const snapTmp = join(base, "snap-tmp");
  mkdirSync(snapTmp);
  mkdirSync(join(base, "snap-user-data"));
  const startsFile = join(base, "starts.jsonl");
  const callsFile = join(base, "snap-calls.txt");
  const env = {
    ...desktop.env, FAKE_NODE: process.execPath, FAKE_CHROME_JS: join(fixtures, "chrome.mjs"), FAKE_STARTS: startsFile, FAKE_SNAP_CALLS: callsFile,
    FAKE_SNAP_ROOT: snapRoot, FAKE_USER_COMMON: userCommon, FAKE_SNAP_USER_DATA: join(base, "snap-user-data"), FAKE_TMP: snapTmp, ...extra,
  };
  const lines = (file: string) => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  return {
    desktop, snapTmp, home, userProfile: join(userCommon, "chromium"), userTree: tree(userCommon),
    starts: () => lines(startsFile).map(line => JSON.parse(line)), snapCalls: () => lines(callsFile),
    options: {
      env, snapBin: join(fixtures, "snap.sh"), revision: "1", inSnap: { dirPrefix: `"${desktop.snapDir}/pi-gui-launch-"` },
      browserProgram: /\/usr\/lib\/chromium-browser\/chrome$/, userRuntime: desktop.userRuntime, home, skipSnapCheck: true,
      statfs: () => ({ bavail: 1 << 20, bsize: 4096, ffree: 1_000_000, files: 1_000_000 }), pollMs: 50, stopTimeoutMs: 2_000, startTimeoutMs: 10_000,
      urls: ["https://example.com/"],
    },
  };
}
const launches = (run: Run) => readdirSync(run.desktop.snapDir).filter(name => name.startsWith("pi-gui-launch-"));
async function waitFor<T>(what: string, check: () => T | undefined, ms = 10_000): Promise<T> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(50)) { const value = check(); if (value) return value; }
  throw new Error(`timed out: ${what}`);
}
const browserOf = (run: Run) => {
  for (const name of launches(run)) {
    const dir = join(run.desktop.snapDir, name);
    const owner = readRecord(dir) as { browser?: { pid: number; profile: string }; launcher?: { pid: number } } | undefined;
    if (owner?.browser) return { ...owner.browser, launcher: owner.launcher!.pid, dir };
  }
  return undefined;
};
/** The user's profile was never chosen by any start and is unchanged (agent profiles live next to it, not in it). */
function assertUserProfileUntouched(run: Run) {
  for (const start of run.starts()) assert.ok(!start.profile?.startsWith(run.userProfile) && !start.given.startsWith(run.userProfile), JSON.stringify(start));
  const outsideAgentProfiles = (paths: string[]) => paths.filter(path => !path.startsWith("pi-gui-profiles"));
  assert.deepEqual(outsideAgentProfiles(tree(join(run.userProfile, ".."))), outsideAgentProfiles(run.userTree), "the user's profile root is unchanged");
}
/** The same user, stand-in snap and home on another (new) private desktop: a desktop torn down and created again, or a second one. */
let displays = 5000;
async function onNewDesktop(run: Run, tag?: string): Promise<{ desktop: FakeDesktop; options: SuperviseOptions }> {
  const desktop = await fakeDesktop({ userRuntime: run.desktop.userRuntime, display: `wayland-virtual-${++displays}` });
  const env = { ...run.options.env, ...desktop.env, ...(tag ? { PI_GUI_VIEW_TAG: tag } : {}) };
  return { desktop, options: { ...run.options, env, userRuntime: desktop.userRuntime } };
}
const logsOf = (logs: string[]) => logs.join("\n");
const lstatMode = (path: string) => lstatSync(path).mode & 0o777;

test("model check: the stand-in chrome falls back to the user's profile exactly where Chromium does (empty or uncreatable --user-data-dir)", async () => {
  // Only the stand-in's choice is checked here; the user's profile in this test is a scratch directory.
  const run = await setup();
  const env = { ...process.env, ...run.options.env, CHROME_CONFIG_HOME: join(run.userProfile, ".."), CHROME_USER_DATA_DIR: "" };
  const chrome = join(run.options.env!.FAKE_SNAP_ROOT!, "usr/lib/chromium-browser/chrome");
  for (const args of [["--user-data-dir="], ["--user-data-dir=/dev/null/x"]]) {
    rmSync(join(run.userProfile, "SingletonSocket"), { force: true });
    spawnSync(chrome, args, { env, stdio: "ignore", timeout: 5_000 });
  }
  assert.deepEqual(run.starts().map(start => start.profile), [run.userProfile, run.userProfile], "what the launcher's failed mktemp, or Chromium's own fallback, would do");
});

test("fail-closed: a normal launch uses only its own profile, and Chromium's default profile is inside the launch too", async () => {
  const run = await setup();
  const logs: string[] = [];
  const result = supervise({ ...run.options, log: line => logs.push(line) });
  const browser = await waitFor("the browser", () => browserOf(run));
  const [start] = await waitFor("its start record", () => run.starts().length ? run.starts() : undefined);
  assert.equal(start!.profile, join(browser.dir, "config", "chromium"));
  assert.deepEqual(start!.env, {
    CHROME_CONFIG_HOME: join(browser.dir, "config"), CHROME_USER_DATA_DIR: null, HOME: join(browser.dir, "home"), XDG_CACHE_HOME: join(browser.dir, "cache"),
    TMPDIR: join(browser.dir, "tmp"), BREAKPAD_DUMP_LOCATION: join(browser.dir, "crash"), CHROMIUM_FLAGS: null,
  });
  assert.deepEqual(start!.args.filter(arg => arg.startsWith("--user-data-dir=")), [`--user-data-dir=${join(browser.dir, "config", "chromium")}`]);
  assert.equal(start!.args.at(-1), "https://example.com/");
  assert.deepEqual(readdirSync(run.snapTmp), [], "nothing in the snap's /tmp: the singleton directory is in the launch");
  process.kill(browser.pid, "SIGTERM");
  assert.equal(await result, 0, logsOf(logs));
  assert.deepEqual(launches(run), [], "launch directory (profile included) removed");
  assert.equal(existsSync(join(run.userProfile, "..", "pi-gui-profiles")), false, "without an agent profile nothing persistent is created");
  assertUserProfileUntouched(run);
});

test("fail-closed: when the launch directory cannot be created, or there is no room, the snap is never run", async () => {
  const run = await setup();
  const logs: string[] = [];
  chmodSync(run.desktop.snapDir, 0o500);
  try { assert.equal(await supervise({ ...run.options, log: line => logs.push(line) }), 1); } finally { chmodSync(run.desktop.snapDir, 0o700); }
  assert.match(logsOf(logs), /refused: cannot create the launch directory/);
  assert.equal(await supervise({ ...run.options, statfs: () => ({ bavail: 10, bsize: 4096, ffree: 10, files: 100 }), log: line => logs.push(line) }), 1);
  assert.match(logsOf(logs), /refused: .* MiB free/);
  assert.deepEqual(run.snapCalls(), []);
  assert.deepEqual(run.starts(), []);
  assert.deepEqual(launches(run), []);
  assertUserProfileUntouched(run);
});

// Races and failures between pi-gui creating the launch directory and the in-snap check: run inside the stand-in snap
// just before the script ($launch_dir is the launch directory). None of them may start a browser.
const races: Record<string, string> = {
  "the whole launch directory removed": 'rm -rf "$launch_dir"',
  "the profile directory removed": 'rm -rf "$launch_dir/config/chromium"',
  "the profile directory replaced by a file": 'rm -rf "$launch_dir/config/chromium" && : > "$launch_dir/config/chromium"',
  "the profile directory replaced by a link to the user's profile": 'rm -rf "$launch_dir/config/chromium" && ln -s "$FAKE_USER_COMMON/chromium" "$launch_dir/config/chromium"',
  "the config directory replaced by a link to the user's profile root": 'rm -rf "$launch_dir/config" && ln -s "$FAKE_USER_COMMON" "$launch_dir/config"',
  "the profile directory not writable (probe fails)": 'chmod 500 "$launch_dir/config/chromium"',
  "the temporary directory not writable": 'chmod 500 "$launch_dir/tmp"',
  "the profile directory not empty": ': > "$launch_dir/config/chromium/Preferences"',
  "the profile directory not readable": 'chmod 300 "$launch_dir/config/chromium"',
  "a link planted where the write probe goes": 'ln -s "$FAKE_USER_COMMON/chromium/planted" "$launch_dir/tmp/.pi-gui-probe.$$"',
};
for (const [name, before] of Object.entries(races)) {
  test(`fail-closed: ${name} → no browser start`, async () => {
    const run = await setup({ FAKE_BEFORE_SCRIPT: before });
    const logs: string[] = [];
    assert.equal(await supervise({ ...run.options, log: line => logs.push(line) }), 1);
    assert.match(logsOf(logs), /the in-snap check refused to start Chromium/, logsOf(logs));
    assert.equal(run.snapCalls().length, 1);
    assert.deepEqual(run.starts(), [], "the browser never started");
    assert.deepEqual(launches(run), [], "the launch directory is removed (links inside are removed, not followed)");
    assertUserProfileUntouched(run);
  });
}

test("fail-closed: a snap revision other than the verified one never starts", async () => {
  const run = await setup({ FAKE_SNAP_REVISION: "2" });
  const logs: string[] = [];
  assert.equal(await supervise({ ...run.options, log: line => logs.push(line) }), 1);
  assert.deepEqual(run.starts(), []);
  assertUserProfileUntouched(run);
});

test("fail-closed: the profile breaking after the check (Chromium's own fallback) still never reaches the user's profile", async () => {
  const run = await setup({ FAKE_BREAK_PROFILE: "1" });
  const logs: string[] = [];
  assert.notEqual(await supervise({ ...run.options, log: line => logs.push(line) }), 0);
  assert.deepEqual(launches(run), [], logsOf(logs));
  const starts = run.starts();
  assert.equal(starts.length, 1);
  assert.equal(starts[0]!.profile, null, "the given directory and the default ($CHROME_CONFIG_HOME/chromium, inside the launch) both failed: no profile");
  assertUserProfileUntouched(run);
});

test("supervisor: a browser started some other way (not with this launch's profile) is killed at once", async () => {
  const run = await setup({ FAKE_BYPASS: "1", FAKE_BYPASS_ARGS: "--user-data-dir=/tmp/elsewhere-profile" });
  const logs: string[] = [];
  assert.equal(await supervise({ ...run.options, log: line => logs.push(line) }), 1);
  assert.match(logsOf(logs), /killed the browser \d+: its profile \["\/tmp\/elsewhere-profile"\] is not /, logsOf(logs));
  rmSync("/tmp/elsewhere-profile", { recursive: true, force: true });
});

test("supervisor: the private desktop ends → the browser is stopped and its launch directory removed", async () => {
  const run = await setup();
  const logs: string[] = [];
  const result = supervise({ ...run.options, log: line => logs.push(line) });
  await waitFor("the browser", () => browserOf(run));
  rmSync(run.desktop.marker); // the runner's cleanup
  assert.equal(await result, 0);
  assert.match(logsOf(logs), /stopping: the private desktop ended/);
  assert.deepEqual(launches(run), []);
});

test("supervisor: a browser that ignores TERM is killed with its launch's processes, then everything is removed", async () => {
  const run = await setup({ FAKE_STUBBORN: "1" });
  const logs: string[] = [];
  const result = supervise({ ...run.options, log: line => logs.push(line) });
  await waitFor("the browser", () => browserOf(run));
  rmSync(run.desktop.marker);
  await result;
  assert.match(logsOf(logs), /did not stop; killing them/);
  assert.deepEqual(launches(run), []);
});

function startSupervisor(run: Run, extra: Partial<SuperviseOptions> = {}) {
  const options = { ...run.options, ...extra, browserProgram: run.options.browserProgram!.source };
  const child = spawn(process.execPath, [runSupervise], { env: { ...process.env, SUPERVISE_OPTIONS: JSON.stringify(options) }, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", chunk => { out += chunk; });
  const exit = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
  return { child, exit, out: () => out };
}

test("supervisor: SIGTERM to the supervisor stops its browser and cleans up", async () => {
  const run = await setup();
  const sup = startSupervisor(run);
  await waitFor("the browser", () => browserOf(run));
  await waitFor("its start record", () => run.starts().length || undefined);
  await sleep(200);
  sup.child.kill("SIGTERM");
  assert.equal(await sup.exit, 0, sup.out());
  assert.match(sup.out(), /stopping: supervisor received SIGTERM/);
  assert.deepEqual(launches(run), []);
});

test("supervisor: after a SIGKILL of the supervisor and its browser, the next launch removes that launch directory (and nothing else)", async () => {
  const run = await setup();
  const sup = startSupervisor(run);
  const first = await waitFor("the browser", () => browserOf(run));
  await waitFor("its profile written", () => existsSync(join(first.dir, "config", "chromium", "Default", "Cookies")) || undefined);
  const foreign = mkdtempSync(join(run.desktop.snapDir, "other-"));
  sup.child.kill("SIGKILL");
  try { process.kill(first.pid, "SIGKILL"); } catch { /* gone */ }
  await sup.exit;
  await waitFor("the killed browser is gone", () => { try { process.kill(first.pid, 0); return undefined; } catch { return true; } });
  assert.ok(existsSync(join(first.dir, "config", "chromium", "Default", "Cookies")), "left behind until the next launch");
  const logs: string[] = [];
  const next = supervise({ ...run.options, log: line => logs.push(line) });
  await waitFor("stale directory removed", () => !existsSync(first.dir) || undefined);
  const second = await waitFor("the next browser", () => browserOf(run));
  await waitFor("its start record", () => run.starts().length > 1 || undefined);
  await sleep(200);
  assert.ok(existsSync(foreign), "other directories are not touched");
  process.kill(second.pid, "SIGTERM");
  assert.equal(await next, 0, logsOf(logs));
  assert.match(logsOf(logs), /removed the stale launch directory/);
  assert.deepEqual(launches(run), []);
  assertUserProfileUntouched(run);
});

test("sweep: a pi-gui-launch-* entry that is a link (e.g. into the user's profile) is never followed or removed", async () => {
  const run = await setup();
  const target = join(run.userProfile, "..");
  const link = join(run.desktop.snapDir, "pi-gui-launch-planted");
  symlinkSync(target, link);
  const logs: string[] = [];
  const result = supervise({ ...run.options, log: line => logs.push(line) });
  const browser = await waitFor("the browser", () => browserOf(run));
  await waitFor("its start record", () => run.starts().length || undefined);
  await sleep(200);
  process.kill(browser.pid, "SIGTERM");
  assert.equal(await result, 0, logsOf(logs));
  assert.ok(existsSync(link), "the link stays");
  assertUserProfileUntouched(run);
  rmSync(link);
});

// ---------------------------------------------------------------- agent profile (opt-in, persistent)
let agentNames = 0;
/** A profile name of this test only (the lock is per user and name, machine-wide). */
const agentName = () => `t${process.pid}-${++agentNames}`;
const fakeProgram = /\/usr\/lib\/chromium-browser\/chrome$/;
const useOf = (run: Run, name: string, snapDir = run.desktop.snapDir) => agentProfileUse(name, { snapDir, home: run.home, program: fakeProgram });

test("agent profile: kept across browser restarts and a new desktop; the launch directory is still removed; the user's profile untouched", async () => {
  const run = await setup();
  const name = agentName();
  const agent = agentProfilePaths(name, run.home);
  const logs: string[] = [];
  const first = supervise({ ...run.options, profileName: name, log: line => logs.push(line) });
  const b1 = await waitFor("the browser", () => browserOf(run));
  const [s1] = await waitFor("its start record", () => run.starts().length ? run.starts() : undefined);
  assert.equal(s1!.profile, agent.profile);
  assert.equal(s1!.kept, false, "a new profile starts empty");
  assert.deepEqual(s1!.args.filter(arg => arg.startsWith("--user-data-dir=")), [`--user-data-dir=${agent.profile}`]);
  assert.deepEqual(s1!.env, {
    CHROME_CONFIG_HOME: agent.config, CHROME_USER_DATA_DIR: null, HOME: join(b1.dir, "home"), XDG_CACHE_HOME: join(b1.dir, "cache"),
    TMPDIR: join(b1.dir, "tmp"), BREAKPAD_DUMP_LOCATION: join(b1.dir, "crash"), CHROMIUM_FLAGS: null,
  }, "Chromium's default profile is the agent profile too; everything else stays in the launch");
  assert.equal(b1.profile, agent.profile);
  for (const path of [agent.root, agent.config, agent.profile]) assert.equal(lstatMode(path), 0o700, path);
  const running = useOf(run, name);
  assert.ok(running && "owner" in running && running.owner.display === "wayland-virtual-4242", JSON.stringify(running));
  await waitFor("its cookies written", () => existsSync(join(agent.profile, "Default", "Cookies")) || undefined);
  process.kill(b1.pid, "SIGTERM");
  assert.equal(await first, 0, logsOf(logs));
  assert.deepEqual(launches(run), [], "the launch directory is removed");
  assert.match(logsOf(logs), new RegExp(`the agent profile ${agent.profile} is kept`));
  assert.equal(useOf(run, name), undefined, "free again once the browser has stopped");

  // The browser started again on the same desktop: the same profile, with what the first start wrote.
  const second = supervise({ ...run.options, profileName: name, log: line => logs.push(line) });
  await waitFor("the second browser", () => browserOf(run));
  const s2 = await waitFor("its start record", () => run.starts()[1]);
  assert.equal(s2.profile, agent.profile);
  assert.equal(s2.kept, true, "state survives a browser restart");
  rmSync(run.desktop.marker); // the desktop ends (worker session ended or desktop replaced)
  assert.equal(await second, 0, logsOf(logs));
  assert.match(logsOf(logs), /stopping: the private desktop ended/);
  assert.deepEqual(launches(run), []);
  assert.ok(existsSync(join(agent.profile, "Default", "Cookies")), "the profile survives the desktop's end");

  // A new desktop (a new worker, or the same worker's replaced desktop).
  const next = await onNewDesktop(run);
  const third = supervise({ ...next.options, profileName: name, log: line => logs.push(line) });
  const b3 = await waitFor("the browser on the new desktop", () => browserOf(run));
  const s3 = await waitFor("its start record", () => run.starts()[2]);
  assert.equal(s3.kept, true, "state survives a new desktop");
  process.kill(b3.pid, "SIGTERM");
  assert.equal(await third, 0, logsOf(logs));
  assert.deepEqual(launches(run), []);
  assertUserProfileUntouched(run);
});

test("agent profile: one desktop at a time; a second launch is refused before the snap runs, and works once the first has closed", async () => {
  const run = await setup();
  const name = agentName();
  const a = await onNewDesktop(run, "tag-a");
  const b = await onNewDesktop(run, "tag-b");
  const first = supervise({ ...a.options, profileName: name });
  const browser = await waitFor("the browser on desktop A", () => browserOf(run));
  await waitFor("its start record", () => run.starts().length || undefined);
  for (const other of [b, a]) {
    const logs: string[] = [];
    assert.equal(await supervise({ ...other.options, profileName: name, log: line => logs.push(line) }), 1);
    assert.match(logsOf(logs), new RegExp(`refused: the agent profile ${name} is in use by the launch .*pi-gui-launch-\\w+ on wayland-virtual-\\d+; one browser per profile`), logsOf(logs));
  }
  assert.equal(run.snapCalls().length, 1, "the refused launches never ran the snap (Chromium would hand them to A's browser)");
  assert.equal(launches(run).length, 1, "and created no launch directory");
  const use = useOf(run, name);
  assert.ok(use && "owner" in use && use.owner.tag === "tag-a", JSON.stringify(use));
  process.kill(browser.pid, "SIGTERM");
  assert.equal(await first, 0);

  // A lock held without a record yet (another supervisor taking it right now): refused as well, also by the hook's check.
  const held = await lockAgentProfile(name);
  assert.ok(held);
  try {
    assert.deepEqual(useOf(run, name), { lock: true });
    const logs: string[] = [];
    assert.equal(await supervise({ ...b.options, profileName: name, log: line => logs.push(line) }), 1);
    assert.match(logsOf(logs), /in use by another launch \(it holds the profile's lock\)/);
    assert.equal(await lockAgentProfile(name), undefined, "the lock is exclusive");
  } finally { held!.close(); }

  const second = supervise({ ...b.options, profileName: name });
  const onB = await waitFor("the browser on desktop B", () => browserOf(run));
  const start = await waitFor("its start record", () => run.starts()[1]);
  assert.equal(start.kept, true);
  process.kill(onB.pid, "SIGTERM");
  assert.equal(await second, 0);
  assertUserProfileUntouched(run);
});

test("agent profile: a killed supervisor does not free the profile while its browser (or its starting launch) still runs", async () => {
  const run = await setup({ FAKE_BEFORE_SCRIPT: "sleep 1.5" });
  const name = agentName();
  const other = await onNewDesktop(run);
  const refusedNow = async (what: string) => {
    const logs: string[] = [];
    assert.equal(await supervise({ ...other.options, profileName: name, log: line => logs.push(line) }), 1, what);
    assert.match(logsOf(logs), /refused: the agent profile .* is in use by /, what);
  };
  // Killed while the launch is still starting (the snap has not exec'd Chromium yet; the lock dies with the supervisor).
  const sup = startSupervisor(run, { profileName: name });
  await waitFor("its launcher", () => launches(run).map(entry => readRecord(join(run.desktop.snapDir, entry))).find(owner => owner?.launcher));
  sup.child.kill("SIGKILL");
  await sup.exit;
  await refusedNow("supervisor killed during the start");
  // Then Chromium is up, without its supervisor.
  const browser = await waitFor("the orphaned browser", () => { const use = useOf(run, name, join(run.home, "no-launches")); return use && "pid" in use ? use : undefined; });
  await waitFor("its start record", () => run.starts().length || undefined);
  await refusedNow("supervisor killed, browser running");
  assert.equal(run.snapCalls().length, 1, "no second browser was started");
  process.kill(browser.pid, "SIGKILL");
  await waitFor("the browser is gone", () => { try { process.kill(browser.pid, 0); return undefined; } catch { return true; } });
  // Free again: the next launch removes the stale launch directory and keeps the profile.
  const logs: string[] = [];
  const next = supervise({ ...other.options, profileName: name, log: line => logs.push(line) });
  const b2 = await waitFor("the next browser", () => { const found = browserOf(run); return found && found.pid !== browser.pid ? found : undefined; });
  const start = await waitFor("its start record", () => run.starts()[1]);
  assert.equal(start.kept, true);
  assert.match(logsOf(logs), /removed the stale launch directory/);
  process.kill(b2.pid, "SIGTERM");
  assert.equal(await next, 0, logsOf(logs));
  assert.deepEqual(launches(run), []);
  assert.ok(existsSync(agentProfilePaths(name, run.home).profile));
});

test("agent profile: a link or wrong permissions in its path, or a bad name, never start a browser", async () => {
  // A link planted after pi-gui's own check (the in-snap check refuses it, it is not followed).
  const name = agentName();
  const run = await setup({ FAKE_BEFORE_SCRIPT: `p="$SNAP_USER_COMMON/pi-gui-profiles/${name}/chromium"; rm -rf "$p" && ln -s "$FAKE_USER_COMMON/chromium" "$p"` });
  const logs: string[] = [];
  assert.equal(await supervise({ ...run.options, profileName: name, log: line => logs.push(line) }), 1);
  assert.match(logsOf(logs), /the in-snap check refused to start Chromium/, logsOf(logs));
  assert.deepEqual(run.starts(), []);
  assert.deepEqual(launches(run), []);
  assertUserProfileUntouched(run);
  // Checked before the snap runs: a profile directory others can read, a link in its path, a name that is not one.
  const plain = await setup();
  const open = agentName();
  prepareAgentProfile(open, { home: plain.home });
  chmodSync(agentProfilePaths(open, plain.home).config, 0o755);
  const linkedName = agentName();
  mkdirSync(join(plain.home, "elsewhere"), { mode: 0o700 });
  mkdirSync(agentProfilePaths(linkedName, plain.home).root, { recursive: true, mode: 0o700 });
  symlinkSync(join(plain.home, "elsewhere"), agentProfilePaths(linkedName, plain.home).config);
  for (const [profileName, reason] of [[open, /is not a private \(0700\) directory/], [linkedName, /is not a private \(0700\) directory|is not a canonical path/], ["../x", /unexpected agent profile name/]] as const) {
    const out: string[] = [];
    assert.equal(await supervise({ ...plain.options, profileName, log: line => out.push(line) }), 1, profileName);
    assert.match(logsOf(out), reason, profileName);
  }
  assert.deepEqual(plain.snapCalls(), []);
  assert.deepEqual(launches(plain), []);
  assertUserProfileUntouched(plain);
});

test("findBrowser: Chromium's rewritten title (one space-joined string) is parsed", () => {
  const proc = mkdtempSync(join(tmpdir(), "pi-gui-proc-"));
  const write = (pid: number, ppid: number, cmdline: string) => {
    mkdirSync(join(proc, String(pid)));
    writeFileSync(join(proc, String(pid), "stat"), `${pid} (chrome) S ${ppid} 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 777 0`);
    writeFileSync(join(proc, String(pid), "cmdline"), cmdline);
  };
  write(10, 1, "/snap/chromium/3554/usr/lib/chromium-browser/chrome --user-data-dir=/run/user/1/snap.chromium/pi-gui-launch-a/config/chromium --password-store=basic");
  write(12, 10, "/snap/chromium/3554/usr/lib/chromium-browser/chrome --type=renderer");
  write(20, 1, "/snap/chromium/3554/usr/lib/chromium-browser/chrome --password-store=basic"); // the user's, not ours
  assert.deepEqual(findBrowser(10, proc), { pid: 10, start: "777", profiles: ["/run/user/1/snap.chromium/pi-gui-launch-a/config/chromium"] });
  assert.equal(findBrowser(1234, proc), undefined);
});

test("the launch command: systemd-run does not expand the script's ${…} (it would with its own environment)", () => {
  const [command, args] = launchCommand("snap.chromium.chromium-u.scope", "9", "/run/user/1/snap.chromium/pi-gui-launch-a", ["--x"]);
  assert.equal(command, "/usr/bin/systemd-run");
  const dashes = args.indexOf("--");
  assert.ok(args.slice(0, dashes).includes("--expand-environment=no"), args.slice(0, dashes).join(" "));
  assert.deepEqual(args.slice(dashes + 1, dashes + 6), ["/usr/bin/snap", "run", "--shell", "chromium", "-c"]);
  assert.equal(args[dashes + 6], inSnapScript());
  assert.deepEqual(args.slice(dashes + 7), ["pi-gui-snap-chromium", "9", "/run/user/1/snap.chromium/pi-gui-launch-a", "-", "--x"], "- : the launch's temporary profile");
  const [, agentArgs] = launchCommand("snap.chromium.chromium-u.scope", "9", "/run/user/1/snap.chromium/pi-gui-launch-a", ["--x"], "work");
  assert.deepEqual(agentArgs.slice(dashes + 7), ["pi-gui-snap-chromium", "9", "/run/user/1/snap.chromium/pi-gui-launch-a", "work", "--x"]);
});

const userSystemd = existsSync("/usr/bin/systemd-run") && spawnSync("/usr/bin/systemd-run", ["--user", "--scope", "--quiet", "--collect", "--expand-environment=no", "--", "/bin/true"], { timeout: 20_000 }).status === 0;
test("the in-snap script survives the real systemd-run unchanged (stand-in snap environment, no browser)", { skip: !userSystemd && "no user systemd with --expand-environment" }, async () => {
  const desktop = await fakeDesktop();
  const dir = launchDir(desktop.snapDir);
  try {
    const script = inSnapScript({ program: `/bin/sh -c 'printf "ARG=%s\\n" "$@"; printf "CCH=%s\\n" "$CHROME_CONFIG_HOME"' probe`, dirPrefix: `"${desktop.snapDir}/pi-gui-launch-"` });
    const run = (revision: string, target: string) => spawnSync("/usr/bin/systemd-run", ["--user", "--scope", "--quiet", "--collect", "--expand-environment=no", "--",
      "/usr/bin/env", "SNAP=/nonexistent", "SNAP_REVISION=9", "SNAP_INSTANCE_NAME=chromium", "/bin/bash", "-c", script, "pi-gui-snap-chromium", revision, target, "-", "--x"], { encoding: "utf8", timeout: 20_000 });
    const ok = run("9", dir);
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(ok.stdout.split("\n").filter(Boolean), [`ARG=--user-data-dir=${join(dir, "config", "chromium")}`, "ARG=--x", `CCH=${join(dir, "config")}`]);
    assert.equal(run("8", dir).status, REFUSED_EXIT);
    assert.equal(run("9", `${dir}/nested`).status, REFUSED_EXIT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- inside the real chromium snap (no browser started)
const realSnap = existsSync("/usr/bin/snap") && existsSync("/snap/chromium/current/meta/snap.yaml") && !!currentRevision() && !chainReason(`/snap/chromium/${currentRevision()}`)
  && existsSync(`/run/user/${process.getuid!()}/snap.chromium`);
test("the in-snap script inside the real chromium confinement: refusal before exec, and the environment it execs with (temporary and agent profile)", { skip: !realSnap && "the verified chromium snap is not installed" }, () => {
  const snapDir = `/run/user/${process.getuid!()}/snap.chromium`;
  const revision = currentRevision()!;
  const env = { ...process.env };
  for (const name of ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "CHROME_USER_DATA_DIR", "CHROMIUM_FLAGS"]) delete env[name];
  // A stand-in program instead of chrome: it prints what chrome would get.
  const probe = inSnapScript({ program: `/bin/sh -c 'env; printf "ARG=%s\\n" "$@"' probe` });
  const runIn = (script: string, args: string[]) => spawnSync("/usr/bin/snap", ["run", "--shell", "chromium", "-c", script, "pi-gui-snap-chromium", ...args], { env, encoding: "utf8", timeout: 60_000 });
  const dir = launchDir(snapDir);
  // A synthetic agent profile of this test only, in the real ~/snap/chromium/common/pi-gui-profiles (removed afterwards).
  const name = `pi-gui-test-${Math.random().toString(16).slice(2, 10)}`;
  const agent = agentProfilePaths(name);
  const rootExisted = existsSync(agent.root);
  try {
    const ok = runIn(probe, [revision, dir, "-", "--x", "--", "https://example.com/"]);
    assert.equal(ok.status, 0, ok.stderr);
    const seen = Object.fromEntries(ok.stdout.split("\n").filter(line => /^[A-Z_]+=/.test(line)).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    assert.equal(seen.SNAP_REVISION, revision);
    assert.equal(seen.CHROME_CONFIG_HOME, join(dir, "config"), "Chromium's default profile is the launch's");
    assert.equal(seen.HOME, join(dir, "home"));
    assert.equal(seen.XDG_CACHE_HOME, join(dir, "cache"));
    assert.equal(seen.TMPDIR, join(dir, "tmp"));
    assert.equal(seen.CHROME_USER_DATA_DIR, undefined);
    assert.deepEqual(ok.stdout.split("\n").filter(line => line.startsWith("ARG=")), [`ARG=--user-data-dir=${join(dir, "config", "chromium")}`, "ARG=--x", "ARG=--", "ARG=https://example.com/"]);
    // Refusals inside the confinement, before exec.
    rmSync(join(dir, "config", "chromium"), { recursive: true });
    const missing = runIn(probe, [revision, dir, "-"]);
    assert.equal(missing.status, REFUSED_EXIT, missing.stdout + missing.stderr);
    assert.match(missing.stderr, /refusing to start Chromium: .*config\/chromium is not a directory of this user/);
    assert.doesNotMatch(missing.stdout, /ARG=/);
    mkdirSync(join(dir, "config", "chromium"), { mode: 0o700 });
    const foreign = runIn(probe, [`${revision}0`, dir, "-"]);
    assert.equal(foreign.status, REFUSED_EXIT);
    assert.match(foreign.stderr, /is not the verified/);
    const elsewhere = runIn(probe, [revision, "/tmp/pi-gui-launch-x", "-"]);
    assert.equal(elsewhere.status, REFUSED_EXIT);
    const nested = runIn(probe, [revision, `${snapDir}/pi-gui-launch-x/y`, "-"]);
    assert.equal(nested.status, REFUSED_EXIT);
    const otherUser = runIn(probe, [revision, dir.replace(`/run/user/${process.getuid!()}/`, "/run/user/0/"), "-"]);
    assert.equal(otherUser.status, REFUSED_EXIT);

    // The agent profile: $SNAP_USER_COMMON/pi-gui-profiles/<name> inside the confinement is the directory pi-gui made, and
    // both Chromium's profile and its default are there; everything else stays in the launch.
    prepareAgentProfile(name);
    const agentOk = runIn(probe, [revision, dir, name, "--x"]);
    assert.equal(agentOk.status, 0, agentOk.stderr);
    const agentSeen = Object.fromEntries(agentOk.stdout.split("\n").filter(line => /^[A-Z_]+=/.test(line)).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    assert.equal(agentSeen.CHROME_CONFIG_HOME, agent.config);
    assert.equal(agentSeen.HOME, join(dir, "home"));
    assert.equal(agentSeen.TMPDIR, join(dir, "tmp"));
    assert.deepEqual(agentOk.stdout.split("\n").filter(line => line.startsWith("ARG=")), [`ARG=--user-data-dir=${agent.profile}`, "ARG=--x"]);
    for (const bad of ["../chromium", "-x", "a/b", ".hidden"]) {
      const refused = runIn(probe, [revision, dir, bad]);
      assert.equal(refused.status, REFUSED_EXIT, bad);
      assert.match(refused.stderr, /unexpected profile name/, bad);
    }
    // A link where the profile was (to another directory; never the user's real profile here) is refused before exec.
    rmSync(agent.profile, { recursive: true });
    symlinkSync(join(dir, "cache"), agent.profile);
    const linked = runIn(probe, [revision, dir, name]);
    assert.equal(linked.status, REFUSED_EXIT, linked.stdout + linked.stderr);
    assert.match(linked.stderr, /is not a directory of this user/);
    assert.doesNotMatch(linked.stdout, /ARG=/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(agent.config, { recursive: true, force: true });
    if (!rootExisted) rmSync(agent.root, { recursive: true, force: true });
  }
});
