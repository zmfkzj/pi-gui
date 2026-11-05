// The KDE portal backend's D-Bus activation on a private session bus (bin/private-dbus-daemon,
// bin/xdg-desktop-portal-kde-activated). Reported crash: on the runner's private bus, KWin's startup activated
// xdg-desktop-portal and with it the KDE backend before KWin had created its Wayland socket; Qt found no display and the
// backend aborted (SIGABRT), which apport showed on the user's screen. These tests run a real dbus-daemon through the
// wrapper with a stand-in backend (test/fixtures/fake-portal-backend.py: no Qt, no Wayland) and a plain listening socket
// as the "Wayland display". They show which service file the bus uses, that the backend starts only once the socket
// exists, that it never starts without one, and that the runner's own --replace start keeps the name either way.
// QT_QPA_PLATFORM=offscreen is a safety net only: if the system's service file were used, the real backend must not
// abort here (the tests then fail on the stand-in's missing log).
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { which } from "../src/backend.ts";
import { DBUS_DAEMON_WRAPPER, PORTAL_BACKEND_WRAPPER } from "../src/prerequisites.ts";
import { listenSocket } from "./fixtures/socket-path.ts";

const NAME = "org.freedesktop.impl.portal.desktop.kde";
const ACTIVATED = join(dirname(DBUS_DAEMON_WRAPPER), "xdg-desktop-portal-kde-activated");
const FAKE_BACKEND = fileURLToPath(new URL("./fixtures/fake-portal-backend.py", import.meta.url));
const DISPLAY = "wayland-virtual-test";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const dbusDaemon = which("dbus-daemon") ?? ["/usr/bin/dbus-daemon"].find(path => existsSync(path));
const dbusSend = which("dbus-send") ?? ["/usr/bin/dbus-send"].find(path => existsSync(path));
const python = which("python3");
const gioReady = !!python && spawnSync(python, ["-c", "import gi; gi.require_version('Gio', '2.0'); from gi.repository import Gio"]).status === 0;
const skipBus = !dbusDaemon || !dbusSend || !gioReady ? "needs dbus-daemon, dbus-send and python3 with PyGObject (Gio)" : false;

const runtimes: string[] = [];
const servers: Server[] = [];
const children: ChildProcess[] = [];
/** Kills only this test's processes: its children and anything the bus started with one of its runtime directories. */
function cleanup(): void {
  for (const server of servers) server.close();
  for (const child of children) { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }
  for (const pid of readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    let environ = "";
    try { environ = readFileSync(`/proc/${pid}/environ`, "utf8"); } catch { continue; }
    if (environ.split("\0").some(entry => runtimes.some(dir => entry === `XDG_RUNTIME_DIR=${dir}`))) {
      try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ }
    }
  }
  for (const dir of runtimes) rmSync(dir, { recursive: true, force: true });
}
after(cleanup);

/** A runtime directory like the runner's (mktemp, 0700) and the environment the runner exports before dbus-daemon. */
function runnerEnv(extra: Record<string, string> = {}): { runtime: string; env: Record<string, string>; log: string } {
  const runtime = mkdtempSync(join(tmpdir(), "pi-gui-pa-"));
  runtimes.push(runtime);
  const log = join(runtime, "fake-portal.log");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? runtime,
    LANG: "C.UTF-8",
    XDG_RUNTIME_DIR: runtime,
    WAYLAND_DISPLAY: DISPLAY,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
    XDG_DATA_HOME: join(runtime, "data"),
    XDG_CONFIG_HOME: join(runtime, "config"),
    QT_QPA_PLATFORM: "offscreen",
    COMPUTER_USE_MCP_ISOLATED: "1",
    COMPUTER_USE_MCP_ISOLATION_MARKER: join(runtime, "isolation.ready"),
    COMPUTER_USE_MCP_STARTUP_TIMEOUT_SECS: "3",
    PI_GUI_PORTAL_BACKEND: FAKE_BACKEND,
    PI_GUI_DBUS_DAEMON: dbusDaemon ?? "/usr/bin/dbus-daemon",
    FAKE_PORTAL_LOG: log,
    ...extra,
  };
  return { runtime, env, log };
}

