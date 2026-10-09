// /gui view units: locating a server's private session, the viewer's arguments and environment, its lifecycle.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_GUI_CONFIG, validateGuiConfig } from "../src/config.ts";
import {
  checkViewerPrerequisites, connectionMessage, descendants, findPrivateSession, fingerprintHex, freerdpHasH264, krdpArgs,
  makeCertificate, MARKER_ENV, newPassword, newViewTag, parseEnviron, portOpen, redact, startViewer, stopViewer, VIEW_HOST,
  VIEW_TAG_ENV, VIEW_USER, viewerEnv, ViewRegistry, withViewTag,
  type PathInfo, type PrivateSession, type ProcSource, type RunningViewer,
} from "../src/viewer.ts";
import { workerIdOfSessionFile, workerInstructions } from "../src/worker.ts";

const FAKE_KRDP = fileURLToPath(new URL("./fixtures/fake-krdpserver.mjs", import.meta.url));
const uid = process.getuid!();
const children: ChildProcess[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const child of children) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  for (const cleanup of cleanups.reverse()) await cleanup();
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check: () => boolean, ms = 5_000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50)); return check(); };

// ---------------------------------------------------------------- a fake process table and file system

interface FakeProc { pid: number; ppid: number; uid?: number; env?: Record<string, string> }
function fakeProc(items: FakeProc[]): ProcSource {
  const byPid = new Map(items.map(item => [item.pid, item]));
  return {
    pids: () => [...byPid.keys()],
    ppid: pid => byPid.get(pid)?.ppid,
    uid: pid => byPid.get(pid)?.uid ?? uid,
    environ: pid => byPid.get(pid)?.env,
  };
}
function fakeFs(paths: Record<string, PathInfo>) { return (path: string) => paths[path]; }
const runtime = (suffix: string) => `/tmp/computer-use-mcp-isolated-${suffix}`;
const sessionEnv = (tag: string, dir: string, display: string) => ({ [VIEW_TAG_ENV]: tag, XDG_RUNTIME_DIR: dir, WAYLAND_DISPLAY: display, [MARKER_ENV]: `${dir}/isolation.ready` });
const sessionFiles = (dir: string, display: string, mode = 0o700): Record<string, PathInfo> => ({
  [dir]: { uid, mode, kind: "dir" },
  [`${dir}/isolation.ready`]: { uid, mode: 0o600, kind: "file" },
  [`${dir}/${display}`]: { uid, mode: 0o755, kind: "socket" },
  [`${dir}/bus`]: { uid, mode: 0o755, kind: "socket" },
});

test("environ parsing and the descendants of a process", () => {
  assert.deepEqual(parseEnviron("A=1\0B=x=y\0\0NOEQ\0"), { A: "1", B: "x=y" });
  const proc = fakeProc([{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }, { pid: 13, ppid: 1 }, { pid: 14, ppid: 12 }]);
  assert.deepEqual(descendants(10, proc).sort(), [11, 12, 14]);
  assert.deepEqual(descendants(99, proc), []);
});

test("findPrivateSession: only the tagged server's own private session below this process", () => {
  const tag = "a".repeat(32);
  const other = "b".repeat(32);
  const mine = runtime("AAAAAA");
  const theirs = runtime("BBBBBB");
  const files = { ...sessionFiles(mine, "wayland-virtual-201"), ...sessionFiles(theirs, "wayland-virtual-301") };
  const proc = fakeProc([
    { pid: 100, ppid: 1 }, // this Pi process
    { pid: 200, ppid: 100, env: { [VIEW_TAG_ENV]: tag, XDG_RUNTIME_DIR: "/nonexistent/pi-gui-no-physical-session" } }, // the server itself
    { pid: 201, ppid: 200, env: { [VIEW_TAG_ENV]: tag } }, // the runner before it exports anything
    { pid: 202, ppid: 201, env: sessionEnv(tag, mine, "wayland-virtual-201") },
    { pid: 203, ppid: 201, env: sessionEnv(tag, mine, "wayland-virtual-201") },
    { pid: 300, ppid: 100, env: { [VIEW_TAG_ENV]: other } }, // another worker's server
    { pid: 302, ppid: 300, env: sessionEnv(other, theirs, "wayland-virtual-301") },
    { pid: 400, ppid: 1, env: sessionEnv(tag, theirs, "wayland-virtual-301") }, // a copied tag outside this process tree
    { pid: 500, ppid: 100, uid: uid + 1, env: sessionEnv(tag, theirs, "wayland-virtual-301") }, // another user
  ]);
  const found = findPrivateSession(tag, { root: 100, uid, proc, probe: fakeFs(files) });
  assert.ok(found.ok, JSON.stringify(found));
  assert.equal(found.session.runtimeDir, mine);
  assert.equal(found.session.display, "wayland-virtual-201");
  assert.equal(found.session.marker, `${mine}/isolation.ready`);
  assert.deepEqual(found.session.pids.sort(), [202, 203]);
  const theirsFound = findPrivateSession(other, { root: 100, uid, proc, probe: fakeFs(files) });
  assert.ok(theirsFound.ok && theirsFound.session.runtimeDir === theirs);
  const none = findPrivateSession("c".repeat(32), { root: 100, uid, proc, probe: fakeFs(files) });
  assert.ok(!none.ok && none.reason === "none");
});

