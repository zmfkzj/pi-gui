// Real Pi sessions (SDK, faux model) with Pi's own MCP extension and a fake computer-use-mcp: the routing hook, the
// server environment, the worker capability and the process lifecycle go through Pi's actual pipeline.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
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

const fakeKrdpScript = fileURLToPath(new URL("./fixtures/fake-krdpserver.mjs", import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("/gui view: a worker's private desktop over loopback RDP, stopped with the worker", { skip: !existsSync("/usr/bin/openssl") && "openssl not installed" }, async () => {
  const bin = await mkdtemp(join(tmpdir(), "pi-gui-krdp-"));
  const record = join(bin, "record.json");
  const krdp = join(bin, "krdpserver");
  await writeFile(krdp, `#!/bin/sh\nexport FAKE_KRDP_RECORD=${JSON.stringify(record)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeKrdpScript)} "$@"\n`, { mode: 0o755 });
  const viewerReady = () => ({ ok: true, checks: [], missing: [], krdp, openssl: "/usr/bin/openssl" });
  let api: ExtensionAPI | undefined;
  const cfg = await mkdtemp(join(tmpdir(), "pi-gui-cfg-"));
  const main = await startSession([
    noMcpJson(), pi => { api = pi; },
    createGuiExtension({ agentDir: cfg, resolve: resolveFake, prerequisites: ready, viewer: { prerequisites: viewerReady } }),
  ], []);
  const notes: { text: string; level?: string }[] = [];
  const gui = main.session.extensionRunner.getCommand("gui")!;
  const ctx = { hasUI: true, ui: { notify: (text: string, level?: string) => notes.push({ text, level }) } } as unknown as Parameters<typeof gui.handler>[1];
  const command = async (args: string) => { notes.length = 0; await gui.handler(args, ctx); return notes.at(-1)!; };

  const provide = () => {
    let answer: CapabilityProvider | undefined;
    api!.events.emit(CAPABILITY_CHANNEL, { capability: "gui", cwd: process.cwd(), workerId: "W1", provide: (value: CapabilityProvider) => { answer = value; } });
    return answer!;
  };
  const provider = provide();
  assert.equal(provider.key, provide().key, "the per-worker view tag is not part of the key: reused workers keep their desktop");
  assert.match((await command("view")).text, /W1|no GUI|main/, "before the worker exists only the main session is listed");
  const worker = await startSession(provider.extensionFactories, [
    call("mcp__computer_use__launch_application", { desktop_id: "org.kde.kwrite.desktop" }),
    fauxAssistantMessage("done"),
  ], { tools: ["read", ...provider.tools] });
  assert.match((await command("view list")).text, /main, W1/);
  assert.match((await command("view W1")).text, /has not started yet/, "no desktop before the worker's first GUI call");
  await worker.session.prompt("launch");

  const opened = await command("view");
  assert.equal(opened.level, "info", opened.text);
  const port = Number(/127\.0\.0\.1:(\d+)/.exec(opened.text)?.[1]);
  const password = /Password:\s+(\S+)/.exec(opened.text)?.[1];
  assert.ok(port > 0 && password, opened.text);
  assert.match(opened.text, /W1's private desktop wayland-virtual-\d+/);
  const seen = JSON.parse(readFileSync(record, "utf8"));
  assert.equal(seen.options.address, "127.0.0.1");
  assert.equal(seen.options.port, String(port));
  assert.equal(seen.options.password, password);
  assert.match(seen.env.XDG_RUNTIME_DIR, /computer-use-mcp-isolated-/, "the viewer joined the worker's private session");
  assert.match(seen.env.WAYLAND_DISPLAY, /^wayland-virtual-\d+$/);
  assert.equal(seen.env.DISPLAY, null);
  const again = await command("view W1");
  assert.match(again.text, /Already running/);
  assert.ok(again.text.includes(`127.0.0.1:${port}`) && again.text.includes(password!), "the same connection again");
  assert.match((await command("status")).text, new RegExp(`W1 \\(viewer on 127\\.0\\.0\\.1:${port}\\)`));
  assert.doesNotMatch(readFileSync(join(cfg, "gui.log"), "utf8"), new RegExp(password!), "the password is not logged");
  assert.match(readFileSync(join(cfg, "gui.log"), "utf8"), /view W1: krdp pid \d+ listening on 127\.0\.0\.1:\d+/);

  // Stop and reopen: a new port and password; then the worker ends and takes its viewer with it.
  assert.match((await command("view stop")).text, /Stopped the viewer of W1/);
  assert.equal(isAlive(seen.pid), false);
  const reopened = await command("view W1");
  assert.match(reopened.text, /Started a remote desktop/);
  const second = JSON.parse(readFileSync(record, "utf8"));
  assert.notEqual(second.options.password, password, "a new password per viewer");
  await shutdown(worker.session);
  const deadline = Date.now() + 5_000;
  while (isAlive(second.pid) && Date.now() < deadline) await sleep(50);
  assert.equal(isAlive(second.pid), false, "the worker's session shutdown stopped its viewer");
  assert.equal(existsSync(second.env.TMPDIR), false, "its certificate directory is gone");
  assert.match((await command("view W1")).text, /no GUI desktop named "W1"/);
});

test("/gui view: missing krdp gives the install command", async () => {
  const missing = () => ({ ok: false, checks: [{ name: "krdpserver (KDE RDP server)", ok: false, detail: "not found", apt: "krdp" }], missing: ["krdpserver (KDE RDP server) (apt: krdp)"] });
  const { session } = await startSession([
    noMcpJson(),
    createGuiExtension({ agentDir: await mkdtemp(join(tmpdir(), "pi-gui-cfg-")), resolve: resolveFake, prerequisites: ready, viewer: { prerequisites: missing } }),
  ], []);
  const notes: { text: string; level?: string }[] = [];
  const gui = session.extensionRunner.getCommand("gui")!;
  await gui.handler("view main", { hasUI: true, ui: { notify: (text: string, level?: string) => notes.push({ text, level }) } } as unknown as Parameters<typeof gui.handler>[1]);
  assert.equal(notes.at(-1)!.level, "error");
  assert.match(notes.at(-1)!.text, /sudo apt install krdp/);
});
