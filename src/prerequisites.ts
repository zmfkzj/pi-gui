import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { arch, platform } from "node:os";
import { which, invocation, type Backend } from "./backend.ts";

/**
 * Programs upstream's private-session runner (run-isolated-session.sh, embedded in the binary) requires, with the
 * same lookup: its COMPUTER_USE_MCP_*_BIN override, then PATH, then fixed locations. `gdbus` is required because the
 * background worker installs the private RemoteDesktop grant (COMPUTER_USE_MCP_PRIVATE_PORTAL_AUTH=require).
 */
export const RUNNER_PROGRAMS: readonly { name: string; override: string; candidates: string[]; apt: string; libexec?: boolean }[] = [
  { name: "kwin_wayland", override: "COMPUTER_USE_MCP_COMPOSITOR_BIN", candidates: ["/usr/bin/kwin_wayland"], apt: "kwin-wayland" },
  { name: "xdg-desktop-portal-kde", override: "COMPUTER_USE_MCP_PORTAL_BACKEND_BIN", candidates: ["/usr/lib/xdg-desktop-portal-kde", "/usr/libexec/xdg-desktop-portal-kde"], apt: "xdg-desktop-portal-kde", libexec: true },
  { name: "xdg-desktop-portal", override: "COMPUTER_USE_MCP_PORTAL_BIN", candidates: ["/usr/lib/xdg-desktop-portal", "/usr/libexec/xdg-desktop-portal"], apt: "xdg-desktop-portal", libexec: true },
  { name: "pipewire", override: "COMPUTER_USE_MCP_PIPEWIRE_BIN", candidates: ["/usr/bin/pipewire"], apt: "pipewire" },
  { name: "wireplumber", override: "COMPUTER_USE_MCP_WIREPLUMBER_BIN", candidates: ["/usr/bin/wireplumber"], apt: "wireplumber" },
  { name: "dbus-daemon", override: "COMPUTER_USE_MCP_DBUS_DAEMON_BIN", candidates: ["/usr/bin/dbus-daemon"], apt: "dbus-daemon" },
  { name: "dbus-send", override: "COMPUTER_USE_MCP_DBUS_SEND_BIN", candidates: ["/usr/bin/dbus-send"], apt: "dbus-bin" },
  { name: "at-spi-bus-launcher", override: "COMPUTER_USE_MCP_ATSPI_BUS_BIN", candidates: ["/usr/lib/at-spi-bus-launcher", "/usr/libexec/at-spi-bus-launcher"], apt: "at-spi2-core", libexec: true },
  { name: "at-spi2-registryd", override: "COMPUTER_USE_MCP_ATSPI_REGISTRY_BIN", candidates: ["/usr/lib/at-spi2-registryd", "/usr/libexec/at-spi2-registryd"], apt: "at-spi2-core", libexec: true },
  { name: "gdbus", override: "COMPUTER_USE_MCP_GDBUS_BIN", candidates: ["/usr/bin/gdbus"], apt: "libglib2.0-bin" },
  { name: "setsid", override: "COMPUTER_USE_MCP_SETSID_BIN", candidates: ["/usr/bin/setsid"], apt: "util-linux" },
  { name: "bash", override: "", candidates: ["/bin/bash", "/usr/bin/bash"], apt: "bash" },
];

/** Debian/Ubuntu multiarch directories (`/usr/lib/x86_64-linux-gnu`). */
function multiarchDirs(): string[] {
  try {
    return readdirSync("/usr/lib").filter(name => /-linux-gnu\w*$/.test(name)).map(name => `/usr/lib/${name}`);
  } catch {
    return [];
  }
}

/** Multiarch libexec directories (`/usr/lib/x86_64-linux-gnu/libexec`), where Ubuntu installs the KDE portal; the runner does not search them. */
export function multiarchLibexecDirs(): string[] {
  return multiarchDirs().map(dir => `${dir}/libexec`);
}

/**
 * KWin plugins the private desktop needs: `screencast` provides zkde_screencast_unstable_v1 (screenshots through the KDE
 * portal) and `eis` the input the portal grants. Debian/Ubuntu ship them in kwin-common, which kwin-wayland does not
 * pull in; without them every capture fails as "RemoteDesktop approval failed".
 */
