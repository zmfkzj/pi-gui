// Live tests on real private desktops (computer-use-mcp + KWin). Run: `npm run test:gui` (needs the desktop services).
//
// Every agent is a real Pi session built like an orche worker: Pi's MCP extension and pi-gui's routing hook, loaded from the
// worker capability that pi-gui's main extension answers on `pi.events`. A scripted model (Pi's faux provider) issues the
// tool calls, so every call goes through Pi's real pipeline (tool_call hooks, MCP stdio transport) into the real server.
//
// A  one agent: launch an editor, screenshot, click, type, read the text back
// B  two agents acting at the same time: separate desktops; neither sees the other's window or text
// E  physical desktop: the servers have no physical-session variables, no process of a server or a private desktop is
//    connected to the user's display, session bus, accessibility bus or PipeWire, and the foreground route fails closed
// C  ending agent A's session removes A's server and desktop; B keeps working on its first desktop
// D  a new session for A gets a new private desktop that works
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, type FauxResponseFactory } from "@earendil-works/pi-ai";
import {
  createAgentSession, createMcpExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { mcpToolName, NO_RUNTIME_DIR, PHYSICAL_SESSION_ENV } from "../../src/backend.ts";
import { createGuiExtension } from "../../src/index.ts";
import { CAPABILITY_CHANNEL, type CapabilityProvider } from "../../src/worker.ts";

const OUT = process.env.PI_GUI_LIVE_OUT ?? join(tmpdir(), "pi-gui-live");
mkdirSync(OUT, { recursive: true });
// The GTK 3 test editor (test/integration/app) is registered through XDG_DATA_DIRS below; KDE editors work too. GTK 4 apps
// (e.g. GNOME Text Editor) are not visible: upstream's runner sets GTK_A11Y=1, which GTK 4 rejects, so they export no AT-SPI.
const EDITORS = ["pi.gui.TestEditor.desktop", "org.kde.kwrite.desktop", "org.kde.kate.desktop"];
const APP = fileURLToPath(new URL("./app/pi-gui-test-editor.py", import.meta.url));
const log = (...items: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...items);

type Result = { isError: boolean; text: string; images: { data: string; mimeType: string }[] };
type Call = { tool: string; args: Record<string, unknown> };
type Flow = AsyncGenerator<Call, string, Result>;

// ---------------------------------------------------------------- sessions driven by a script
interface Agent { session: AgentSession; run(flow: Flow, prompt?: string): Promise<void> }
let serial = 0;
async function agent(factories: ExtensionFactory[], agentDir: string, tools?: string[]): Promise<Agent> {
  const faux = fauxProvider({ provider: `pi-gui-live-${++serial}` });
  let flow: Flow | undefined;
  let started = false;
  const step: FauxResponseFactory = async context => {
    const last = [...context.messages].reverse().find(message => message.role === "toolResult") as
      { isError?: boolean; content: { type: string; text?: string; data?: string; mimeType?: string }[] } | undefined;
    const result: Result = {
      isError: last?.isError === true,
      text: (last?.content ?? []).filter(block => block.type === "text").map(block => block.text ?? "").join("\n"),
      images: (last?.content ?? []).filter(block => block.type === "image").map(block => ({ data: block.data!, mimeType: block.mimeType! })),
    };
    const next = await flow!.next(started ? result : undefined as unknown as Result);
    started = true;
    if (next.done) return fauxAssistantMessage(next.value ?? "done");
    return fauxAssistantMessage(fauxToolCall(next.value.tool, next.value.args as Parameters<typeof fauxToolCall>[1]), { stopReason: "toolUse" });
  };
  faux.setResponses(Array.from({ length: 400 }, () => step));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(), agentDir, settingsManager: SettingsManager.inMemory({}),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: factories,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: process.cwd(), agentDir, modelRuntime: runtime, model: faux.getModel(), resourceLoader: loader,
    sessionManager: SessionManager.inMemory(process.cwd()), settingsManager: SettingsManager.inMemory({}),
    ...(tools ? { tools } : {}),
  });
  await session.bindExtensions({});
  return {
    session,
    async run(next, prompt = "Go.") { flow = next; started = false; await session.prompt(prompt); },
  };
}

