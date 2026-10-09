import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomInt, X509Certificate } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { basename, isAbsolute, join } from "node:path";
import { PHYSICAL_SESSION_ENV, which } from "./backend.ts";
import { run, type Check } from "./prerequisites.ts";

/**
 * `/gui view`: a remote-desktop server inside one private desktop, so the user can see and operate it (sign-ins, 2FA).
 *
 * The server is KDE's krdp (`krdpserver`, RDP). It joins the private session the way an app started there would: the
 * session's Wayland display, D-Bus, PipeWire and portals, found through the server process tree (see
 * {@link findPrivateSession}). It captures and injects through the session's own xdg-desktop-portal RemoteDesktop/ScreenCast,
 * which the runner pre-authorizes on the private bus only, so no consent dialog appears. The physical session is never
 * reached: its variables are removed from the server's environment.
 */

/** Environment variable carrying a random per-server tag; every process of that server's private session inherits it. */
export const VIEW_TAG_ENV = "PI_GUI_VIEW_TAG";
export const VIEW_HOST = "127.0.0.1";
export const VIEW_USER = "pi";
export const KRDP_PROGRAM = { name: "krdpserver", candidates: ["/usr/bin/krdpserver"], apt: "krdp" } as const;
export const OPENSSL_PROGRAM = { name: "openssl", candidates: ["/usr/bin/openssl"], apt: "openssl" } as const;
/** Upstream runner names: `mktemp -d -t computer-use-mcp-isolated-XXXXXX`, `wayland-virtual-$$`, `$RUNTIME_DIR/isolation.ready`. */
export const RUNTIME_DIR_NAME = /^computer-use-mcp-isolated-[A-Za-z0-9]{6,}$/;
export const DISPLAY_NAME = /^wayland-virtual-\d+$/;
export const MARKER_FILE = "isolation.ready";
export const MARKER_ENV = "COMPUTER_USE_MCP_ISOLATION_MARKER";
/**
 * App IDs the KDE portal may assign to krdp. The runner grants the unnamed host app (''); krdp registers as
 * `org.kde.krdp-server` when its desktop file is found and ships `org.kde.krdpserver.desktop`.
 */
export const KRDP_APP_IDS = ["", "org.kde.krdp-server", "org.kde.krdpserver"] as const;

export function newViewTag(): string {
  return randomBytes(16).toString("hex");
}

/** Alphanumeric only: safe as one argument and in any client's password field. ~119 bits. */
export function newPassword(length = 20): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

// ---------------------------------------------------------------- locating a server's private session

export interface PrivateSession {
  /** `/tmp/computer-use-mcp-isolated-XXXXXX` (the private XDG_RUNTIME_DIR). */
  runtimeDir: string;
  /** `wayland-virtual-<runner pid>`. */
  display: string;
  /** `<runtimeDir>/isolation.ready`; processes carrying it in their environment are stopped by the runner's teardown. */
  marker: string;
  /** Processes of the session that carry the tag (evidence). */
  pids: number[];
}

export interface ProcSource {
  pids(): number[];
  ppid(pid: number): number | undefined;
  uid(pid: number): number | undefined;
  environ(pid: number): Record<string, string> | undefined;
}

export interface PathInfo { uid: number; mode: number; kind: "dir" | "file" | "socket" | "other" }
export type PathProbe = (path: string) => PathInfo | undefined;

export const procSource: ProcSource = {
  pids: () => {
    try { return readdirSync("/proc").filter(name => /^\d+$/.test(name)).map(Number); } catch { return []; }
  },
  ppid: pid => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const value = Number(fields[1]);
      return Number.isInteger(value) ? value : undefined;
    } catch { return undefined; }
  },
  uid: pid => {
    try { return lstatSync(`/proc/${pid}`).uid; } catch { return undefined; }
  },
  environ: pid => {
    try { return parseEnviron(readFileSync(`/proc/${pid}/environ`)); } catch { return undefined; }
  },
};

