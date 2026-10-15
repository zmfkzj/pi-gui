// Real Pi sessions (SDK, faux model) with Pi's own MCP extension and a fake computer-use-mcp: the routing hook, the
// server environment, the worker capability and the process lifecycle go through Pi's actual pipeline.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { createGuiExtension, type GuiExtensionOptions } from "../src/index.ts";
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
    createGuiExtension({ snapChromium: noSnap, agentDir: await mkdtemp(join(tmpdir(), "pi-gui-cfg-")), resolve: resolveFake, prerequisites: ready }),
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
      createGuiExtension({ snapChromium: noSnap, agentDir: await mkdtemp(join(tmpdir(), "pi-gui-cfg-")), resolve: resolveFake, prerequisites })], [fauxAssistantMessage("ok")]);
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
  const cfg = await mkdtemp(join(tmpdir(), "pi-gui-cfg-"));
  await writeFile(join(cfg, "gui.config.json"), JSON.stringify({ env: { XDG_DATA_DIRS: await workerApps() } }));
  await startSession([
    noMcpJson(), capture,
    createGuiExtension({ snapChromium: noSnap, agentDir: cfg, resolve: resolveFake, prerequisites: ready }),
  ], []);
  const request = (capability: string, workerId: string) => {
    let answer: CapabilityProvider | { error: string } | undefined;
    api!.events.emit(CAPABILITY_CHANNEL, { capability, cwd: process.cwd(), workerId, role: "implement", readOnly: false, provide: (value: CapabilityProvider | { error: string }) => { answer = value; } });
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
    createGuiExtension({ snapChromium: noSnap, agentDir: await mkdtemp(join(tmpdir(), "pi-gui-cfg-")), resolve: resolveFake,
      prerequisites: () => ({ ok: false, checks: [], missing: ["kwin_wayland (apt: kwin-wayland)"], overrides: {}, host: "test" }) }),
  ], []);
  let answer: unknown;
  api!.events.emit(CAPABILITY_CHANNEL, { capability: "gui", cwd: process.cwd(), provide: (value: unknown) => { answer = value; } });
  assert.match((answer as { error: string }).error, /missing kwin_wayland/);
});

/**
 * A data dir of apps for worker tests: a disposable-profile browser (Chromium family, not a snap), Firefox (profile under
 * $HOME), a terminal, an `sh -c` wrapper, a Chromium launcher that moves its profile through the environment, and KWrite.
 */
/** Hosts without a usable snap Chromium (the default here: tests do not depend on this machine's snaps). */
const noSnap = () => ({ ok: false as const, reason: "the chromium snap is not installed (test)" });