export const KWIN_PLUGINS: readonly { name: string; file: string; apt: string }[] = [
  { name: "KWin screencast plugin", file: "screencast.so", apt: "kwin-common" },
  { name: "KWin EIS input plugin", file: "eis.so", apt: "kwin-common" },
];

/** Where Qt (and so KWin) looks for `kwin/plugins`: QT_PLUGIN_PATH, then the distribution's Qt 6 plugin directories. */
export function qtPluginDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...(env.QT_PLUGIN_PATH ?? "").split(":").filter(Boolean), ...multiarchDirs().map(dir => `${dir}/qt6/plugins`), "/usr/lib/qt6/plugins", "/usr/lib64/qt6/plugins"];
}

/** This package's wrapper that starts the KDE portal backend with `--replace` (see the script). */
export const PORTAL_BACKEND_WRAPPER = fileURLToPath(new URL("../bin/xdg-desktop-portal-kde-replace", import.meta.url));

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** Distribution package that provides it (Debian/Ubuntu names). */
  apt?: string;
}

export interface PrerequisiteReport {
  ok: boolean;
  checks: Check[];
  /** Problems that make the private desktop unavailable, one line each. */
  missing: string[];
  /**
   * Environment for the private-session runner, passed to the server: program overrides (`COMPUTER_USE_MCP_*_BIN`) for
   * programs the runner would not find (Ubuntu's multiarch libexec) or must start differently (the KDE portal backend,
   * through {@link PORTAL_BACKEND_WRAPPER}). The runner honours them; a user's own override is left alone.
   */
  overrides: Record<string, string>;
  /** The physical session, for information: private mode needs none. */
  host: string;
}

export interface PrerequisiteDeps {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
  isExecutable?: (path: string) => boolean;
  exists?: (path: string) => boolean;
  libexecDirs?: () => string[];
  pluginDirs?: () => string[];
}

export function checkPrerequisites(backend: Backend | undefined, deps: PrerequisiteDeps = {}): PrerequisiteReport {
  const env = deps.env ?? process.env;
  const os = deps.platform ?? platform();
  const checks: Check[] = [];
  const overrides: Record<string, string> = {};
  checks.push({ name: "Linux", ok: os === "linux", detail: os });
  if (backend?.source === "bundled") {
    const cpu = deps.arch ?? arch();
    checks.push({ name: "x64 (bundled binary)", ok: cpu === "x64", detail: cpu });
  }
  for (const program of RUNNER_PROGRAMS) {
    const override = program.override ? env[program.override] : undefined;
    let found = override
      ? which(override, env, deps.isExecutable)
      : which(program.name, env, deps.isExecutable) ?? program.candidates.find(candidate => which(candidate, env, deps.isExecutable));
    let detail = found;
    if (!found && !override && program.libexec) {
      found = (deps.libexecDirs ?? multiarchLibexecDirs)().map(dir => `${dir}/${program.name}`).find(candidate => which(candidate, env, deps.isExecutable));
      if (found) {
        overrides[program.override] = found;
        detail = `${found} (outside the runner's search path; passed as ${program.override})`;
      }
    }
    if (found && !override && program.name === "xdg-desktop-portal-kde") {
      overrides[program.override] = PORTAL_BACKEND_WRAPPER;
      overrides.PI_GUI_PORTAL_BACKEND = found;
      detail = `${found} (started with --replace through ${PORTAL_BACKEND_WRAPPER})`;
    }
    checks.push({
      name: program.name,
      ok: !!found,
      detail: detail ?? (override ? `${program.override}=${override} is not executable` : "not found"),
      apt: program.apt,
    });
  }
  const exists = deps.exists ?? existsSync;
  const pluginDirs = (deps.pluginDirs ?? (() => qtPluginDirs(env)))();
  for (const plugin of KWIN_PLUGINS) {
    const found = pluginDirs.map(dir => `${dir}/kwin/plugins/${plugin.file}`).find(path => exists(path));
    checks.push({ name: plugin.name, ok: !!found, detail: found ?? `kwin/plugins/${plugin.file} not found`, apt: plugin.apt });
  }
  const missing = checks.filter(check => !check.ok).map(check => check.apt ? `${check.name} (apt: ${check.apt})` : `${check.name}: ${check.detail}`);
  const host = `${env.XDG_SESSION_TYPE || "unknown"} session, desktop ${env.XDG_CURRENT_DESKTOP || "unknown"}`;
  return { ok: missing.length === 0, checks, missing, overrides, host };
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
  error?: string;
}