/** Pi's runtime host on quit (and orche's worker disposal): session_shutdown, then dispose. */
async function end(session: AgentSession) {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}

// ---------------------------------------------------------------- process inspection
const pids = (): string[] => readdirSync("/proc").filter(name => /^\d+$/.test(name));
const readEnviron = (pid: string): string[] => { try { return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0"); } catch { return []; } };
const cmdline = (pid: string): string[] => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch { return []; } };
const comm = (pid: string) => { try { return readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch { return "?"; } };
const parentOf = (pid: string) => { try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[1]!; } catch { return "0"; } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Private desktops on this machine: upstream marks every process of one with COMPUTER_USE_MCP_ISOLATION_MARKER. */
function privateDesktops(): Map<string, { pids: string[]; display?: string }> {
  const desktops = new Map<string, { pids: string[]; display?: string }>();
  for (const pid of pids()) {
    const env = readEnviron(pid);
    const marker = env.find(entry => entry.startsWith("COMPUTER_USE_MCP_ISOLATION_MARKER="))?.slice("COMPUTER_USE_MCP_ISOLATION_MARKER=".length);
    if (!marker) continue;
    const desktop = desktops.get(marker) ?? { pids: [] };
    desktop.pids.push(pid);
    desktop.display ??= env.find(entry => entry.startsWith("WAYLAND_DISPLAY="))?.slice("WAYLAND_DISPLAY=".length);
    desktops.set(marker, desktop);
  }
  return desktops;
}
function descendants(root: string): string[] {
  const children = new Map<string, string[]>();
  for (const pid of pids()) { const parent = parentOf(pid); children.set(parent, [...children.get(parent) ?? [], pid]); }
  const out: string[] = [];
  const walk = (pid: string) => { for (const child of children.get(pid) ?? []) { out.push(child); walk(child); } };
  walk(root);
  return out;
}
/** computer-use-mcp servers started by this process (Pi's stdio transport runs `env … computer-use-mcp mcp`; env execs). */
const servers = (): string[] => descendants(String(process.pid)).filter(pid => { const args = cmdline(pid); return args[0]!.endsWith("computer-use-mcp") && args[1] === "mcp"; });

/** Connections of `owners` to unix sockets served at `prefixes` (`ss -xp`: the server side carries the path). */
function connectionsTo(prefixes: string[], owners: Set<string>): string[] {
  const served = new Map<string, string>(); // client-side inode → server path
  const ownersOf = new Map<string, string[]>();
  for (const line of execFileSync("ss", ["-xpn"], { encoding: "utf8" }).split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 8 || !cols[0]!.startsWith("u_")) continue;
    const [, , , , local, inode, , peer] = cols;
    ownersOf.set(inode!, [...line.matchAll(/pid=(\d+)/g)].map(match => match[1]!));
    if (prefixes.some(prefix => local!.startsWith(prefix))) served.set(peer!, local!);
  }
  const hits: string[] = [];
  for (const [inode, path] of served) for (const pid of ownersOf.get(inode) ?? []) if (owners.has(pid)) hits.push(`${comm(pid)}(${pid}) → ${path}`);
  return hits;
}

// ---------------------------------------------------------------- scripted agent
const ids = (text: string, prefix: string) => [...new Set(text.match(new RegExp(`\\b${prefix}-[0-9a-f]{16}\\b`, "g")) ?? [])];
/** One operation as a Pi tool call: direct tools (workers' default surface). */
const dispatch = (action: string, args: Record<string, unknown>): Call => ({ tool: mcpToolName(action), args });
const pngSize = (data: string) => { const png = Buffer.from(data, "base64"); return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }; };
const summary = (result: Result) => `${result.isError ? "ERROR " : ""}${result.text.split("\n").slice(0, 2).join(" | ").slice(0, 240)}${result.images.length ? ` [+${result.images.length} image]` : ""}`;

interface Record_ {
  label: string;
  editor?: string;
  target?: { app_instance_id: string; window_instance_id: string };
  sessions: Set<string>;
  windows?: string;
  readback?: string;
  screenshots: string[];
  errors: string[];
}
const record = (label: string, from?: Record_): Record_ => ({ label, sessions: new Set(), screenshots: [], errors: [], ...(from ? { editor: from.editor, target: from.target } : {}) });

