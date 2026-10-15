// pi-gui's answers to the umbrella's dependency contract (src/dependencies.ts): `/gui doctor`, `/gui install-deps` and
// `/oh-my-pi doctor|install-deps`. check() only inspects files, PATH and one bounded `computer-use-mcp version`; it never
// starts a private desktop, never runs the npx fallback and never downloads. The live smoke test belongs to `/gui doctor`.
import { basename, join } from "node:path";
import { arch as osArch, platform as osPlatform } from "node:os";
import { fileURLToPath } from "node:url";
import { bundledBinary, invocation, resolveBackend, UPSTREAM_PACKAGE, UPSTREAM_VERSION, type Backend, type BackendResolution } from "./backend.ts";
import { CONFIG_FILE, loadGuiConfig, type GuiConfig, type LoadedGuiConfig } from "./config.ts";
import { installNpmDependencies, insideNodeModules, npmPackageInstalled, type DependencyItem, type DependencyReport } from "./dependencies.ts";
import { checkPrerequisites, KWIN_PLUGINS, RUNNER_PROGRAMS, run, type Check, type PrerequisiteReport, type RunResult, type SmokeResult } from "./prerequisites.ts";
import { checkViewerPrerequisites, probeRdpClients, type ViewerPrerequisites } from "./viewer.ts";

/** The package root (this file is in src/). */
export const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
export const PROVIDER = { id: "pi-gui", label: "pi-gui", command: "/gui" } as const;
/** The bundled server's platform: npm `os`/`cpu`/`libc` of the optional dependency, glibc of its build. */
export const MIN_GLIBC = "2.39";
export const CARGO_INSTALL = "cargo install --locked --git https://github.com/mirsella/computer-use-mcp computer-use-mcp";
export const SERVER_ITEM = "computer-use-mcp server";
export const BUNDLED_ITEM = `bundled server (npm ${UPSTREAM_PACKAGE}@${UPSTREAM_VERSION})`;
export const LIVE_ITEM = "private desktop (live)";
export const UNSUPPORTED_NOTE = "pi-gui supports Linux only: private desktops are KDE Wayland sessions (kwin_wayland --virtual) run by computer-use-mcp.";
const UNSUPPORTED_ACTION = "Unsupported platform: run Pi on Linux (Debian/Ubuntu or another distribution with KDE Plasma 6 packages) to use /gui; nothing to install here";
const PROBE_TIMEOUT_MS = 5_000;

export const aptInstall = (packages: readonly string[]): string => `sudo apt install --no-install-recommends ${[...new Set(packages)].join(" ")}`;

export interface HealthContext { cwd?: string; isProjectTrusted?: () => boolean }

export interface GuiHealthDeps {
  agentDir: string;
  packageDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
  /** glibc version of this process (undefined: none, e.g. musl). */
  glibc?: () => string | undefined;
  resolve?: (config: GuiConfig) => BackendResolution;
  /** The bundled binary (default: resolved from the package, see backend.ts). */
  bundled?: () => string | undefined;
  prerequisites?: (backend: Backend | undefined) => PrerequisiteReport;
  viewer?: (viewerCommand: string | null) => ViewerPrerequisites;
  rdpClients?: () => Promise<string[]>;
  /** Runs `computer-use-mcp version` (bounded). */
  probe?: (command: string, args: string[], options: { timeoutMs: number }) => Promise<RunResult>;
  /** Installs the package's npm dependencies (default: installNpmDependencies). */
  installNpm?: (packageDir: string) => Promise<DependencyItem[]>;
}

export function glibcVersion(): string | undefined {
  try {
    return (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime;
  } catch {
    return undefined;
  }
}

export function versionAtLeast(version: string, minimum: string): boolean {
  const a = version.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (Number.isNaN(x)) return false;
    if (x !== y) return x > y;
  }
  return true;
}

/** Why the bundled Linux x64 glibc binary cannot run here, or undefined when it can. */
export function bundledUnsupported(os: string, cpu: string, glibc: string | undefined): string | undefined {
  if (os !== "linux") return os;
  if (cpu !== "x64") return `${cpu} CPU`;
  if (!glibc) return "no glibc (musl?)";
  if (!versionAtLeast(glibc, MIN_GLIBC)) return `glibc ${glibc}`;
  return undefined;
}

