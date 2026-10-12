// Live test: the installed snap Chromium on real pi-gui worker desktops, with pi-gui's own profile, next to the user's own
// running Chromium. Run: `npm run test:snap-chromium` (needs the desktop services and the chromium snap).
//
// A worker (an orche-like Pi session loaded from pi-gui's `gui` capability, scripted through Pi's faux provider, so every
// call goes through the real tool hooks and MCP transport into a real private desktop) launches
// pi-gui-chromium-temp-profile.desktop, opens a public test page (https://example.com) and follows its link.
//
// S1 isolation while it runs: the worker browser's only --user-data-dir is the profile pi-gui created for the launch
//    (/run/user/<uid>/snap.chromium/pi-gui-launch-*/config/chromium), its singleton socket lies in that launch too; no
//    process of its scope is connected to the physical session's display, buses, sound or X11, or holds a file of the
//    user's Chromium profile; crash databases are the launch's; the user's Chromium keeps its PID, start time and lock.
// S2 normal close (Ctrl+Shift+W): browser, supervisor and the launch directory (profile included) are gone.
// S3 the desktop ends (worker session shutdown): the same, within the timeout, and no supervisor is left.
// S4 forced stop: supervisor and every process of the scope SIGKILLed → the launch directory is left; the next launch
//    removes it.
// The user's Chromium profile content is never read: only process tables, sockets, open-file names and its lock link.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, type FauxResponseFactory } from "@earendil-works/pi-ai";
import {
  createAgentSession, createMcpExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { mcpToolName } from "../../src/backend.ts";
import { SNAP_CHROMIUM_ID } from "../../src/browsers.ts";
import { createGuiExtension } from "../../src/index.ts";
import { CAPABILITY_CHANNEL, type CapabilityProvider } from "../../src/worker.ts";

const OUT = process.env.PI_GUI_LIVE_OUT ?? join(process.cwd(), ".pi-gui-live");
mkdirSync(OUT, { recursive: true });
const AGENT_DIR = join(OUT, "agent");
mkdirSync(AGENT_DIR, { recursive: true });
const PAGE = "https://example.com/";
const uid = process.getuid!();
const USER_RUNTIME = `/run/user/${uid}`;
const SNAP_RUNTIME = join(USER_RUNTIME, "snap.chromium");
const USER_PROFILE = join(homedir(), "snap/chromium/common/chromium");
const log = (...items: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...items);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const evidence: Record<string, unknown> = {};
let handlersBefore = new Set<number>();

// ---------------------------------------------------------------- scripted Pi sessions (as gui.integration.ts)
type Result = { isError: boolean; text: string; images: { data: string; mimeType: string }[] };
type Call = { tool: string; args: Record<string, unknown> };
type Flow = AsyncGenerator<Call, string, Result>;
interface Agent { session: AgentSession; run(flow: Flow): Promise<void> }
let serial = 0;
async function agent(factories: ExtensionFactory[], tools?: string[]): Promise<Agent> {
  const faux = fauxProvider({ provider: `pi-gui-snap-${++serial}` });
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
    cwd: process.cwd(), agentDir: AGENT_DIR, settingsManager: SettingsManager.inMemory({}),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: factories,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: process.cwd(), agentDir: AGENT_DIR, modelRuntime: runtime, model: faux.getModel(), resourceLoader: loader,
    sessionManager: SessionManager.inMemory(process.cwd()), settingsManager: SettingsManager.inMemory({}), ...(tools ? { tools } : {}),
  });
  await session.bindExtensions({});
  return { session, async run(next) { flow = next; started = false; await session.prompt("Go."); } };
}
async function end(session: AgentSession) {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}