async function* call(rec: Record_, request: Call, what: string): AsyncGenerator<Call, Result, Result> {
  const answer = yield request;
  for (const id of answer.text.match(/session=session-[0-9a-f]+/g) ?? []) rec.sessions.add(id.slice("session=".length));
  log(rec.label, what, "→", summary(answer));
  if (answer.isError) rec.errors.push(`${what}: ${answer.text.slice(0, 600)}`);
  return answer;
}

function screenshot(rec: Record_, result: Result, name: string) {
  const image = result.images[0];
  if (!image) return undefined;
  const file = join(OUT, `${rec.label}-${name}.png`);
  writeFileSync(file, Buffer.from(image.data, "base64"));
  rec.screenshots.push(file);
  return pngSize(image.data);
}

/** Launch an editor on the agent's own desktop (unless it has one), click into it, type `text`, read it back. */
async function* editorFlow(rec: Record_, text: string): Flow {
  let result: Result;
  if (!rec.target) {
    let cursor: string | undefined;
    const installed: string[] = [];
    for (let page = 0; page < 10 && !rec.editor; page++) {
      result = yield* call(rec, dispatch("list_desktop", { scope: "applications", limit: 100, ...(cursor ? { cursor } : {}) }), "list applications");
      installed.push(...[...result.text.matchAll(/([A-Za-z0-9_.-]+\.desktop)\b/g)].map(match => match[1]!));
      rec.editor = EDITORS.find(id => installed.includes(id));
      cursor = ids(result.text, "cur")[0];
      if (!cursor) break;
    }
    if (!rec.editor) { rec.errors.push(`no editor among ${installed.length} applications`); return "no editor"; }
    yield* call(rec, dispatch("launch_application", { desktop_id: rec.editor }), `launch ${rec.editor}`);
    // Windows are found through AT-SPI (KWin does not give this client compositor app IDs, so window_opened cannot match).
    for (let attempt = 0; attempt < 20 && !rec.target; attempt++) {
      if (attempt) await sleep(500);
      result = yield* call(rec, dispatch("list_desktop", { scope: "windows" }), "list windows (waiting for the editor)");
      const [app] = ids(result.text, "app");
      const [win] = ids(result.text, "win");
      if (app && win) rec.target = { app_instance_id: app, window_instance_id: win };
    }
    if (!rec.target) { rec.errors.push("no window"); return "no window"; }
  }
  const target = rec.target;
  result = yield* call(rec, dispatch("observe", { target, view: "screenshot", crop: "target_window" }), "observe screenshot");
  const size = screenshot(rec, result, "before");
  const observation = ids(result.text, "obs")[0];
  const frame = ids(result.text, "frame")[0];
  if (!size || !observation || !frame) { rec.errors.push("no ready screenshot"); return "no screenshot"; }
  const point = { x: Math.floor(size.width / 2), y: Math.floor(size.height * 0.6) };
  result = yield* call(rec, dispatch("act", { target, source_observation: { observation_id: observation, frame_id: frame }, operation: { type: "pointer", action: { type: "click", ...point } } }), "act click");
  result = yield* call(rec, dispatch("observe", { target, view: "screenshot", crop: "target_window" }), "observe after click");
  const clicked = { observation_id: ids(result.text, "obs")[0]!, frame_id: ids(result.text, "frame")[0]! };
  result = yield* call(rec, dispatch("act", { target, source_observation: clicked, operation: { type: "keyboard", focus: { type: "point", ...point }, events: [{ type: "type", text }] } }), `act type ${text}`);
  result = yield* call(rec, dispatch("observe", { target, view: "both", crop: "target_window", accessibility: { scope: "full", limits: { text_limit: 2000 } } }), "observe readback");
  rec.readback = result.text;
  screenshot(rec, result, "after");
  result = yield* call(rec, dispatch("list_desktop", { scope: "windows" }), "list windows");
  rec.windows = result.text;
  return "done";
}

async function* readbackFlow(rec: Record_): Flow {
  const result = yield* call(rec, dispatch("observe", { target: rec.target, view: "both", crop: "target_window", accessibility: { scope: "full", limits: { text_limit: 2000 } } }), "observe again");
  rec.readback = result.text;
  screenshot(rec, result, "again");
  return "done";
}