test("findPrivateSession: a candidate counts only with the runner's private paths", () => {
  const tag = newViewTag();
  const dir = runtime("CCCCCC");
  const probeWith = (patch: Record<string, PathInfo | undefined>) => fakeFs({ ...sessionFiles(dir, "wayland-virtual-7"), ...patch } as Record<string, PathInfo>);
  const lookup = (env: Record<string, string>, probe = probeWith({})) =>
    findPrivateSession(tag, { root: 1, uid, proc: fakeProc([{ pid: 2, ppid: 1, env }]), probe });
  assert.ok(lookup(sessionEnv(tag, dir, "wayland-virtual-7")).ok);
  const reasons = [
    lookup(sessionEnv(tag, "/tmp/elsewhere-AAAAAA", "wayland-virtual-7")),
    lookup(sessionEnv(tag, dir, "wayland-0")),
    lookup({ ...sessionEnv(tag, dir, "wayland-virtual-7"), [MARKER_ENV]: "/tmp/other/isolation.ready" }),
    lookup(sessionEnv(tag, dir, "wayland-virtual-7"), probeWith({ [dir]: { uid, mode: 0o755, kind: "dir" } })),
    lookup(sessionEnv(tag, dir, "wayland-virtual-7"), probeWith({ [dir]: { uid: uid + 1, mode: 0o700, kind: "dir" } })),
    lookup(sessionEnv(tag, dir, "wayland-virtual-7"), probeWith({ [`${dir}/isolation.ready`]: undefined })),
    lookup(sessionEnv(tag, dir, "wayland-virtual-7"), probeWith({ [`${dir}/wayland-virtual-7`]: undefined })),
    lookup(sessionEnv(tag, dir, "wayland-virtual-7"), probeWith({ [`${dir}/bus`]: undefined })),
  ];
  for (const result of reasons) assert.ok(!result.ok && result.reason === "invalid", JSON.stringify(result));
  assert.match((reasons[3] as { error: string }).error, /not private/);
  // Two live desktops for one server (a replacement in progress): refuse rather than guess.
  const second = runtime("DDDDDD");
  const two = findPrivateSession(tag, {
    root: 1, uid,
    proc: fakeProc([{ pid: 2, ppid: 1, env: sessionEnv(tag, dir, "wayland-virtual-7") }, { pid: 3, ppid: 1, env: sessionEnv(tag, second, "wayland-virtual-8") }]),
    probe: fakeFs({ ...sessionFiles(dir, "wayland-virtual-7"), ...sessionFiles(second, "wayland-virtual-8") }),
  });
  assert.ok(!two.ok && two.reason === "ambiguous");
});

/** A runner-shaped directory with live sockets and a session process below this test process. */
async function realSession(tag: string): Promise<{ session: PrivateSession; service: ChildProcess }> {
  const dir = await mkdtemp(join(tmpdir(), "computer-use-mcp-isolated-"));
  await chmod(dir, 0o700);
  const display = `wayland-virtual-${process.pid}${Math.floor(Math.random() * 1000)}`;
  const servers: Server[] = await Promise.all([display, "bus"].map(name => new Promise<Server>(resolve => { const server = createServer().listen(join(dir, name), () => resolve(server)); })));
  await writeFile(join(dir, "isolation.ready"), "ok\n");
  const session: PrivateSession = { runtimeDir: dir, display, marker: join(dir, "isolation.ready"), pids: [] };
  const service = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { env: { ...process.env, ...sessionEnv(tag, dir, display) }, stdio: "ignore" });
  children.push(service);
  cleanups.push(async () => { for (const server of servers) server.close(); await rm(dir, { recursive: true, force: true }); });
  await until(() => !!service.pid && existsSync(`/proc/${service.pid}/environ`));
  return { session, service };
}

