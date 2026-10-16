// Live regression test: `act` paste on a private desktop while `/gui view` runs in it. Run: `npm run test:paste-view`
// (needs the desktop services, krdp, gcc, wayland-scanner and wayland-protocols).
//
// Upstream pastes through the KDE portal's Clipboard. krdp reads every new clipboard selection at once for a connected
// RDP client (ext-data-control), and xdg-desktop-portal-kde 6.6 can deadlock when its portal selection is read that way:
// its main thread stops, every later GUI call fails with "AT-SPI application discovery timed out", and the viewer no longer
// takes input. A small ext-data-control reader (app/data-control-reader.c) stands in for the RDP client, since krdp
// streams only H.264 and a matching client is rarely installed. The test checks that pi-gui types the paste while the
// viewer runs, the text arrives, and the portal keeps answering. PI_GUI_PASTE_VIEW_UNGUARDED=1 then stops the viewer and
// pastes once more with the reader attached, to show the upstream deadlock (a race; it may not hang every run).
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, type FauxResponseFactory } from "@earendil-works/pi-ai";
import {
  createAgentSession, createMcpExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { mcpToolName } from "../../src/backend.ts";
import { createGuiExtension } from "../../src/index.ts";
import { CAPABILITY_CHANNEL, type CapabilityProvider } from "../../src/worker.ts";

const APP = fileURLToPath(new URL("./app/pi-gui-test-editor.py", import.meta.url));
const READER = fileURLToPath(new URL("./app/data-control-reader.c", import.meta.url));
const log = (...items: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...items);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Result = { isError: boolean; text: string };
type Call = { tool: string; args: Record<string, unknown> };
type Flow = AsyncGenerator<Call, string, Result>;
let serial = 0;
async function agent(factories: ExtensionFactory[], agentDir: string, tools?: string[]) {
  const faux = fauxProvider({ provider: `pi-gui-repro-${++serial}` });
  let flow: Flow | undefined;
  let started = false;
  const step: FauxResponseFactory = async context => {
    const last = [...context.messages].reverse().find(message => message.role === "toolResult") as { isError?: boolean; content: { type: string; text?: string }[] } | undefined;
    const result: Result = { isError: last?.isError === true, text: (last?.content ?? []).filter(block => block.type === "text").map(block => block.text ?? "").join("\n") };
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
    sessionManager: SessionManager.inMemory(process.cwd()), settingsManager: SettingsManager.inMemory({}), ...(tools ? { tools } : {}),
  });
  await session.bindExtensions({});
  return { session, async run(next: Flow) { flow = next; started = false; await session.prompt("Go."); } };
}
async function end(session: AgentSession) {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
const pids = () => readdirSync("/proc").filter(name => /^\d+$/.test(name));
const environ = (pid: string | number): Record<string, string> => {
  try { return Object.fromEntries(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map(entry => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)])); } catch { return {}; }
};
const markers = () => new Set(pids().map(pid => environ(pid).COMPUTER_USE_MCP_ISOLATION_MARKER).filter(Boolean) as string[]);
const ids = (text: string, prefix: string) => [...new Set(text.match(new RegExp(`\\b${prefix}-[0-9a-f]{16}\\b`, "g")) ?? [])];
const dispatch = (action: string, args: Record<string, unknown>): Call => ({ tool: mcpToolName(action), args });

interface State { target?: { app_instance_id: string; window_instance_id: string }; readback?: string; log: string[] }
async function* call(state: State, request: Call, what: string): AsyncGenerator<Call, Result, Result> {
  const answer = yield request;
  const line = `${what} → ${answer.isError ? "ERROR " : ""}${answer.text.split("\n").slice(0, 3).join(" | ").slice(0, 300)}`;
  log(line);
  state.log.push(line);
  return answer;
}
async function* pasteFlow(state: State, text: string): Flow {
  let result: Result;
  if (!state.target) {
    yield* call(state, dispatch("launch_application", { desktop_id: "pi.gui.TestEditor.desktop" }), "launch");
    for (let attempt = 0; attempt < 20 && !state.target; attempt++) {
      if (attempt) await sleep(500);
      result = yield* call(state, dispatch("list_desktop", { scope: "windows" }), "list");
      const [app] = ids(result.text, "app");
      const [win] = ids(result.text, "win");
      if (app && win) state.target = { app_instance_id: app, window_instance_id: win };
    }
    if (!state.target) return "no window";
  }
  const target = state.target;
  result = yield* call(state, dispatch("observe", { target, view: "screenshot", crop: "target_window" }), "observe");
  const source = { observation_id: ids(result.text, "obs")[0]!, frame_id: ids(result.text, "frame")[0]! };
  if (text) result = yield* call(state, dispatch("act", { target, source_observation: source, operation: { type: "paste", focus: { type: "point", x: 300, y: 300 }, text } }), `paste ${text}`);
  result = yield* call(state, dispatch("observe", { target, view: "accessibility", crop: "target_window", accessibility: { scope: "full", limits: { text_limit: 4000 } } }), "read back");
  state.readback = result.text;
  return "done";
}