// ---------------------------------------------------------------- process inspection (read-only)
const pids = () => readdirSync("/proc").filter(name => /^\d+$/.test(name)).map(Number);
const read = (pid: number, file: string) => { try { return readFileSync(`/proc/${pid}/${file}`, "utf8"); } catch { return ""; } };
/** Arguments; Chromium rewrites its title into one string with spaces. */
const args = (pid: number) => { const list = read(pid, "cmdline").split("\0").filter(Boolean); return list.length === 1 ? list[0]!.split(" ").filter(Boolean) : list; };
const environ = (pid: number) => read(pid, "environ").split("\0").filter(Boolean);
const stat = (pid: number) => { const text = read(pid, "stat"); if (!text) return undefined; const fields = text.slice(text.lastIndexOf(")") + 2).split(" "); return { ppid: Number(fields[1]), start: fields[19]!, state: fields[0]! }; };
const live = (pid: number, start?: string) => { const info = stat(pid); return !!info && info.state !== "Z" && (!start || info.start === start); };
const CHROME = /^\/snap\/chromium\/[^/]+\/usr\/lib\/chromium-browser\/chrome(_crashpad_handler)?$/;
function descendants(root: number): number[] {
  const children = new Map<number, number[]>();
  for (const pid of pids()) { const parent = stat(pid)?.ppid ?? 0; children.set(parent, [...children.get(parent) ?? [], pid]); }
  const out: number[] = [];
  const walk = (pid: number) => { for (const child of children.get(pid) ?? []) { out.push(child); walk(child); } };
  walk(root);
  return out;
}
/** The user's own Chromium: snap chrome main processes without --user-data-dir (default profile). */
const userBrowsers = () => pids().filter(pid => { const a = args(pid); return CHROME.test(a[0] ?? "") && !a[0]!.endsWith("_crashpad_handler") && !a.some(arg => arg.startsWith("--type=") || arg.startsWith("--user-data-dir="));
}).map(pid => ({ pid, start: stat(pid)!.start }));
/** Supervisors (bin/pi-gui-snap-chromium.mjs, stage supervise) started from this test's agent dir. */
const supervisors = () => pids().filter(pid => args(pid).some(arg => arg.endsWith("pi-gui-snap-chromium.mjs")) && environ(pid).includes("PI_GUI_SNAP_CHROMIUM_STAGE=supervise"));
const launchDirs = () => { try { return readdirSync(SNAP_RUNTIME).filter(name => name.startsWith("pi-gui-")).map(name => join(SNAP_RUNTIME, name)); } catch { return []; } };
const record = (dir: string) => { try { return JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as { pid: number; scope?: string; launcher?: { pid: number; start: string }; browser?: { pid: number; start: string; profile: string; singleton?: string } }; } catch { return undefined; } };
const scopeProcs = (scope: string) => { try { return readFileSync(join("/sys/fs/cgroup", scope, "cgroup.procs"), "utf8").split("\n").filter(Boolean).map(Number); } catch { return []; } };
function connections(owners: Set<number>): { path: string; pid: number }[] {
  const served = new Map<string, string>();
  const ownersOf = new Map<string, number[]>();
  for (const line of execFileSync("ss", ["-xpn"], { encoding: "utf8", maxBuffer: 256 << 20 }).split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 8 || !cols[0]!.startsWith("u_")) continue;
    const [, , , , local, inode, , peer] = cols;
    ownersOf.set(inode!, [...line.matchAll(/pid=(\d+)/g)].map(match => Number(match[1])));
    if (local !== "*") served.set(peer!, local!);
  }
  const hits: { path: string; pid: number }[] = [];
  for (const [inode, path] of served) for (const pid of ownersOf.get(inode) ?? []) if (owners.has(pid)) hits.push({ path, pid });
  return hits;
}
const profileLock = () => { try { return readlinkSync(join(USER_PROFILE, "SingletonLock")); } catch { return undefined; } };

// ---------------------------------------------------------------- the worker's flows
const tool = (name: string) => mcpToolName(name);
const ids = (text: string, prefix: string) => [...new Set(text.match(new RegExp(`\\b${prefix}-[0-9a-f]{16}\\b`, "g")) ?? [])];
const pngSize = (data: string) => { const png = Buffer.from(data, "base64"); return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }; };
const summary = (result: Result) => `${result.isError ? "ERROR " : ""}${result.text.split("\n").slice(0, 2).join(" | ").slice(0, 200)}${result.images.length ? " [+image]" : ""}`;
interface Rec { label: string; target?: { app_instance_id: string; window_instance_id: string }; texts: string[]; shots: string[]; errors: string[] }
const rec = (label: string): Rec => ({ label, texts: [], shots: [], errors: [] });
async function* call(r: Rec, name: string, input: Record<string, unknown>, what: string): AsyncGenerator<Call, Result, Result> {
  const answer = yield { tool: tool(name), args: input };
  log(r.label, what, "→", summary(answer));
  if (answer.isError) r.errors.push(`${what}: ${answer.text.slice(0, 400)}`);
  return answer;
}
function shot(r: Rec, result: Result, name: string) {
  const image = result.images[0];
  if (!image) return;
  const file = join(OUT, `${r.label}-${name}.png`);
  writeFileSync(file, Buffer.from(image.data, "base64"));
  r.shots.push(file);
}

