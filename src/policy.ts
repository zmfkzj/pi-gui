/**
 * Desktop routing of computer-use-mcp calls. Upstream routes a call without a returned ID to the foreground desktop
 * (the user's physical session) unless `desktop: "background"` is given. Here the private background desktop is the
 * default: the selector is added where upstream accepts it, and an explicit foreground request is refused unless the
 * main session opted in. Calls with returned IDs route by those IDs, which all come from the private desktop.
 *
 * This is the convenience layer. The hard boundary is the server environment (see backend.ts PHYSICAL_SESSION_ENV):
 * without the physical session's display and buses, a foreground route has nothing to reach.
 */

export interface PolicyOptions {
  /** Allow an explicit `desktop: "foreground"` and the foreground-only `human_idle` wait. */
  allowPhysicalDesktop: boolean;
  /** Worker desktops: a reason to refuse launching this desktop ID (a browser that would open the user's profile; browsers.ts). */
  checkLaunch?: (desktopId: string) => string | undefined;
  /**
   * Worker of a read-only role (orche explore/answer/verify, or no role given): only {@link OBSERVE_OPERATIONS} run.
   * `act` (clicks, typing, paste, set_value: form input, submission, upload, sign-in) is refused before it reaches the
   * server, on both tool surfaces. The value is the role name for the refusal text.
   */
  readOnlyRole?: string;
  /**
   * Whether a `/gui view` viewer (krdp) runs on this desktop now. While it does, `act` paste is typed instead
   * ({@link pasteWhileViewing}).
   */
  viewerRunning?: () => boolean;
  /** Notes about calls the policy changed (gui.log). */
  log?: (line: string) => void;
}

/** What a read-only worker may do on its private desktop: look, open apps and wait. Nothing that sends input to an app. */
export const OBSERVE_OPERATIONS: ReadonlySet<string> = new Set(["list_desktop", "launch_application", "activate_window", "observe", "wait_for"]);

export function readOnlyRefusal(operation: string, role: string): string {
  return `${operation} is refused: this worker's role (${role}) is read-only, so its private desktop is observe-only `
    + `(${[...OBSERVE_OPERATIONS].join(", ")}). Clicking, typing, form input, submission, upload and sign-in need a worker with `
    + "a writing role: report that the task needs orche_task with role implement and gui: true, delegated explicitly by the main session. "
    + "Public web pages can still be read with browser_fetch.";
}

/** Longest text of one keyboard `type` event, in Unicode scalar values (upstream's limit). */
export const TYPE_EVENT_MAX = 4096;

/**
 * `act` paste while a viewer runs on the desktop. Upstream pastes through the KDE portal's Clipboard (SetSelection,
 * SelectionTransfer, Ctrl+V). krdp, which serves `/gui view`, reads every new selection at once for its RDP client
 * (ext-data-control), and xdg-desktop-portal-kde 6.6 deadlocks when its own portal selection is read that way: its main
 * thread stops for good, so every later call fails with "AT-SPI application discovery timed out" (the portal is an
 * accessible app) and the viewer stops taking input. The desktop cannot recover without restarting it, which loses its
 * apps and sign-ins. So the paste is sent as one keyboard `type` event instead: the same focus click and text, typed
 * through EIS like upstream's own fallback when the portal offers no clipboard, with no selection change. Text longer
 * than one `type` event is refused before anything is sent. Mutates `args`; returns a reason to block the call.
 */
export function pasteWhileViewing(args: Record<string, unknown>, log?: (line: string) => void): string | undefined {
  const operation = isRecord(args.operation) ? args.operation : undefined;
  if (operation?.type !== "paste" || typeof operation.text !== "string" || !operation.text) return undefined; // upstream validates the rest
  const length = [...operation.text].length;
  if (length > TYPE_EVENT_MAX) {
    return `act paste is refused while /gui view runs on this desktop: the clipboard paste can freeze the desktop's portal (and with it every GUI call and the viewer), so pastes are typed instead, and this text has ${length} characters, more than one keyboard type event takes (${TYPE_EVENT_MAX}). `
      + `Nothing was sent. Type it in parts of at most ${TYPE_EVENT_MAX} characters with act keyboard {events: [{type: "type", text}]} (observe between parts), or ask the user to stop the viewer (/gui view stop) first.`;
  }
  args.operation = { type: "keyboard", ...(operation.focus !== undefined ? { focus: operation.focus } : {}), events: [{ type: "type", text: operation.text }] };
  log?.(`act paste of ${length} characters typed instead (a viewer runs on this desktop)`);
  return undefined;
}

