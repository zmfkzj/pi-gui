// Live test of `/gui view` on a real private desktop (computer-use-mcp + KWin) with a real krdp. Run: `npm run test:view`.
//
// A worker session built like an orche worker (pi-gui's capability) launches the GTK test editor on its private desktop
// and types into it. `/gui view W1` then starts krdp inside that desktop; the test checks the listening socket
// (127.0.0.1 only, owned by krdp), krdp's environment (the worker's private session, no physical-session variables),
// stop/restart, and that ending the worker stops the viewer and leaves no process or runtime directory behind.
//
// Optional client step (krdp streams only H.264, so the client must be a FreeRDP built with it):
//   PI_GUI_VIEW_CLIENT=/path/to/xfreerdp  PI_GUI_VIEW_CLIENT_DISPLAY=:97 (an X server for the client, e.g. Xvfb)
//   [PI_GUI_VIEW_CLIENT_LD_LIBRARY_PATH=…]
// The client connects with the printed password and certificate fingerprint, a wrong password is refused, keystrokes sent
// to the client window (XTest) reach the editor on the worker's desktop (read back by the worker through accessibility),
// and the worker can still type while the viewer is connected.
// PI_GUI_VIEW_KRDP=/path/to/krdpserver uses a krdp outside PATH (written as viewerCommand into the test's gui.config.json).
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, type FauxResponseFactory } from "@earendil-works/pi-ai";
import {
  createAgentSession, createMcpExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { mcpToolName, PHYSICAL_SESSION_ENV } from "../../src/backend.ts";
import { createGuiExtension } from "../../src/index.ts";
import { fingerprintHex } from "../../src/viewer.ts";
import { CAPABILITY_CHANNEL, type CapabilityProvider } from "../../src/worker.ts";

const OUT = process.env.PI_GUI_LIVE_OUT ?? join(tmpdir(), "pi-gui-live");
mkdirSync(OUT, { recursive: true });
const APP = fileURLToPath(new URL("./app/pi-gui-test-editor.py", import.meta.url));
const log = (...items: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...items);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Result = { isError: boolean; text: string };
type Call = { tool: string; args: Record<string, unknown> };
type Flow = AsyncGenerator<Call, string, Result>;
let serial = 0;
async function agent(factories: ExtensionFactory[], agentDir: string, tools?: string[]) {
  const faux = fauxProvider({ provider: `pi-gui-view-${++serial}` });
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
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const markers = () => new Set(pids().map(pid => environ(pid).COMPUTER_USE_MCP_ISOLATION_MARKER).filter(Boolean) as string[]);
/** `ss -ltnpH` lines for one TCP port. */
const listeners = (port: number) => execFileSync("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8" }).split("\n").filter(line => line.trim());
const ids = (text: string, prefix: string) => [...new Set(text.match(new RegExp(`\\b${prefix}-[0-9a-f]{16}\\b`, "g")) ?? [])];
const dispatch = (action: string, args: Record<string, unknown>): Call => ({ tool: mcpToolName(action), args });

interface Editor { target?: { app_instance_id: string; window_instance_id: string }; readback?: string; errors: string[] }
async function* call(state: Editor, request: Call, what: string): AsyncGenerator<Call, Result, Result> {
  const answer = yield request;
  log(what, "→", `${answer.isError ? "ERROR " : ""}${answer.text.split("\n").slice(0, 2).join(" | ").slice(0, 200)}`);
  if (answer.isError) state.errors.push(`${what}: ${answer.text.slice(0, 400)}`);
  return answer;
}
async function* typeFlow(state: Editor, text: string): Flow {
  let result: Result;
  if (!state.target) {
    yield* call(state, dispatch("launch_application", { desktop_id: "pi.gui.TestEditor.desktop" }), "launch test editor");
    for (let attempt = 0; attempt < 20 && !state.target; attempt++) {
      if (attempt) await sleep(500);
      result = yield* call(state, dispatch("list_desktop", { scope: "windows" }), "list windows");
      const [app] = ids(result.text, "app");
      const [win] = ids(result.text, "win");
      if (app && win) state.target = { app_instance_id: app, window_instance_id: win };
    }
    if (!state.target) { state.errors.push("no window"); return "no window"; }
  }
  const target = state.target;
  result = yield* call(state, dispatch("observe", { target, view: "screenshot", crop: "target_window" }), "observe");
  const source = { observation_id: ids(result.text, "obs")[0]!, frame_id: ids(result.text, "frame")[0]! };
  if (text) {
    result = yield* call(state, dispatch("act", { target, source_observation: source, operation: { type: "keyboard", focus: { type: "point", x: 300, y: 300 }, events: [{ type: "type", text }] } }), `type ${text}`);
  }
  result = yield* call(state, dispatch("observe", { target, view: "accessibility", crop: "target_window", accessibility: { scope: "full", limits: { text_limit: 4000 } } }), "read back");
  state.readback = result.text;
  return "done";
}

/** Click into and type on an X display through XTest (python3 + ctypes; no extra packages). */
/** Lower-case letters only (no Shift, whose state RDP synchronises separately). */
function xtype(display: string, text: string) {
  assert.match(text, /^[a-z]+$/);
  const script = `
import ctypes, sys, time
x11 = ctypes.CDLL("libX11.so.6"); xt = ctypes.CDLL("libXtst.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p; x11.XStringToKeysym.restype = ctypes.c_ulong; x11.XKeysymToKeycode.restype = ctypes.c_ubyte
d = ctypes.c_void_p(x11.XOpenDisplay(sys.argv[1].encode())); assert d.value
xt.XTestFakeMotionEvent(d, 0, 800, 500, 0); xt.XTestFakeButtonEvent(d, 1, 1, 0); xt.XTestFakeButtonEvent(d, 1, 0, 0); x11.XFlush(d); time.sleep(0.5)
for ch in sys.argv[2]:
    code = x11.XKeysymToKeycode(d, x11.XStringToKeysym(ch.encode()))
    xt.XTestFakeKeyEvent(d, code, 1, 0); x11.XFlush(d); time.sleep(0.03)
    xt.XTestFakeKeyEvent(d, code, 0, 0); x11.XFlush(d); time.sleep(0.05)
`;
  const result = spawnSync("python3", ["-c", script, display, text], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`xtype failed: ${result.stderr}`);
}

async function main() {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-gui-view-agent-"));
  const data = join(agentDir, "xdg");
  mkdirSync(join(data, "applications"), { recursive: true });
  writeFileSync(join(data, "applications", "pi.gui.TestEditor.desktop"), `[Desktop Entry]\nType=Application\nName=pi-gui Test Editor\nExec=/usr/bin/python3 ${APP}\nTerminal=false\n`);
  process.env.XDG_DATA_DIRS = `${data}:${process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share"}`;
  writeFileSync(join(agentDir, "gui.config.json"), JSON.stringify({ mainSession: false, ...(process.env.PI_GUI_VIEW_KRDP ? { viewerCommand: process.env.PI_GUI_VIEW_KRDP } : {}) }));
  let api: ExtensionAPI | undefined;
  const main = await agent([createMcpExtension({ loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }) }), pi => { api = pi; }, createGuiExtension({ agentDir })], agentDir);
  const gui = main.session.extensionRunner.getCommand("gui")!;
  const notes: { text: string; level?: string }[] = [];
  const ctx = { hasUI: true, ui: { notify: (text: string, level?: string) => notes.push({ text, level }) } } as unknown as Parameters<typeof gui.handler>[1];
  const command = async (args: string) => { notes.length = 0; await gui.handler(args, ctx); log(`/gui ${args} →\n${notes.at(-1)?.text}`); return notes.at(-1)!; };
  const passed: string[] = [];
  const pass = (name: string, detail: string) => { passed.push(`PASS ${name}: ${detail}`); log(`PASS ${name}: ${detail}`); };
  const before = markers();
  const clients: ChildProcess[] = [];
  try {
    let answer: CapabilityProvider | { error: string } | undefined;
    api!.events.emit(CAPABILITY_CHANNEL, { capability: "gui", cwd: process.cwd(), workerId: "W1", provide: (value: CapabilityProvider | { error: string }) => { answer = value; } });
    if (!answer || "error" in answer) throw new Error(`GUI capability unavailable: ${answer && "error" in answer ? answer.error : "no answer"}`);
    const worker = await agent(answer.extensionFactories, agentDir, answer.tools);
    const editor: Editor = { errors: [] };
    await worker.run(typeFlow(editor, "AGENTTEXT"));
    assert.deepEqual(editor.errors, []);
    assert.match(editor.readback ?? "", /AGENTTEXT/);
    const desktops = [...markers()].filter(marker => !before.has(marker));
    assert.equal(desktops.length, 1, "one private desktop");
    const runtimeDir = desktops[0]!.replace(/\/isolation\.ready$/, "");
    pass("worker", `W1 typed AGENTTEXT on its private desktop (${runtimeDir})`);

    // ---- view: krdp in the worker's private session, loopback only
    const opened = await command("view W1");
    assert.equal(opened.level, "info", opened.text);
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(opened.text)![1]);
    const password = /Password:\s+(\S+)/.exec(opened.text)![1]!;
    const fingerprint = /SHA-256 ([0-9A-F:]+)/.exec(opened.text)![1]!;
    const lines = listeners(port);
    assert.equal(lines.length, 1, `one listener on port ${port}: ${lines.join(" / ")}`);
    assert.match(lines[0]!, new RegExp(`127\\.0\\.0\\.1:${port}\\s`), "bound to 127.0.0.1 only");
    const krdpPid = Number(/pid=(\d+)/.exec(lines[0]!)![1]);
    const krdpEnv = environ(krdpPid);
    assert.equal(krdpEnv.XDG_RUNTIME_DIR, runtimeDir, "krdp runs in the worker's private session");
    assert.match(krdpEnv.WAYLAND_DISPLAY ?? "", /^wayland-virtual-\d+$/);
    assert.equal(krdpEnv.DBUS_SESSION_BUS_ADDRESS, `unix:path=${runtimeDir}/bus`);
    for (const name of PHYSICAL_SESSION_ENV) if (!["WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "AT_SPI_BUS_ADDRESS", "PIPEWIRE_REMOTE", "PIPEWIRE_RUNTIME_DIR"].includes(name)) assert.equal(krdpEnv[name], undefined, `krdp has ${name}`);
    assert.equal(krdpEnv.COMPUTER_USE_MCP_ISOLATION_MARKER, desktops[0]);
    const logText = readFileSync(join(agentDir, "gui.log"), "utf8");
    assert.ok(!logText.includes(password), "password not in gui.log");
    pass("view", `/gui view W1 → krdp pid ${krdpPid} LISTEN ${lines[0]!.trim().split(/\s+/)[3]} in ${krdpEnv.WAYLAND_DISPLAY} (${runtimeDir}); password not logged`);
    const again = await command("view");
    assert.ok(again.text.includes(`127.0.0.1:${port}`) && /Already running/.test(again.text), "a second /gui view shows the same viewer");

    // ---- optional: a real RDP client
    const client = process.env.PI_GUI_VIEW_CLIENT;
    const clientDisplay = process.env.PI_GUI_VIEW_CLIENT_DISPLAY;
    if (client && clientDisplay) {
      const clientEnv: NodeJS.ProcessEnv = { ...process.env, DISPLAY: clientDisplay, ...(process.env.PI_GUI_VIEW_CLIENT_LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.PI_GUI_VIEW_CLIENT_LD_LIBRARY_PATH } : {}) };
      delete clientEnv.WAYLAND_DISPLAY;
      const base = [`/v:127.0.0.1:${port}`, "/u:pi", "/sec:tls", "/gfx:avc420", `/cert:fingerprint:sha256:${fingerprintHex(fingerprint)}`, "/size:1280x720"];
      const wrong = spawnSync(client, [...base, "/p:wrong-password"], { env: clientEnv, encoding: "utf8", timeout: 30_000 });
      writeFileSync(join(OUT, "view-client-wrong.log"), `${wrong.stdout}${wrong.stderr}`);
      assert.notEqual(wrong.status, 0, "a wrong password is refused");
      assert.doesNotMatch(`${wrong.stdout}${wrong.stderr}`, /certificate|fingerprint/i, "refused for the password, not the pinned certificate");
      const out = join(OUT, "view-client.log");
      const connected = spawn(client, [...base, `/p:${password}`], { env: clientEnv, stdio: ["ignore", "pipe", "pipe"] });
      clients.push(connected);
      let clientLog = "";
      connected.stdout!.on("data", chunk => { clientLog += chunk; });
      connected.stderr!.on("data", chunk => { clientLog += chunk; });
      await sleep(8_000);
      writeFileSync(out, clientLog);
      assert.equal(connected.exitCode, null, `the client stays connected (see ${out})`);
      xtype(clientDisplay, "humantext");
      await sleep(1_500);
      const shot = join(OUT, "view-client.png");
      spawnSync("gst-launch-1.0", ["-q", "ximagesrc", `display-name=${clientDisplay}`, "num-buffers=1", "!", "videoconvert", "!", "pngenc", "!", "filesink", `location=${shot}`]);
      await worker.run(typeFlow(editor, ""));
      assert.match(editor.readback ?? "", /humantext/, "keystrokes in the RDP client reached the worker's desktop");
      await worker.run(typeFlow(editor, "AFTERVIEW"));
      assert.deepEqual(editor.errors, [], "the worker still acts while the viewer is connected");
      assert.match(editor.readback ?? "", /AFTERVIEW/);
      connected.kill("SIGTERM");
      pass("client", `${client}: fingerprint-pinned TLS + password accepted, wrong password refused; typed humantext through RDP and W1 read it back; W1 then typed AFTERVIEW with the viewer attached; screenshot ${existsSync(shot) ? shot : "(none)"}`);
    } else {
      log("client step skipped (set PI_GUI_VIEW_CLIENT and PI_GUI_VIEW_CLIENT_DISPLAY)");
    }

    // ---- stop, reopen, and end the worker
    assert.match((await command("view stop W1")).text, /Stopped the viewer of W1/);
    for (const deadline = Date.now() + 5_000; alive(krdpPid) && Date.now() < deadline; await sleep(100));
    assert.equal(alive(krdpPid), false, "krdp stopped");
    assert.deepEqual(listeners(port), [], "port closed");
    const reopened = await command("view W1");
    const port2 = Number(/127\.0\.0\.1:(\d+)/.exec(reopened.text)![1]);
    const krdpPid2 = Number(/pid=(\d+)/.exec(listeners(port2)[0]!)![1]);
    assert.notEqual(/Password:\s+(\S+)/.exec(reopened.text)![1], password, "a new password per viewer");
    pass("stop", `/gui view stop W1 → krdp ${krdpPid} gone, port ${port} closed; reopened on ${port2} (krdp ${krdpPid2}) with a new password`);
    await end(worker.session);
    for (const deadline = Date.now() + 30_000; Date.now() < deadline && (alive(krdpPid2) || [...markers()].some(marker => !before.has(marker))); await sleep(250));
    assert.equal(alive(krdpPid2), false, "the worker's end stopped its viewer");
    assert.deepEqual([...markers()].filter(marker => !before.has(marker)), [], "no process of the private desktop is left");
    assert.equal(existsSync(runtimeDir), false, "the private runtime directory is gone");
    pass("cleanup", `ending W1 stopped krdp ${krdpPid2}, its desktop and ${runtimeDir}`);
  } finally {
    for (const client of clients) client.kill("SIGKILL");
    await end(main.session).catch(() => undefined);
  }
  console.log(`\n${passed.join("\n")}`);
}

main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
