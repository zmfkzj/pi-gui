// Real Pi sessions (SDK, faux model) with Pi's own MCP extension and a fake computer-use-mcp: the routing hook, the
// server environment, the worker capability and the process lifecycle go through Pi's actual pipeline.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, type FauxResponseStep } from "@earendil-works/pi-ai";
import {
  createAgentSession, createMcpExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { NO_RUNTIME_DIR, type Backend } from "../src/backend.ts";
import { createGuiExtension } from "../src/index.ts";
import { checkPrerequisites } from "../src/prerequisites.ts";
import { CAPABILITY_CHANNEL, type CapabilityProvider } from "../src/worker.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-computer-use-mcp.mjs", import.meta.url));
const fakeBackend: Backend = { source: "config", command: process.execPath, prefix: [fixture], mcpArgs: ["--compact-tools"], label: "fake" };
/** The fake server, with the tool surface the requested mode asks for (like resolveBackend). */
const resolveFake = (config: { mode: "compact" | "direct" }) => ({ ok: true as const, backend: { ...fakeBackend, mcpArgs: config.mode === "compact" ? ["--compact-tools"] : [] } });
const ready = () => checkPrerequisites(undefined, { platform: "linux", isExecutable: () => true, exists: () => true });
const open: AgentSession[] = [];
after(async () => { for (const session of [...open]) await shutdown(session); });

let serial = 0;
async function startSession(factories: ExtensionFactory[], steps: FauxResponseStep[], options: { tools?: string[] } = {}) {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-gui-agent-"));
  const faux = fauxProvider({ provider: `pi-gui-faux-${++serial}` });
  faux.setResponses(steps);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(), agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: factories,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: process.cwd(), agentDir, modelRuntime: runtime, model: faux.getModel(), resourceLoader: loader,
    sessionManager: SessionManager.inMemory(process.cwd()), settingsManager: SettingsManager.inMemory({}),
    ...(options.tools ? { tools: options.tools } : {}),
  });
  await session.bindExtensions({});
  open.push(session);
  return { session, agentDir };
}

/** What Pi's runtime host does on quit: session_shutdown (MCP closes its servers), then dispose. */
async function shutdown(session: AgentSession) {
  const index = open.indexOf(session);
  if (index < 0) return;
  open.splice(index, 1);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}

const noMcpJson = () => createMcpExtension({ loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }) });
const results = (session: AgentSession) => session.messages
  .filter(message => message.role === "toolResult")
  .map(message => ({ isError: (message as { isError?: boolean }).isError === true, text: (message as { content: { type: string; text?: string }[] }).content.map(block => block.text ?? "").join("\n") }));
const payload = (text: string) => JSON.parse(text.slice(text.indexOf("\n") + 1)) as { operation: string; arguments: Record<string, unknown>; env: Record<string, string | null>; pid: number };
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("main session: private desktop by default, sanitized server environment, foreground refused", async () => {
  process.env.WAYLAND_DISPLAY ??= "wayland-test";
  const { session, agentDir } = await startSession([
    noMcpJson(),
    createGuiExtension({ agentDir: await mkdtemp(join(tmpdir(), "pi-gui-cfg-")), resolve: resolveFake, prerequisites: ready }),
  ], [
    call("mcp__computer_use__dispatch", { action: "list_desktop", arguments: { scope: "windows" } }),
    call("mcp__computer_use__dispatch", { action: "list_desktop", arguments: { scope: "windows", desktop: "foreground" } }),
    call("mcp__computer_use__dispatch", { action: "wait_for", arguments: { condition: { type: "human_idle" }, timeout_ms: 1000 } }),
    fauxAssistantMessage("done"),
  ]);
  assert.ok(agentDir);
  await session.prompt("use the desktop");
  assert.ok(["mcp__computer_use__help", "mcp__computer_use__dispatch"].every(name => session.getActiveToolNames().includes(name)), "compact tools are declared directly");
  const [first, foreground, idle] = results(session);
  assert.equal(first!.isError, false, first!.text);
  const seen = payload(first!.text);
  assert.equal(seen.operation, "list_desktop");
  assert.equal(seen.arguments.desktop, "background", "the routing hook selected the private desktop");
  assert.equal(seen.env.WAYLAND_DISPLAY, null);
  assert.equal(seen.env.DBUS_SESSION_BUS_ADDRESS, null);
  assert.equal(seen.env.AT_SPI_BUS_ADDRESS, null);
  assert.equal(seen.env.DISPLAY, null);
  assert.equal(seen.env.XDG_RUNTIME_DIR, NO_RUNTIME_DIR);
  assert.equal(foreground!.isError, true);
  assert.match(foreground!.text, /private desktop/);
  assert.equal(idle!.isError, true);
  assert.match(idle!.text, /human_idle/);
});