/** Launch the entry and wait for its window. */
async function* launchFlow(r: Rec): Flow {
  let result = yield* call(r, "list_desktop", { scope: "applications", limit: 100 }, "list applications");
  let cursor = ids(result.text, "cur")[0];
  let listed = result.text.includes(SNAP_CHROMIUM_ID);
  for (let page = 0; page < 10 && !listed && cursor; page++) {
    result = yield* call(r, "list_desktop", { scope: "applications", limit: 100, cursor }, "list applications (more)");
    listed = result.text.includes(SNAP_CHROMIUM_ID);
    cursor = ids(result.text, "cur")[0];
  }
  if (!listed) r.errors.push(`${SNAP_CHROMIUM_ID} is not among the desktop's applications`);
  // The snap's own entry is refused before it reaches the desktop.
  const refused = yield* call(r, "launch_application", { desktop_id: "chromium_chromium.desktop" }, "launch the snap's own entry");
  r.errors.splice(r.errors.findIndex(error => error.startsWith("launch the snap's own entry")) >>> 0, 1);
  r.texts.push(`refused: ${refused.text}`);
  yield* call(r, "launch_application", { desktop_id: SNAP_CHROMIUM_ID }, `launch ${SNAP_CHROMIUM_ID}`);
  for (let attempt = 0; attempt < 60 && !r.target; attempt++) {
    if (attempt) await sleep(1000);
    result = yield* call(r, "list_desktop", { scope: "windows" }, "list windows");
    const [app] = ids(result.text, "app");
    const [win] = ids(result.text, "win");
    if (app && win) r.target = { app_instance_id: app, window_instance_id: win };
  }
  if (!r.target) r.errors.push("no browser window");
  return "launched";
}

/** Open the public test page through the address bar and follow its link; read the page back through accessibility. */
async function* pageFlow(r: Rec): Flow {
  const target = r.target!;
  let result = yield* call(r, "observe", { target, view: "screenshot", crop: "target_window" }, "observe new window");
  shot(r, result, "1-start");
  // Point focus clicks (which activates the window; KWin gives no activation to AT-SPI's GrabFocus here) into the new-tab
  // page's search box, horizontally centred, about 250 px below the top of the centred window; typing there goes to the
  // page's search box, and Enter (with a second click on the same box) opens the address.
  const size = pngSize(result.images[0]!.data);
  const box = { x: Math.floor(size.width / 2), y: Math.floor(size.height * 0.376) };
  yield* call(r, "act", { target, source_observation: { observation_id: ids(result.text, "obs")[0]!, frame_id: ids(result.text, "frame")[0]! }, operation: { type: "keyboard", focus: { type: "point", ...box }, events: [{ type: "type", text: PAGE }] } }, `type ${PAGE} into the new-tab search box`);
  result = yield* call(r, "observe", { target, view: "screenshot", crop: "target_window" }, "observe the typed address");
  yield* call(r, "act", { target, source_observation: { observation_id: ids(result.text, "obs")[0]!, frame_id: ids(result.text, "frame")[0]! }, operation: { type: "keyboard", focus: { type: "point", ...box }, events: [{ type: "press", key: "Return" }] } }, "Enter");
  let page = "";
  for (let attempt = 0; attempt < 20 && !/Example Domain/.test(page); attempt++) {
    await sleep(1000);
    result = yield* call(r, "observe", { target, view: "both", crop: "target_window", accessibility: { scope: "full", limits: { text_limit: 4000, max_nodes: 600 } } }, "observe the page");
    page = result.text;
  }
  shot(r, result, "2-example");
  r.texts.push(page);
  if (!/Example Domain/.test(page)) { r.errors.push("the page did not load"); return "no page"; }
  // Follow the page's only link from the keyboard: a click on the empty page below the text, Tab to the link, Enter.
  const blank = { x: Math.floor(size.width / 2), y: Math.floor(size.height * 0.85) };
  yield* call(r, "act", { target, source_observation: { observation_id: ids(result.text, "obs")[0]!, frame_id: ids(result.text, "frame")[0]! }, operation: { type: "keyboard", focus: { type: "point", ...blank }, events: [{ type: "press", key: "Tab" }, { type: "press", key: "Return" }] } }, "follow the link (Tab, Enter)");
  let next = "";
  for (let attempt = 0; attempt < 20 && !/IANA|iana\.org|Example Domains/i.test(next); attempt++) {
    await sleep(1000);
    result = yield* call(r, "observe", { target, view: "both", crop: "target_window", accessibility: { scope: "full", limits: { text_limit: 4000, max_nodes: 600 } } }, "observe after the link");
    next = result.text;
  }
  shot(r, result, "3-followed");
  r.texts.push(next);
  if (!/IANA|iana\.org|Example Domains/i.test(next)) r.errors.push("the link did not open its page");
  return "done";
}