test("findPrivateSession on the real process table: a descendant matches, an orphan with the same tag does not", async () => {
  const tag = newViewTag();
  const { session, service } = await realSession(tag);
  // The same tag and paths in a process that is not below this one (double fork: reparented to init or a subreaper).
  const orphanPidFile = join(session.runtimeDir, "orphan.pid");
  const launcher = spawn("sh", ["-c", `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1 << 30)" & echo $! > ${JSON.stringify(orphanPidFile)}`], {
    env: { ...process.env, ...sessionEnv(tag, session.runtimeDir, session.display) }, stdio: "ignore",
  });
  await new Promise(resolve => launcher.once("exit", resolve));
  await until(() => existsSync(orphanPidFile) && readFileSync(orphanPidFile, "utf8").trim().length > 0);
  const orphan = Number(readFileSync(orphanPidFile, "utf8").trim());
  cleanups.push(() => { try { process.kill(orphan, "SIGKILL"); } catch { /* gone */ } });
  const found = findPrivateSession(tag, { root: process.pid, uid });
  assert.ok(found.ok, JSON.stringify(found));
  assert.equal(found.session.runtimeDir, session.runtimeDir);
  assert.deepEqual(found.session.pids, [service.pid], "only the descendant; the orphan is not below this process");
  assert.ok(!findPrivateSession(newViewTag(), { root: process.pid, uid }).ok, "another tag finds nothing");
});

test("viewer environment: private session only, physical session removed, runner marker kept", () => {
  const session: PrivateSession = { runtimeDir: runtime("EEEEEE"), display: "wayland-virtual-42", marker: `${runtime("EEEEEE")}/isolation.ready`, pids: [] };
  const env = viewerEnv({
    PATH: "/usr/bin", HOME: "/home/u", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", XAUTHORITY: "/x", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    XDG_RUNTIME_DIR: "/run/user/1000", AT_SPI_BUS_ADDRESS: "unix:path=/run/user/1000/at-spi/bus", PIPEWIRE_REMOTE: "x", SESSION_MANAGER: "local/x", [VIEW_TAG_ENV]: "t",
  }, session, `${session.runtimeDir}/pi-gui-view-1`);
  assert.equal(env.DISPLAY, undefined);
  assert.equal(env.XAUTHORITY, undefined);
  assert.equal(env.SESSION_MANAGER, undefined);
  assert.equal(env[VIEW_TAG_ENV], undefined);
  assert.equal(env.WAYLAND_DISPLAY, "wayland-virtual-42");
  assert.equal(env.XDG_RUNTIME_DIR, session.runtimeDir);
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, `unix:path=${session.runtimeDir}/bus`);
  assert.equal(env.AT_SPI_BUS_ADDRESS, `unix:path=${session.runtimeDir}/at-spi/bus`);
  assert.equal(env.PIPEWIRE_RUNTIME_DIR, session.runtimeDir);
  assert.equal(env.PIPEWIRE_REMOTE, "pipewire-0");
  assert.equal(env.XDG_CONFIG_HOME, `${session.runtimeDir}/config`);
  assert.equal(env.TMPDIR, `${session.runtimeDir}/pi-gui-view-1`);
  assert.equal(env.QT_QPA_PLATFORM, "wayland");
  assert.equal(env[MARKER_ENV], session.marker, "the runner's teardown stops the viewer with the desktop");
  assert.equal(env.PATH, "/usr/bin");
  assert.ok(!Object.values(env).some(value => typeof value === "string" && value.includes("/run/user/1000")), "nothing points at the physical session");
});

