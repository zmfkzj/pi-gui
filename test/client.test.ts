// /gui view auto-connect (src/client.ts): which client, what it is given, what is removed afterwards. Never starts a real
// RDP client: programs are fakes in a temporary directory or an injected spawn, and HOME is a temporary directory.
import assert from "node:assert/strict";
import { execFileSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createDecipheriv, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  autoConnect, certificateStorePath, clientEnv, connectClient, findRdpClient, remminaEncrypt, remminaPaths, remminaProfile, remminaSecret,
} from "../src/client.ts";
import { DEFAULT_GUI_CONFIG, validateGuiConfig } from "../src/config.ts";
import { connectionMessage, MARKER_ENV, runCleanups, VIEW_HOST, VIEW_TAG_ENV, VIEW_USER, ViewRegistry, type PrivateSession, type RunningViewer } from "../src/viewer.ts";

const dirs: string[] = [];
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
const scratch = async () => { const dir = await mkdtemp(join(tmpdir(), "pi-gui-client-")); dirs.push(dir); return dir; };

/** Remmina's `remmina_crypt_decrypt`: base64, 3DES-CBC with the secret's key and IV, text up to the first zero byte. */
function remminaDecrypt(secret: string, value: string): string {
  const key = Buffer.from(secret, "base64");
  const decipher = createDecipheriv("des-ede3-cbc", key.subarray(0, 24), key.subarray(24, 32));
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(Buffer.from(value, "base64")), decipher.final()]);
  const end = plain.indexOf(0);
  return plain.subarray(0, end < 0 ? plain.length : end).toString("utf8");
}

const SECRET = randomBytes(32).toString("base64");
const PASSWORD = "Abcdefghijkmnopqrst2";

function fakeViewer(overrides: Partial<RunningViewer> = {}): RunningViewer {
  return {
    target: "W1", session: { runtimeDir: "/tmp/x", display: "wayland-virtual-7", marker: "/tmp/x/isolation.ready", pids: [] },
    pid: 1, host: VIEW_HOST, port: 40413, user: VIEW_USER, password: PASSWORD, fingerprint: "AB:CD:EF", scratchDir: "/tmp/x",
    startedAt: 0, output: [], exitPromise: Promise.resolve(), child: undefined as unknown as ChildProcess,
    ...overrides,
  } as RunningViewer;
}

/** An injected spawn that records the call and reports a started (or failed) process, like node's `spawn` events. */
function recordingSpawn(options: { fail?: string; pid?: number } = {}) {
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const spawn = (command: string, args: string[], spawnOptions: SpawnOptions): ChildProcess => {
    calls.push({ command, args, options: spawnOptions });
    const child = Object.assign(new EventEmitter(), { pid: options.fail ? undefined : options.pid ?? 4242, unref: () => {} });
    setImmediate(() => options.fail ? child.emit("error", new Error(options.fail)) : child.emit("spawn"));
    return child as unknown as ChildProcess;
  };
  return { calls, spawn };
}

const GRAPHICAL = { PATH: "/nonexistent", WAYLAND_DISPLAY: "wayland-0", [VIEW_TAG_ENV]: "tag", [MARKER_ENV]: "/tmp/x/isolation.ready" };

