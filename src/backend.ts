import { accessSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { GuiConfig, ToolMode } from "./config.ts";

/** The stdio variant of Pi's MCP server config (the package exports only the union). */
export type McpStdioServerConfig = Extract<McpServerConfig, { command: string }>;

/** One server name everywhere: every session (main or worker) owns its own registration, connection and process. */
export const SERVER_NAME = "computer-use";
export const UPSTREAM_PACKAGE = "@mirsella/opencode-computer-use-mcp";
export const UPSTREAM_VERSION = "0.6.0";
export const COMPACT_TOOLS = ["help", "dispatch"] as const;
export const DIRECT_TOOLS = ["list_desktop", "launch_application", "activate_window", "observe", "act", "wait_for"] as const;

/**
 * Variables that lead to the user's physical session. In private mode the server runs without them, so the upstream
 * foreground route (its default) fails closed: no Wayland display, no session bus and no accessibility bus to reach.
 * The private runner sets its own values for everything it starts.
 */
export const PHYSICAL_SESSION_ENV = [
  "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "DISPLAY", "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS", "AT_SPI_BUS_ADDRESS", "PIPEWIRE_REMOTE", "PIPEWIRE_RUNTIME_DIR",
] as const;
/** Never created: without it libraries cannot fall back to `$XDG_RUNTIME_DIR/bus` or `wayland-0` of the physical session. */
export const NO_RUNTIME_DIR = "/nonexistent/pi-gui-no-physical-session";

/** Pi's MCP tool name: `mcp__<server>__<tool>` with every character other than letters, digits and `_` replaced by `_`. */
export function mcpToolName(tool: string, server = SERVER_NAME): string {
  return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
}

export function serverTools(mode: ToolMode): readonly string[] {
  return mode === "compact" ? COMPACT_TOOLS : DIRECT_TOOLS;
}

export function toolNames(mode: ToolMode): string[] {
  return serverTools(mode).map(tool => mcpToolName(tool));
}

/** The server tool behind a Pi tool name of this server (`mcp__computer_use__dispatch` → `dispatch`). */
export function serverToolOf(toolName: string): string | undefined {
  const prefix = mcpToolName("");
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : undefined;
}

export interface Backend {
  /** Where the executable came from. */
  source: "config" | "bundled" | "path" | "npx";
  /** Executable and the arguments before the subcommand, e.g. `npx -y pkg@1` or the binary alone. */
  command: string;
  prefix: string[];
  /** Arguments after `mcp` (`--compact-tools`), or the configured remainder. */
  mcpArgs: string[];
  /** Absolute path of the server binary when it is known without running anything. */
  binary?: string;
  /** For status lines, e.g. `bundled npm 0.6.0 (/…/computer-use-mcp)`. */
  label: string;
}

export type BackendResolution = { ok: true; backend: Backend } | { ok: false; error: string };

export interface ResolveDeps {
  env?: NodeJS.ProcessEnv;
  /** Bundled binary path, or undefined when the optional dependency is absent. */
  bundled?: () => string | undefined;
  isExecutable?: (path: string) => boolean;
}

const isExecutableFile = (path: string): boolean => {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
};

/** The binary of the optional npm dependency, resolved from this package. */
export function bundledBinary(): string | undefined {
  try {
    const entry = createRequire(import.meta.url).resolve(UPSTREAM_PACKAGE);
    const binary = join(dirname(entry), "..", "vendor", "bin", "computer-use-mcp");
    return existsSync(binary) ? binary : undefined;
  } catch {
    return undefined;
  }
}

/** `command -v`: absolute paths as given, other names on PATH. */
export function which(name: string, env: NodeJS.ProcessEnv = process.env, isExecutable = isExecutableFile): string | undefined {
  if (name.includes("/")) return isExecutable(name) ? name : undefined;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Pick the server: the configured command, else the bundled npm binary (pinned, offline), else `computer-use-mcp` on
 * PATH (e.g. `cargo install`), else `npx -y @mirsella/opencode-computer-use-mcp@0.6.0` (downloads on first use).
 */
export function resolveBackend(config: Pick<GuiConfig, "command" | "args" | "mode">, deps: ResolveDeps = {}): BackendResolution {
  const env = deps.env ?? process.env;
  const isExecutable = deps.isExecutable ?? isExecutableFile;
  const compact = config.mode === "compact" ? ["--compact-tools"] : [];
  if (config.command) {
    const command = config.command;
    let prefix: string[];
    let mcpArgs: string[];
    if (config.args) {
      const at = config.args.lastIndexOf("mcp");
      if (at < 0) return { ok: false, error: `gui.config.json args ${JSON.stringify(config.args)} must contain the "mcp" subcommand` };
      prefix = config.args.slice(0, at);
      mcpArgs = config.args.slice(at + 1);
      const hasCompact = mcpArgs.includes("--compact-tools");
      if (config.mode === "compact" && !hasCompact) mcpArgs = [...mcpArgs, "--compact-tools"];
      if (config.mode === "direct" && hasCompact) return { ok: false, error: 'gui.config.json mode "direct" conflicts with "--compact-tools" in args' };
    } else {
      prefix = command === "npx" || command.endsWith("/npx") ? ["-y", `${UPSTREAM_PACKAGE}@${UPSTREAM_VERSION}`] : [];
      mcpArgs = compact;
    }
    const found = which(command, env, isExecutable);
    if (!found) return { ok: false, error: `configured command "${command}" is not an executable${isAbsolute(command) ? "" : " on PATH"}` };
    const binary = prefix.length === 0 ? found : undefined;
    return { ok: true, backend: { source: "config", command, prefix, mcpArgs, ...(binary ? { binary } : {}), label: `configured ${[command, ...prefix].join(" ")}` } };
  }
  const bundled = (deps.bundled ?? bundledBinary)();
  if (bundled && isExecutable(bundled)) {
    return { ok: true, backend: { source: "bundled", command: bundled, prefix: [], mcpArgs: compact, binary: bundled, label: `bundled npm ${UPSTREAM_VERSION} (${bundled})` } };
  }
  const onPath = which("computer-use-mcp", env, isExecutable);
  if (onPath) return { ok: true, backend: { source: "path", command: onPath, prefix: [], mcpArgs: compact, binary: onPath, label: `PATH (${onPath})` } };
  if (which("npx", env, isExecutable)) {
    return { ok: true, backend: { source: "npx", command: "npx", prefix: ["-y", `${UPSTREAM_PACKAGE}@${UPSTREAM_VERSION}`], mcpArgs: compact, label: `npx ${UPSTREAM_PACKAGE}@${UPSTREAM_VERSION}` } };
  }
  return { ok: false, error: `computer-use-mcp not found: install ${UPSTREAM_PACKAGE} (npm), put computer-use-mcp on PATH, or set "command" in gui.config.json` };
}

/**
 * The command line of a subcommand. Private mode runs it through `env`, which removes the physical-session variables and
 * points XDG_RUNTIME_DIR at a directory that does not exist (see {@link PHYSICAL_SESSION_ENV}).
 */
export function invocation(backend: Backend, subcommand: string[], options: { physical: boolean }): { command: string; args: string[] } {
  const args = [...backend.prefix, ...subcommand];
  if (options.physical) return { command: backend.command, args };
  return {
    command: "env",
    args: [...PHYSICAL_SESSION_ENV.flatMap(name => ["-u", name]), `XDG_RUNTIME_DIR=${NO_RUNTIME_DIR}`, backend.command, ...args],
  };
}

export const SERVER_DESCRIPTION =
  "Private desktop: a KDE Wayland session of its own, invisible to the user, for GUI apps (launch, screenshot, accessibility, click, type).";

/**
 * The `pi.registerMcpServer()` config. `physical` keeps the user's session reachable (main-session opt-in only).
 * `runnerEnv` carries the runner's program overrides (see prerequisites.ts); the configured `env` wins over them.
 */
export function serverConfig(backend: Backend, config: Pick<GuiConfig, "timeoutSeconds" | "env">, options: { physical: boolean; exposure: McpStdioServerConfig["exposure"]; runnerEnv?: Record<string, string> }): McpStdioServerConfig {
  const { command, args } = invocation(backend, ["mcp", ...backend.mcpArgs], options);
  const env = { ...options.runnerEnv, ...config.env };
  return {
    command,
    args,
    ...(Object.keys(env).length ? { env } : {}),
    exposure: options.exposure,
    timeout: config.timeoutSeconds,
    description: SERVER_DESCRIPTION,
  };
}
