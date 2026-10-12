import { createMcpExtension, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { SERVER_NAME, serverToolOf, toolNames, type McpStdioServerConfig } from "./backend.ts";
import type { ToolMode } from "./config.ts";
import type { GuiLog } from "./log.ts";
import { OBSERVE_OPERATIONS, routeToolCall, sessionOf, type PolicyOptions } from "./policy.ts";
import type { ViewRegistry } from "./viewer.ts";

/**
 * Worker capability contract (orche): orche emits `{ capability, cwd, workerId, role, readOnly, provide }` on `pi.events` when a task
 * asks for a capability; a provider answers synchronously through `provide`. The answer lists the extension factories
 * to load into that worker's own session and the tool names to allow there. Orche knows nothing about GUIs.
 */
export const CAPABILITY_CHANNEL = "orche:worker-capability";
export const GUI_CAPABILITY = "gui";

export interface CapabilityProvider {
  /** Stable description of the configuration; a reused worker whose key differs is replaced. */
  key: string;
  tools: string[];
  extensionFactories: ExtensionFactory[];
  /** Appended to the worker's instructions. */
  instructions: string;
  /** Per-tool timeouts, so liveness does not take a long first call (desktop startup) for a hang. */
  toolTimeoutsMs: Record<string, number>;
}

export interface CapabilityRequest {
  capability: string;
  cwd: string;
  workerId?: string;
  /** The worker's role, and whether it may not write the workspace (answer, explore, verify). Absent: treated as read-only. */
  role?: string;
  readOnly?: boolean;
  provide(answer: CapabilityProvider | { error: string }): void;
}

export function isCapabilityRequest(value: unknown): value is CapabilityRequest {
  const request = value as Partial<CapabilityRequest> | undefined;
  return !!request && typeof request.capability === "string" && typeof request.provide === "function";
}

/** orche's worker transcript: `<records>/<session>/workers/<id>-<spawn time>.jsonl`. */
export function workerIdOfSessionFile(file: string | undefined): string | undefined {
  return file ? /(?:^|\/)workers\/(W\d+)-[^/]*\.jsonl$/.exec(file)?.[1] : undefined;
}

/**
 * The GUI part of one session: registers this session's own computer-use server (Pi's MCP extension spawns, owns and
 * stops its process; nothing here manages processes) and routes calls to the private desktop. With `view`, the server
 * is listed for `/gui view` while the session lives; its viewer stops with the session.
 */
export function guiSessionExtension(options: {
  server: McpStdioServerConfig; policy: PolicyOptions; log: GuiLog; label: string;
  view?: { registry: ViewRegistry; name: string; tag: string };
}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerMcpServer(SERVER_NAME, options.server);
    options.log.write(`registered ${SERVER_NAME} MCP (${options.label})`);
    const view = options.view;
    if (view) view.registry.register(view.name, view.tag);
    pi.on("session_start", (_event, ctx) => {
      // orche names the worker before it is spawned; its transcript name is authoritative when there is one.
      const id = workerIdOfSessionFile(ctx.sessionManager.getSessionFile());
      if (view) view.registry.register(id ?? view.name, view.tag);
    });
    let session: string | undefined;
    const policy: PolicyOptions = {
      ...options.policy,
      ...(view ? { viewerRunning: () => view.registry.viewing(view.tag) } : {}),
      log: line => options.log.write(line),
    };
    pi.on("tool_call", event => {
      const tool = serverToolOf(event.toolName);
      if (!tool) return undefined;
      const reason = routeToolCall(tool, event.input as Record<string, unknown>, policy);
      return reason ? { block: true, reason } : undefined;
    });
    pi.on("tool_result", event => {
      if (!serverToolOf(event.toolName)) return undefined;
      const seen = sessionOf(event.content);
      if (seen && seen.session !== session) {
        session = seen.session;
        options.log.write(`${seen.desktop} desktop ready (${seen.session})`);
      } else if (event.isError && !seen) {
        options.log.write(`${event.toolName} failed before reaching a desktop`);
      }
      return undefined;
    });
    pi.on("session_shutdown", async () => {
      options.log.write(`session shutdown${session ? ` (${session})` : ""}`);
      if (view) await view.registry.release(view.tag);
    });
  };
}