test("remmina password encryption: what Remmina's remmina_crypt_encrypt makes, cross-checked with openssl", { skip: !existsSync("/usr/bin/openssl") && "openssl not installed" }, () => {
  const encrypted = remminaEncrypt(SECRET, PASSWORD)!;
  const key = Buffer.from(SECRET, "base64");
  // Independent implementation: openssl 3DES-CBC, no padding, over the text zero-padded to the next multiple of 8 (always one zero at least).
  const padded = Buffer.alloc(24); Buffer.from(PASSWORD).copy(padded);
  const viaOpenssl = execFileSync("/usr/bin/openssl", ["enc", "-des-ede3-cbc", "-nopad", "-K", key.subarray(0, 24).toString("hex"), "-iv", key.subarray(24, 32).toString("hex")], { input: padded }).toString("base64");
  assert.equal(encrypted, viaOpenssl);
  assert.equal(remminaDecrypt(SECRET, encrypted), PASSWORD);
  assert.equal(Buffer.from(remminaEncrypt(SECRET, "12345678")!, "base64").length, 16, "a full block gets a zero block (Remmina's terminator)");
  assert.equal(remminaEncrypt(Buffer.alloc(31).toString("base64"), PASSWORD), undefined, "a short secret is refused, as Remmina does");
  assert.equal(remminaEncrypt(SECRET, ""), undefined);
});

test("remmina paths, key and profile", async () => {
  assert.deepEqual(remminaPaths(true, "/home/u", {}), { profileDir: "/home/u/snap/remmina/common/pi-gui-view", configHome: "/home/u/snap/remmina/current/.config" });
  assert.deepEqual(remminaPaths(false, "/home/u", { XDG_RUNTIME_DIR: "/run/user/1", XDG_CONFIG_HOME: "/cfg" }), { profileDir: "/run/user/1/pi-gui-view", configHome: "/cfg" });
  assert.equal(remminaPaths(false, "/home/u", {}).configHome, "/home/u/.config");
  const config = await scratch();
  assert.equal(remminaSecret(config), undefined, "no remmina.pref yet");
  await mkdir(join(config, "remmina"));
  await writeFile(join(config, "remmina", "remmina.pref"), `[remmina_pref]\nsave_view_mode=true\nsecret=${SECRET}\nuse_primary_password=false\n`);
  assert.equal(remminaSecret(config), SECRET);
  const profile = remminaProfile(fakeViewer(), "ENC");
  for (const line of ["protocol=RDP", "server=127.0.0.1:40413", "username=pi", "password=ENC", "security=tls", "colordepth=65", "cert_ignore=0", "disablepasswordstoring=1"]) {
    assert.ok(profile.split("\n").includes(line), `${line} in\n${profile}`);
  }
  assert.doesNotMatch(remminaProfile(fakeViewer(), undefined), /^password=/m, "no key: no password line, Remmina asks");
  assert.equal(certificateStorePath("/cfg", "127.0.0.1", 40413), "/cfg/freerdp/server/127.0.0.1:40413_40413.pem");
  const env = clientEnv(GRAPHICAL);
  assert.equal(env[VIEW_TAG_ENV], undefined);
  assert.equal(env[MARKER_ENV], undefined);
  assert.equal(env.WAYLAND_DISPLAY, "wayland-0", "the client runs in the user's own session");
});

test("client choice: FreeRDP with H.264, then the Remmina snap, then another Remmina; FreeRDP without H.264 is skipped", async () => {
  const bins = new Set<string>();
  const isExecutable = (path: string) => bins.has(path);
  const h264 = new Map<string, string>();
  const deps = { env: { PATH: "/bin" }, isExecutable, exists: (path: string) => bins.has(path), buildconfig: async (program: string) => h264.get(program) ?? "" };
  assert.equal(await findRdpClient(deps), undefined);
  bins.add("/bin/remmina");
  assert.deepEqual(await findRdpClient(deps), { kind: "remmina", program: "/bin/remmina", snap: false });
  bins.add("/snap/bin/remmina");
  assert.deepEqual(await findRdpClient(deps), { kind: "remmina", program: "/snap/bin/remmina", snap: true }, "the snap (bundled FreeRDP with H.264) first");
  bins.add("/bin/xfreerdp3"); h264.set("/bin/xfreerdp3", "WITH_GFX_H264=OFF");
  assert.equal((await findRdpClient(deps))?.kind, "remmina", "a FreeRDP build without H.264 cannot show krdp's stream");
  bins.add("/bin/sdl-freerdp3"); h264.set("/bin/sdl-freerdp3", "... WITH_GFX_H264=ON ...");
  assert.deepEqual(await findRdpClient(deps), { kind: "freerdp", name: "sdl-freerdp3", program: "/bin/sdl-freerdp3" });
});

