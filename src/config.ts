import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Upstream tool surface: `compact` = help/dispatch (`mcp --compact-tools`), `direct` = the six operations. */
export type ToolMode = "compact" | "direct";
/** Pi exposure of the server in ordinary sessions. Worker sessions always use `direct`. */
export type Exposure = "direct" | "deferred" | "codemode";

export interface GuiConfig {
  /** Master switch: off disables the main-session server and the worker capability. */
  enabled: boolean;
  /** Register the server in ordinary Pi sessions (worker sessions ask for it per task). */
  mainSession: boolean;
  /** Server executable. null: the bundled npm binary, then `computer-use-mcp` on PATH, then npx. */
  command: string | null;
  /** Server arguments; null derives them from `command` and `mode`. They must contain the `mcp` subcommand. */
  args: string[] | null;
  /** Tool surface of the main session: compact by default, since most sessions never use the GUI. */
  mode: ToolMode;
  /** Tool surface of GUI workers (orche_task gui): direct by default, since they are spawned for GUI work. */
  workerMode: ToolMode;
  exposure: Exposure;
  /** Main session only: allow an explicit `desktop: "foreground"` (the user's physical desktop). */
  allowPhysicalDesktop: boolean;
  /** Pi's per-request MCP timeout. The first call of a session starts the private desktop (up to 120 s upstream). */
  timeoutSeconds: number;
  /** Extra environment for the server. Physical-session variables are removed afterwards in private mode. */
  env: Record<string, string>;
  /** `/gui view` server (KDE's krdp). null: `krdpserver` on PATH, then /usr/bin/krdpserver. */
  viewerCommand: string | null;
}

export const DEFAULT_GUI_CONFIG: Readonly<GuiConfig> = Object.freeze({
  enabled: true,
  mainSession: true,
  command: null,
  args: null,
  mode: "compact",
  workerMode: "direct",
  exposure: "direct",
  allowPhysicalDesktop: false,
  timeoutSeconds: 150,
  env: {},
  viewerCommand: null,
});

export const CONFIG_FILE = "gui.config.json";
/** Keys a project file may not set: they decide which program runs and whether the physical desktop is reachable. */
const USER_ONLY_KEYS: ReadonlySet<string> = new Set(["allowPhysicalDesktop", "command", "args", "env", "viewerCommand"]);

export interface LoadedGuiConfig {
  config: GuiConfig;
  /** Applied files in ascending precedence. */
  sources: string[];
  errors: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Validate one file's object. Throws one error listing every problem; nothing of an invalid file applies. */
export function validateGuiConfig(value: unknown, options: { project?: boolean } = {}): Partial<GuiConfig> {
  if (!isRecord(value)) throw new Error("expected a JSON object");
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.hasOwn(DEFAULT_GUI_CONFIG, key)) {
      problems.push(`unknown key "${key}"`);
      continue;
    }
    if (options.project && USER_ONLY_KEYS.has(key)) {
      problems.push(`"${key}" is only allowed in the user config`);
      continue;
    }
    let valid: boolean;
    let expected: string;
    switch (key) {
      case "enabled":
      case "mainSession":
      case "allowPhysicalDesktop":
        valid = typeof entry === "boolean";
        expected = "a boolean";
        break;
      case "command":
      case "viewerCommand":
        valid = entry === null || (typeof entry === "string" && entry.trim().length > 0);
        expected = "a non-empty string or null";
        break;
      case "args":
        valid = entry === null || (Array.isArray(entry) && entry.every(arg => typeof arg === "string"));
        expected = "an array of strings or null";
        break;
      case "mode":
      case "workerMode":
        valid = entry === "compact" || entry === "direct";
        expected = '"compact" or "direct"';
        break;
      case "exposure":
        valid = entry === "direct" || entry === "deferred" || entry === "codemode";
        expected = '"direct", "deferred" or "codemode"';
        break;
      case "timeoutSeconds":
        valid = typeof entry === "number" && Number.isInteger(entry) && entry >= 10 && entry <= 3600;
        expected = "an integer from 10 to 3600";
        break;
      case "env":
        valid = isRecord(entry) && Object.values(entry).every(item => typeof item === "string");
        expected = "an object of strings";
        break;
      default:
        valid = false;
        expected = "a known value";
    }
    if (!valid) problems.push(`${key} must be ${expected}`);
  }
  if (problems.length) throw new Error(problems.join("; "));
  return value as Partial<GuiConfig>;
}

/** Defaults, then `<agentDir>/gui.config.json`, then the trusted project's `.pi/gui.config.json`, key by key. */
export async function loadGuiConfig(options: { cwd: string; agentDir: string; projectTrusted: boolean }): Promise<LoadedGuiConfig> {
  const config: GuiConfig = { ...DEFAULT_GUI_CONFIG, env: {} };
  const sources: string[] = [];
  const errors: string[] = [];
  const files = [{ path: join(options.agentDir, CONFIG_FILE), project: false }];
  if (options.projectTrusted) files.push({ path: join(options.cwd, ".pi", CONFIG_FILE), project: true });
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${file.path}: ${(error as Error).message}`);
      continue;
    }
    try {
      Object.assign(config, validateGuiConfig(JSON.parse(text), { project: file.project }));
      sources.push(file.path);
    } catch (error) {
      errors.push(`${file.path}: ${(error as Error).message}`);
    }
  }
  return { config, sources, errors };
}