interface State {
  os: string;
  cpu: string;
  glibc: string | undefined;
  env: NodeJS.ProcessEnv;
  packageDir: string;
  userConfig: string;
  loaded: LoadedGuiConfig;
  resolution: BackendResolution;
  backend: Backend | undefined;
  bundledInstalled: boolean;
  bundledPath: string | undefined;
  unsupported: string | undefined;
  /** The server comes from the user's config or PATH: the bundled one is not needed. */
  elsewhere: boolean;
}

async function inspect(ctx: HealthContext, deps: GuiHealthDeps): Promise<State> {
  const env = deps.env ?? process.env;
  const os = deps.platform ?? osPlatform();
  const cpu = deps.arch ?? osArch();
  const glibc = (deps.glibc ?? glibcVersion)();
  const packageDir = deps.packageDir ?? PACKAGE_DIR;
  const loaded = await loadGuiConfig({ cwd: ctx.cwd ?? process.cwd(), agentDir: deps.agentDir, projectTrusted: ctx.isProjectTrusted?.() ?? false });
  const bundled = deps.bundled ?? bundledBinary;
  const resolution = (deps.resolve ?? (config => resolveBackend(config, { env, bundled })))(loaded.config);
  const backend = resolution.ok ? resolution.backend : undefined;
  return {
    os, cpu, glibc, env, packageDir, loaded, resolution, backend,
    userConfig: join(deps.agentDir, CONFIG_FILE),
    bundledInstalled: npmPackageInstalled(packageDir, UPSTREAM_PACKAGE),
    bundledPath: bundled(),
    unsupported: bundledUnsupported(os, cpu, glibc),
    elsewhere: backend?.source === "config" || backend?.source === "path",
  };
}

function platformItem(s: State): DependencyItem {
  if (s.os !== "linux") return { name: "platform", status: "error", detail: `${s.os}: unsupported`, action: UNSUPPORTED_ACTION };
  return { name: "platform", status: "ok", detail: `linux ${s.cpu}${s.glibc ? `, glibc ${s.glibc}` : ", no glibc"}` };
}

function configItem(s: State): DependencyItem {
  const { config, sources, errors } = s.loaded;
  if (errors.length) {
    return {
      name: CONFIG_FILE, status: "error", detail: errors.join("; "),
      action: "Fix the file(s) named here (README \"Configuration\"; an invalid file is ignored as a whole and the defaults apply), then /reload",
    };
  }
  const flags = [!config.enabled ? "enabled: false (GUI disabled)" : "", config.enabled && !config.mainSession ? "mainSession: false (workers only)" : ""].filter(Boolean);
  return { name: CONFIG_FILE, status: "ok", detail: `${sources.length ? sources.join(", ") : `defaults (no ${CONFIG_FILE})`}${flags.length ? `; ${flags.join("; ")}` : ""}` };
}

/** A command that may download or start something under another name: not probed by check(). */
const LAUNCHER = /^(npx|bunx|pnpx|pnpm|yarn|bun|npm)$/;

function serverHint(s: State): string {
  if (s.unsupported) return `Build the server for this host: ${CARGO_INSTALL} (puts computer-use-mcp on PATH), then /reload`;
  return `Run /gui install-deps (installs the bundled server through npm), or put computer-use-mcp on PATH (${CARGO_INSTALL}), then /reload`;
}