test("connect with the Remmina snap: profile (0600, TLS, AVC420, encrypted password), certificate pinned for this address, both removed on stop", async () => {
  const home = await scratch();
  const config = join(home, "snap", "remmina", "current", ".config");
  await mkdir(join(config, "remmina"), { recursive: true });
  await writeFile(join(config, "remmina", "remmina.pref"), `[remmina_pref]\nsecret=${SECRET}\n`);
  const certificate = join(home, "tls.crt");
  await writeFile(certificate, "-----BEGIN CERTIFICATE-----\nMIIfake\n-----END CERTIFICATE-----\n");
  const otherPin = certificateStorePath(config, "127.0.0.1", 33333);
  await mkdir(join(config, "freerdp", "server"), { recursive: true });
  await writeFile(otherPin, "the user's other certificate");
  const viewer = fakeViewer({ certificate });
  const { calls, spawn } = recordingSpawn();
  const result = await connectClient(viewer, { env: GRAPHICAL, home, exists: path => path === "/snap/bin/remmina", isExecutable: () => false, spawn });
  assert.ok("ok" in result && result.ok, JSON.stringify(result));
  assert.match(result.client, /Remmina \(snap\)/);
  assert.doesNotMatch(result.detail, new RegExp(PASSWORD), "the password is not in the message detail");
  assert.equal(calls.length, 1);
  const profile = join(home, "snap", "remmina", "common", "pi-gui-view", "W1-40413.remmina");
  assert.deepEqual([calls[0]!.command, ...calls[0]!.args], ["/snap/bin/remmina", "-c", profile]);
  assert.equal(calls[0]!.options.detached, true);
  assert.equal(calls[0]!.options.stdio, "ignore");
  assert.equal((calls[0]!.options.env as NodeJS.ProcessEnv)[VIEW_TAG_ENV], undefined, "no private-session marker in the client");
  assert.equal(statSync(profile).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, "snap", "remmina", "common", "pi-gui-view")).mode & 0o777, 0o700);
  const text = readFileSync(profile, "utf8");
  assert.doesNotMatch(text, new RegExp(PASSWORD), "never the plain password");
  assert.equal(remminaDecrypt(SECRET, /^password=(.+)$/m.exec(text)![1]!), PASSWORD, "Remmina decrypts it to the viewer's password");
  assert.match(text, /^security=tls$/m);
  assert.match(text, /^colordepth=65$/m);
  const pin = certificateStorePath(config, "127.0.0.1", 40413);
  assert.equal(readFileSync(pin, "utf8"), readFileSync(certificate, "utf8"), "FreeRDP's store trusts exactly this certificate for 127.0.0.1:40413");
  assert.equal(viewer.clientPid, undefined, "a Remmina launch hands over to Remmina's instance: not watched");

  runCleanups(viewer);
  assert.equal(existsSync(profile), false, "profile removed with the viewer");
  assert.equal(existsSync(pin), false, "pin removed with the viewer");
  assert.equal(readFileSync(otherPin, "utf8"), "the user's other certificate", "other entries untouched");
  runCleanups(viewer);
});