export const probePath: PathProbe = path => {
  try {
    const stat = lstatSync(path);
    return { uid: stat.uid, mode: stat.mode & 0o7777, kind: stat.isDirectory() ? "dir" : stat.isFile() ? "file" : stat.isSocket() ? "socket" : "other" };
  } catch { return undefined; }
};

export function parseEnviron(raw: Buffer | string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of raw.toString().split("\0")) {
    const at = entry.indexOf("=");
    if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return env;
}

/** Every descendant of `root` (not `root` itself), from one snapshot of the process table. */
export function descendants(root: number, proc: Pick<ProcSource, "pids" | "ppid">): number[] {
  const children = new Map<number, number[]>();
  for (const pid of proc.pids()) {
    const parent = proc.ppid(pid);
    if (parent === undefined) continue;
    const list = children.get(parent) ?? [];
    list.push(pid);
    children.set(parent, list);
  }
  const found: number[] = [];
  const queue = [...(children.get(root) ?? [])];
  const seen = new Set<number>([root]);
  while (queue.length) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    found.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return found;
}

export type SessionLookup = { ok: true; session: PrivateSession } | { ok: false; reason: "none" | "ambiguous" | "invalid"; error: string };

/**
 * The private session of the server tagged `tag`: processes below `root` (this Pi process, which spawned the server),
 * owned by `uid`, whose environment carries the tag and the runner's session variables. A candidate counts only when
 * its runtime directory is the runner's (name, owner, mode 0700, readiness marker, Wayland and bus sockets). Other
 * servers, other users and the physical session never match: they lack the tag, the ancestry or the private paths.
 */
export function findPrivateSession(tag: string, options: { root: number; uid: number; proc?: ProcSource; probe?: PathProbe }): SessionLookup {
  const proc = options.proc ?? procSource;
  const probe = options.probe ?? probePath;
  const groups = new Map<string, PrivateSession>();
  const rejected: string[] = [];
  for (const pid of descendants(options.root, proc)) {
    if (proc.uid(pid) !== options.uid) continue;
    const env = proc.environ(pid);
    if (!env || env[VIEW_TAG_ENV] !== tag) continue;
    const runtimeDir = env.XDG_RUNTIME_DIR;
    const display = env.WAYLAND_DISPLAY;
    const marker = env[MARKER_ENV];
    if (!runtimeDir || !display || !marker) continue; // the server itself, before or outside its private session
    const key = `${runtimeDir}\0${display}\0${marker}`;
    const existing = groups.get(key);
    if (existing) { existing.pids.push(pid); continue; }
    const problem = sessionProblem(runtimeDir, display, marker, options.uid, probe);
    if (problem) { rejected.push(`${runtimeDir}: ${problem}`); continue; }
    groups.set(key, { runtimeDir, display, marker, pids: [pid] });
  }
  const sessions = [...groups.values()];
  if (sessions.length === 1) return { ok: true, session: sessions[0]! };
  if (sessions.length > 1) {
    return { ok: false, reason: "ambiguous", error: `several private desktops carry this server's tag (${sessions.map(item => item.display).join(", ")}); try again when the server has replaced its desktop` };
  }
  if (rejected.length) return { ok: false, reason: "invalid", error: `no verifiable private desktop (${rejected.join("; ")})` };
  return { ok: false, reason: "none", error: "its private desktop has not started yet (it starts with the first GUI call) or has stopped" };
}

function sessionProblem(runtimeDir: string, display: string, marker: string, uid: number, probe: PathProbe): string | undefined {
  if (!isAbsolute(runtimeDir) || !RUNTIME_DIR_NAME.test(basename(runtimeDir))) return "not a runner directory";
  if (!DISPLAY_NAME.test(display)) return `display ${display} is not a private one`;
  if (marker !== join(runtimeDir, MARKER_FILE)) return "readiness marker does not belong to the directory";
  const dir = probe(runtimeDir);
  if (!dir || dir.kind !== "dir") return "directory is gone";
  if (dir.uid !== uid) return "directory belongs to another user";
  if ((dir.mode & 0o077) !== 0) return "directory is not private (mode)";
  if (probe(marker)?.kind !== "file") return "not ready (no readiness marker)";
  if (probe(join(runtimeDir, display))?.kind !== "socket") return "no Wayland socket";
  if (probe(join(runtimeDir, "bus"))?.kind !== "socket") return "no session bus socket";
  return undefined;
}