async function serverItem(s: State, deps: GuiHealthDeps): Promise<DependencyItem> {
  if (!s.resolution.ok) {
    const action = s.loaded.config.command
      ? `Fix "command"/"args" in ${s.userConfig} (or remove "command" to use the bundled server), then /reload`
      : serverHint(s);
    return { name: SERVER_ITEM, status: "error", detail: s.resolution.error, action };
  }
  const backend = s.resolution.backend;
  if (backend.source === "npx") {
    return {
      name: SERVER_ITEM, status: "unverified",
      detail: `not installed locally; Pi would run npx -y ${UPSTREAM_PACKAGE}@${UPSTREAM_VERSION}, which downloads on first use (not run by this check)`,
      action: serverHint(s),
    };
  }
  if (LAUNCHER.test(basename(backend.command))) {
    return {
      name: SERVER_ITEM, status: "unverified", detail: `${backend.label}: a package launcher, not probed (it may download)`,
      action: "Run /gui doctor (runs the server's own doctor and a smoke test), or set \"command\" to the computer-use-mcp binary",
    };
  }
  const { command, args } = invocation(backend, ["version"], { physical: true });
  const result = await (deps.probe ?? run)(command, args, { timeoutMs: PROBE_TIMEOUT_MS });
  const version = result.stdout.trim().split("\n").at(-1);
  if (result.code === 0 && version) return { name: SERVER_ITEM, status: "ok", detail: `${backend.label}; \`version\` answered ${version}` };
  const tail = (result.error ?? (result.timedOut ? `no answer within ${PROBE_TIMEOUT_MS / 1000} s` : "")) || result.stderr.trim().split("\n").at(-1) || `exit ${result.code}`;
  const action = backend.source === "bundled"
    ? `The bundled binary needs Linux x64 with glibc ≥ ${MIN_GLIBC}. Build the server instead (${CARGO_INSTALL}) and set "command": "computer-use-mcp" in ${s.userConfig}, then /reload`
    : backend.source === "path"
      ? `Reinstall it (${CARGO_INSTALL}), or remove it from PATH and run /gui install-deps for the bundled server`
      : `Fix "command"/"args" in ${s.userConfig} (the command must answer \`version\`), then /reload`;
  return { name: SERVER_ITEM, status: "error", detail: `${backend.label} does not run: ${tail.slice(0, 300)}`, action };
}

function bundledItem(s: State): DependencyItem {
  const name = BUNDLED_ITEM;
  const needs = `Linux x64 with glibc ≥ ${MIN_GLIBC}`;
  if (s.bundledInstalled && s.bundledPath) {
    if (s.unsupported && s.backend?.source === "bundled") {
      return {
        name, status: "error", detail: `installed (${s.bundledPath}), but this host has ${s.unsupported}; it needs ${needs}`,
        action: `Build the server for this host (${CARGO_INSTALL}) and set "command": "computer-use-mcp" in ${s.userConfig} (the bundled binary takes precedence over PATH), then /reload`,
      };
    }
    return { name, status: "ok", detail: `installed (${s.bundledPath})${s.backend && s.backend.source !== "bundled" ? `; unused: the server is ${s.backend.label}` : ""}` };
  }
  if (s.elsewhere) return { name, status: "ok", detail: `${s.bundledInstalled ? "present without its binary" : "not installed"}; not needed: the server is ${s.backend!.label}` };
  if (s.bundledInstalled) {
    return {
      name, status: "error", detail: "the npm package is present, but vendor/bin/computer-use-mcp is missing or not executable",
      action: `Reinstall it: cd ${s.packageDir} && rm -rf node_modules/${UPSTREAM_PACKAGE} && npm install --legacy-peer-deps, then /reload`,
    };
  }
  if (s.unsupported) {
    return { name, status: "warn", optional: true, detail: `not installable here (${s.unsupported}); it is ${needs} only`, action: `Build the server instead: ${CARGO_INSTALL}, then /reload` };
  }
  if (insideNodeModules(s.packageDir)) {
    return { name, status: "warn", optional: true, detail: "not installed (npm-installed package)", action: "Reinstall the package with pi install (or pi update --extensions), then /reload" };
  }
  return {
    name, status: "warn", optional: true, detail: "not installed: the pinned offline server, preferred over PATH and npx",
    action: `Run /gui install-deps (npm install --legacy-peer-deps in ${s.packageDir}), then /reload`,
  };
}

const isPlatformCheck = (check: Check) => check.name === "Linux" || check.name.startsWith("x64");
const isPlugin = (check: Check) => KWIN_PLUGINS.some(plugin => plugin.name === check.name);

/** A runner program whose user override (`COMPUTER_USE_MCP_*_BIN`) is set: fix the override, not the package. */
function brokenOverride(check: Check, env: NodeJS.ProcessEnv): string | undefined {
  const program = RUNNER_PROGRAMS.find(item => item.name === check.name);
  const value = program?.override ? env[program.override] : undefined;
  return value ? `${program!.override}=${value} is not an executable: fix or unset it, then /reload` : undefined;
}

