import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  resolveBackend, SERVER_NAME, serverConfig, serverToolOf, toolNames, UPSTREAM_VERSION,
  type Backend, type BackendResolution,
} from "./backend.ts";
import { DEFAULT_GUI_CONFIG, loadGuiConfig, type LoadedGuiConfig } from "./config.ts";
import { GuiLog } from "./log.ts";
import { desktopGuidance, GUIDANCE_SECTION, routeToolCall, sessionOf } from "./policy.ts";
import {
  backendVersion, checkPrerequisites, doctorStatuses, privateDesktopSmoke, upstreamDoctor, type PrerequisiteReport,
} from "./prerequisites.ts";
import {
  CAPABILITY_CHANNEL, GUI_CAPABILITY, guiSessionExtension, isCapabilityRequest, workerInstructions, workerMcpExtension,
} from "./worker.ts";
import {
  checkViewerPrerequisites, connectionMessage, findPrivateSession, newViewTag, probeRdpClients, startViewer, VIEW_HOST, ViewRegistry, withViewTag,
  type PrivateSession, type RunningViewer, type SessionLookup,
} from "./viewer.ts";

/** Every live registry, so one exit hook can stop every viewer synchronously if Pi exits without a session shutdown. */
const registries = new Set<ViewRegistry>();
let exitHook = false;
function trackRegistry(registry: ViewRegistry): void {
  registries.add(registry);
  if (exitHook) return;
  exitHook = true;
  process.once("exit", () => { for (const item of registries) item.killAllSync(); });
}

export interface GuiExtensionOptions {
  agentDir?: string;
  /** Test seams. */
  resolve?: typeof resolveBackend;
  prerequisites?: typeof checkPrerequisites;
  viewer?: {
    find?: (tag: string) => SessionLookup;
    start?: (target: string, session: PrivateSession) => Promise<RunningViewer>;
    prerequisites?: typeof checkViewerPrerequisites;
  };
}

type State = "off" | "workers" | "unavailable" | "starting" | "ready" | "error";

/**
 * pi-gui: integration glue between Pi's built-in MCP support and computer-use-mcp. The main session registers its own
 * `computer-use` server; orche workers ask for the `gui` capability and get their own server in their own session. Every
 * server process is a separate computer-use-mcp broker whose background worker owns a separate private KDE Wayland
 * session (upstream's runner), so the OS process is the ownership boundary of each desktop.
 */