test("connect: a pin or profile that changed meanwhile is left alone; no Remmina key means Remmina asks for the password", async () => {
  const home = await scratch();
  const certificate = join(home, "tls.crt");
  await writeFile(certificate, "PEM");
  const viewer = fakeViewer({ certificate, port: 40500 });
  const env = { ...GRAPHICAL, PATH: join(home, "bin"), XDG_RUNTIME_DIR: join(home, "run"), XDG_CONFIG_HOME: join(home, "cfg") };
  await mkdir(join(home, "bin"));
  await writeFile(join(home, "bin", "remmina"), "#!/bin/sh\nexit 0\n");
  await chmod(join(home, "bin", "remmina"), 0o755);
  const { calls, spawn } = recordingSpawn();
  const result = await connectClient(viewer, { env, home, exists: () => false, spawn });
  assert.ok("ok" in result && result.ok);
  assert.match(result.detail, /Remmina asks for the password/);
  assert.match(result.detail, /system FreeRDP/, "a non-snap Remmina gets the H.264 caveat");
  assert.equal(calls[0]!.command, join(home, "bin", "remmina"));
  const profile = join(home, "run", "pi-gui-view", "W1-40500.remmina");
  assert.doesNotMatch(readFileSync(profile, "utf8"), /^password=/m);
  const pin = certificateStorePath(join(home, "cfg"), "127.0.0.1", 40500);
  await writeFile(pin, "accepted by the user in the meantime");
  runCleanups(viewer);
  assert.equal(existsSync(profile), false);
  assert.equal(readFileSync(pin, "utf8"), "accepted by the user in the meantime");
});

test("connect with FreeRDP: TLS, AVC420, the certificate fingerprint; a repeated /gui view reuses a running client", async () => {
  const deps = { env: { ...GRAPHICAL, PATH: "/bin" }, isExecutable: (path: string) => path === "/bin/xfreerdp3", exists: () => false, buildconfig: async () => "WITH_GFX_H264=ON" };
  const viewer = fakeViewer();
  const first = recordingSpawn({ pid: 777 });
  const result = await autoConnect(viewer, "started", { ...deps, spawn: first.spawn });
  assert.ok("ok" in result && result.ok);
  assert.deepEqual(first.calls[0]!.args, ["/v:127.0.0.1:40413", "/u:pi", `/p:${PASSWORD}`, "/sec:tls", "/gfx:avc420", "/cert:fingerprint:sha256:abcdef", "/title:pi-gui W1"]);
  assert.equal(viewer.clientPid, 777);
  const again = recordingSpawn();
  assert.deepEqual(await autoConnect(viewer, "running", { ...deps, spawn: again.spawn, isAlive: () => true }), { skipped: "the client opened for it is still running (pid 777)" });
  assert.equal(again.calls.length, 0, "no second window while the first runs");
  const reopened = await autoConnect(viewer, "running", { ...deps, spawn: again.spawn, isAlive: () => false });
  assert.ok("ok" in reopened && reopened.ok, "the client was closed: open it again");
  assert.equal(again.calls.length, 1);
});

test("connect fails with a reason, never throws: no graphical session, no client, the program does not start", async () => {
  const viewer = fakeViewer();
  const none = await connectClient(viewer, { env: { PATH: "/bin" }, isExecutable: () => true, spawn: recordingSpawn().spawn });
  assert.ok("reason" in none && /no graphical session/.test(none.reason));
  const missing = await connectClient(viewer, { env: { ...GRAPHICAL, PATH: "/bin" }, isExecutable: () => false, exists: () => false });
  assert.ok("reason" in missing && /no RDP client found.*snap install remmina/.test(missing.reason));
  const broken = await connectClient(viewer, { env: { ...GRAPHICAL, PATH: "/bin" }, isExecutable: path => path === "/bin/xfreerdp3", exists: () => false, buildconfig: async () => "WITH_GFX_H264=ON", spawn: recordingSpawn({ fail: "spawn /bin/xfreerdp3 ENOENT" }).spawn });
  assert.ok("reason" in broken && /could not start \/bin\/xfreerdp3: spawn \/bin\/xfreerdp3 ENOENT/.test(broken.reason));
});