async function workerApps(extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-apps-"));
  const apps = join(root, "share", "applications");
  await mkdir(apps, { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
  const http = "MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;";
  const entries: Record<string, string> = {
    "google-chrome": `Exec=${join(root, "bin", "google-chrome")} %U\n${http}`,
    firefox: `Exec=${join(root, "bin", "firefox")} %u\n${http}`,
    "chromium-home": `Exec=env XDG_CONFIG_HOME=/home/someone/.config ${join(root, "bin", "chromium")} %U\n${http}`,
    "org.kde.konsole": `Exec=${join(root, "bin", "konsole")}\nCategories=Qt;KDE;System;TerminalEmulator;`,
    "open-link": "Exec=sh -c 'firefox https://example.com'\nCategories=Network;",
    "org.kde.kwrite": `Exec=${join(root, "bin", "kwrite")} %U\nMimeType=text/plain;`,
    ...extra,
  };
  for (const name of ["google-chrome", "firefox", "chromium", "konsole", "kwrite"]) await writeFile(join(root, "bin", name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  for (const [id, body] of Object.entries(entries)) await writeFile(join(apps, `${id}.desktop`), `[Desktop Entry]\nType=Application\nName=${id}\n${body}\n`);
  return join(root, "share");
}

/** A main session with pi-gui (fake backend) and a function that asks it for a worker's GUI capability. */
async function guiProvider(config: Record<string, unknown> = {}, options: { snapChromium?: GuiExtensionOptions["snapChromium"]; apps?: Record<string, string> } = {}) {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-gui-cfg-"));
  await writeFile(join(agentDir, "gui.config.json"), JSON.stringify({ env: { XDG_DATA_DIRS: await workerApps(options.apps) }, ...config }));
  let api: ExtensionAPI | undefined;
  const { session } = await startSession([noMcpJson(), pi => { api = pi; }, createGuiExtension({ snapChromium: options.snapChromium ?? noSnap, agentDir, resolve: resolveFake, prerequisites: ready })], []);
  const request = (fields: Record<string, unknown>) => {
    let answer: CapabilityProvider | undefined;
    api!.events.emit(CAPABILITY_CHANNEL, { capability: "gui", cwd: process.cwd(), workerId: "W1", ...fields, provide: (value: CapabilityProvider) => { answer = value; } });
    return answer!;
  };
  /** `/gui status` text. */
  const status = async () => {
    let text = "";
    const ctx = { hasUI: true, cwd: process.cwd(), isProjectTrusted: () => false, ui: { notify: (value: string) => { text = value; }, setStatus: () => undefined } };
    await session.extensionRunner.getCommand("gui")!.handler("status", ctx as never);
    return text;
  };
  return { agentDir, request, status };
}

/** Run tool calls in a worker session loaded from `provider`; `extraTools` simulates a widened allowlist. */
async function runWorker(provider: CapabilityProvider, calls: [string, Record<string, unknown>][], extraTools: string[] = []) {
  const worker = await startSession(provider.extensionFactories, [...calls.map(([name, args]) => call(name, args as Parameters<typeof call>[1])), fauxAssistantMessage("done")], { tools: ["read", ...provider.tools, ...extraTools] });
  await worker.session.prompt("work");
  const found = results(worker.session);
  await shutdown(worker.session);
  return found;
}
const tool = (name: string) => `mcp__computer_use__${name}`;
/** A result from the (fake) server, not a refusal of the routing hook. */
const reachedServer = (result: { text: string }) => /^Desktop: \w+ session=/.test(result.text);
const act = { target: { app_instance_id: "app-1", window_instance_id: "win-1" }, source_observation: { observation_id: "obs-1" }, operation: { type: "semantic", action: { type: "invoke" } } };

test("worker capability: read-only roles get an observe-only desktop, enforced before the server (direct tools)", async () => {
  const { request } = await guiProvider();
  for (const fields of [{ role: "answer", readOnly: true }, { role: "explore", readOnly: true }, { role: "verify", readOnly: true }, {}]) {
    const answer = request(fields);
    assert.deepEqual(answer.tools, ["list_desktop", "launch_application", "activate_window", "observe", "wait_for"].map(tool), JSON.stringify(fields));
    assert.match(answer.instructions, /Your role is read-only, so this desktop is observe-only/);
    assert.doesNotMatch(answer.instructions, /→ act/);
  }
  const implement = request({ role: "implement", readOnly: false });
  assert.ok(implement.tools.includes(tool("act")));
  assert.doesNotMatch(implement.instructions, /read-only/);
  assert.notEqual(implement.key, request({ role: "answer", readOnly: true }).key, "a role change replaces the worker");

  // Even with act in the session's allowlist, the routing hook refuses it before it reaches the server.
  const [refused, observed] = await runWorker(request({ role: "answer", readOnly: true }), [[tool("act"), { ...act }], [tool("observe"), { target: act.target }]], [tool("act")]);
  assert.equal(refused!.isError, true);
  assert.equal(reachedServer(refused!), false);
  assert.match(refused!.text, /act is refused: this worker's role \(answer\) is read-only.*orche_task with role implement and gui: true.*browser_fetch/s);
  assert.equal(reachedServer(observed!), true, observed!.text);
  const [missingRole] = await runWorker(request({}), [[tool("act"), { ...act }]], [tool("act")]);
  assert.match(missingRole!.text, /role \(unspecified\) is read-only/);
  const [allowed] = await runWorker(implement, [[tool("act"), { ...act }]]);
  assert.equal(reachedServer(allowed!), true, allowed!.text);

  // The user's browser-profile opt-in does not lift the role boundary.
  const optedIn = (await guiProvider({ allowWorkerUserBrowserProfiles: true })).request({ role: "verify", readOnly: true });
  assert.ok(!optedIn.tools.includes(tool("act")));
  const [stillRefused] = await runWorker(optedIn, [[tool("act"), { ...act }]], [tool("act")]);
  assert.equal(reachedServer(stillRefused!), false);
});

test("worker capability: compact dispatch has the same boundary, failing closed on malformed input", async () => {
  const { request } = await guiProvider({ workerMode: "compact" });
  const answer = request({ role: "answer", readOnly: true });
  assert.deepEqual(answer.tools, [tool("help"), tool("dispatch")]);
  const found = await runWorker(answer, [
    [tool("dispatch"), { action: "act", arguments: { ...act } }],
    [tool("dispatch"), { action: "act" }],
    [tool("dispatch"), { action: "launch_application", arguments: { desktop_id: "firefox.desktop" } }],
    [tool("dispatch"), { action: "launch_application", arguments: { desktop_id: "google-chrome.desktop" } }],
  ]);
  assert.deepEqual(found.map(reachedServer), [false, false, false, true], found.map(result => result.text).join("\n"));
  assert.match(found[0]!.text, /act is refused: this worker's role \(answer\) is read-only/);
  assert.match(found[1]!.text, /dispatch "act" is refused/);
  assert.match(found[2]!.text, /firefox\.desktop is refused/);
  const [written] = await runWorker(request({ role: "implement", readOnly: false }), [[tool("dispatch"), { action: "act", arguments: { ...act } }]]);
  assert.equal(reachedServer(written!), true, written!.text);
});

test("worker capability: launches that would reach the user's browser profile are refused; links go to the allowed browser", async () => {
  const { agentDir, request } = await guiProvider();
  const provider = request({ role: "implement", readOnly: false });
  assert.match(provider.instructions, /Web browsers: launch only google-chrome\.desktop\. It starts signed out with a fresh or temporary profile of its own \(not the user's\)/);
  const launch = (id: string): [string, Record<string, unknown>] => [tool("launch_application"), { desktop_id: id }];
  const found = await runWorker(provider, ["google-chrome.desktop", "firefox.desktop", "chromium-home.desktop", "org.kde.konsole.desktop", "open-link.desktop", "missing.desktop", "org.kde.kwrite.desktop"].map(launch));
  assert.deepEqual(found.map(reachedServer), [true, false, false, false, false, false, true], found.map(result => result.text).join("\n"));
  assert.match(found[1]!.text, /firefox\.desktop is refused.*only Chromium-family browsers/);
  assert.match(found[2]!.text, /sets environment variables that can move the profile/);
  assert.match(found[3]!.text, /it is a terminal/);
  assert.match(found[4]!.text, /runs a command line through sh/);
  assert.match(found[5]!.text, /no such application entry was found/);
  // The server (and so the private desktop and its apps) gets the pinned web defaults.
  const seen = payload(found[0]!.text);
  assert.match(seen.env.BROWSER!, /\/bin\/google-chrome$/);
  const configDir = seen.env.XDG_CONFIG_DIRS!.split(":")[0]!;
  assert.ok(configDir.startsWith(join(agentDir, "pi-gui", "worker-web")), configDir);
  const mimeapps = readFileSync(join(configDir, "mimeapps.list"), "utf8");
  assert.match(mimeapps, /\[Default Applications\]\nx-scheme-handler\/http=google-chrome\.desktop;/);
  assert.match(mimeapps, /\[Removed Associations\][^[]*x-scheme-handler\/https=chromium-home\.desktop;firefox\.desktop;/);

  // The user's opt-in lifts the browser check and the pinned defaults, nothing else.
  const optedIn = (await guiProvider({ allowWorkerUserBrowserProfiles: true })).request({ role: "implement", readOnly: false });
  assert.match(optedIn.instructions, /The user allowed browsers that use their own profile here/);
  const [firefox] = await runWorker(optedIn, [launch("firefox.desktop")]);
  assert.equal(reachedServer(firefox!), true);
  assert.equal(payload(firefox!.text).env.BROWSER, process.env.BROWSER ?? null);
});

test("worker capability: the installed snap Chromium runs only through pi-gui's temporary-profile entry", async () => {
  const userRuntime = await mkdtemp(join(tmpdir(), "pgr-"));
  const snapApps = {
    chromium_chromium: "Exec=/snap/bin/chromium %U\nX-SnapInstanceName=chromium\nCategories=Network;WebBrowser;\nMimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;",
  };
  // No non-snap browser: pi-gui's entry is the only browser and the links' handler.
  const apps = { ...snapApps, "google-chrome": "Exec=/nonexistent/google-chrome %U\nMimeType=text/html;x-scheme-handler/http;" };
  const { agentDir, request } = await guiProvider({}, { apps, snapChromium: () => ({ ok: true, userRuntime }) });
  const provider = request({ role: "implement", readOnly: false });
  assert.match(provider.instructions, /Web browsers: launch only pi-gui-chromium-temp-profile\.desktop\./);
  const launch = (id: string): [string, Record<string, unknown>] => [tool("launch_application"), { desktop_id: id }];
  const found = await runWorker(provider, ["pi-gui-chromium-temp-profile.desktop", "pi-gui-chromium-temp-profile", "chromium_chromium.desktop", "firefox.desktop"].map(launch));
  assert.deepEqual(found.map(reachedServer), [true, true, false, false], found.map(result => result.text).join("\n"));
  assert.match(found[2]!.text, /chromium_chromium\.desktop is refused.*is a snap.*launch pi-gui-chromium-temp-profile\.desktop: the same snap Chromium with a temporary profile/s);
  const env = payload(found[0]!.text).env;
  // The private desktop's runtime dir lands in /run/user/<uid>/snap.chromium (here: a stand-in), where the snap may connect.
  assert.equal(env.TMPDIR, join(userRuntime, "snap.chromium", "pi-gui"));
  assert.equal(statSync(env.TMPDIR!).mode & 0o777, 0o700);
  // Default launch, registered entry, links and $BROWSER all go through the same shim → supervisor.
  const dataDir = env.XDG_DATA_DIRS!.split(":")[0]!;
  assert.ok(dataDir.startsWith(join(agentDir, "pi-gui", "worker-web")), dataDir);
  const entry = readFileSync(join(dataDir, "applications", "pi-gui-chromium-temp-profile.desktop"), "utf8");
  const shim = /^Exec=(\/\S+) %U$/m.exec(entry)?.[1];
  assert.ok(shim && existsSync(shim), entry);
  assert.equal(env.BROWSER, shim);
  assert.equal(statSync(shim).mode & 0o111, 0o111);
  const shimText = readFileSync(shim, "utf8");
  assert.ok(shimText.includes(`exec '${process.execPath}' '${fileURLToPath(new URL("../bin/pi-gui-snap-chromium.mjs", import.meta.url))}' "$@"`), shimText);
  assert.ok(shimText.includes(`PI_GUI_SNAP_CHROMIUM_LOG='${join(agentDir, "gui-snap-chromium.log")}'`), shimText);
  const mimeapps = readFileSync(join(env.XDG_CONFIG_DIRS!.split(":")[0]!, "mimeapps.list"), "utf8");
  assert.match(mimeapps, /\[Default Applications\]\nx-scheme-handler\/http=pi-gui-chromium-temp-profile\.desktop;/);
  assert.match(mimeapps, /\[Removed Associations\][^[]*x-scheme-handler\/https=[^\n]*chromium_chromium\.desktop;/);

  // Not offered (e.g. an unverified launcher): pi-gui's entry is refused too, and nothing moves the desktop's runtime.
  const off = await guiProvider({}, { apps, snapChromium: () => ({ ok: false, reason: "its launcher differs from the verified one" }) });
  const refusedProvider = off.request({ role: "implement", readOnly: false });
  assert.match(refusedProvider.instructions, /Web browsers: none can run here/);
  const [refused, snapRefused] = await runWorker(refusedProvider, [launch("pi-gui-chromium-temp-profile.desktop"), launch("chromium_chromium.desktop")]);
  assert.equal(reachedServer(refused!), false);
  assert.match(refused!.text, /snap Chromium with a temporary profile is not offered here/);
  assert.match(snapRefused!.text, /is a snap.*e\.g\. Google Chrome/s);
  const offEnv = payload((await runWorker(refusedProvider, [launch("org.kde.kwrite.desktop")]))[0]!.text).env;
  assert.equal(offEnv.TMPDIR, process.env.TMPDIR ?? null);
  assert.equal(offEnv.BROWSER!.endsWith("/true"), true, offEnv.BROWSER!);
  // A read-only role still only observes; the user's opt-in does not use the temporary-profile entry.
  const readOnly = request({ role: "verify", readOnly: true });
  assert.ok(!readOnly.tools.includes(tool("act")));
  const optedIn = (await guiProvider({ allowWorkerUserBrowserProfiles: true }, { apps, snapChromium: () => ({ ok: true, userRuntime }) })).request({ role: "implement", readOnly: false });
  const [optedEnv] = await runWorker(optedIn, [launch("chromium_chromium.desktop")]);
  assert.equal(payload(optedEnv!.text).env.TMPDIR, process.env.TMPDIR ?? null);
});

test("worker capability: the agent profile only with the user's workerBrowserProfile, for writing roles, never as the link handler; busy refusals", async () => {
  const userRuntime = await mkdtemp(join(tmpdir(), "pgr-"));
  // No non-snap browser (as on this machine): pi-gui's temporary-profile entry is the only browser and the links' handler.
  const apps = {
    chromium_chromium: "Exec=/snap/bin/chromium %U\nX-SnapInstanceName=chromium\nCategories=Network;WebBrowser;\nMimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;",
    "google-chrome": "Exec=/nonexistent/google-chrome %U\nMimeType=text/html;x-scheme-handler/http;",
  };
  const snapOk = () => ({ ok: true as const, userRuntime });
  const name = `t${process.pid}-ext`;
  const launch = (id: string): [string, Record<string, unknown>] => [tool("launch_application"), { desktop_id: id }];

  // Default (no workerBrowserProfile): exactly as before, the agent entry is refused and nothing persistent is offered.
  const plainProvider = await guiProvider({}, { apps, snapChromium: snapOk });
  const plain = plainProvider.request({ role: "implement", readOnly: false });
  assert.doesNotMatch(await plainProvider.status(), /Agent browser profile/);
  assert.doesNotMatch(plain.instructions, /agent browser profile/);
  const [notOffered] = await runWorker(plain, [launch("pi-gui-chromium-agent-profile.desktop")]);
  assert.equal(reachedServer(notOffered!), false);
  assert.match(notOffered!.text, /agent browser profile is not offered here/);

  const { request, status } = await guiProvider({ workerBrowserProfile: name }, { apps, snapChromium: snapOk });
  assert.match(await status(), new RegExp(`\\nAgent browser profile "${name}" \\(workerBrowserProfile, sign-ins kept in \\S+/snap/chromium/common/pi-gui-profiles/${name}/chromium\\): pi-gui-chromium-agent-profile\\.desktop for writing-role workers, one desktop at a time`));
  assert.match(await (await guiProvider({ workerBrowserProfile: name }, { apps, snapChromium: () => ({ ok: false, reason: "x" }) })).status(), /Agent browser profile .*not offered \(snap Chromium is not: x\)/);
  const provider = request({ role: "implement", readOnly: false });
  assert.match(provider.instructions, new RegExp(`agent browser profile "${name}": pi-gui-chromium-agent-profile\\.desktop .*kept across browser restarts and desktops.*one desktop at a time`));
  assert.match(provider.instructions, /Web browsers: launch only pi-gui-chromium-temp-profile\.desktop\. It starts signed out/, "the temporary entry is still offered as before");
  assert.notEqual(provider.key, plain.key, "turning the profile on replaces a reused worker");
  assert.notEqual(provider.key, (await guiProvider({ workerBrowserProfile: `${name}-2` }, { apps, snapChromium: snapOk })).request({ role: "implement", readOnly: false }).key, "so does another profile");
  const [agentLaunch, tempLaunch] = await runWorker(provider, [launch("pi-gui-chromium-agent-profile.desktop"), launch("pi-gui-chromium-temp-profile.desktop")]);
  assert.equal(reachedServer(agentLaunch!), true, agentLaunch!.text);
  assert.equal(reachedServer(tempLaunch!), true, tempLaunch!.text);
  const env = payload(agentLaunch!.text).env;
  const dataDir = env.XDG_DATA_DIRS!.split(":")[0]!;
  const agentEntry = readFileSync(join(dataDir, "applications", "pi-gui-chromium-agent-profile.desktop"), "utf8");
  const agentShim = /^Exec=(\/\S+) %U$/m.exec(agentEntry)?.[1];
  assert.ok(agentShim && readFileSync(agentShim, "utf8").includes(`PI_GUI_SNAP_CHROMIUM_PROFILE='${name}'`), agentEntry);
  // Links and $BROWSER stay with the temporary profile.
  assert.ok(readFileSync(env.BROWSER!, "utf8").includes("PI_GUI_SNAP_CHROMIUM_PROFILE=''"));
  assert.match(readFileSync(join(env.XDG_CONFIG_DIRS!.split(":")[0]!, "mimeapps.list"), "utf8"), /\[Default Applications\]\nx-scheme-handler\/http=pi-gui-chromium-temp-profile\.desktop;/);

  // Busy: a live launch of this profile (here: a record naming this test process) on this or another desktop.
  const launchDir = join(userRuntime, "snap.chromium", "pi-gui-launch-test");
  await mkdir(launchDir, { recursive: true });
  const record = (tag: string) => writeFile(join(launchDir, "owner.json"), JSON.stringify({ pid: process.pid, runtime: "/r", profile: "/p", agentProfile: name, display: "wayland-virtual-9", tag }));
  const worker = request({ role: "implement", readOnly: false });
  const ownTag = payload((await runWorker(worker, [launch("org.kde.kwrite.desktop")]))[0]!.text).env.PI_GUI_VIEW_TAG!;
  await record("another-server");
  const [refused, tempStill] = await runWorker(worker, [launch("pi-gui-chromium-agent-profile.desktop"), launch("pi-gui-chromium-temp-profile.desktop")]);
  assert.equal(reachedServer(refused!), false);
  assert.match(refused!.text, new RegExp(`agent browser profile "${name}" is already open on another private desktop \\(wayland-virtual-9.*one desktop at a time`));
  assert.equal(reachedServer(tempStill!), true, "the temporary entry is not affected");
  await record(ownTag);
  const [again] = await runWorker(worker, [launch("pi-gui-chromium-agent-profile.desktop")]);
  assert.match(again!.text, /already open on this desktop .*Use that window/);
  await rm(launchDir, { recursive: true });
  const [free] = await runWorker(worker, [launch("pi-gui-chromium-agent-profile.desktop")]);
  assert.equal(reachedServer(free!), true, "free again once that launch is gone");

  // Read-only roles, an unavailable snap Chromium and allowWorkerUserBrowserProfiles: not offered.
  const readOnly = request({ role: "verify", readOnly: true });
  assert.doesNotMatch(readOnly.instructions, /agent browser profile/);
  const [readOnlyLaunch] = await runWorker(readOnly, [launch("pi-gui-chromium-agent-profile.desktop")]);
  assert.match(readOnlyLaunch!.text, /agent browser profile is not offered here/);
  const noSnapAnswer = (await guiProvider({ workerBrowserProfile: name }, { apps, snapChromium: () => ({ ok: false, reason: "x" }) })).request({ role: "implement", readOnly: false });
  assert.doesNotMatch(noSnapAnswer.instructions, /agent browser profile/);
  const userProfiles = (await guiProvider({ workerBrowserProfile: name, allowWorkerUserBrowserProfiles: true }, { apps, snapChromium: snapOk })).request({ role: "implement", readOnly: false });
  assert.doesNotMatch(userProfiles.instructions, /agent browser profile/);
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
  await writeFile(join(cfg, "gui.config.json"), JSON.stringify({ env: { XDG_DATA_DIRS: await workerApps() } }));
  const main = await startSession([
    noMcpJson(), pi => { api = pi; },
    createGuiExtension({ snapChromium: noSnap, agentDir: cfg, resolve: resolveFake, prerequisites: ready, viewer: { prerequisites: viewerReady } }),
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

// Regression (live: test/integration/paste-view.integration.ts): an act paste through the KDE portal's Clipboard while krdp
// serves the same desktop deadlocked xdg-desktop-portal-kde, and every later call failed with "AT-SPI application
// discovery timed out". While a viewer runs, the routing hook types the paste instead; nothing else changes.
test("/gui view: while a viewer runs, act paste reaches the server as typing; long text is refused before anything is sent", { skip: !existsSync("/usr/bin/openssl") && "openssl not installed" }, async () => {
  const bin = await mkdtemp(join(tmpdir(), "pi-gui-krdp-"));
  const krdp = join(bin, "krdpserver");
  await writeFile(krdp, `#!/bin/sh\nexport FAKE_KRDP_RECORD=${JSON.stringify(join(bin, "record.json"))}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeKrdpScript)} "$@"\n`, { mode: 0o755 });
  let api: ExtensionAPI | undefined;
  const cfg = await mkdtemp(join(tmpdir(), "pi-gui-cfg-"));
  await writeFile(join(cfg, "gui.config.json"), JSON.stringify({ env: { XDG_DATA_DIRS: await workerApps() } }));
  const main = await startSession([
    noMcpJson(), pi => { api = pi; },
    createGuiExtension({ snapChromium: noSnap, agentDir: cfg, resolve: resolveFake, prerequisites: ready, viewer: { prerequisites: () => ({ ok: true, checks: [], missing: [], krdp, openssl: "/usr/bin/openssl" }) } }),
  ], []);
  const gui = main.session.extensionRunner.getCommand("gui")!;
  const notes: { text: string; level?: string }[] = [];
  const ctx = { hasUI: true, ui: { notify: (text: string, level?: string) => notes.push({ text, level }) } } as unknown as Parameters<typeof gui.handler>[1];
  const command = async (args: string) => { notes.length = 0; await gui.handler(args, ctx); return notes.at(-1)!; };
  let provider: CapabilityProvider | undefined;
  api!.events.emit(CAPABILITY_CHANNEL, { capability: "gui", cwd: process.cwd(), workerId: "W1", role: "implement", readOnly: false, provide: (value: CapabilityProvider) => { provider = value; } });
  const target = { app_instance_id: "app-0000000000000001", window_instance_id: "win-0000000000000002" };
  const source = { observation_id: "obs-0000000000000003", frame_id: "frame-0000000000000004" };
  const paste = (text: string) => ({ target, source_observation: source, operation: { type: "paste", focus: { type: "point", x: 620, y: 63 }, text } });
  const click = { target, source_observation: source, operation: { type: "pointer", action: { type: "click", x: 1, y: 2 } } };
  const url = "https://example.test/saved-versions?limit=10\n";
  const long = "가".repeat(4097);
  const worker = await startSession(provider!.extensionFactories, [
    call("mcp__computer_use__list_desktop", { scope: "windows" }),
    fauxAssistantMessage("desktop up"),
    call("mcp__computer_use__act", paste(url)),
    call("mcp__computer_use__act", paste(long)),
    call("mcp__computer_use__act", click),
    fauxAssistantMessage("viewer on"),
    call("mcp__computer_use__act", paste(url)),
    fauxAssistantMessage("viewer off"),
  ], { tools: provider!.tools });
  await worker.session.prompt("start");
  assert.equal((await command("view W1")).level, "info");
  await worker.session.prompt("paste with the viewer");
  const [, typed, refused, clicked] = results(worker.session);
  assert.equal(typed!.isError, false, typed!.text);
  const typedArgs = payload(typed!.text);
  assert.equal(typedArgs.operation, "act");
  assert.deepEqual(typedArgs.arguments.operation, { type: "keyboard", focus: { type: "point", x: 620, y: 63 }, events: [{ type: "type", text: url }] }, "the paste reached the server as one type event");
  assert.deepEqual(typedArgs.arguments.target, target);
  assert.deepEqual(typedArgs.arguments.source_observation, source);
  assert.equal(refused!.isError, true);
  assert.doesNotMatch(refused!.text, /^Desktop: /m, "the long paste never reached the server");
  assert.match(refused!.text, /act paste is refused while \/gui view runs.*4097 characters.*Nothing was sent/s);
  assert.deepEqual(payload(clicked!.text).arguments.operation, click.operation, "other act operations pass unchanged");
  assert.match(readFileSync(join(cfg, "gui.log"), "utf8"), /act paste of 45 characters typed instead \(a viewer runs on this desktop\)/);

  assert.match((await command("view stop W1")).text, /Stopped the viewer of W1/);
  await worker.session.prompt("paste without the viewer");
  const pasted = results(worker.session).at(-1)!;
  assert.deepEqual(payload(pasted.text).arguments.operation, paste(url).operation, "without a viewer the paste is upstream's");
  await shutdown(worker.session);
});

test("/gui view: missing krdp gives the install command", async () => {
  const missing = () => ({ ok: false, checks: [{ name: "krdpserver (KDE RDP server)", ok: false, detail: "not found", apt: "krdp" }], missing: ["krdpserver (KDE RDP server) (apt: krdp)"] });
  const { session } = await startSession([
    noMcpJson(),
    createGuiExtension({ snapChromium: noSnap, agentDir: await mkdtemp(join(tmpdir(), "pi-gui-cfg-")), resolve: resolveFake, prerequisites: ready, viewer: { prerequisites: missing } }),
  ], []);
  const notes: { text: string; level?: string }[] = [];
  const gui = session.extensionRunner.getCommand("gui")!;
  await gui.handler("view main", { hasUI: true, ui: { notify: (text: string, level?: string) => notes.push({ text, level }) } } as unknown as Parameters<typeof gui.handler>[1]);
  assert.equal(notes.at(-1)!.level, "error");
  assert.match(notes.at(-1)!.text, /sudo apt install krdp/);
});