test("main session: the system prompt says which screen each computer-use tool reaches", async () => {
  // A stand-in for @amaster.ai/pi-computer-use: a tool that controls the user's physical screen.
  const physicalTool: ExtensionFactory = pi => pi.registerTool({
    name: "computer_use_click", label: "click", description: "Click on the user's screen", parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "clicked" }], details: undefined }),
  });
  const prompt = async (factories: ExtensionFactory[], prerequisites = ready) => {
    const { session } = await startSession([noMcpJson(), ...factories,
      createGuiExtension({ agentDir: await mkdtemp(join(tmpdir(), "pi-gui-cfg-")), resolve: resolveFake, prerequisites })], [fauxAssistantMessage("ok")]);
    await session.prompt("hello");
    return JSON.stringify(session.messages) + session.systemPrompt;
  };
  const both = await prompt([physicalTool]);
  assert.match(both, /mcp__computer_use__\* tools operate your own private desktop/);
  assert.match(both, /computer_use_\* \(without the mcp__ prefix\) control the user's physical screen/);
  const alone = await prompt([]);
  assert.match(alone, /operate your own private desktop/);
  assert.doesNotMatch(alone, /physical screen/);
  const unavailable = await prompt([physicalTool], () => ({ ok: false, checks: [], missing: ["kwin_wayland (apt: kwin-wayland)"], overrides: {}, host: "test" }));
  assert.doesNotMatch(unavailable, /private desktop/, "no guidance without a registered server");
});

test("worker capability: one server process per worker session, stopped with its session", async () => {
  let api: ExtensionAPI | undefined;
  const capture: ExtensionFactory = pi => { api = pi; };
  await startSession([
    noMcpJson(), capture,
    createGuiExtension({ agentDir: await mkdtemp(join(tmpdir(), "pi-gui-cfg-")), resolve: resolveFake, prerequisites: ready }),
  ], []);
  const request = (capability: string, workerId: string) => {
    let answer: CapabilityProvider | { error: string } | undefined;
    api!.events.emit(CAPABILITY_CHANNEL, { capability, cwd: process.cwd(), workerId, provide: (value: CapabilityProvider | { error: string }) => { answer = value; } });
    return answer;
  };
  assert.equal(request("telepathy", "W0"), undefined, "other capabilities are not answered");
  const providers = [request("gui", "W1"), request("gui", "W2")] as CapabilityProvider[];
  for (const provider of providers) {
    assert.ok(provider && "tools" in provider, JSON.stringify(provider));
    // Workers are spawned for GUI work: the six direct tools by default (workerMode), the main session stays compact.
    assert.deepEqual(provider.tools, ["list_desktop", "launch_application", "activate_window", "observe", "act", "wait_for"].map(tool => `mcp__computer_use__${tool}`));
    assert.match(provider.instructions, /KDE Wayland desktop of your own/);
    assert.equal(provider.toolTimeoutsMs.mcp__computer_use__act, 150_000);
  }
  assert.equal(providers[0]!.key, providers[1]!.key, "same configuration, same key");
  const workers = await Promise.all(providers.map(provider => startSession(provider.extensionFactories, [
    call("mcp__computer_use__launch_application", { desktop_id: "org.kde.kwrite.desktop" }),
    fauxAssistantMessage("done"),
  ], { tools: ["read", ...provider.tools] })));
  await Promise.all(workers.map(({ session }) => session.prompt("launch")));
  const pids = workers.map(({ session }) => {
    const [result] = results(session);
    assert.equal(result!.isError, false, result!.text);
    const seen = payload(result!.text);
    assert.equal(seen.arguments.desktop, "background");
    assert.equal(seen.env.WAYLAND_DISPLAY, null);
    return seen.pid;
  });
  assert.notEqual(pids[0], pids[1], "each worker session owns its own server process");
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(pids.every(alive));
  await shutdown(workers[0]!.session);
  const deadline = Date.now() + 5_000;
  while (alive(pids[0]!) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(alive(pids[0]!), false, "session_shutdown stopped worker 1's server");
  assert.equal(alive(pids[1]!), true, "worker 2's server is untouched");
});

test("worker capability is refused with the reason when prerequisites are missing", async () => {
  let api: ExtensionAPI | undefined;
  await startSession([
    noMcpJson(), pi => { api = pi; },
    createGuiExtension({ agentDir: await mkdtemp(join(tmpdir(), "pi-gui-cfg-")), resolve: resolveFake,
      prerequisites: () => ({ ok: false, checks: [], missing: ["kwin_wayland (apt: kwin-wayland)"], overrides: {}, host: "test" }) }),
  ], []);
  let answer: unknown;
  api!.events.emit(CAPABILITY_CHANNEL, { capability: "gui", cwd: process.cwd(), provide: (value: unknown) => { answer = value; } });
  assert.match((answer as { error: string }).error, /missing kwin_wayland/);
});