// ---------------------------------------------------------------- the server process

/** Variables that lead to the user's session or would be wrong inside the private one; removed before the private ones are set. */
const HOST_ONLY_ENV = [
  ...PHYSICAL_SESSION_ENV, "DBUS_STARTER_ADDRESS", "DBUS_STARTER_BUS_TYPE", "DBUS_SESSION_BUS_PID", "DBUS_SESSION_BUS_WINDOWID",
  "DBUS_SYSTEM_BUS_ADDRESS", "SESSION_MANAGER", "XDG_SESSION_ID", "XDG_SEAT", "XDG_VTNR", "KDE_SESSION_UID", VIEW_TAG_ENV,
];

/**
 * The server's environment: the caller's, minus every physical-session variable, plus the private session's own values
 * as upstream's runner exports them to the apps it hosts. The runner's marker makes its teardown stop the server too.
 */
export function viewerEnv(base: NodeJS.ProcessEnv, session: PrivateSession, scratchDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of HOST_ONLY_ENV) delete env[name];
  const dir = session.runtimeDir;
  return {
    ...env,
    XDG_RUNTIME_DIR: dir,
    WAYLAND_DISPLAY: session.display,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${dir}/bus`,
    AT_SPI_BUS_ADDRESS: `unix:path=${dir}/at-spi/bus`,
    PIPEWIRE_RUNTIME_DIR: dir,
    PIPEWIRE_REMOTE: "pipewire-0",
    XDG_SESSION_TYPE: "wayland",
    XDG_CURRENT_DESKTOP: "KDE",
    XDG_SESSION_DESKTOP: "KDE",
    KDE_FULL_SESSION: "true",
    QT_QPA_PLATFORM: "wayland",
    XDG_CONFIG_HOME: `${dir}/config`,
    XDG_DATA_HOME: `${dir}/data`,
    XDG_STATE_HOME: `${dir}/state`,
    KDEHOME: `${dir}/kdehome`,
    TMPDIR: scratchDir,
    [MARKER_ENV]: session.marker,
  };
}

export interface KrdpOptions { user: string; password: string; port: number; certificate: string; key: string }

/** krdpserver arguments: loopback only, one user with a one-time password, the generated TLS certificate. */
export function krdpArgs(options: KrdpOptions): string[] {
  return [
    `--username=${options.user}`, `--password=${options.password}`,
    `--address=${VIEW_HOST}`, `--port=${options.port}`,
    `--certificate=${options.certificate}`, `--certificate-key=${options.key}`,
  ];
}

/** `AB:CD:…` → `abcd…`. */
export function fingerprintHex(fingerprint: string): string {
  return fingerprint.replace(/:/g, "").toLowerCase();
}

/** A port on 127.0.0.1 that was free a moment ago (the server is started on it right away; a lost race is retried). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, VIEW_HOST, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

export function portOpen(port: number, host = VIEW_HOST, timeoutMs = 1_000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** A self-signed certificate for this viewer only, in its private scratch directory (key mode 0600). */
export async function makeCertificate(openssl: string, dir: string): Promise<{ certificate: string; key: string; fingerprint: string }> {
  const certificate = join(dir, "tls.crt");
  const key = join(dir, "tls.key");
  const result = await run(openssl, [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
    "-subj", "/CN=pi-gui-view", "-addext", `subjectAltName=IP:${VIEW_HOST}`,
    "-keyout", key, "-out", certificate,
  ], { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`openssl could not create the TLS certificate: ${(result.error ?? result.stderr.trim().split("\n").at(-1)) || `exit ${result.code}`}`);
  const fingerprint = new X509Certificate(await readFile(certificate)).fingerprint256;
  return { certificate, key, fingerprint };
}

/** Pre-authorize krdp's possible app IDs for RemoteDesktop in the private session's portal permission store (private bus only). */
export async function grantPortal(gdbus: string, session: PrivateSession): Promise<string[]> {
  const failures: string[] = [];
  for (const appId of KRDP_APP_IDS) {
    const result = await run(gdbus, [
      "call", "--address", `unix:path=${session.runtimeDir}/bus`,
      "--dest", "org.freedesktop.impl.portal.PermissionStore", "--object-path", "/org/freedesktop/impl/portal/PermissionStore",
      "--method", "org.freedesktop.impl.portal.PermissionStore.SetPermission",
      "kde-authorized", "true", "remote-desktop", appId, "['yes']",
    ], { timeoutMs: 10_000 });
    if (result.code !== 0) failures.push(`${appId || "''"}: ${(result.error ?? result.stderr.trim().split("\n").at(-1)) || `exit ${result.code}`}`);
  }
  return failures;
}

export interface RunningViewer {
  target: string;
  session: PrivateSession;
  pid: number;
  host: string;
  port: number;
  user: string;
  password: string;
  fingerprint: string;
  scratchDir: string;
  startedAt: number;
  /** Set once the process has exited. */
  exited?: { code: number | null; signal: NodeJS.Signals | null };
  child: ChildProcess;
  exitPromise: Promise<void>;
  /** The server's recent output, password redacted (never written to disk). */
  output: string[];
}

export interface StartDeps {
  krdp: string;
  openssl: string;
  gdbus?: string;
  env?: NodeJS.ProcessEnv;
  port?: () => Promise<number>;
  password?: () => string;
  certificate?: typeof makeCertificate;
  grant?: typeof grantPortal;
  readyTimeoutMs?: number;
  log?: (line: string) => void;
}

export function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("<password>") : text;
}

/** Start krdp in `session`. Retries on a port lost to a race; never logs the password. */
export async function startViewer(target: string, session: PrivateSession, deps: StartDeps): Promise<RunningViewer> {
  const scratchDir = await mkdtemp(join(session.runtimeDir, "pi-gui-view-"));
  try {
    const { certificate, key, fingerprint } = await (deps.certificate ?? makeCertificate)(deps.openssl, scratchDir);
    if (deps.gdbus) {
      const failures = await (deps.grant ?? grantPortal)(deps.gdbus, session);
      if (failures.length) deps.log?.(`view ${target}: portal pre-authorization incomplete (${failures.join("; ")}); relying on the runner's grant`);
    }
    const password = (deps.password ?? newPassword)();
    let lastError = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const port = await (deps.port ?? freePort)();
      const started = await launch(target, session, { krdp: deps.krdp, env: deps.env, readyTimeoutMs: deps.readyTimeoutMs, password, port, certificate, key, fingerprint, scratchDir });
      if ("viewer" in started) return started.viewer;
      lastError = started.error;
      if (!started.retry) break;
    }
    throw new Error(lastError);
  } catch (error) {
    rmSync(scratchDir, { recursive: true, force: true });
    throw error;
  }
}

