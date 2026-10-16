import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createCipheriv } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "./backend.ts";
import { run } from "./prerequisites.ts";
import { fingerprintHex, FREERDP_CLIENTS, freerdpHasH264, MARKER_ENV, VIEW_TAG_ENV, type ClientOutcome, type RunningViewer } from "./viewer.ts";

/**
 * `/gui view` auto-connect: open an RDP client on the user's own screen, connected to the viewer that was just started
 * (or is already running), so the user does not have to copy address, user, password and fingerprint by hand.
 *
 * Which client: a FreeRDP command-line client whose `/buildconfig` says `WITH_GFX_H264=ON` (krdp streams only H.264),
 * else Remmina (the snap first: it bundles a FreeRDP with H.264; README > Clients). Remmina gets a profile file with TLS
 * security (not NLA, which krdp cannot check), GFX AVC420, user and password (encrypted with Remmina's own key, the way
 * Remmina stores passwords in profiles), and the viewer's certificate is put into FreeRDP's certificate store for exactly
 * `127.0.0.1:<port>` so it is accepted without a prompt and only that certificate is. Both files are removed when the
 * viewer stops. The client runs with Pi's own environment (the user's graphical session), never inside the private one.
 */

export type RdpClient =
  | { kind: "freerdp"; name: string; program: string }
  | { kind: "remmina"; program: string; snap: boolean };

export interface ClientDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (path: string) => boolean;
  isExecutable?: (path: string) => boolean;
  /** FreeRDP `/buildconfig` output (default: run it, 5 s). */
  buildconfig?: (program: string) => Promise<string>;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

/** The client `/gui view` opens, or undefined when none is installed. */
export async function findRdpClient(deps: ClientDeps = {}): Promise<RdpClient | undefined> {
  const env = deps.env ?? process.env;
  for (const name of FREERDP_CLIENTS) {
    const program = which(name, env, deps.isExecutable);
    if (!program) continue;
    const output = deps.buildconfig ? await deps.buildconfig(program) : await run(program, ["/buildconfig"], { timeoutMs: 5_000 }).then(result => result.stdout + result.stderr);
    if (freerdpHasH264(output)) return { kind: "freerdp", name, program };
  }
  const exists = deps.exists ?? existsSync;
  const onPath = which("remmina", env, deps.isExecutable);
  if (onPath?.startsWith("/snap/")) return { kind: "remmina", program: onPath, snap: true };
  if (exists("/snap/bin/remmina")) return { kind: "remmina", program: "/snap/bin/remmina", snap: true };
  if (onPath) return { kind: "remmina", program: onPath, snap: false };
  return undefined;
}

/** Where Remmina (snap or not) reads profiles from us and keeps its own configuration (its key, FreeRDP's certificate store). */
export function remminaPaths(snap: boolean, home: string, env: NodeJS.ProcessEnv): { profileDir: string; configHome: string } {
  if (snap) {
    // The snap reads its common directory (SNAP_USER_COMMON) and keeps XDG_CONFIG_HOME under its current revision.
    return { profileDir: join(home, "snap", "remmina", "common", "pi-gui-view"), configHome: join(home, "snap", "remmina", "current", ".config") };
  }
  return {
    profileDir: join(env.XDG_RUNTIME_DIR || tmpdir(), "pi-gui-view"),
    configHome: env.XDG_CONFIG_HOME || join(home, ".config"),
  };
}

/** Remmina's profile key (`secret=` in `remmina.pref`), or undefined when Remmina has not created one yet. */
export function remminaSecret(configHome: string): string | undefined {
  let text: string;
  try { text = readFileSync(join(configHome, "remmina", "remmina.pref"), "utf8"); } catch { return undefined; }
  const match = /^secret=(\S+)\s*$/m.exec(text);
  return match?.[1];
}

/**
 * A password as Remmina stores it in a profile (`remmina_crypt_encrypt`): 3DES-CBC with key = first 24 bytes and IV =
 * next 8 bytes of the base64-decoded secret, the text zero-padded to a multiple of 8 bytes (always at least one zero),
 * base64. Undefined when the secret is too short (Remmina then refuses it too).
 */