/** Run a command with a deadline; the whole process group is killed on timeout. Output is capped. */
export function run(command: string, args: string[], options: { input?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<RunResult> {
  const started = Date.now();
  return new Promise(resolve => {
    const cap = 256 * 1024;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], detached: true, env: options.env ?? process.env });
    } catch (error) {
      resolve({ code: null, stdout, stderr, ms: 0, timedOut, error: (error as Error).message });
      return;
    }
    const kill = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch { /* gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill("SIGTERM"); setTimeout(() => kill("SIGKILL"), 5_000).unref(); }, options.timeoutMs);
    child.stdout.on("data", chunk => { if (stdout.length < cap) stdout += chunk; });
    child.stderr.on("data", chunk => { if (stderr.length < cap) stderr += chunk; });
    child.on("error", error => { clearTimeout(timer); resolve({ code: null, stdout, stderr, ms: Date.now() - started, timedOut, error: error.message }); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr, ms: Date.now() - started, timedOut }); });
    child.stdin.end(options.input ?? "");
  });
}

export async function backendVersion(backend: Backend): Promise<string | undefined> {
  const { command, args } = invocation(backend, ["version"], { physical: true });
  const result = await run(command, args, { timeoutMs: 60_000 });
  return result.code === 0 ? result.stdout.trim().split("\n").at(-1) : undefined;
}

/** Upstream `doctor` (never prompts). It checks the session it runs in: the host session, relevant to physical opt-in. */
export async function upstreamDoctor(backend: Backend): Promise<RunResult> {
  const { command, args } = invocation(backend, ["doctor"], { physical: true });
  return run(command, args, { timeoutMs: 60_000 });
}

/** `[Section]` + `Status:` pairs of the upstream doctor report. */
export function doctorStatuses(output: string): { section: string; status: string }[] {
  const statuses: { section: string; status: string }[] = [];
  let section: string | undefined;
  for (const line of output.split("\n")) {
    const header = /^\[(.+)\]\s*$/.exec(line.trim());
    if (header) { section = header[1]; continue; }
    const status = /^Status:\s*(.+)$/.exec(line.trim());
    if (status && section) statuses.push({ section, status: status[1]! });
  }
  return statuses;
}

export interface SmokeResult {
  ok: boolean;
  ms: number;
  /** One line: the session id, or why it failed (the runner's own message when there is one). */
  detail: string;
}

/**
 * End-to-end private desktop check through upstream's own CLI: `call -` with one background `list_desktop`, in the same
 * sanitized environment as the server. The call starts the private runner (D-Bus, KWin, PipeWire, WirePlumber, AT-SPI,
 * portals), lists its windows and tears everything down when the batch exits.
 */
export async function privateDesktopSmoke(backend: Backend, overrides: Record<string, string> = {}, timeoutMs = 150_000): Promise<SmokeResult> {
  const { command, args } = invocation(backend, ["call", "-"], { physical: false });
  const input = JSON.stringify({ name: "list_desktop", arguments: { scope: "windows", desktop: "background" } });
  const result = await run(command, args, { input, timeoutMs, env: { ...process.env, ...overrides } });
  if (result.error) return { ok: false, ms: result.ms, detail: result.error };
  if (result.timedOut) return { ok: false, ms: result.ms, detail: `no answer within ${Math.round(timeoutMs / 1000)} s` };
  let parsed: { isError?: boolean; content?: { type: string; text?: string }[] } | undefined;
  try { parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? ""); } catch { /* reported below */ }
  const text = parsed?.content?.find(block => block.type === "text")?.text ?? "";
  const session = /session=(session-[0-9a-f]+)/.exec(text)?.[1];
  if (result.code === 0 && parsed && !parsed.isError && session) return { ok: true, ms: result.ms, detail: `private desktop ${session} started, listed and torn down` };
  const runner = result.stderr.split("\n").map(line => line.trim()).filter(line => /run-isolated-session\.sh: |computer-use-mcp: /.test(line)).at(-1);
  const reason = runner ?? (text.split("\n").find(line => line && !line.startsWith("Desktop:")) || result.stderr.trim().split("\n").at(-1) || `exit ${result.code}`);
  return { ok: false, ms: result.ms, detail: reason.slice(0, 400) };
}