// ---------------------------------------------------------------- the tests
async function main() {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-gui-live-agent-"));
  // The test editor as an installed application of the private desktops (they inherit XDG_DATA_DIRS).
  const data = join(agentDir, "xdg");
  mkdirSync(join(data, "applications"), { recursive: true });
  writeFileSync(join(data, "applications", "pi.gui.TestEditor.desktop"), `[Desktop Entry]\nType=Application\nName=pi-gui Test Editor\nExec=/usr/bin/python3 ${APP}\nTerminal=false\n`);
  process.env.XDG_DATA_DIRS = `${data}:${process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share"}`;
  writeFileSync(join(agentDir, "gui.config.json"), JSON.stringify({ mainSession: false }));
  let api: ExtensionAPI | undefined;
  const main = await agent([
    createMcpExtension({ loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }) }),
    pi => { api = pi; },
    createGuiExtension({ agentDir }),
  ], agentDir);
  const provider = (workerId: string): CapabilityProvider => {
    let answer: CapabilityProvider | { error: string } | undefined;
    api!.events.emit(CAPABILITY_CHANNEL, { capability: "gui", cwd: process.cwd(), workerId, provide: (value: CapabilityProvider | { error: string }) => { answer = value; } });
    if (!answer || "error" in answer) throw new Error(`GUI capability unavailable: ${answer && "error" in answer ? answer.error : "no answer"}`);
    return answer;
  };
  const worker = async (label: string) => { const capability = provider(label); return agent(capability.extensionFactories, agentDir, capability.tools); };
  const passed: string[] = [];
  const pass = (name: string, detail: string) => { passed.push(`PASS ${name}: ${detail}`); log(`PASS ${name}: ${detail}`); };
  const uid = process.getuid!();
  const before = privateDesktops();
  try {
    // ---- A
    const a = await worker("A");
    const recA = record("A");
    await a.run(editorFlow(recA, "AGENT_A"));
    assert.deepEqual(recA.errors, [], "A had tool errors");
    assert.match(recA.readback ?? "", /AGENT_A/, "A reads its text back");
    assert.equal(recA.sessions.size, 1);
    const [sessionA] = [...recA.sessions];
    pass("A", `${recA.editor}: launched, screenshot, click, type AGENT_A, read back (private ${sessionA}); ${recA.screenshots.join(", ")}`);

    // ---- B: B starts and types while A types again on its own desktop, at the same time
    const b = await worker("B");
    const recB = record("B");
    const recA2 = record("A-concurrent", recA);
    await Promise.all([b.run(editorFlow(recB, "AGENT_B")), a.run(editorFlow(recA2, " AGENT_A_AGAIN"))]);
    assert.deepEqual(recB.errors, [], "B had tool errors");
    assert.deepEqual(recA2.errors, [], "A (concurrent) had tool errors");
    const [sessionB] = [...recB.sessions];
    assert.notEqual(sessionA, sessionB);
    assert.deepEqual([...recA2.sessions], [sessionA], "A stayed on its desktop");
    assert.match(recB.readback ?? "", /AGENT_B/);
    assert.doesNotMatch(recB.readback ?? "", /AGENT_A/, "B does not see A's text");
    assert.match(recA2.readback ?? "", /AGENT_A_AGAIN/);
    assert.doesNotMatch(recA2.readback ?? "", /AGENT_B/, "A does not see B's text");
    const windowsA = ids(recA2.windows ?? "", "win");
    const windowsB = ids(recB.windows ?? "", "win");
    assert.ok(!windowsB.includes(recA.target!.window_instance_id) && !windowsA.includes(recB.target!.window_instance_id), "window IDs do not cross desktops");
    const ours = [...privateDesktops().entries()].filter(([marker]) => !before.has(marker));
    assert.equal(ours.length, 2, "two private desktops");
    assert.notEqual(ours[0]![1].display, ours[1]![1].display);
    pass("B", `A ${sessionA} and B ${sessionB} acted concurrently on displays ${ours.map(([, desktop]) => desktop.display).join(" / ")}; windows A=${windowsA.length} B=${windowsB.length}; neither text crossed; ${[...recA2.screenshots, ...recB.screenshots].join(", ")}`);

    // ---- E: physical desktop isolation
    const serverPids = servers();
    assert.equal(serverPids.length, 2, `two servers (${serverPids.join(", ")})`);
    for (const pid of serverPids) for (const name of PHYSICAL_SESSION_ENV) assert.ok(!readEnviron(pid).some(entry => entry.startsWith(`${name}=`)), `server ${pid} has ${name}`);
    const owners = new Set([...serverPids.flatMap(pid => [pid, ...descendants(pid)]), ...ours.flatMap(([, desktop]) => desktop.pids)]);
    const physical = [`/run/user/${uid}/${process.env.WAYLAND_DISPLAY || "wayland-0"}`, `/run/user/${uid}/bus`, `/run/user/${uid}/at-spi/`, `/run/user/${uid}/pipewire-0`, "/tmp/.X11-unix/"];
    const leaks = connectionsTo(physical, owners);
    assert.deepEqual(leaks, [], "a private-desktop process is connected to the physical session");
    const binary = readlinkSync(`/proc/${serverPids[0]}/exe`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !(PHYSICAL_SESSION_ENV as readonly string[]).includes(name)));
    // Upstream's `call` exits 1 when a call fails; the result is still the last stdout line.
    const raw = spawnSync(binary, ["call", "-"], { input: JSON.stringify({ name: "list_desktop", arguments: { scope: "windows", desktop: "foreground" } }), env: { ...env, XDG_RUNTIME_DIR: NO_RUNTIME_DIR }, encoding: "utf8" });
    const foreground = JSON.parse(raw.stdout.trim().split("\n").at(-1)!) as { isError?: boolean; content: { text: string }[] };
    assert.equal(foreground.isError, true, "the foreground route must fail in the server environment");
    pass("E", `${owners.size} processes (2 servers + 2 desktops): no physical-session variables in the servers; no connection to ${physical.join(", ")}; explicit foreground fails closed: "${foreground.content[0]!.text.split("\n").filter(line => !line.startsWith("Desktop:")).join(" ").slice(0, 160)}"`);

    // ---- C: end A; B keeps working
    const serversBefore = new Set(servers());
    await end(a.session);
    let gone: string[] = [];
    for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(250)) {
      gone = ours.filter(([marker]) => !privateDesktops().has(marker)).map(([marker]) => marker);
      if (gone.length && servers().length === serversBefore.size - 1) break;
    }
    assert.equal(gone.length, 1, "exactly one private desktop (A's) is gone");
    assert.equal(servers().length, 1, "A's server stopped, B's still runs");
    const recB2 = record("B-after-A-ended", recB);
    await b.run(readbackFlow(recB2));
    assert.deepEqual(recB2.errors, []);
    assert.match(recB2.readback ?? "", /AGENT_B/);
    assert.deepEqual([...recB2.sessions], [sessionB], "B is still on its first desktop");
    pass("C", `A's session ended → A's server and desktop processes gone; B still reads AGENT_B on ${sessionB}`);

    // ---- D: restart A
    const a3 = await worker("A-restarted");
    const recA3 = record("A-restarted");
    await a3.run(editorFlow(recA3, "AGENT_A_RESTARTED"));
    assert.deepEqual(recA3.errors, []);
    assert.match(recA3.readback ?? "", /AGENT_A_RESTARTED/);
    assert.doesNotMatch(recA3.readback ?? "", /AGENT_A\b|AGENT_B/);
    const [sessionA3] = [...recA3.sessions];
    assert.ok(sessionA3 && sessionA3 !== sessionA);
    pass("D", `new session for A → new private desktop ${sessionA3} (was ${sessionA}); ${recA3.editor} launched and typed`);
    await end(a3.session);
    await end(b.session);
    for (const deadline = Date.now() + 30_000; Date.now() < deadline && [...privateDesktops().keys()].some(marker => !before.has(marker)); await sleep(250));
    assert.deepEqual([...privateDesktops().keys()].filter(marker => !before.has(marker)), [], "no private desktop outlives its session");
    assert.deepEqual(servers(), [], "no server outlives its session");
    pass("cleanup", "every server and private desktop stopped with its session");
  } finally {
    await end(main.session).catch(() => undefined);
  }
  console.log(`\n${passed.join("\n")}`);
}

main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