/** What a worker's private desktop offers for the web: its disposable-profile browsers, or why there is none. */
export interface WorkerWeb {
  /** Desktop IDs of browsers the worker may launch (disposable profile, or any with the user's opt-in). */
  browsers: string[];
  /** The user allowed browsers with their own profile (gui.config.json allowWorkerUserBrowserProfiles). */
  userProfiles: boolean;
}

export function workerInstructions(mode: ToolMode, options: { readOnly?: boolean; web?: WorkerWeb } = {}): string {
  const [first, second] = toolNames(mode);
  const web = options.web;
  const browserLine = !web ? [] : web.userProfiles
    ? [`Web browsers on this desktop: ${web.browsers.join(", ") || "none listed"}. The user allowed browsers that use their own profile here: one may be signed in as the user, so act only as the assignment says.`]
    : web.browsers.length
      ? [`Web browsers: launch only ${web.browsers.join(", ")}. It starts signed out with a fresh or temporary profile of its own (not the user's), deleted when it closes or with this desktop; other browser entries (the snap's own Chromium and Firefox entries included) are refused because they would open the user's own profile, cookies and logins.`]
      : ["Web browsers: none can run here with a disposable profile (Chromium-family browsers installed outside snap/Flatpak can, and the installed snap Chromium through pi-gui's temporary-profile entry when /gui status offers it), and other browser entries are refused because they would open the user's own profile. If the task needs a rendered page, report that, instead of working around it."];
  const readOnly = options.readOnly !== false;
  const readOnlyLine = !readOnly ? [] : [
    `Your role is read-only, so this desktop is observe-only: ${[...OBSERVE_OPERATIONS].join(", ")}. act (clicks, typing, paste, form input) is refused before it runs. When the task needs input in an app (navigating a page, submitting, uploading, signing in), stop and report that it needs a worker with a writing role (orche_task role implement with gui: true, delegated by the main session). Read public web pages with browser_fetch.`,
  ];
  const tools = mode === "compact" ? `${first} and ${second}` : "the mcp__computer_use__* tools";
  const howTo = mode === "compact"
    ? "Call help with an action name to get its schema before the first dispatch of that action."
    : "Each tool documents its own arguments.";
  return [
    `Private GUI desktop: ${tools} operate a KDE Wayland desktop of your own. The user does not see it; it is not their screen, and other workers have their own.`,
    `${howTo} Typical flow: list_desktop {scope: "applications"} → launch_application {desktop_id} → list_desktop {scope: "windows"} until the window is listed (windows are found through accessibility; window_opened waits need compositor app IDs, which KWin may not provide) → observe {target, view: "both"}${readOnly ? "" : " → act → observe again"}. Copy returned IDs unchanged.`,
    "Apps that start other programs (terminals, KRunner, System Settings) are refused here, and links opened by an app go only to the browser allowed below (or nowhere).",
    "Apps there run as the user with the user's files and network: stay within the assignment, and report GUI evidence (what you observed) in your result.",
    "When a step needs the user (a sign-in, 2FA code, CAPTCHA or consent screen), do not guess credentials or work around it: leave the app on that screen and end the assignment, reporting that user sign-in is needed on this desktop. The user can open it with /gui view and then reuse you with the same desktop.",
    ...browserLine,
    ...readOnlyLine,
  ].join("\n");
}

const SHARED_WORKER_MCP = Symbol.for("pi.orche.worker-mcp-extension");
/**
 * Pi's MCP extension for a worker session: only the servers this session registers, never the user's mcp.json. One factory
 * object per process, shared through `globalThis` with other capability providers (pi-codegraph), so orche, which merges
 * capability factories by identity, loads one MCP extension per worker session (two would each connect every server).
 */
export function workerMcpExtension(): ExtensionFactory {
  const store = globalThis as { [SHARED_WORKER_MCP]?: ExtensionFactory };
  return store[SHARED_WORKER_MCP] ??= createMcpExtension({ loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }) });
}