async function waitFor(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** Starts the private bus the way the runner does (`"$DBUS_DAEMON_BIN" --session --nofork --nopidfile --address=…`). */
async function startBus(env: Record<string, string>, runtime: string): Promise<{ daemon: ChildProcess; output: () => string }> {
  let output = "";
  const daemon = spawn(DBUS_DAEMON_WRAPPER, ["--session", "--nofork", "--nopidfile", `--address=unix:path=${runtime}/bus`], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(daemon);
  daemon.stdout!.on("data", chunk => { output += chunk; });
  daemon.stderr!.on("data", chunk => { output += chunk; });
  await waitFor(() => existsSync(join(runtime, "bus")), 5_000, "the private bus socket");
  return { daemon, output: () => output };
}

function busCall(env: Record<string, string>, ...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(dbusSend!, [`--bus=${env.DBUS_SESSION_BUS_ADDRESS}`, "--print-reply", "--reply-timeout=20000", "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}
const activate = (env: Record<string, string>) => busCall(env, "org.freedesktop.DBus.StartServiceByName", `string:${NAME}`, "uint32:0");
async function owner(env: Record<string, string>): Promise<string | undefined> {
  const reply = await busCall(env, "org.freedesktop.DBus.GetNameOwner", `string:${NAME}`);
  return reply.code === 0 ? /string "([^"]+)"/.exec(reply.stdout)?.[1] : undefined;
}
async function ownerPid(env: Record<string, string>): Promise<number | undefined> {
  const name = await owner(env);
  if (!name) return undefined;
  const reply = await busCall(env, "org.freedesktop.DBus.GetConnectionUnixProcessID", `string:${name}`);
  const pid = /uint32 (\d+)/.exec(reply.stdout)?.[1];
  return pid ? Number(pid) : undefined;
}

/** The stand-in's log: one entry per line, e.g. `{ event: "start", args: "--replace", pid: 123 }`. */
function events(log: string): { event: string; args: string; pid: number }[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => {
    const match = /^(\w+) (\d+) ?(.*)$/.exec(line);
    assert.ok(match, line);
    return { event: match[1]!, pid: Number(match[2]), args: match[3]! };
  });
}

function display(runtime: string): Promise<Server> {
  return new Promise(resolve => {
    const server = createServer();
    servers.push(server);
    listenSocket(server, join(runtime, DISPLAY), () => resolve(server));
  });
}

test("private dbus-daemon wrapper: registers the waiting activation only in the runner's private runtime dir", { skip: !dbusDaemon }, () => {
  // A stand-in daemon shows the wrapper passes arguments, output and exit status through unchanged.
  const fakeDir = mkdtempSync(join(tmpdir(), "pi-gui-pa-daemon-"));
  runtimes.push(fakeDir);
  const fakeDaemon = join(fakeDir, "dbus-daemon");
  writeFileSync(fakeDaemon, "#!/bin/sh\nprintf 'arg:%s\\n' \"$@\"\nexit 7\n", { mode: 0o755 });
  const service = (runtime: string) => join(runtime, "dbus-1", "services", `${NAME}.service`);
  const args = ["--session", "--nofork", "--address=unix:path=/x y/bus"];

  const { runtime, env } = runnerEnv({ PI_GUI_DBUS_DAEMON: fakeDaemon });
  const run = spawnSync(DBUS_DAEMON_WRAPPER, args, { env, encoding: "utf8" });
  assert.equal(run.status, 7);
  assert.equal(run.stdout, args.map(arg => `arg:${arg}\n`).join(""));
  assert.equal(run.stderr, "");
  assert.equal(readFileSync(service(runtime), "utf8"), `[D-BUS Service]\nName=${NAME}\nExec='${ACTIVATED}'\n`, "no SystemdService, the activation script quoted");
  // dbus-daemon ignores a transient service directory that others can write to.
  for (const dir of [join(runtime, "dbus-1"), join(runtime, "dbus-1", "services")]) assert.equal(statSync(dir).mode & 0o077, 0, dir);

  // Not the runner's private runtime dir (no runner marker, a foreign marker, pi-gui's nonexistent sentinel) or no
  // pi-gui portal backend (a user's override): nothing is written, the daemon still starts with the same arguments.
  const cases: Record<string, string>[] = [
    { COMPUTER_USE_MCP_ISOLATED: "" },
    { COMPUTER_USE_MCP_ISOLATION_MARKER: "/elsewhere/isolation.ready" },
    { PI_GUI_PORTAL_BACKEND: "" },
  ];
  for (const patch of cases) {
    const other = runnerEnv({ PI_GUI_DBUS_DAEMON: fakeDaemon, ...patch });
    const result = spawnSync(DBUS_DAEMON_WRAPPER, args, { env: other.env, encoding: "utf8" });
    assert.equal(result.status, 7, JSON.stringify(patch));
    assert.equal(existsSync(join(other.runtime, "dbus-1")), false, JSON.stringify(patch));
  }
  const sentinel = "/nonexistent/pi-gui-no-physical-session";
  const outside = spawnSync(DBUS_DAEMON_WRAPPER, args, { env: { ...env, XDG_RUNTIME_DIR: sentinel, COMPUTER_USE_MCP_ISOLATION_MARKER: `${sentinel}/isolation.ready` }, encoding: "utf8" });
  assert.equal(outside.status, 7);
  assert.equal(existsSync(sentinel), false);
  // Without the real program it refuses to guess one.
  const unset = runnerEnv({ PI_GUI_DBUS_DAEMON: "" });
  assert.notEqual(spawnSync(DBUS_DAEMON_WRAPPER, args, { env: unset.env }).status, 0);
});

test("KDE portal activation waits for the private Wayland socket, then starts the backend without --replace", { skip: skipBus }, async () => {
  const { runtime, env, log } = runnerEnv();
  await startBus(env, runtime);
  // KWin's startup asks for the portal before its socket exists (the reported crash): the activation is pending and the
  // backend not started.
  const pending = activate(env);
  await sleep(600);
  assert.deepEqual(events(log), [], "no backend start while the display socket is missing");
  await display(runtime);
  const reply = await pending;
  assert.equal(reply.code, 0, reply.stderr);
  assert.match(reply.stdout, /uint32 1/, "DBUS_START_REPLY_SUCCESS");
  const started = events(log);
  assert.deepEqual(started.map(entry => entry.event), ["start", "owner"], "the bus used pi-gui's service file, not the system's");
  assert.equal(started[0]!.args, "", "the activated start does not take the name with --replace");
  assert.equal(await ownerPid(env), started[1]!.pid);

  // Then the runner's own start (bin/xdg-desktop-portal-kde-replace) takes the name over, as before this change.
  const runner = spawn(PORTAL_BACKEND_WRAPPER, [], { env, detached: true, stdio: "ignore" });
  children.push(runner);
  await waitFor(() => events(log).some(entry => entry.event === "owner" && entry.pid === runner.pid), 10_000, "the runner's backend to own the name");
  assert.equal(await ownerPid(env), runner.pid);
  assert.ok(events(log).some(entry => entry.event === "start" && entry.args === "--replace" && entry.pid === runner.pid));
  await waitFor(() => events(log).some(entry => entry.event === "lost" && entry.pid === started[1]!.pid), 10_000, "the activated backend to lose the name");
});

test("the runner's backend keeps the name when it wins while an activation still waits", { skip: skipBus }, async () => {
  const { runtime, env, log } = runnerEnv();
  await startBus(env, runtime);
  const pending = activate(env);
  await sleep(300);
  // The runner starts its backend (a stand-in needs no display) while the activation still waits for the socket.
  const runner = spawn(PORTAL_BACKEND_WRAPPER, [], { env, detached: true, stdio: "ignore" });
  children.push(runner);
  await waitFor(() => events(log).some(entry => entry.event === "owner" && entry.pid === runner.pid), 10_000, "the runner's backend to own the name");
  await display(runtime);
  await pending;
  await waitFor(() => events(log).some(entry => entry.event === "refused"), 10_000, "the late activated backend to give up");
  assert.equal(await ownerPid(env), runner.pid, "the activated start never takes the name from the runner's");
  assert.equal(events(log).filter(entry => entry.event === "lost").length, 0);
});

test("no display socket: the activation fails with a message after the startup timeout and never starts the backend", { skip: skipBus }, async () => {
  const { runtime, env, log } = runnerEnv({ COMPUTER_USE_MCP_STARTUP_TIMEOUT_SECS: "1" });
  // A regular file at the display's path is not a Wayland socket.
  writeFileSync(join(runtime, DISPLAY), "");
  const bus = await startBus(env, runtime);
  const started = Date.now();
  const reply = await activate(env);
  const waited = Date.now() - started;
  assert.notEqual(reply.code, 0);
  assert.match(reply.stderr, /exited with status 1/, "a clean failure, not a signal");
  assert.ok(waited >= 900 && waited < 10_000, `waited ${waited} ms`);
  assert.deepEqual(events(log), []);
  assert.match(bus.output(), new RegExp(`Wayland socket ${runtime}/${DISPLAY} was not created within 1 s; not starting the KDE portal backend`));
});

test("activation script: absolute WAYLAND_DISPLAY paths, no display, invalid timeout", { skip: !gioReady && "needs python3 with PyGObject" }, async () => {
  const { runtime, env, log } = runnerEnv({ COMPUTER_USE_MCP_STARTUP_TIMEOUT_SECS: "x" });
  const none = spawnSync(ACTIVATED, [], { env: { ...env, WAYLAND_DISPLAY: "" }, encoding: "utf8" });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no WAYLAND_DISPLAY/);
  // An absolute display path is waited for as it is; an invalid timeout falls back to the runner's default (15 s), so
  // the socket that appears after 300 ms is still found. The stand-in then fails (no bus): only its start is checked.
  const absolute = join(runtime, "elsewhere-display");
  const child = spawn(ACTIVATED, [], { env: { ...env, WAYLAND_DISPLAY: absolute, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/no-bus` }, stdio: "ignore" });
  children.push(child);
  await sleep(300);
  assert.deepEqual(events(log), []);
  const server = createServer();
  servers.push(server);
  await new Promise<void>(resolve => listenSocket(server, absolute, () => resolve()));
  await waitFor(() => events(log).some(entry => entry.event === "start"), 5_000, "the backend start");
});