export function createGuiExtension(options: GuiExtensionOptions = {}) {
  return function gui(pi: ExtensionAPI): void {
    const agentDir = options.agentDir ?? getAgentDir();
    const log = new GuiLog(agentDir, "main");
    let loaded: LoadedGuiConfig = { config: { ...DEFAULT_GUI_CONFIG, env: {} }, sources: [], errors: [] };
    let resolution: BackendResolution | undefined;
    let prerequisites: PrerequisiteReport | undefined;
    let registered = false;
    let state: State = "off";
    let lastSession: { desktop: string; session: string } | undefined;
    let lastError: string | undefined;
    let version: string | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let context: ExtensionContext | undefined;

    const backend = (): Backend | undefined => (resolution?.ok ? resolution.backend : undefined);
    const tools = () => toolNames(loaded.config.mode);
    const connected = () => pi.getAllTools().some(tool => tool.name === tools()[0] && tool.exposure !== "hidden");
    const show = (next: State) => {
      state = next;
      if (!context?.hasUI) return;
      const text = next === "off" ? undefined
        : next === "workers" ? "GUI: workers only"
        : next === "ready" && lastSession ? `GUI: ready · ${lastSession.desktop === "background" ? "private" : "PHYSICAL"} ${lastSession.session.slice(0, 16)}`
        : `GUI: ${next}`;
      context.ui.setStatus("gui", text);
    };
    const stopPoll = () => { if (poll) clearInterval(poll); poll = undefined; };

    // `/gui view`: one tag per server (the main session's is stable, so re-registration keeps the same config).
    const mainTag = newViewTag();
    const viewerPrerequisites = () => (options.viewer?.prerequisites ?? checkViewerPrerequisites)(loaded.config.viewerCommand);
    const views = new ViewRegistry({
      find: options.viewer?.find ?? (tag => findPrivateSession(tag, { root: process.pid, uid: process.getuid?.() ?? -1 })),
      start: options.viewer?.start ?? ((target, session) => {
        const programs = viewerPrerequisites();
        if (!programs.krdp || !programs.openssl) return Promise.reject(new Error(`missing ${programs.missing.join(", ")}`));
        return startViewer(target, session, { krdp: programs.krdp, openssl: programs.openssl, ...(programs.gdbus ? { gdbus: programs.gdbus } : {}), log: line => log.write(line) });
      }),
      log: line => log.write(line),
    });
    trackRegistry(views);

    const setup = async (ctx: ExtensionContext) => {
      context = ctx;
      stopPoll();
      loaded = await loadGuiConfig({ cwd: ctx.cwd, agentDir, projectTrusted: ctx.isProjectTrusted() });
      if (loaded.errors.length && ctx.hasUI) ctx.ui.notify(`gui: ignored invalid config:\n${loaded.errors.join("\n")}`, "warning");
      const { config } = loaded;
      resolution = (options.resolve ?? resolveBackend)(config);
      prerequisites = (options.prerequisites ?? checkPrerequisites)(backend());
      lastSession = undefined;
      lastError = undefined;
      if (!config.enabled) {
        if (registered) pi.unregisterMcpServer(SERVER_NAME);
        registered = false;
        void views.release(mainTag);
        return show("off");
      }
      const found = backend();
      if (!found || !prerequisites.ok) {
        if (registered) pi.unregisterMcpServer(SERVER_NAME);
        registered = false;
        void views.release(mainTag);
        lastError = found ? `missing: ${prerequisites.missing.join(", ")}` : (resolution as { error: string }).error;
        log.write(`unavailable: ${lastError}`);
        return show("unavailable");
      }
      if (!config.mainSession) {
        if (registered) pi.unregisterMcpServer(SERVER_NAME);
        registered = false;
        void views.release(mainTag);
        return show("workers");
      }
      const physical = config.allowPhysicalDesktop;
      pi.registerMcpServer(SERVER_NAME, withViewTag(serverConfig(found, config, { physical, exposure: config.exposure, runnerEnv: prerequisites.overrides }), mainTag));
      views.register("main", mainTag);
      registered = true;
      log.write(`registered ${SERVER_NAME} MCP (${found.label}, ${config.mode}, ${config.exposure}${physical ? ", physical desktop allowed" : ""})`);
      show(connected() ? "ready" : "starting");
      if (state === "starting") {
        const deadline = Date.now() + 60_000;
        poll = setInterval(() => {
          if (connected()) { stopPoll(); log.write("MCP connected"); show("ready"); }
          else if (Date.now() > deadline) { stopPoll(); lastError = "MCP server did not connect within 60 s (see /mcp)"; log.write(lastError); show("error"); }
        }, 1_000);
        poll.unref?.();
      }
      void backendVersion(found).then(value => { version = value; });
    };

    pi.on("session_start", async (_event, ctx) => { await setup(ctx); });
    pi.on("session_shutdown", async () => {
      stopPoll();
      if (registered) log.write("session shutdown");
      registered = false;
      context = undefined;
      await views.stopAll();
      await views.release(mainTag);
    });

    // Which screen a tool reaches. Direct-exposure MCP servers are not described in the system prompt, and other
    // extensions (e.g. @amaster.ai/pi-computer-use, `computer_use_*`) may control the user's physical desktop next to us.
    pi.on("before_agent_start", event => {
      const { sections } = event.systemPromptOptions;
      if (!registered) { delete sections[GUIDANCE_SECTION]; return; }
      const physical = pi.getAllTools().some(tool => /^computer_use_/.test(tool.name) && tool.exposure !== "hidden");
      sections[GUIDANCE_SECTION] = desktopGuidance(physical);
    });

    // Desktop routing for this session's own server (worker sessions install the same hook through guiSessionExtension).
    pi.on("tool_call", event => {
      if (!registered) return undefined;
      const tool = serverToolOf(event.toolName);
      if (!tool) return undefined;
      const reason = routeToolCall(tool, event.input as Record<string, unknown>, { allowPhysicalDesktop: loaded.config.allowPhysicalDesktop });
      return reason ? { block: true, reason } : undefined;
    });
    pi.on("tool_result", event => {
      if (!registered || !serverToolOf(event.toolName)) return undefined;
      const seen = sessionOf(event.content);
      if (seen) {
        if (seen.session !== lastSession?.session) log.write(`${seen.desktop} desktop ready (${seen.session})`);
        lastSession = seen;
        lastError = undefined;
        show("ready");
      } else if (event.isError) {
        const text = event.content.find(block => block.type === "text");
        const message = text && "text" in text ? text.text.split("\n")[0]!.slice(0, 200) : "error";
        // A call that never reached a desktop: the server failed to start or the connection dropped (Pi reconnects on
        // the next call). Errors of the desktop itself carry the session header and land above.
        if (/MCP server|connect|Connection closed|shut down/i.test(message)) {
          lastError = message;
          log.write(`MCP error: ${message}`);
          show("error");
        }
      }
      return undefined;
    });

    // Worker capability provider: a separate session, server and private desktop per worker.
    pi.events.on(CAPABILITY_CHANNEL, data => {
      if (!isCapabilityRequest(data) || data.capability !== GUI_CAPABILITY) return;
      const { config } = loaded;
      if (!config.enabled) return data.provide({ error: "the GUI capability is disabled (gui.config.json enabled: false)" });
      if (!resolution) return data.provide({ error: "GUI unavailable: pi-gui has not started" });
      // Workers get their own tool surface (workerMode), resolved like the main session's.
      const workerResolution = (options.resolve ?? resolveBackend)({ ...config, mode: config.workerMode });
      if (!workerResolution.ok) return data.provide({ error: `GUI unavailable: ${workerResolution.error}` });
      if (!prerequisites?.ok) return data.provide({ error: `GUI unavailable: missing ${prerequisites?.missing.join(", ")}; run /gui doctor` });
      const found = workerResolution.backend;
      const names = toolNames(config.workerMode);
      const server = serverConfig(found, config, { physical: false, exposure: "direct", runnerEnv: prerequisites.overrides });
      // A fresh tag per answer: it marks this worker's server (and its private desktop) for /gui view. It is not part
      // of the key, so a reused worker keeps its session; factories load only into a newly spawned one.
      const tag = newViewTag();
      data.provide({
        key: JSON.stringify({ server, mode: config.workerMode }),
        tools: names,
        extensionFactories: [
          workerMcpExtension(),
          guiSessionExtension({
            server: withViewTag(server, tag), policy: { allowPhysicalDesktop: false }, log: new GuiLog(agentDir, `worker:${data.workerId ?? "?"}`),
            label: `${found.label}, ${config.workerMode}`, view: { registry: views, name: data.workerId ?? "worker", tag },
          }),
        ],
        instructions: workerInstructions(config.workerMode),
        toolTimeoutsMs: Object.fromEntries(names.map(name => [name, config.timeoutSeconds * 1000])),
      });
    });

    const statusReport = (): string => {
      const { config } = loaded;
      const found = backend();
      const physical = config.allowPhysicalDesktop;
      const lines = [
        `Computer Use: ${!config.enabled ? "disabled" : state === "unavailable" ? "unavailable" : config.mainSession ? "enabled" : "enabled for workers only"}`,
        `MCP server: ${!registered ? "not registered in this session" : connected() ? `${SERVER_NAME} connected (${tools().join(", ")})` : `${SERVER_NAME} registered, not connected yet (see /mcp)`}`,
        `Backend: computer-use-mcp ${version ?? UPSTREAM_VERSION} — ${found ? found.label : resolution && !resolution.ok ? resolution.error : "unresolved"}`,
        `Tools: main ${config.mode} (${tools().length} tools, Pi exposure ${config.exposure}); workers ${config.workerMode} (${toolNames(config.workerMode).length} tools, exposure direct)`,
        `Desktop: ${physical ? "private/background by default; physical foreground allowed on explicit request" : "private/background (physical desktop blocked)"}`,
        `Private session: ${lastSession ? `${lastSession.desktop} ${lastSession.session}` : "not started (starts on the first call)"}`,
        `Health: ${state === "ready" || state === "starting" ? (lastError ? `error: ${lastError}` : state === "ready" ? "ok" : "starting") : state === "unavailable" || state === "error" ? `${state}: ${lastError ?? "see /gui doctor"}` : state}`,
        `Workers: ${config.enabled && found && prerequisites?.ok ? "orche_task gui:true gets a private desktop per worker" : "GUI capability unavailable"}`,
        `Viewers (/gui view): ${views.describe()}`,
        `Config: ${loaded.sources.length ? loaded.sources.join(", ") : "defaults"}${loaded.errors.length ? ` (ignored: ${loaded.errors.join("; ")})` : ""}`,
        `Log: ${log.path}`,
      ];
      return lines.join("\n");
    };

    const viewerDoctor = async (): Promise<string[]> => {
      const programs = viewerPrerequisites();
      const lines = [`Viewer (/gui view: KDE krdp over RDP, ${VIEW_HOST} only, portal pre-authorized inside the private desktop):`];
      for (const check of programs.checks) lines.push(`  ${check.ok ? "ok     " : "MISSING"} ${check.name}${check.ok ? ` — ${check.detail}` : ` — apt install ${check.apt}`}`);
      const clients = await probeRdpClients();
      lines.push("  RDP clients on this host (krdp needs one that decodes H.264/AVC420):");
      if (clients.length) for (const line of clients) lines.push(`    ${line}`);
      else lines.push("    none found — e.g. `snap install remmina` or Flatpak org.remmina.Remmina / com.freerdp.FreeRDP (built with H.264)");
      lines.push(`  Viewer: ${programs.ok ? "ready" : `missing ${programs.missing.join(", ")}`}`);
      return lines;
    };

    const doctorReport = async (ctx: ExtensionContext): Promise<string> => {
      const found = backend();
      const report = prerequisites ?? checkPrerequisites(found);
      const lines = ["Prerequisites for private desktops (upstream runner):"];
      for (const check of report.checks) lines.push(`  ${check.ok ? "ok     " : "MISSING"} ${check.name}${check.ok ? ` — ${check.detail}` : check.apt ? ` — apt install ${check.apt}` : ` — ${check.detail}`}`);
      lines.push(`  info    host: ${report.host} (private desktops do not use it)`);
      if (!found) {
        lines.push(`Backend: ${resolution && !resolution.ok ? resolution.error : "unresolved"}`);
        lines.push(...await viewerDoctor());
        return lines.join("\n");
      }
      lines.push(`Backend: ${found.label}${version ? `, version ${version}` : ""}`);
      if (ctx.hasUI) ctx.ui.notify("gui: running upstream doctor and a private desktop smoke test…", "info");
      const doctor = await upstreamDoctor(found);
      lines.push("Upstream doctor (host session; matters only for allowPhysicalDesktop):");
      const statuses = doctorStatuses(doctor.stdout);
      if (statuses.length) for (const item of statuses) lines.push(`  ${item.section}: ${item.status}`);
      else lines.push(`  failed: ${(doctor.error ?? doctor.stderr.trim().split("\n").at(-1)) || `exit ${doctor.code}`}`);
      const smoke = await privateDesktopSmoke(found, report.overrides);
      lines.push(`Private desktop smoke test (upstream \`call\`, background list_desktop): ${smoke.ok ? "ok" : "FAILED"} in ${(smoke.ms / 1000).toFixed(1)} s — ${smoke.detail}`);
      log.write(`doctor: prerequisites ${report.ok ? "ok" : "missing"}, smoke ${smoke.ok ? "ok" : "failed"}`);
      lines.push(report.ok && smoke.ok ? "Health: ok" : `Health: ${report.ok ? "smoke test failed" : `missing ${report.missing.join(", ")}`}`);
      lines.push(...await viewerDoctor());
      return lines.join("\n");
    };

    const viewCommand = async (words: string[], ctx: ExtensionContext): Promise<{ text: string; level: "info" | "warning" | "error" }> => {
      if (words[0] === "list") return { text: views.describe(), level: "info" };
      if (words[0] === "stop") {
        const name = words[1];
        if (name === "all") {
          const stopped = await views.stopAll();
          return { text: stopped.length ? `Stopped viewers: ${stopped.join(", ")}` : "No viewer was running.", level: "info" };
        }
        let target;
        if (name) {
          const resolved = views.resolve(name);
          if ("error" in resolved) return { text: resolved.error, level: "warning" };
          target = resolved.target;
        } else {
          const running = views.list().filter(item => item.viewer && !item.viewer.exited);
          if (running.length === 0) return { text: `No viewer is running. ${views.describe()}`, level: "info" };
          if (running.length > 1) return { text: `Several viewers are running; name one or all: /gui view stop <name|all>. ${views.describe()}`, level: "warning" };
          target = running[0]!;
        }
        return { text: await views.stop(target) ? `Stopped the viewer of ${target.name}.` : `${target.name} has no viewer.`, level: "info" };
      }
      const resolved = views.resolve(words[0]);
      if ("error" in resolved) return { text: resolved.error, level: "warning" };
      if (!options.viewer?.start) {
        const programs = viewerPrerequisites();
        if (!programs.ok) {
          return { text: `Cannot open a viewer: missing ${programs.missing.join(", ")}.\nInstall: sudo apt install ${programs.checks.filter(check => !check.ok).map(check => check.apt).join(" ")} (or set "viewerCommand" in ${agentDir}/gui.config.json). Then /gui doctor.`, level: "error" };
        }
      }
      if (ctx.hasUI) ctx.ui.notify(`gui: starting a viewer for ${resolved.target.name}…`, "info");
      const outcome = await views.view(resolved.target);
      if (outcome.kind === "error") return { text: `Cannot open a viewer: ${outcome.message}`, level: "error" };
      return { text: connectionMessage(outcome.viewer, outcome.kind, { replaced: !!outcome.replaced }), level: "info" };
    };

    const SUBCOMMANDS = ["status", "doctor", "view", "view stop", "view stop all", "view list"];
    pi.registerCommand("gui", {
      description: "Private GUI desktop (computer-use-mcp): /gui status, /gui doctor, /gui view [name], /gui view stop [name|all], /gui view list",
      getArgumentCompletions: prefix => {
        const typed = prefix.trimStart();
        const names = views.list().map(target => target.name);
        const items = [...SUBCOMMANDS, ...names.map(name => `view ${name}`), ...names.map(name => `view stop ${name}`)];
        return items.filter(item => item.startsWith(typed)).map(item => ({ value: item, label: item }));
      },
      handler: async (args, ctx) => {
        const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
        if (action === "status") return ctx.ui.notify(statusReport(), "info");
        if (action === "doctor") return ctx.ui.notify(await doctorReport(ctx), "info");
        if (action === "view") {
          const { text, level } = await viewCommand(rest, ctx);
          return ctx.ui.notify(text, level);
        }
        ctx.ui.notify("Usage: /gui [status|doctor|view [name]|view stop [name|all]|view list]", "warning");
      },
    });
  };
}

export default createGuiExtension();