async function launch(
  target: string, session: PrivateSession,
  options: { krdp: string; env: NodeJS.ProcessEnv | undefined; readyTimeoutMs: number | undefined; password: string; port: number; certificate: string; key: string; fingerprint: string; scratchDir: string },
): Promise<{ viewer: RunningViewer } | { error: string; retry: boolean }> {
  const args = krdpArgs({ user: VIEW_USER, password: options.password, port: options.port, certificate: options.certificate, key: options.key });
  const output: string[] = [];
  let child: ChildProcess;
  try {
    child = spawn(options.krdp, args, { env: viewerEnv(options.env ?? process.env, session, options.scratchDir), stdio: ["ignore", "pipe", "pipe"], detached: true });
  } catch (error) {
    return { error: `could not start ${options.krdp}: ${(error as Error).message}`, retry: false };
  }
  let exited: RunningViewer["exited"];
  const exitPromise = new Promise<void>(resolve => {
    child.once("exit", (code, signal) => { exited = { code, signal }; resolve(); });
    child.once("error", error => { output.push(redact(`spawn error: ${error.message}`, options.password)); exited ??= { code: null, signal: null }; resolve(); });
  });
  let ready = false;
  const onData = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      output.push(redact(line.trimEnd(), options.password).slice(0, 300));
      if (output.length > 40) output.shift();
      if (/Listening for connections/i.test(line)) ready = true;
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  const deadline = Date.now() + (options.readyTimeoutMs ?? 20_000);
  while (!exited && Date.now() < deadline) {
    if (ready && await portOpen(options.port)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const tail = () => output.filter(line => !/^\[\d|^libva info/.test(line)).slice(-3).join(" | ") || "no output";
  if (exited) {
    return { error: `${basename(options.krdp)} exited (${exited.code ?? exited.signal}) before listening: ${tail()}`, retry: /listen|address|port/i.test(output.join("\n")) };
  }
  if (!ready) {
    killGroup(child.pid, "SIGKILL");
    await Promise.race([exitPromise, new Promise(resolve => setTimeout(resolve, 2_000))]);
    return { error: `${basename(options.krdp)} did not listen on ${VIEW_HOST}:${options.port} within ${Math.round((options.readyTimeoutMs ?? 20_000) / 1000)} s: ${tail()}`, retry: false };
  }
  const viewer: RunningViewer = {
    target, session, pid: child.pid!, host: VIEW_HOST, port: options.port, user: VIEW_USER, password: options.password,
    fingerprint: options.fingerprint, scratchDir: options.scratchDir, startedAt: Date.now(), child, exitPromise, output,
  };
  void exitPromise.then(() => { viewer.exited = exited; });
  return { viewer };
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* gone */ } }
}

/** SIGTERM to the server's process group, SIGKILL after `graceMs`, then remove its scratch directory (certificate, key). */
export async function stopViewer(viewer: RunningViewer, graceMs = 3_000): Promise<void> {
  if (!viewer.exited) {
    killGroup(viewer.pid, "SIGTERM");
    const timer = new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), graceMs).unref());
    if (await Promise.race([viewer.exitPromise.then(() => "exited" as const), timer]) === "timeout") {
      killGroup(viewer.pid, "SIGKILL");
      await Promise.race([viewer.exitPromise, new Promise(resolve => setTimeout(resolve, 2_000).unref())]);
    }
  }
  rmSync(viewer.scratchDir, { recursive: true, force: true });
}