test("viewer arguments, password, fingerprint, tag and messages", () => {
  const args = krdpArgs({ user: VIEW_USER, password: "Secret123", port: 40123, certificate: "/d/tls.crt", key: "/d/tls.key" });
  assert.deepEqual(args, ["--username=pi", "--password=Secret123", "--address=127.0.0.1", "--port=40123", "--certificate=/d/tls.crt", "--certificate-key=/d/tls.key"]);
  const passwords = new Set(Array.from({ length: 50 }, () => newPassword()));
  assert.equal(passwords.size, 50);
  for (const password of passwords) assert.match(password, /^[A-Za-z0-9]{20}$/);
  assert.equal(fingerprintHex("AB:CD:0F"), "abcd0f");
  assert.equal(redact("krdp --password=XyZ said XyZ", "XyZ"), "krdp --password=<password> said <password>");
  assert.match(newViewTag(), /^[0-9a-f]{32}$/);
  const server = { command: "env", args: ["x"], env: { A: "1" } };
  const tagged = withViewTag(server, "tag1");
  assert.deepEqual(tagged.env, { A: "1", [VIEW_TAG_ENV]: "tag1" });
  assert.deepEqual(server.env, { A: "1" }, "the original config (the worker key) is not changed");
  const viewer = { target: "W1", host: VIEW_HOST, port: 40123, user: VIEW_USER, password: "Secret123", fingerprint: "AB:CD", session: { display: "wayland-virtual-9" } } as RunningViewer;
  const text = connectionMessage(viewer, "started");
  assert.match(text, /127\.0\.0\.1:40123/);
  assert.match(text, /Password:\s+Secret123/);
  assert.match(text, /\/cert:fingerprint:sha256:abcd/);
  assert.match(text, /\/gui view stop W1/);
  assert.match(text, /orche_task worker: "W1"/);
  assert.match(text, /H\.264/);
  assert.match(text, /Remmina.*"TLS protocol security".*not "Automatic"\/NLA/, "Remmina's default negotiation picks NLA, which krdp always refuses");
  assert.match(text, /snap run remmina/, "names the snap build explicitly, so an apt Remmina without H.264 is not started by mistake");
  assert.equal(workerIdOfSessionFile("/r/abc/workers/W12-2026-10-06T12-30-33-963Z.jsonl"), "W12");
  assert.equal(workerIdOfSessionFile("/r/abc/sessions/main.jsonl"), undefined);
  assert.equal(workerIdOfSessionFile(undefined), undefined);
  assert.match(workerInstructions("direct"), /sign-in is needed/);
  assert.match(workerInstructions("direct"), /\/gui view/);
});

test("viewer prerequisites and client probing", () => {
  const all = checkViewerPrerequisites(null, { env: { PATH: "/usr/bin" }, isExecutable: () => true });
  assert.ok(all.ok);
  assert.equal(all.krdp, "/usr/bin/krdpserver");
  assert.equal(all.openssl, "/usr/bin/openssl");
  const none = checkViewerPrerequisites(null, { env: { PATH: "/nowhere" }, isExecutable: () => false });
  assert.equal(none.ok, false);
  assert.deepEqual(none.missing, ["krdpserver (KDE RDP server) (apt: krdp)", "openssl (viewer TLS certificate) (apt: openssl)"]);
  const configured = checkViewerPrerequisites("/opt/krdp/bin/krdpserver", { env: { PATH: "/usr/bin" }, isExecutable: path => path !== "/opt/krdp/bin/krdpserver" });
  assert.match(configured.checks[0]!.detail, /viewerCommand .* is not an executable/);
  assert.equal(freerdpHasH264("x WITH_GFX_H264=ON y"), true);
  assert.equal(freerdpHasH264("WITH_GFX_H264=OFF"), false);
  assert.equal(freerdpHasH264("nothing"), undefined);
  assert.equal(DEFAULT_GUI_CONFIG.viewerCommand, null);
  assert.deepEqual(validateGuiConfig({ viewerCommand: "/opt/krdpserver" }), { viewerCommand: "/opt/krdpserver" });
  assert.throws(() => validateGuiConfig({ viewerCommand: "/x" }, { project: true }), /only allowed in the user config/);
  assert.throws(() => validateGuiConfig({ viewerCommand: 3 }), /viewerCommand must be/);
});