async function* closeFlow(r: Rec): Flow {
  const target = r.target!;
  const result = yield* call(r, "observe", { target, view: "screenshot", crop: "target_window" }, "observe before closing");
  const size = pngSize(result.images[0]!.data);
  yield* call(r, "act", { target, source_observation: { observation_id: ids(result.text, "obs")[0]!, frame_id: ids(result.text, "frame")[0]! }, operation: { type: "keyboard", focus: { type: "point", x: Math.floor(size.width / 2), y: Math.floor(size.height * 0.6) }, events: [{ type: "press", key: "ctrl+shift+w" }] } }, "close the window (Ctrl+Shift+W)");
  return "closed";
}

// ---------------------------------------------------------------- run
interface Launch { dir: string; supervisor: number; scope: string; launcher: { pid: number; start: string }; browser: { pid: number; start: string; profile: string } }
async function waitLaunch(before: Set<string>): Promise<Launch> {
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; await sleep(500)) {
    for (const dir of launchDirs().filter(dir => !before.has(dir))) {
      const owner = record(dir);
      if (owner?.browser && owner.launcher && owner.scope) return { dir, supervisor: owner.pid, scope: owner.scope, launcher: owner.launcher, browser: owner.browser };
    }
  }
  throw new Error(`no launch record appeared; see ${join(AGENT_DIR, "gui-snap-chromium.log")}`);
}
async function until(what: string, check: () => boolean, ms = 30_000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(250)) if (check()) return;
  throw new Error(`timed out: ${what}`);
}