export const PRIVATE_DESKTOP = "background";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const refusal = (what: string) =>
  `${what} is not available: this agent's GUI is a private desktop that the user does not see. ` +
  "Omit `desktop` (or pass \"background\"); the user's physical desktop is reachable only when they enable allowPhysicalDesktop.";

/** Route one operation (`list_desktop`, `act`, ...). Mutates `args`; returns a reason to block the call. */
export function routeOperation(operation: string, args: Record<string, unknown>, options: PolicyOptions): string | undefined {
  if (options.readOnlyRole !== undefined && !OBSERVE_OPERATIONS.has(operation)) return readOnlyRefusal(operation, options.readOnlyRole);
  const select = (): string | undefined => {
    const desktop = args.desktop;
    if (desktop === undefined) {
      args.desktop = PRIVATE_DESKTOP;
      return undefined;
    }
    if (desktop === PRIVATE_DESKTOP || (desktop === "foreground" && options.allowPhysicalDesktop)) return undefined;
    return refusal(`desktop ${JSON.stringify(desktop)}`);
  };
  switch (operation) {
    case "list_desktop":
      return select();
    case "launch_application":
      return select() ?? (options.checkLaunch && typeof args.desktop_id === "string" ? options.checkLaunch(args.desktop_id) : undefined);
    case "wait_for": {
      const condition = isRecord(args.condition) ? args.condition : undefined;
      if (condition?.type === "human_idle") return options.allowPhysicalDesktop ? undefined : refusal("wait_for human_idle (it watches the physical desktop)");
      // Only a targetless window_opened wait accepts a desktop selector; the others route by IDs.
      if (condition?.type === "window_opened" && args.target === undefined) return select();
      return undefined;
    }
    case "act":
      return options.viewerRunning?.() ? pasteWhileViewing(args, options.log) : undefined;
    default:
      return undefined;
  }
}

/**
 * Route a call of a server tool: a direct operation, or compact `dispatch {action, arguments}`. `help` and malformed
 * input pass unchanged; upstream validation reports the latter. A read-only worker's malformed dispatch is refused
 * instead (fail closed: its action is not known to be an observation).
 */
export function routeToolCall(serverTool: string, input: Record<string, unknown>, options: PolicyOptions): string | undefined {
  if (serverTool === "help") return undefined;
  if (serverTool === "dispatch") {
    if (typeof input.action !== "string" || !isRecord(input.arguments)) {
      return options.readOnlyRole !== undefined ? readOnlyRefusal(`dispatch ${JSON.stringify(input.action ?? null)}`, options.readOnlyRole) : undefined;
    }
    return routeOperation(input.action, input.arguments, options);
  }
  return routeOperation(serverTool, input, options);
}

const SESSION_HEADER = /^Desktop: (foreground|background) session=(session-[0-9a-f]+)/m;

/** The desktop and session id upstream prints at the start of every routed result; nothing else of the result is read. */
export function sessionOf(content: readonly { type: string; text?: string }[]): { desktop: string; session: string } | undefined {
  for (const block of content) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    const match = SESSION_HEADER.exec(block.text.slice(0, 200));
    if (match) return { desktop: match[1]!, session: match[2]! };
  }
  return undefined;
}

export const GUIDANCE_SECTION = "pi-gui";

/**
 * The main session's system prompt section: what the computer-use tools reach. `physical` when tools of another extension
 * that controls the user's own screen (`computer_use_*`, e.g. @amaster.ai/pi-computer-use) are registered too.
 */
export function desktopGuidance(physical: boolean): string {
  return [
    "GUI: the mcp__computer_use__* tools operate your own private desktop, a separate KDE Wayland session that the user does not see. Use it for GUI work; tell the user what you observed there, since they cannot see it.",
    ...(physical ? ["Tools named computer_use_* (without the mcp__ prefix) control the user's physical screen and apps. Use them only when the user explicitly asks you to act on their own screen."] : []),
  ].join(" ");
}
