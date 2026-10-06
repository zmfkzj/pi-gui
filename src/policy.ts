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
}

export const PRIVATE_DESKTOP = "background";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const refusal = (what: string) =>
  `${what} is not available: this agent's GUI is a private desktop that the user does not see. ` +
  "Omit `desktop` (or pass \"background\"); the user's physical desktop is reachable only when they enable allowPhysicalDesktop.";

/** Route one operation (`list_desktop`, `act`, ...). Mutates `args`; returns a reason to block the call. */
export function routeOperation(operation: string, args: Record<string, unknown>, options: PolicyOptions): string | undefined {
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
    case "launch_application":
      return select();
    case "wait_for": {
      const condition = isRecord(args.condition) ? args.condition : undefined;
      if (condition?.type === "human_idle") return options.allowPhysicalDesktop ? undefined : refusal("wait_for human_idle (it watches the physical desktop)");
      // Only a targetless window_opened wait accepts a desktop selector; the others route by IDs.
      if (condition?.type === "window_opened" && args.target === undefined) return select();
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Route a call of a server tool: a direct operation, or compact `dispatch {action, arguments}`. `help` and malformed
 * input pass unchanged; upstream validation reports the latter.
 */
export function routeToolCall(serverTool: string, input: Record<string, unknown>, options: PolicyOptions): string | undefined {
  if (serverTool === "help") return undefined;
  if (serverTool === "dispatch") {
    if (typeof input.action !== "string" || !isRecord(input.arguments)) return undefined;
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