function serviceItems(s: State, prerequisites: PrerequisiteReport): DependencyItem[] {
  return prerequisites.checks.filter(check => !isPlatformCheck(check)).map(check => {
    const name = `private desktop: ${check.name}`;
    if (check.ok) return { name, status: "ok", detail: check.detail };
    const action = brokenOverride(check, s.env)
      ?? (check.apt
        ? `${aptInstall([check.apt])}${isPlugin(check) ? " (kwin-common ships KWin's screencast and EIS plugins; kwin-wayland does not pull it in), or add their Qt plugin directory to QT_PLUGIN_PATH" : ""}`
        : "Install it with your distribution's package manager");
    return { name, status: "error", detail: check.detail, action };
  });
}

function liveItem(prerequisites: PrerequisiteReport, server: DependencyItem): DependencyItem {
  const blocked = !prerequisites.ok || server.status === "error";
  return {
    name: LIVE_ITEM, status: "unverified",
    detail: blocked ? "live desktop not started; fix the errors above, then run /gui doctor for the smoke test" : "live desktop not started; run /gui doctor for the smoke test",
    action: "Run /gui doctor: it starts one private desktop through computer-use-mcp `call`, lists its windows and tears it down",
  };
}

/** The live item from `/gui doctor`'s smoke test (undefined: not run). */
export function smokeItem(smoke: SmokeResult | undefined, logPath: string): DependencyItem {
  if (!smoke) return { name: LIVE_ITEM, status: "unverified", detail: "smoke test not run: no computer-use-mcp server resolved", action: "Fix the server item above, then run /gui doctor again" };
  if (smoke.ok) return { name: LIVE_ITEM, status: "ok", detail: `${smoke.detail} in ${(smoke.ms / 1000).toFixed(1)} s` };
  return {
    name: LIVE_ITEM, status: "error", detail: `smoke test failed in ${(smoke.ms / 1000).toFixed(1)} s: ${smoke.detail}`,
    action: `Fix the errors above (missing desktop services first), then run /gui doctor again; README "Known limitations" and ${logPath} have details`,
  };
}

function viewerItems(s: State, viewer: ViewerPrerequisites): DependencyItem[] {
  return viewer.checks.map(check => {
    const name = `/gui view: ${check.name}`;
    if (check.ok) return { name, status: "ok", optional: true, detail: check.detail };
    const configured = s.loaded.config.viewerCommand && /krdp/i.test(check.name);
    const action = configured
      ? `Fix "viewerCommand" in ${s.userConfig} (or remove it and ${aptInstall([check.apt ?? "krdp"])}), then /reload`
      : `${aptInstall([check.apt ?? check.name])} (needed only by /gui view)`;
    return { name, status: "warn", optional: true, detail: check.detail, action };
  });
}

async function rdpItem(deps: GuiHealthDeps, env: NodeJS.ProcessEnv): Promise<DependencyItem> {
  const lines = await (deps.rdpClients ?? (() => probeRdpClients(env, undefined, PROBE_TIMEOUT_MS)))();
  const usable = lines.filter(line => !/H\.264 no/.test(line));
  const name = "/gui view: RDP client with H.264";
  if (usable.length) return { name, status: "ok", optional: true, detail: usable.join("; ") };
  return {
    name, status: "warn", optional: true, detail: lines.length ? `only clients without H.264: ${lines.join("; ")}` : "no RDP client found",
    action: "Install a client that decodes H.264: sudo snap install remmina, or flatpak install flathub org.remmina.Remmina (or com.freerdp.FreeRDP); needed only to connect to /gui view",
  };
}

function prerequisitesOf(s: State, deps: GuiHealthDeps): PrerequisiteReport {
  return (deps.prerequisites ?? (backend => checkPrerequisites(backend, { env: s.env, platform: s.os, arch: s.cpu })))(s.backend);
}

function viewerOf(s: State, deps: GuiHealthDeps): ViewerPrerequisites {
  return (deps.viewer ?? (command => checkViewerPrerequisites(command, { env: s.env })))(s.loaded.config.viewerCommand);
}