test("TLS certificate through openssl", { skip: !existsSync("/usr/bin/openssl") && "openssl not installed" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-gui-cert-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const cert = await makeCertificate("/usr/bin/openssl", dir);
  assert.match(cert.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  const { statSync } = await import("node:fs");
  assert.equal(statSync(cert.key).mode & 0o077, 0, "private key is not readable by others");
});

/** krdp stand-in behind an executable wrapper, like a real `krdpserver`. */
async function fakeKrdp(extraEnv: Record<string, string> = {}): Promise<{ krdp: string; record: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-gui-fake-krdp-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const record = join(dir, "record.json");
  const krdp = join(dir, "krdpserver");
  const exports = Object.entries({ FAKE_KRDP_RECORD: record, ...extraEnv }).map(([name, value]) => `export ${name}=${JSON.stringify(value)}`).join("\n");
  await writeFile(krdp, `#!/bin/sh\n${exports}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_KRDP)} "$@"\n`, { mode: 0o755 });
  return { krdp, record };
}
const fakeCertificate = async (_openssl: string, dir: string) => {
  await writeFile(join(dir, "tls.crt"), "cert"); await writeFile(join(dir, "tls.key"), "key", { mode: 0o600 });
  return { certificate: join(dir, "tls.crt"), key: join(dir, "tls.key"), fingerprint: "AA:BB" };
};

test("startViewer/stopViewer: loopback listener in the private session, retried port, nothing left behind", async () => {
  const tag = newViewTag();
  const { session } = await realSession(tag);
  // Port race: the first port is taken (krdp fails to listen), the second is used.
  const busy = 41000 + Math.floor(Math.random() * 2000);
  const { krdp, record } = await fakeKrdp({ FAKE_KRDP_BUSY_PORT: String(busy) });
  const ports = [busy, 0];
  const { freePort } = await import("../src/viewer.ts");
  const logs: string[] = [];
  const viewer = await startViewer("W1", session, {
    krdp, openssl: "/unused", certificate: fakeCertificate, password: () => "Pw0rdPw0rdPw0rdPw0rd", log: line => logs.push(line),
    port: async () => ports.shift() || freePort(),
    env: { ...process.env, DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" },
  });
  try {
    assert.notEqual(viewer.port, busy, "a lost port is retried with another");
    assert.equal(viewer.host, "127.0.0.1");
    assert.ok(await portOpen(viewer.port), "listening on 127.0.0.1");
    const seen = JSON.parse(readFileSync(record, "utf8"));
    assert.equal(seen.options.address, "127.0.0.1");
    assert.equal(seen.options.username, "pi");
    assert.equal(seen.options.password, "Pw0rdPw0rdPw0rdPw0rd");
    assert.equal(seen.env.XDG_RUNTIME_DIR, session.runtimeDir);
    assert.equal(seen.env.WAYLAND_DISPLAY, session.display);
    assert.equal(seen.env.DBUS_SESSION_BUS_ADDRESS, `unix:path=${session.runtimeDir}/bus`);
    assert.equal(seen.env.DISPLAY, null, "no physical X display");
    assert.equal(seen.env.COMPUTER_USE_MCP_ISOLATION_MARKER, session.marker);
    assert.equal(seen.env.PI_GUI_VIEW_TAG, null);
    assert.ok(viewer.scratchDir.startsWith(`${session.runtimeDir}/pi-gui-view-`), "certificate and key live inside the private runtime directory");
    assert.ok(viewer.output.every(line => !line.includes("Pw0rd")), "server output is redacted");
    assert.ok(logs.every(line => !line.includes("Pw0rd")));
    await stopViewer(viewer);
    assert.ok(viewer.exited, "stopped");
    assert.equal(alive(seen.pid), false);
    assert.ok(await until(() => !alive(seen.child)), "the server's own child is gone too (process group)");
    assert.equal(existsSync(viewer.scratchDir), false, "scratch directory removed");
    assert.equal(await portOpen(viewer.port), false);
  } finally {
    await stopViewer(viewer);
  }
  // A server that cannot start reports why, without the password, and leaves no scratch directory.
  const broken = join(await mkdtemp(join(tmpdir(), "pi-gui-broken-")), "krdpserver");
  await writeFile(broken, "#!/bin/sh\necho \"bad start --password=$2\" >&2\nexit 1\n", { mode: 0o755 });
  await assert.rejects(startViewer("W1", session, { krdp: broken, openssl: "/unused", certificate: fakeCertificate, password: () => "Zz9Zz9Zz9Zz9Zz9Zz9Zz" }), (error: Error) => {
    assert.match(error.message, /exited/);
    assert.doesNotMatch(error.message, /Zz9Zz9/);
    return true;
  });
  assert.deepEqual((await readdir(session.runtimeDir)).filter(name => name.startsWith("pi-gui-view-")), []);
});

test("view registry: names, default target, reuse, restart on a replaced desktop, release", async () => {
  const sessions = new Map<string, PrivateSession>();
  const started: string[] = [];
  const stopped: string[] = [];
  let serial = 0;
  const makeViewer = (target: string, session: PrivateSession): RunningViewer => {
    let resolveExit!: () => void;
    const viewer = {
      target, session, pid: 1, host: VIEW_HOST, port: 50000 + ++serial, user: VIEW_USER, password: `pw${serial}`, fingerprint: "AA", scratchDir: "/x",
      startedAt: Date.now(), output: [], exitPromise: new Promise<void>(resolve => { resolveExit = resolve; }),
    } as unknown as RunningViewer;
    (viewer as { kill?: () => void }).kill = () => { viewer.exited = { code: 0, signal: null }; resolveExit(); };
    return viewer;
  };
  const registry = new ViewRegistry({
    find: tag => sessions.has(tag) ? { ok: true, session: sessions.get(tag)! } : { ok: false, reason: "none", error: "its private desktop has not started yet" },
    start: async (target, session) => { started.push(target); await new Promise(resolve => setTimeout(resolve, 30)); return makeViewer(target, session); },
    stop: async viewer => { stopped.push(viewer.target); (viewer as { kill?: () => void }).kill?.(); },
  });
  assert.match((registry.resolve(undefined) as { error: string }).error, /no GUI worker is running/);
  registry.register("main", "tm");
  assert.equal((registry.resolve(undefined) as { target: { name: string } }).target.name, "main", "only the main session: its desktop");
  const w1 = registry.register("W1", "t1");
  assert.equal((registry.resolve(undefined) as { target: { name: string } }).target.name, "W1", "one worker: the default");
  registry.register("W1", "t2");
  assert.deepEqual(registry.list().map(target => target.name), ["main", "W1", "W1-2"], "a taken name gets a suffix");
  registry.register("W2", "t2");
  assert.deepEqual(registry.list().map(target => target.name), ["main", "W1", "W2"], "re-registering a tag renames it");
  assert.match((registry.resolve(undefined) as { error: string }).error, /several GUI desktops.*main, W1, W2/);
  assert.equal((registry.resolve("w2") as { target: { name: string } }).target.name, "W2");
  assert.match((registry.resolve("W9") as { error: string }).error, /no GUI desktop named "W9"/);

  const notYet = await registry.view(w1);
  assert.ok(notYet.kind === "error" && /has not started yet/.test(notYet.message));
  sessions.set("t1", { runtimeDir: runtime("FFFFFF"), display: "wayland-virtual-1", marker: "m", pids: [] });
  const [first, concurrent] = await Promise.all([registry.view(w1), registry.view(w1)]);
  assert.equal(first.kind, "started");
  assert.equal(concurrent.kind, "running", "a second view waits for the first and reuses it");
  assert.deepEqual(started, ["W1"]);
  const again = await registry.view(w1);
  assert.ok(again.kind === "running" && first.kind === "started" && again.viewer === first.viewer);
  // The worker's server replaced its desktop: the old viewer is stopped and a new one attaches to the new desktop.
  sessions.set("t1", { runtimeDir: runtime("GGGGGG"), display: "wayland-virtual-2", marker: "m", pids: [] });
  const moved = await registry.view(w1);
  assert.ok(moved.kind === "started" && moved.replaced && moved.viewer.session.display === "wayland-virtual-2");
  assert.deepEqual(stopped, ["W1"]);
  assert.match(registry.describe(), /W1 \(viewer on 127\.0\.0\.1:\d+\)/);
  // The worker's session ends: its viewer stops and the name is gone.
  await registry.release("t1");
  assert.deepEqual(stopped, ["W1", "W1"]);
  assert.deepEqual(registry.list().map(target => target.name), ["main", "W2"]);
  const afterRelease = await registry.view(w1);
  assert.equal(afterRelease.kind, "error");
  assert.equal(await registry.stop(registry.get("W2")!), false, "no viewer to stop");
  assert.deepEqual(await registry.stopAll(), []);
});