function portalAlive(runtimeDir: string): string {
  const ready = readFileSync(join(runtimeDir, "isolation.ready"), "utf8");
  const pid = /portal_backend_pid=(\d+)/.exec(ready)?.[1];
  const names = execFileSync("busctl", [`--address=unix:path=${runtimeDir}/bus`, "list", "--no-pager"], { encoding: "utf8" });
  const unique = names.split("\n").find(line => /org\.freedesktop\.impl\.portal\.desktop\.kde/.test(line))?.trim().split(/\s+/)[4];
  const start = Date.now();
  const probe = spawnSync("busctl", [`--address=unix:path=${runtimeDir}/bus`, "--timeout=5", "call", unique ?? "org.freedesktop.impl.portal.desktop.kde", "/org/freedesktop/portal/desktop", "org.freedesktop.DBus.Introspectable", "Introspect"], { encoding: "utf8" });
  return `portal-kde pid=${pid} ${unique} introspect ${probe.status === 0 ? "ok" : `FAILED (${probe.stderr.trim()})`} in ${Date.now() - start} ms`;
}

/** Build the ext-data-control reader (test/integration/app/data-control-reader.c) into `dir`. */
function buildReader(dir: string): string {
  const xml = "/usr/share/wayland-protocols/staging/ext-data-control/ext-data-control-v1.xml";
  const out = join(dir, "data-control-reader");
  execFileSync("wayland-scanner", ["client-header", xml, join(dir, "ext-data-control-v1-client.h")]);
  execFileSync("wayland-scanner", ["private-code", xml, join(dir, "ext-data-control-v1.c")]);
  const flags = execFileSync("pkg-config", ["--cflags", "--libs", "wayland-client"], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);
  execFileSync("gcc", ["-O1", "-I", dir, "-o", out, READER, join(dir, "ext-data-control-v1.c"), ...flags]);
  return out;
}