/** Read-only health check: platform, config, server, bundled server, desktop services, live access (unverified), viewer. */
export async function checkGui(ctx: HealthContext, deps: GuiHealthDeps): Promise<DependencyReport> {
  const s = await inspect(ctx, deps);
  const items: DependencyItem[] = [platformItem(s), configItem(s)];
  if (s.os !== "linux") return { items, note: UNSUPPORTED_NOTE };
  const prerequisites = prerequisitesOf(s, deps);
  const server = await serverItem(s, deps);
  items.push(server, bundledItem(s), ...serviceItems(s, prerequisites), liveItem(prerequisites, server));
  items.push(...viewerItems(s, viewerOf(s, deps)), await rdpItem(deps, s.env));
  return { items };
}

async function installServer(s: State, deps: GuiHealthDeps): Promise<DependencyItem[]> {
  if (s.elsewhere) return [{ name: SERVER_ITEM, status: "ok", detail: `already available: ${s.backend!.label}` }];
  if (s.bundledInstalled && s.bundledPath && !s.unsupported) return [{ name: SERVER_ITEM, status: "ok", detail: `already installed: bundled (${s.bundledPath})` }];
  if (s.unsupported) {
    return [{
      name: SERVER_ITEM, status: "manual", detail: `the bundled server is Linux x64 with glibc ≥ ${MIN_GLIBC} only (this host: ${s.unsupported})`,
      action: `Build it with Rust: ${CARGO_INSTALL} (puts computer-use-mcp on PATH), then /reload`,
    }];
  }
  if (s.bundledInstalled) return [{ ...bundledItem(s), status: "manual" }];
  const items = await (deps.installNpm ?? (dir => installNpmDependencies(dir, { env: s.env })))(s.packageDir);
  const after = (deps.bundled ?? bundledBinary)();
  if (after || items.some(item => item.status === "failed" || item.status === "manual")) return items;
  return [...items.filter(item => item.status !== "warn"), {
    name: SERVER_ITEM, status: "failed", detail: `npm finished, but ${UPSTREAM_PACKAGE} did not install its binary (npm skips failed optional dependencies)`,
    action: `Run by hand and read npm's output: cd ${s.packageDir} && npm install --legacy-peer-deps; or ${CARGO_INSTALL}`,
  }];
}

/** Install what needs no privileges (the bundled server through npm); everything else is a manual step. */
export async function installGui(ctx: HealthContext, deps: GuiHealthDeps): Promise<DependencyReport> {
  const s = await inspect(ctx, deps);
  if (s.os !== "linux") return { items: [{ name: "platform", status: "manual", detail: `${s.os}: unsupported`, action: UNSUPPORTED_ACTION }], note: UNSUPPORTED_NOTE };
  const items: DependencyItem[] = [];
  if (s.loaded.errors.length) items.push({ ...configItem(s), status: "manual" });
  items.push(...await installServer(s, deps));
  const prerequisites = prerequisitesOf(s, deps);
  const missing = prerequisites.checks.filter(check => !check.ok && !isPlatformCheck(check));
  for (const check of missing) {
    const override = brokenOverride(check, s.env);
    if (override) items.push({ name: `private desktop: ${check.name}`, status: "manual", detail: check.detail, action: override });
  }
  const apt = missing.filter(check => !brokenOverride(check, s.env) && check.apt).map(check => check.apt!);
  items.push(apt.length
    ? { name: "system packages (private desktop)", status: "manual", detail: `missing ${missing.filter(check => !brokenOverride(check, s.env)).map(check => check.name).join(", ")}`, action: `${aptInstall(apt)} (pi-gui never runs sudo), then /reload` }
    : { name: "system packages (private desktop)", status: "ok", detail: "already installed" });
  const viewer = viewerOf(s, deps);
  const viewerMissing = viewer.checks.filter(check => !check.ok);
  items.push(viewerMissing.length
    ? { name: "system packages (/gui view)", status: "manual", optional: true, detail: `missing ${viewerMissing.map(check => check.name).join(", ")}`, action: `${aptInstall(viewerMissing.map(check => check.apt ?? check.name))} (needed only by /gui view)` }
    : { name: "system packages (/gui view)", status: "ok", optional: true, detail: "already installed" });
  return { items };
}

/** One install at a time: a second call while one runs gets the same promise. */
export function singleFlight<A extends unknown[], T>(fn: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  let running: Promise<T> | undefined;
  return (...args: A) => {
    running ??= fn(...args).finally(() => { running = undefined; });
    return running;
  };
}