export function remminaEncrypt(secret: string, text: string): string | undefined {
  const key = Buffer.from(secret, "base64");
  if (key.length < 32 || !text) return undefined;
  const plain = Buffer.from(text, "utf8");
  const padded = Buffer.alloc(plain.length + 8 - (plain.length % 8));
  plain.copy(padded);
  const cipher = createCipheriv("des-ede3-cbc", key.subarray(0, 24), key.subarray(24, 32));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

/** A Remmina RDP profile for the viewer: TLS (krdp cannot check NLA logins), GFX AVC420, no sound, nothing saved. */
export function remminaProfile(viewer: Pick<RunningViewer, "target" | "host" | "port" | "user" | "session">, encryptedPassword: string | undefined): string {
  return [
    "[remmina]",
    `name=pi-gui ${viewer.target} (${viewer.session.display})`,
    "protocol=RDP",
    `server=${viewer.host}:${viewer.port}`,
    `username=${viewer.user}`,
    ...(encryptedPassword ? [`password=${encryptedPassword}`] : []),
    "security=tls",
    "colordepth=65",
    "cert_ignore=0",
    "disablepasswordstoring=1",
    "sound=off",
    "",
  ].join("\n");
}

/**
 * FreeRDP's certificate store entry for the viewer's address: `<config>/freerdp/server/<host:port>_<port>.pem` (Remmina
 * names the certificate host `host:port` for ports other than 3389; FreeRDP compares the stored certificate's fingerprint).
 */
export function certificateStorePath(configHome: string, host: string, port: number): string {
  return join(configHome, "freerdp", "server", `${host}:${port}_${port}.pem`.toLowerCase());
}

/** The client's environment: Pi's own (the user's graphical session), without pi-gui's private-session markers. */
export function clientEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy[VIEW_TAG_ENV];
  delete copy[MARKER_ENV];
  return copy;
}

function writePrivate(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function removeIfUnchanged(path: string, content: string): void {
  try { if (readFileSync(path, "utf8") === content) rmSync(path, { force: true }); } catch { /* gone */ }
}

function launch(spawnFn: NonNullable<ClientDeps["spawn"]>, program: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ pid?: number; error?: string }> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = spawnFn(program, args, { env, detached: true, stdio: "ignore" });
    } catch (error) {
      resolve({ error: (error as Error).message });
      return;
    }
    child.once("error", error => resolve({ error: error.message }));
    child.once("spawn", () => { child.unref(); resolve({ ...(child.pid ? { pid: child.pid } : {}) }); });
  });
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };

/**
 * Why `/gui view` opens no RDP client this time, or undefined to open one. `choice` is `viewerAutoConnect`; `configFile`
 * names where to change it. "auto" skips the client when Pi runs in a herdr pane (`HERDR_PANE_ID`, which herdr sets for
 * every pane's processes): herdr-web-ui opens the desktop in the browser that ran `/gui view`, usually on another device,
 * and a client here would only pop up on this PC's screen and hold a second RDP session. That is a conservative guess,
 * not knowledge of a browser: herdr used in a terminal on this PC is skipped too, and `true` brings the client back.
 */
export function autoConnectSkip(choice: boolean | "auto", env: NodeJS.ProcessEnv, configFile: string): string | undefined {
  if (choice === false) return `"viewerAutoConnect": false in ${configFile}`;
  if (choice === "auto" && env.HERDR_PANE_ID) {
    return `Pi runs in herdr pane ${env.HERDR_PANE_ID}: herdr-web-ui shows this desktop in the browser that ran /gui view; for a client on this PC's screen too, set "viewerAutoConnect": true in ${configFile}`;
  }
  return undefined;
}

/**
 * `/gui view`'s auto-connect step: a new viewer always gets a client; a running one gets another only when the client
 * opened for it before is not running any more (FreeRDP; a Remmina launch hands over to Remmina's running instance, so
 * its window cannot be watched and a repeated `/gui view` opens it again).
 */
export async function autoConnect(viewer: RunningViewer, kind: "started" | "running", deps: ClientDeps & { isAlive?: (pid: number) => boolean } = {}): Promise<ClientOutcome> {
  if (kind === "running" && viewer.clientPid && (deps.isAlive ?? alive)(viewer.clientPid)) {
    return { skipped: `the client opened for it is still running (pid ${viewer.clientPid})` };
  }
  viewer.clientPid = undefined;
  return connectClient(viewer, deps);
}