test("connection message: client line, password redacted from client errors, manual instructions kept", () => {
  const viewer = fakeViewer();
  const failed = connectionMessage(viewer, "started", { client: { ok: false, reason: `boom ${PASSWORD}` } });
  assert.match(failed, /RDP client: could not open one automatically: boom <password>\. Connect by hand:/);
  assert.equal(failed.split(PASSWORD).length, 2, "the password appears once: its own line");
  assert.match(failed, /not saved anywhere/);
  assert.match(failed, /xfreerdp3 \/v:127\.0\.0\.1:40413 .*\/sec:tls \/gfx:avc420 \/cert:fingerprint:sha256:abcdef/);
  const opened = connectionMessage(viewer, "started", { client: { ok: true, client: "Remmina (snap) (/snap/bin/remmina)", detail: "TLS; profile /p/W1-40413.remmina, removed when the viewer stops" } });
  assert.match(opened, /RDP client: opened Remmina \(snap\) \(\/snap\/bin\/remmina\) on your screen for 127\.0\.0\.1:40413/);
  assert.match(opened, /kept only in the client's profile, removed when the viewer stops/);
  assert.match(connectionMessage(viewer, "running", { client: { skipped: "off" } }), /RDP client: not opened automatically \(off\)\./);
  assert.doesNotMatch(connectionMessage(viewer, "started"), /RDP client:/, "no auto-connect configured: the old message");
});

test("config: viewerAutoConnect is a boolean, on by default, user config only", () => {
  assert.equal(DEFAULT_GUI_CONFIG.viewerAutoConnect, true);
  assert.deepEqual(validateGuiConfig({ viewerAutoConnect: false }), { viewerAutoConnect: false });
  assert.throws(() => validateGuiConfig({ viewerAutoConnect: "no" }), /viewerAutoConnect must be a boolean/);
  assert.throws(() => validateGuiConfig({ viewerAutoConnect: true }, { project: true }), /only allowed in the user config/);
});

test("view registry: auto-connect runs inside the target's section, so stop/release after it removes what it set up", async () => {
  const session: PrivateSession = { runtimeDir: "/tmp/computer-use-mcp-isolated-AAAAAA", display: "wayland-virtual-1", marker: "m", pids: [] };
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let serial = 0;
  const registry = new ViewRegistry({
    find: () => ({ ok: true, session }),
    start: async target => fakeViewer({ target, port: 41000 + ++serial }),
    stop: async viewer => { events.push(`stop ${viewer.port}`); runCleanups(viewer); },
    connect: async (viewer, kind) => {
      events.push(`connect ${kind} ${viewer.port}`);
      if (kind === "started" && viewer.port === 41001) await gate;
      (viewer.cleanups ??= []).push(() => events.push(`cleanup ${viewer.port}`));
      if (viewer.port === 41002) throw new Error(`exploded with ${viewer.password}`);
      return { ok: true, client: "fake", detail: "" };
    },
    log: line => events.push(`log ${line}`),
  });
  const target = registry.register("W1", "t1");
  const viewing = registry.view(target);
  await new Promise(resolve => setTimeout(resolve, 20));
  const stopping = registry.stop(target);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(!events.includes("stop 41001"), "the stop waits for the client launch in progress");
  release();
  const outcome = await viewing;
  assert.ok(outcome.kind === "started" && outcome.client && "ok" in outcome.client && outcome.client.ok);
  assert.equal(await stopping, true);
  assert.deepEqual(events.filter(line => !line.startsWith("log ")), ["connect started 41001", "stop 41001", "cleanup 41001"], "then the stop removed what the launch set up");
  const failed = await registry.view(target);
  assert.ok(failed.kind === "started" && failed.client && "reason" in failed.client && /exploded/.test(failed.client.reason), "a throwing connect is a reason, the viewer still runs");
  assert.ok(!events.some(line => line.includes(PASSWORD)), "the password is not logged");
  assert.ok(events.includes("log view W1: could not open a client: exploded with <password>"));
  await registry.release("t1");
  assert.ok(events.includes("cleanup 41002"), "release (the worker ended) runs the cleanup too");
});