async function main() {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-gui-paste-view-agent-"));
  const reader = buildReader(agentDir);
  const data = join(agentDir, "xdg");
  mkdirSync(join(data, "applications"), { recursive: true });
  writeFileSync(join(data, "applications", "pi.gui.TestEditor.desktop"), `[Desktop Entry]\nType=Application\nName=pi-gui Test Editor\nExec=/usr/bin/python3 ${APP}\nTerminal=false\n`);
  process.env.XDG_DATA_DIRS = `${data}:${process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share"}`;
  // The test editor's launcher runs python3, which worker desktops refuse unless the user opts out of the launch checks.
  writeFileSync(join(agentDir, "gui.config.json"), JSON.stringify({ mainSession: false, allowWorkerUserBrowserProfiles: true }));
  let api: ExtensionAPI | undefined;
  const main = await agent([createMcpExtension({ loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }) }), pi => { api = pi; }, createGuiExtension({ agentDir, viewer: { connect: async () => ({ skipped: "live test: no client on the user's screen" }) } })], agentDir);
  const gui = main.session.extensionRunner.getCommand("gui")!;
  const notes: { text: string; level?: string }[] = [];
  const ctx = { hasUI: true, ui: { notify: (text: string, level?: string) => notes.push({ text, level }) } } as unknown as Parameters<typeof gui.handler>[1];
  const command = async (args: string) => { notes.length = 0; await gui.handler(args, ctx); log(`/gui ${args} → ${notes.at(-1)?.text.split("\n")[0]}`); return notes.at(-1)!; };
  const before = markers();
  const extra: ChildProcess[] = [];
  let worker: Awaited<ReturnType<typeof agent>> | undefined;
  const passed: string[] = [];
  const pass = (name: string, detail: string) => { passed.push(`PASS ${name}: ${detail}`); log(`PASS ${name}: ${detail}`); };
  try {
    let answer: CapabilityProvider | { error: string } | undefined;
    api!.events.emit(CAPABILITY_CHANNEL, { capability: "gui", cwd: process.cwd(), workerId: "W1", role: "implement", readOnly: false, provide: (value: CapabilityProvider | { error: string }) => { answer = value; } });
    if (!answer || "error" in answer) throw new Error(`GUI capability unavailable: ${answer && "error" in answer ? answer.error : "no answer"}`);
    worker = await agent(answer.extensionFactories, agentDir, answer.tools);
    const state: State = { log: [] };
    await worker.run(pasteFlow(state, ""));
    assert.ok(state.target, "the test editor is up");
    const runtimeDir = [...markers()].filter(marker => !before.has(marker))[0]!.replace(/\/isolation\.ready$/, "");
    assert.match(portalAlive(runtimeDir), /introspect ok/);

    // The viewer, plus a client that reads every new selection at once (as krdp does while an RDP client is connected).
    assert.equal((await command("view W1")).level, "info");
    const env = environ(/portal_pid=(\d+)/.exec(readFileSync(join(runtimeDir, "isolation.ready"), "utf8"))![1]!);
    assert.equal(env.XDG_RUNTIME_DIR, runtimeDir, "the reader joins the private session only");
    const reads: string[] = [];
    const child = spawn(reader, [], { env, stdio: ["ignore", "pipe", "inherit"] });
    child.stdout!.on("data", chunk => { for (const line of String(chunk).split("\n").filter(Boolean)) { reads.push(line); log("reader:", line); } });
    extra.push(child);
    for (const deadline = Date.now() + 5_000; !reads.includes("ready") && Date.now() < deadline; await sleep(100));
    assert.ok(reads.includes("ready"), "the data-control reader started");

    const rounds = Number(process.env.PI_GUI_PASTE_VIEW_ROUNDS ?? 3);
    for (let round = 1; round <= rounds; round++) {
      state.log.length = 0;
      await worker.run(pasteFlow(state, `PASTED${round}\nTWICE `));
      assert.deepEqual(state.log.filter(line => line.includes("ERROR")), [], `paste ${round} and read-back succeed with the viewer running`);
      assert.match(state.readback ?? "", new RegExp(`PASTED${round}\\s*TWICE`), "the text, newline included, reached the editor");
      assert.match(portalAlive(runtimeDir), /introspect ok/, "the portal still answers");
    }
    assert.ok(!reads.some(line => /PASTED/.test(line)), "no clipboard selection was set (typed, not pasted)");
    assert.match(readFileSync(join(agentDir, "gui.log"), "utf8"), /act paste of 14 characters typed instead/);
    await sleep(2_000);
    state.log.length = 0;
    await worker.run(pasteFlow(state, ""));
    assert.deepEqual(state.log.filter(line => line.includes("ERROR")), [], "the desktop keeps answering");
    pass("guarded", `with /gui view running and a selection reader attached, ${rounds} act pastes were typed (text with a newline read back each time), the KDE portal kept answering, later observes worked`);

    const attempts = Number(process.env.PI_GUI_PASTE_VIEW_UNGUARDED ?? 0);
    if (attempts > 0) {
      // Shows the upstream deadlock this guards against: without a viewer the paste goes through the portal clipboard,
      // and the reader stands in for the RDP client. It is a race: up to N pastes, stopping at the first hang.
      await command("view stop W1");
      let portal = "";
      let attempt = 0;
      while (attempt < attempts && !/FAILED/.test(portal)) {
        attempt++;
        state.log.length = 0;
        await worker.run(pasteFlow(state, `UNGUARDED${attempt} `));
        await sleep(1_500);
        portal = portalAlive(runtimeDir);
        log(`unguarded ${attempt}:`, portal, "|", state.log.filter(line => line.includes("ERROR")).join(" / ") || "no errors");
      }
      pass("unguarded", /FAILED/.test(portal) ? `upstream deadlock reproduced on paste ${attempt} (portal stopped answering; GUI calls fail with AT-SPI discovery timeouts)` : `no hang in ${attempt} pastes (race)`);
    }
  } finally {
    for (const item of extra) item.kill("SIGKILL");
    if (worker) await end(worker.session).catch(() => undefined);
    await end(main.session).catch(() => undefined);
  }
  for (const deadline = Date.now() + 30_000; Date.now() < deadline && [...markers()].some(marker => !before.has(marker)); await sleep(250));
  assert.deepEqual([...markers()].filter(marker => !before.has(marker)), [], "no process of the private desktop is left");
  rmSync(agentDir, { recursive: true, force: true });
  console.log(`\n${passed.join("\n")}`);
}

main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