function checkIsolation(launch: Launch, users: { pid: number; start: string }[]) {
  const browser = launch.browser.pid;
  // Every process of the launch: its systemd scope (snap.chromium.chromium-<uuid>.scope, created by the supervisor).
  const tree = new Set(scopeProcs(launch.scope));
  assert.ok(tree.has(browser) && tree.has(launch.launcher.pid), `scope ${launch.scope}: ${[...tree].join(",")}`);
  assert.match(launch.scope, /\/snap\.chromium\.chromium-[0-9a-f-]{36}\.scope$/);
  const chromeArgs = args(browser);
  // The profile pi-gui created for this launch, on the host's view of the snap's runtime dir; Chromium's default profile
  // in this process is the same directory (the in-snap script set CHROME_CONFIG_HOME; asserted in test/snap-chromium.test.ts
  // inside the real confinement, since Chromium makes its own /proc environ unreadable).
  assert.equal(launch.browser.profile, join(launch.dir, "config", "chromium"));
  assert.ok(launch.dir.startsWith(`${SNAP_RUNTIME}/pi-gui-launch-`), launch.dir);
  assert.deepEqual(chromeArgs.filter(arg => arg.startsWith("--user-data-dir=")), [`--user-data-dir=${launch.browser.profile}`], chromeArgs.join(" "));
  assert.ok(existsSync(join(launch.browser.profile, "Default")), "the browser writes its own profile");
  // Its singleton socket (TMPDIR) and therefore its temporary files are in the launch too, not in the snap's /tmp.
  const singleton = readlinkSync(join(launch.browser.profile, "SingletonSocket"));
  assert.ok(singleton.startsWith(join(launch.dir, "tmp") + "/"), singleton);
  // No sound or capture device: the snap points PULSE_SERVER at the user's sound server, so audio is turned off instead.
  for (const flag of ["--disable-audio-output", "--disable-audio-input", "--use-fake-device-for-media-stream"]) assert.ok(chromeArgs.includes(flag), flag);
  // Sockets of the worker browser's processes: only the private desktop's (the server side keeps its bound path).
  const physical = [`${USER_RUNTIME}/wayland-`, `${USER_RUNTIME}/bus`, `${USER_RUNTIME}/at-spi/`, `${USER_RUNTIME}/pipewire-`, `${USER_RUNTIME}/pulse/`, "/tmp/.X11-unix/", "@/tmp/.X11-unix/"];
  const conns = connections(tree);
  const leaks = conns.filter(conn => physical.some(prefix => conn.path.startsWith(prefix)));
  assert.deepEqual(leaks, [], "a worker browser process is connected to the physical session");
  const privateConns = [...new Set(conns.map(conn => conn.path))].filter(path => path.startsWith(`${SNAP_RUNTIME}/pi-gui/computer-use-mcp-isolated-`));
  assert.ok(privateConns.some(path => /wayland-virtual-\d+$/.test(path)), `connected to the private compositor: ${JSON.stringify(conns.map(conn => conn.path))}`);
  // No open file of the user's Chromium profile; no crash handler with the user's crash database.
  const userFiles = [...tree].flatMap(pid => { try { return readdirSync(`/proc/${pid}/fd`).map(fd => { try { return readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { return ""; } }); } catch { return []; } })
    .filter(path => path.startsWith(USER_PROFILE));
  assert.deepEqual(userFiles, [], "a worker browser process holds a file of the user's Chromium profile");
  // Crash handlers started since the test began (the user's own are older): their database is this launch's directory.
  const crashpad = pids().filter(pid => args(pid)[0]?.endsWith("chrome_crashpad_handler") && !handlersBefore.has(pid)).map(pid => read(pid, "cmdline").split("\0").join(" "));
  const crashDatabases = [...new Set(crashpad.flatMap(line => [...line.matchAll(/--database=(.+?)(?= --|$)/g)].map(match => match[1]!)))];
  assert.ok(crashDatabases.every(path => path.startsWith(launch.dir)), `crash databases of worker browsers: ${JSON.stringify(crashDatabases)}`);
  // The user's Chromium: same processes, same profile lock, none of them in the worker's tree.
  assert.deepEqual(userBrowsers(), users);
  assert.ok(users.every(user => !tree.has(user.pid)));
  return { tree: tree.size, privateConns, crashDatabases, singleton, browserArgs: chromeArgs.filter(arg => /^--(user-data-dir|ozone-platform|password-store|disable-breakpad|disable-audio|use-fake-device)/.test(arg)) };
}

async function main() {
  writeFileSync(join(AGENT_DIR, "gui.config.json"), JSON.stringify({ mainSession: false }));
  const users = userBrowsers();
  const lock = profileLock();
  handlersBefore = new Set(pids().filter(pid => args(pid)[0]?.endsWith("chrome_crashpad_handler")));
  evidence.userChromium = { processes: users, profileLock: lock };
  log("user's Chromium:", JSON.stringify(users), "lock:", lock);
  let api: ExtensionAPI | undefined;
  const main = await agent([createMcpExtension({ loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }) }), pi => { api = pi; }, createGuiExtension({ agentDir: AGENT_DIR })]);
  const provider = (workerId: string): CapabilityProvider => {
    let answer: CapabilityProvider | { error: string } | undefined;
    api!.events.emit(CAPABILITY_CHANNEL, { capability: "gui", cwd: process.cwd(), workerId, role: "implement", readOnly: false, provide: (value: CapabilityProvider | { error: string }) => { answer = value; } });
    if (!answer || "error" in answer) throw new Error(`GUI capability unavailable: ${answer && "error" in answer ? answer.error : "no answer"}`);
    return answer;
  };
  const passed: string[] = [];
  const pass = (name: string, detail: string) => { passed.push(`PASS ${name}: ${detail}`); log(`PASS ${name}: ${detail}`); };
  try {
    const capability = provider("S");
    assert.match(capability.instructions, new RegExp(`launch only [^.]*${SNAP_CHROMIUM_ID.replace(/\./g, "\\.")}`), capability.instructions);
    let worker = await agent(capability.extensionFactories, capability.tools);

    // ---- S1
    const r1 = rec("S1");
    const before1 = new Set(launchDirs());
    await worker.run(launchFlow(r1));
    assert.deepEqual(r1.errors, [], "launch errors");
    assert.match(r1.texts[0]!, /chromium_chromium\.desktop is refused.*launch pi-gui-chromium-temp-profile\.desktop/s);
    const l1 = await waitLaunch(before1);
    await worker.run(pageFlow(r1));
    assert.deepEqual(r1.errors, [], "page errors");
    const iso = checkIsolation(l1, users);
    assert.equal(profileLock(), lock, "the user's profile lock still names the user's browser");
    evidence.S1 = { launch: l1, ...iso, screenshots: r1.shots };
    pass("S1", `worker browser ${l1.browser.pid} (${iso.browserArgs.join(" ")}) under supervisor ${l1.supervisor}, launcher ${l1.launcher.pid}; private sockets ${iso.privateConns.join(", ")}; page "Example Domain" opened and its link followed; no physical-session connection, no user-profile file, crash databases ${JSON.stringify(iso.crashDatabases)}; user's Chromium ${JSON.stringify(users)} unchanged; ${r1.shots.join(", ")}`);

    // ---- S2: normal close
    await worker.run(closeFlow(r1));
    await until("the worker browser exits after Ctrl+Shift+W", () => !live(l1.browser.pid, l1.browser.start) && !live(l1.supervisor));
    await until("the launch directory is removed", () => !existsSync(l1.dir), 10_000);
    assert.deepEqual(scopeProcs(l1.scope), [], "no process of the launch is left");
    assert.deepEqual(userBrowsers(), users);
    evidence.S2 = { removed: l1.dir };
    pass("S2", `closed: browser ${l1.browser.pid} and supervisor ${l1.supervisor} exited; ${l1.dir} (profile ${l1.browser.profile}, its temporary files and singleton socket) removed; scope empty`);

    // ---- S4: forced stop, then the next launch cleans up
    const r4 = rec("S4");
    r4.target = undefined;
    const before4 = new Set(launchDirs());
    await worker.run(launchFlow(r4));
    const l4 = await waitLaunch(before4);
    await until("the browser writes its profile", () => existsSync(join(l4.browser.profile, "Default")), 15_000);
    // Forced stop of everything this launch owns: the supervisor and every process of its scope.
    process.kill(l4.supervisor, "SIGKILL");
    for (const pid of scopeProcs(l4.scope)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    await until("the killed launch is gone", () => scopeProcs(l4.scope).length === 0 && !live(l4.supervisor), 10_000);
    assert.ok(existsSync(l4.browser.profile), "the profile stays after SIGKILL of everything");
    const r5 = rec("S5");
    const before5 = new Set(launchDirs());
    await worker.run(launchFlow(r5));
    const l5 = await waitLaunch(before5);
    await until("the stale launch directory (profile included) is removed by the next launch", () => !existsSync(l4.dir), 15_000);
    evidence.S4 = { killed: l4, next: l5 };
    pass("S4", `SIGKILL of supervisor ${l4.supervisor} and scope ${l4.scope} left ${l4.dir} (profile included); the next launch (browser ${l5.browser.pid}) removed it`);

    // ---- S3: the desktop ends with the worker session
    await end(worker.session);
    await until("the worker browser and supervisor exit when the desktop ends", () => !live(l5.browser.pid, l5.browser.start) && !live(l5.supervisor), 30_000);
    await until("the launch directory is removed", () => !existsSync(l5.dir), 10_000);
    assert.deepEqual(scopeProcs(l5.scope), [], "no process of the launch is left");
    assert.deepEqual(supervisors(), [], "no supervisor outlives its desktop");
    assert.deepEqual(userBrowsers(), users);
    assert.equal(profileLock(), lock);
    evidence.S3 = { removed: l5.dir };
    pass("S3", `desktop ended → browser ${l5.browser.pid}, supervisor ${l5.supervisor} exited; ${l5.dir} (profile included) removed; scope empty; user's Chromium and its profile lock unchanged`);
    worker = undefined as unknown as Agent;
  } finally {
    await end(main.session).catch(() => undefined);
    writeFileSync(join(OUT, "evidence.json"), `${JSON.stringify({ evidence, passed }, null, 2)}\n`);
  }
  console.log(`\n${passed.join("\n")}\nevidence: ${join(OUT, "evidence.json")}`);
}

main().then(() => process.exit(0), error => { console.error(error); writeFileSync(join(OUT, "evidence.json"), `${JSON.stringify({ evidence, error: String(error?.stack ?? error) }, null, 2)}\n`); process.exit(1); });