/**
 * Open an RDP client on the user's screen, connected to `viewer`. Files it writes are added to `viewer.cleanups`,
 * which stopping the viewer runs. Never throws; the reason is returned instead.
 */
export async function connectClient(viewer: RunningViewer, deps: ClientDeps = {}): Promise<ClientOutcome> {
  const env = deps.env ?? process.env;
  if (!env.WAYLAND_DISPLAY && !env.DISPLAY) return { ok: false, reason: "Pi has no graphical session to open a client in (no WAYLAND_DISPLAY or DISPLAY; started over SSH?)" };
  let client: RdpClient | undefined;
  try { client = await findRdpClient(deps); } catch (error) { return { ok: false, reason: `looking for an RDP client failed: ${(error as Error).message}` }; }
  if (!client) return { ok: false, reason: "no RDP client found (install one that decodes H.264, e.g. `sudo snap install remmina`)" };
  const spawnFn = deps.spawn ?? nodeSpawn;
  const childEnv = clientEnv(env);
  const address = `${viewer.host}:${viewer.port}`;

  if (client.kind === "freerdp") {
    const args = [
      `/v:${address}`, `/u:${viewer.user}`, `/p:${viewer.password}`, "/sec:tls", "/gfx:avc420",
      `/cert:fingerprint:sha256:${fingerprintHex(viewer.fingerprint)}`, `/title:pi-gui ${viewer.target}`,
    ];
    const started = await launch(spawnFn, client.program, args, childEnv);
    if (started.error) return { ok: false, reason: `could not start ${client.program}: ${started.error}` };
    if (started.pid) viewer.clientPid = started.pid;
    return { ok: true, client: `${client.name} (${client.program})`, detail: "TLS pinned to this viewer's certificate, password filled in" };
  }

  const home = deps.home ?? homedir();
  const { profileDir, configHome } = remminaPaths(client.snap, home, env);
  const secret = remminaSecret(configHome);
  const encrypted = secret ? remminaEncrypt(secret, viewer.password) : undefined;
  const profile = join(profileDir, `${viewer.target.replace(/[^A-Za-z0-9_-]/g, "_")}-${viewer.port}.remmina`);
  const profileText = remminaProfile(viewer, encrypted);
  let pinned = false;
  try {
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    chmodSync(profileDir, 0o700);
    writePrivate(profile, profileText);
    viewer.cleanups ??= [];
    viewer.cleanups.push(() => removeIfUnchanged(profile, profileText));
  } catch (error) {
    return { ok: false, reason: `could not write the Remmina profile ${profile}: ${(error as Error).message}` };
  }
  if (viewer.certificate) {
    try {
      const pem = readFileSync(viewer.certificate, "utf8");
      const store = certificateStorePath(configHome, viewer.host, viewer.port);
      mkdirSync(join(configHome, "freerdp", "server"), { recursive: true, mode: 0o700 });
      writeFileSync(store, pem, { mode: 0o644 });
      viewer.cleanups.push(() => removeIfUnchanged(store, pem));
      pinned = true;
    } catch { /* Remmina then asks to accept the certificate: the fingerprint is in the message */ }
  }
  const started = await launch(spawnFn, client.program, ["-c", profile], childEnv);
  if (started.error) return { ok: false, reason: `could not start ${client.program}: ${started.error}` };
  const parts = [
    "TLS security, H.264 (GFX AVC420)",
    pinned ? "this viewer's certificate trusted for this address only" : "accept the certificate if its fingerprint matches",
    encrypted ? "password filled in" : "Remmina asks for the password (no Remmina key yet: start Remmina once to create it)",
    ...(client.snap ? [] : ["this Remmina uses the system FreeRDP: if it disconnects right after sign-in, that build lacks H.264 (README > Clients)"]),
  ];
  return { ok: true, client: `Remmina${client.snap ? " (snap)" : ""} (${client.program})`, detail: `${parts.join("; ")}; profile ${profile}, removed when the viewer stops` };
}