/** On process exit: synchronous, best effort. */
export function killViewerSync(viewer: RunningViewer): void {
  if (!viewer.exited) killGroup(viewer.pid, "SIGKILL");
  try { rmSync(viewer.scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ---------------------------------------------------------------- targets: the main session and each GUI worker

export interface ViewTarget {
  /** `main`, `W1`, … (unique among live targets). */
  name: string;
  tag: string;
  viewer?: RunningViewer;
  /** Set when the server's session has ended. */
  released?: boolean;
  /** Serializes view/stop of this target, so a second `/gui view` waits for a start in progress instead of starting another server. */
  queue?: Promise<void>;
}

export interface RegistryDeps {
  find: (tag: string) => SessionLookup;
  start: (target: string, session: PrivateSession) => Promise<RunningViewer>;
  stop?: (viewer: RunningViewer) => Promise<void>;
  log?: (line: string) => void;
}

export type ViewOutcome =
  | { kind: "started" | "running"; viewer: RunningViewer; replaced?: boolean }
  | { kind: "error"; message: string };

/**
 * The servers a user can view, by name. Workers register when their session starts and are released when it shuts
 * down (orche disposes idle workers that way); releasing stops the viewer.
 */
export class ViewRegistry {
  private readonly targets = new Map<string, ViewTarget>();
  private readonly deps: RegistryDeps;
  constructor(deps: RegistryDeps) { this.deps = deps; }

  /** Register a server; a taken name gets a suffix (`W3-2`). Re-registering a tag renames it. */
  register(name: string, tag: string): ViewTarget {
    const existing = [...this.targets.values()].find(target => target.tag === tag);
    if (existing) {
      if (existing.name === name) return existing;
      this.targets.delete(existing.name);
      existing.name = this.unique(name);
      this.targets.set(existing.name, existing);
      return existing;
    }
    const target: ViewTarget = { name: this.unique(name), tag };
    this.targets.set(target.name, target);
    return target;
  }

  private unique(name: string): string {
    if (!this.targets.has(name)) return name;
    for (let i = 2; ; i++) if (!this.targets.has(`${name}-${i}`)) return `${name}-${i}`;
  }

  list(): ViewTarget[] {
    return [...this.targets.values()].sort((a, b) => a.name === "main" ? -1 : b.name === "main" ? 1 : a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  get(name: string): ViewTarget | undefined {
    return this.targets.get(name) ?? [...this.targets.values()].find(target => target.name.toLowerCase() === name.toLowerCase());
  }

  /** The target a command means: the named one, or the only GUI worker when no name is given. */
  resolve(name: string | undefined): { target: ViewTarget } | { error: string } {
    if (name) {
      const target = this.get(name);
      return target ? { target } : { error: `no GUI desktop named "${name}". ${this.describe()}` };
    }
    const workers = this.list().filter(target => target.name !== "main");
    if (workers.length === 1) return { target: workers[0]! };
    if (workers.length === 0) {
      const main = this.targets.get("main");
      return main ? { target: main } : { error: `no GUI worker is running (start one with orche_task gui: true). ${this.describe()}` };
    }
    return { error: `several GUI desktops; name one: /gui view <name>. ${this.describe()}` };
  }

  describe(): string {
    const items = this.list();
    if (!items.length) return "Desktops: none.";
    return `Desktops: ${items.map(target => `${target.name}${target.viewer && !target.viewer.exited ? ` (viewer on ${target.viewer.host}:${target.viewer.port})` : ""}`).join(", ")}.`;
  }

  private async exclusive<T>(target: ViewTarget, action: () => Promise<T>): Promise<T> {
    const previous = target.queue ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>(resolve => { release = resolve; });
    target.queue = previous.then(() => mine);
    await previous;
    try { return await action(); } finally { release(); }
  }

  /** Start a viewer, or return the running one (restarted when its desktop has been replaced or it has exited). */
  view(target: ViewTarget): Promise<ViewOutcome> {
    return this.exclusive(target, async (): Promise<ViewOutcome> => {
      if (target.released) return { kind: "error", message: `${target.name} has ended` };
      const lookup = this.deps.find(target.tag);
      const current = target.viewer;
      if (current && !current.exited && lookup.ok && lookup.session.runtimeDir === current.session.runtimeDir && lookup.session.display === current.session.display) {
        return { kind: "running", viewer: current };
      }
      let replaced = false;
      if (current) {
        replaced = !current.exited;
        target.viewer = undefined;
        await (this.deps.stop ?? stopViewer)(current);
        this.deps.log?.(`view ${target.name}: previous viewer ${current.exited ? "had exited" : "stopped (its desktop was replaced)"}`);
      }
      if (!lookup.ok) return { kind: "error", message: `${target.name}: ${lookup.error}` };
      try {
        const viewer = await this.deps.start(target.name, lookup.session);
        target.viewer = viewer;
        this.deps.log?.(`view ${target.name}: krdp pid ${viewer.pid} listening on ${viewer.host}:${viewer.port} for ${lookup.session.display}`);
        void viewer.exitPromise.then(() => {
          if (target.viewer === viewer) this.deps.log?.(`view ${target.name}: viewer exited (${viewer.exited?.code ?? viewer.exited?.signal ?? "?"})`);
        });
        return { kind: "started", viewer, replaced };
      } catch (error) {
        this.deps.log?.(`view ${target.name}: failed: ${(error as Error).message}`);
        return { kind: "error", message: `${target.name}: ${(error as Error).message}` };
      }
    });
  }

  /** Stop the viewer of one target (after a start in progress); true when there was one. */
  stop(target: ViewTarget): Promise<boolean> {
    return this.exclusive(target, async () => {
      const viewer = target.viewer;
      target.viewer = undefined;
      if (!viewer) return false;
      await (this.deps.stop ?? stopViewer)(viewer);
      this.deps.log?.(`view ${target.name}: viewer stopped`);
      return true;
    });
  }

  async stopAll(): Promise<string[]> {
    const stopped: string[] = [];
    for (const target of this.list()) if (await this.stop(target)) stopped.push(target.name);
    return stopped;
  }

  /** A server's session ended: stop its viewer and forget it. */
  async release(tag: string): Promise<void> {
    const target = [...this.targets.values()].find(item => item.tag === tag);
    if (!target) return;
    this.targets.delete(target.name);
    target.released = true;
    await this.stop(target);
  }

  killAllSync(): void {
    for (const target of this.targets.values()) if (target.viewer) killViewerSync(target.viewer);
  }
}

/** The message `/gui view` prints: where to connect, with what, and how to finish. */
export function connectionMessage(viewer: RunningViewer, kind: "started" | "running", options: { replaced?: boolean } = {}): string {
  const address = `${viewer.host}:${viewer.port}`;
  const hex = fingerprintHex(viewer.fingerprint);
  const isWorker = viewer.target !== "main";
  return [
    `${kind === "started" ? (options.replaced ? "Restarted the" : "Started a") : "Already running:"} remote desktop (RDP, krdp) for ${viewer.target}'s private desktop ${viewer.session.display}. Local connections only; it stops with /gui view stop ${viewer.target}${isWorker ? " or when the worker ends" : ""}.`,
    `  Address:   ${address}`,
    `  User:      ${viewer.user}`,
    `  Password:  ${viewer.password}   (one-time, for this viewer only; not saved anywhere)`,
    `  TLS:       self-signed, SHA-256 ${viewer.fingerprint}`,
    "Connect with an RDP client that decodes H.264 (krdp streams only H.264/AVC420; distribution FreeRDP builds, and the Remmina/KRDC that use them, may lack it: /gui doctor checks FreeRDP command-line clients, README > Clients covers Remmina):",
    `  xfreerdp3 /v:${address} /u:${viewer.user} /sec:tls /gfx:avc420 /cert:fingerprint:sha256:${hex}   (FreeRDP with H.264; asks for the password)`,
    `  Remmina (snap: \`snap run remmina\`, or Flatpak with the openh264 extension): new RDP profile, server ${address}, user ${viewer.user}, Advanced > Security protocol negotiation "TLS protocol security" (not "Automatic"/NLA: krdp cannot check passwords over NLA, so every login fails and the password prompt returns); accept the certificate whose fingerprint matches.`,
    isWorker
      ? `While you operate the desktop, give ${viewer.target} no assignment. When done: /gui view stop ${viewer.target}, then continue with orche_task worker: "${viewer.target}" (same desktop, same signed-in apps).`
      : "While you operate the desktop, let this session's agent wait. When done: /gui view stop main.",
  ].join("\n");
}

export function resolveProgram(program: { name: string; candidates: readonly string[] }, configured: string | null, env: NodeJS.ProcessEnv = process.env, isExecutable?: (path: string) => boolean): string | undefined {
  if (configured) return which(configured, env, isExecutable);
  return which(program.name, env, isExecutable) ?? program.candidates.find(candidate => which(candidate, env, isExecutable));
}

/** The server config with this server's view tag (inherited by every process of its private session). */
export function withViewTag<T extends { env?: Record<string, string> }>(server: T, tag: string): T {
  return { ...server, env: { ...server.env, [VIEW_TAG_ENV]: tag } };
}

export interface ViewerPrerequisites {
  ok: boolean;
  checks: Check[];
  missing: string[];
  krdp?: string;
  openssl?: string;
  gdbus?: string;
}

/** Programs `/gui view` runs: krdp (the server), openssl (its TLS certificate), gdbus (private portal grant; optional). */
export function checkViewerPrerequisites(viewerCommand: string | null, deps: { env?: NodeJS.ProcessEnv; isExecutable?: (path: string) => boolean } = {}): ViewerPrerequisites {
  const env = deps.env ?? process.env;
  const krdp = resolveProgram(KRDP_PROGRAM, viewerCommand, env, deps.isExecutable);
  const openssl = resolveProgram(OPENSSL_PROGRAM, null, env, deps.isExecutable);
  const gdbusOverride = env.COMPUTER_USE_MCP_GDBUS_BIN;
  const gdbus = resolveProgram({ name: "gdbus", candidates: ["/usr/bin/gdbus"] }, gdbusOverride || null, env, deps.isExecutable);
  const checks: Check[] = [
    { name: "krdpserver (KDE RDP server)", ok: !!krdp, detail: krdp ?? (viewerCommand ? `viewerCommand ${viewerCommand} is not an executable` : "not found"), apt: KRDP_PROGRAM.apt },
    { name: "openssl (viewer TLS certificate)", ok: !!openssl, detail: openssl ?? "not found", apt: OPENSSL_PROGRAM.apt },
  ];
  const missing = checks.filter(check => !check.ok).map(check => `${check.name} (apt: ${check.apt})`);
  return { ok: missing.length === 0, checks, missing, ...(krdp ? { krdp } : {}), ...(openssl ? { openssl } : {}), ...(gdbus ? { gdbus } : {}) };
}

export const FREERDP_CLIENTS = ["xfreerdp3", "sdl-freerdp3", "wlfreerdp3", "xfreerdp", "sdl-freerdp", "wlfreerdp"] as const;

/** `WITH_GFX_H264=ON` in FreeRDP's `/buildconfig`; undefined when the output does not say. */
export function freerdpHasH264(buildconfig: string): boolean | undefined {
  const match = /WITH_GFX_H264=(ON|OFF)/.exec(buildconfig);
  return match ? match[1] === "ON" : undefined;
}

/** One line per RDP client found on this host, with its H.264 support where it can be read. Never connects anywhere. */
export async function probeRdpClients(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = path => !!probePath(path)): Promise<string[]> {
  const lines: string[] = [];
  for (const name of FREERDP_CLIENTS) {
    const path = which(name, env);
    if (!path) continue;
    const result = await run(path, ["/buildconfig"], { timeoutMs: 10_000 });
    const h264 = freerdpHasH264(result.stdout + result.stderr);
    lines.push(`${name} (${path}): ${h264 === undefined ? "H.264 unknown" : h264 ? "H.264 yes — usable" : "H.264 no — cannot show krdp's stream"}`);
  }
  for (const name of ["remmina", "krdc"]) {
    const path = which(name, env);
    if (path) lines.push(`${name} (${path}): ${path.startsWith("/snap/") ? "snap build (bundles its own FreeRDP)" : "uses the system FreeRDP library; H.264 only if that build has it"}`);
  }
  if (!which("remmina", env) && exists("/snap/bin/remmina")) lines.push("remmina (/snap/bin/remmina): snap build (bundles its own FreeRDP)");
  const flatpak = which("flatpak", env);
  if (flatpak) {
    const result = await run(flatpak, ["list", "--app", "--columns=application"], { timeoutMs: 10_000 });
    for (const id of ["org.remmina.Remmina", "com.freerdp.FreeRDP", "org.kde.krdc"]) if (result.stdout.split("\n").some(line => line.trim() === id)) lines.push(`${id} (Flatpak)`);
  }
  return lines;
}
