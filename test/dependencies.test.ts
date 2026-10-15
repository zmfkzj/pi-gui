// The dependency contract (src/dependencies.ts) as pi-gui answers it (src/health.ts): `/gui doctor`, `/gui install-deps`
// and the umbrella's batch run. Every system access is a fake: no desktop starts, nothing installs, nothing downloads.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession, createMcpExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { UPSTREAM_PACKAGE, type Backend, type BackendResolution } from "../src/backend.ts";
import { DEPENDENCY_CHANNEL, dependencyOutcome, type DependencyItem, type DependencyProvider, type DependencyReport } from "../src/dependencies.ts";
import { BUNDLED_ITEM, checkGui, installGui, LIVE_ITEM, SERVER_ITEM, singleFlight, versionAtLeast, type GuiHealthDeps } from "../src/health.ts";
import { createGuiExtension } from "../src/index.ts";
import { checkPrerequisites, type PrerequisiteReport, type RunResult } from "../src/prerequisites.ts";
import type { ViewerPrerequisites } from "../src/viewer.ts";

const BUNDLED = "/fake/node_modules/@mirsella/opencode-computer-use-mcp/vendor/bin/computer-use-mcp";
const bundledBackend: Backend = { source: "bundled", command: BUNDLED, prefix: [], mcpArgs: ["--compact-tools"], binary: BUNDLED, label: `bundled npm 0.6.0 (${BUNDLED})` };
const npxBackend: Backend = { source: "npx", command: "npx", prefix: ["-y", `${UPSTREAM_PACKAGE}@0.6.0`], mcpArgs: [], label: "npx" };
const pathBackend: Backend = { source: "path", command: "/usr/local/bin/computer-use-mcp", prefix: [], mcpArgs: [], binary: "/usr/local/bin/computer-use-mcp", label: "PATH (/usr/local/bin/computer-use-mcp)" };
const ok = (backend: Backend) => (): BackendResolution => ({ ok: true, backend });
const ready = (): PrerequisiteReport => checkPrerequisites(undefined, { platform: "linux", isExecutable: () => true, exists: () => true });
const viewerReady = (): ViewerPrerequisites => ({ ok: true, checks: [{ name: "krdpserver (KDE RDP server)", ok: true, detail: "/usr/bin/krdpserver", apt: "krdp" }, { name: "openssl (viewer TLS certificate)", ok: true, detail: "/usr/bin/openssl", apt: "openssl" }], missing: [] });
const answer = (stdout: string, code = 0, stderr = ""): RunResult => ({ code, stdout, stderr, ms: 1, timedOut: false });

/** A package dir with pi-gui's manifest; `installed` adds the optional dependency to its node_modules. */
async function packageDir(installed: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-gui-pkg-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "pi-gui", optionalDependencies: { [UPSTREAM_PACKAGE]: "0.6.0" } }));
  if (installed) await installFake(dir);
  return dir;
}
async function installFake(dir: string): Promise<void> {
  await mkdir(join(dir, "node_modules", UPSTREAM_PACKAGE), { recursive: true });
  await writeFile(join(dir, "node_modules", UPSTREAM_PACKAGE, "package.json"), JSON.stringify({ name: UPSTREAM_PACKAGE, version: "0.6.0" }));
}

/** Healthy fakes, recording every command run and every install. */
async function healthy(overrides: Partial<GuiHealthDeps> = {}) {
  const probes: string[][] = [];
  const installs: string[] = [];
  const deps: GuiHealthDeps = {
    agentDir: await mkdtemp(join(tmpdir(), "pi-gui-agent-")),
    packageDir: await packageDir(true),
    env: { PATH: "" },
    platform: "linux", arch: "x64", glibc: () => "2.43",
    resolve: ok(bundledBackend), bundled: () => BUNDLED,
    prerequisites: ready, viewer: viewerReady,
    rdpClients: async () => ["remmina (/snap/bin/remmina): snap build (bundles its own FreeRDP)"],
    probe: async (command, args) => { probes.push([command, ...args]); return answer("0.6.0\n"); },
    installNpm: async dir => { installs.push(dir); return [{ name: "npm dependencies", status: "installed", detail: "installed" }]; },
    ...overrides,
  };
  return { deps, probes, installs };
}
const item = (report: DependencyReport, name: string): DependencyItem => {
  const found = report.items.find(entry => entry.name === name);
  assert.ok(found, `${name} in ${JSON.stringify(report.items.map(entry => entry.name))}`);
  return found;
};
/** The contract: every warn/error/failed/manual/unverified item says what to do. */
const actionable = (report: DependencyReport) => {
  for (const entry of report.items) if (!["ok", "installed"].includes(entry.status)) assert.ok(entry.action, `${entry.name} [${entry.status}] has an action`);
};

test("check: healthy host — every static prerequisite ok, the live desktop unverified, nothing started or installed", async () => {
  const { deps, probes, installs } = await healthy();
  const report = await checkGui({ cwd: process.cwd() }, deps);
  actionable(report);
  const notOk = report.items.filter(entry => entry.status !== "ok");
  assert.deepEqual(notOk.map(entry => entry.name), [LIVE_ITEM], JSON.stringify(notOk));
  assert.match(item(report, LIVE_ITEM).detail!, /live desktop not started; run \/gui doctor for the smoke test/);
  assert.equal(dependencyOutcome(report, "check"), "unverified");
  assert.match(item(report, SERVER_ITEM).detail!, /version` answered 0\.6\.0/);
  assert.match(item(report, "platform").detail!, /linux x64, glibc 2\.43/);
  for (const name of ["kwin_wayland", "xdg-desktop-portal-kde", "KWin screencast plugin", "KWin EIS input plugin"]) assert.equal(item(report, `private desktop: ${name}`).status, "ok");
  assert.equal(item(report, "/gui view: RDP client with H.264").optional, true);
  assert.deepEqual(probes, [[BUNDLED, "version"]], "one bounded version probe, no call/doctor/mcp");
  assert.deepEqual(installs, [], "check never installs");
});

test("check: missing desktop services and plugins give the exact apt command; the Ubuntu libexec portal is found", async () => {
  const missingPortal = (path: string) => !/xdg-desktop-portal-kde$/.test(path) || path.startsWith("/usr/lib/x86_64-linux-gnu/libexec");
  const { deps } = await healthy({
    prerequisites: backend => checkPrerequisites(backend, {
      env: { PATH: "" }, platform: "linux", isExecutable: path => !path.endsWith("kwin_wayland") && missingPortal(path),
      libexecDirs: () => ["/usr/lib/x86_64-linux-gnu/libexec"], pluginDirs: () => ["/usr/lib/qt6/plugins"], exists: path => path.endsWith("eis.so"),
    }),
  });
  const report = await checkGui({}, deps);
  actionable(report);
  const kwin = item(report, "private desktop: kwin_wayland");
  assert.equal(kwin.status, "error");
  assert.equal(kwin.action, "sudo apt install --no-install-recommends kwin-wayland");
  const screencast = item(report, "private desktop: KWin screencast plugin");
  assert.equal(screencast.status, "error");
  assert.match(screencast.action!, /^sudo apt install --no-install-recommends kwin-common \(kwin-common ships KWin's screencast and EIS plugins/);
  assert.equal(item(report, "private desktop: KWin EIS input plugin").status, "ok");
  const portal = item(report, "private desktop: xdg-desktop-portal-kde");
  assert.equal(portal.status, "ok");
  assert.match(portal.detail!, /\/usr\/lib\/x86_64-linux-gnu\/libexec\/xdg-desktop-portal-kde .*--replace/);
  assert.match(item(report, LIVE_ITEM).detail!, /fix the errors above/);
  assert.equal(dependencyOutcome(report, "check"), "abnormal");
});

test("check: without the bundled server the npx fallback is reported unverified and never run", async () => {
  const { deps, probes } = await healthy({ packageDir: await packageDir(false), bundled: () => undefined, resolve: ok(npxBackend) });
  const report = await checkGui({}, deps);
  actionable(report);
  const server = item(report, SERVER_ITEM);
  assert.equal(server.status, "unverified");
  assert.match(server.detail!, /downloads on first use \(not run by this check\)/);
  assert.match(server.action!, /\/gui install-deps/);
  const bundled = item(report, BUNDLED_ITEM);
  assert.equal(bundled.status, "warn");
  assert.equal(bundled.optional, true);
  assert.match(bundled.action!, /Run \/gui install-deps \(npm install --legacy-peer-deps in /);
  assert.deepEqual(probes, [], "no npx, no download");
});

test("check: a server from PATH makes the bundled one unnecessary; a broken binary is an error with the fix", async () => {
  const fromPath = await healthy({ packageDir: await packageDir(false), bundled: () => undefined, resolve: ok(pathBackend) });
  const report = await checkGui({}, fromPath.deps);
  assert.equal(item(report, SERVER_ITEM).status, "ok");
  assert.match(item(report, BUNDLED_ITEM).detail!, /not needed: the server is PATH/);

  const broken = await healthy({ probe: async () => answer("", 1, "computer-use-mcp: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found") });
  const failed = await checkGui({}, broken.deps);
  actionable(failed);
  const server = item(failed, SERVER_ITEM);
  assert.equal(server.status, "error");
  assert.match(server.detail!, /does not run: .*GLIBC_2\.39/);
  assert.match(server.action!, /glibc ≥ 2\.39.*cargo install --locked --git https:\/\/github\.com\/mirsella\/computer-use-mcp computer-use-mcp/);
  assert.equal(dependencyOutcome(failed, "check"), "abnormal");
});

test("check: the bundled server is Linux x64 glibc only; other hosts get the cargo build", async () => {
  const arm = await healthy({ arch: "arm64", packageDir: await packageDir(false), bundled: () => undefined, resolve: () => ({ ok: false, error: "computer-use-mcp not found" }) });
  const report = await checkGui({}, arm.deps);
  actionable(report);
  assert.equal(item(report, SERVER_ITEM).status, "error");
  assert.match(item(report, SERVER_ITEM).action!, /cargo install/);
  const bundled = item(report, BUNDLED_ITEM);
  assert.equal(bundled.status, "warn");
  assert.match(bundled.detail!, /not installable here \(arm64 CPU\)/);
  const oldGlibc = await healthy({ glibc: () => "2.35", packageDir: await packageDir(false), bundled: () => undefined, resolve: ok(npxBackend) });
  assert.match(item(await checkGui({}, oldGlibc.deps), BUNDLED_ITEM).detail!, /glibc 2\.35/);
  assert.ok(versionAtLeast("2.39", "2.39") && versionAtLeast("2.43", "2.39") && !versionAtLeast("2.9", "2.39"));
});

test("check: optional viewer dependencies warn with their apt command; an invalid config is an error", async () => {
  const { deps } = await healthy({
    viewer: () => ({ ok: false, checks: [{ name: "krdpserver (KDE RDP server)", ok: false, detail: "not found", apt: "krdp" }, { name: "openssl (viewer TLS certificate)", ok: true, detail: "/usr/bin/openssl", apt: "openssl" }], missing: ["krdp"] }),
    rdpClients: async () => ["xfreerdp (/usr/bin/xfreerdp): H.264 no — cannot show krdp's stream"],
  });
  await writeFile(join(deps.agentDir, "gui.config.json"), JSON.stringify({ mode: "fast", bogus: 1 }));
  const report = await checkGui({}, deps);
  actionable(report);
  const krdp = item(report, "/gui view: krdpserver (KDE RDP server)");
  assert.deepEqual([krdp.status, krdp.optional], ["warn", true]);
  assert.match(krdp.action!, /^sudo apt install --no-install-recommends krdp \(needed only by \/gui view\)/);
  const client = item(report, "/gui view: RDP client with H.264");
  assert.equal(client.status, "warn");
  assert.match(client.detail!, /only clients without H\.264/);
  const config = item(report, "gui.config.json");
  assert.equal(config.status, "error");
  assert.match(config.detail!, /gui\.config\.json: mode must be "compact" or "direct"; unknown key "bogus"/);
  assert.match(config.action!, /then \/reload/);
});

test("non-Linux: check and install explain that pi-gui is unsupported", async () => {
  const { deps, probes, installs } = await healthy({ platform: "darwin" });
  const report = await checkGui({}, deps);
  actionable(report);
  assert.equal(item(report, "platform").status, "error");
  assert.match(report.note!, /Linux only/);
  assert.equal(report.items.length, 2, "platform and config only");
  const installed = await installGui({}, deps);
  assert.deepEqual(installed.items.map(entry => entry.status), ["manual"]);
  assert.match(installed.items[0]!.action!, /Unsupported platform: run Pi on Linux/);
  assert.deepEqual([probes, installs], [[], []]);
});

test("install: the bundled server through npm, then ok on the second run; system packages stay manual", async () => {
  let present = false;
  const dir = await packageDir(false);
  const { deps, installs, probes } = await healthy({
    packageDir: dir, bundled: () => present ? BUNDLED : undefined, resolve: () => present ? { ok: true, backend: bundledBackend } : { ok: true, backend: npxBackend },
    installNpm: async target => { installs.push(target); await installFake(target); present = true; return [{ name: "npm dependencies", status: "installed", detail: `installed ${UPSTREAM_PACKAGE}`, action: "Run /reload to load them" }]; },
    prerequisites: () => ({ ...ready(), ok: false, checks: [...ready().checks.map(check => check.name === "kwin_wayland" || check.name === "KWin EIS input plugin" ? { ...check, ok: false, detail: "not found" } : check)] }),
  });
  const first = await installGui({}, deps);
  actionable(first);
  assert.equal(item(first, "npm dependencies").status, "installed");
  const apt = item(first, "system packages (private desktop)");
  assert.equal(apt.status, "manual");
  assert.equal(apt.action, "sudo apt install --no-install-recommends kwin-wayland kwin-common (pi-gui never runs sudo), then /reload");
  assert.equal(item(first, "system packages (/gui view)").status, "ok");
  assert.deepEqual(installs, [dir]);
  const second = await installGui({}, deps);
  assert.equal(item(second, SERVER_ITEM).status, "ok");
  assert.match(item(second, SERVER_ITEM).detail!, /already installed/);
  assert.deepEqual(installs, [dir], "nothing installed the second time");
  assert.deepEqual(probes, [], "install runs nothing else (no sudo, no apt, no cargo)");
});

test("install: an npm failure is reported failed with the manual command; unsupported hosts get cargo as a manual step", async () => {
  const failing = await healthy({
    packageDir: await packageDir(false), bundled: () => undefined, resolve: ok(npxBackend),
    installNpm: async () => [{ name: "npm dependencies", status: "failed", detail: "npm install exited 1: ENOTFOUND", action: "Run by hand and read the error: cd x && npm install --legacy-peer-deps" }],
  });
  const failed = await installGui({}, failing.deps);
  actionable(failed);
  assert.equal(item(failed, "npm dependencies").status, "failed");
  assert.equal(dependencyOutcome(failed, "install"), "failed");

  const skipped = await healthy({ packageDir: await packageDir(false), bundled: () => undefined, resolve: ok(npxBackend), installNpm: async () => [{ name: "npm dependencies", status: "installed", detail: "(lockfile refreshed)" }, { name: `npm optional dependency ${UPSTREAM_PACKAGE}`, status: "warn", optional: true, detail: "npm skipped it", action: "see npm" }] });
  const notThere = await installGui({}, skipped.deps);
  assert.equal(item(notThere, SERVER_ITEM).status, "failed", "installed only when the re-check finds the binary");

  const arm = await healthy({ arch: "arm64", packageDir: await packageDir(false), bundled: () => undefined, resolve: () => ({ ok: false, error: "not found" }) });
  const manual = await installGui({}, arm.deps);
  assert.equal(item(manual, SERVER_ITEM).status, "manual");
  assert.match(item(manual, SERVER_ITEM).action!, /^Build it with Rust: cargo install --locked --git/);
  assert.deepEqual(arm.installs, []);
});

test("singleFlight: overlapping installs share one run", async () => {
  let runs = 0;
  let release!: () => void;
  const once = singleFlight(() => { runs++; return new Promise<number>(resolve => { release = () => resolve(runs); }); });
  const [a, b] = [once(), once()];
  release();
  assert.deepEqual(await Promise.all([a, b]), [1, 1]);
  const c = once();
  release();
  assert.equal(await c, 2, "a new run after the first finished");
});

// --- The extension: provider on the channel, `/gui doctor`, `/gui install-deps` -------------------------------------

const fixture = fileURLToPath(new URL("./fixtures/fake-computer-use-mcp.mjs", import.meta.url));
const fakeBackend: Backend = { source: "config", command: process.execPath, prefix: [fixture], mcpArgs: ["--compact-tools"], label: "fake" };
const resolveFake = (config: { mode: "compact" | "direct" }) => ({ ok: true as const, backend: { ...fakeBackend, mcpArgs: config.mode === "compact" ? ["--compact-tools"] : [] } });
const noSnap = () => ({ ok: false as const, reason: "the chromium snap is not installed (test)" });
const open: AgentSession[] = [];
after(async () => {
  for (const session of open.splice(0)) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
});

async function startSession(factories: ExtensionFactory[]) {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-gui-agent-"));
  const faux = fauxProvider({ provider: `pi-gui-deps-faux-${open.length}` });
  faux.setResponses([fauxAssistantMessage("ok")]);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(), agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: factories,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: process.cwd(), agentDir, modelRuntime: runtime, model: faux.getModel(), resourceLoader: loader,
    sessionManager: SessionManager.inMemory(process.cwd()), settingsManager: SettingsManager.inMemory({}),
  });
  await session.bindExtensions({});
  open.push(session);
  return session;
}

test("extension: answers the umbrella's request synchronously; /gui doctor and /gui install-deps notify the formatted report", async () => {
  let api: ExtensionAPI | undefined;
  const installs: string[] = [];
  let release: (() => void) | undefined;
  const dir = await packageDir(false);
  const session = await startSession([
    createMcpExtension({ loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }) }),
    pi => { api = pi; },
    createGuiExtension({
      snapChromium: noSnap, agentDir: await mkdtemp(join(tmpdir(), "pi-gui-cfg-")), resolve: resolveFake, prerequisites: ready, viewer: { prerequisites: viewerReady },
      dependencies: {
        packageDir: dir, platform: "linux", arch: "x64", glibc: () => "2.43", bundled: () => undefined,
        // Only the dependency check sees the npx fallback; the session's own server is the fake one.
        resolve: () => ({ ok: true, backend: npxBackend }),
        rdpClients: async () => ["remmina (/snap/bin/remmina): snap build (bundles its own FreeRDP)"],
        installNpm: async target => {
          installs.push(target);
          await new Promise<void>(resolve => { release = resolve; });
          return [{ name: "npm dependencies", status: "failed", detail: "npm install exited 1", action: "Run by hand: npm install --legacy-peer-deps" }];
        },
      },
    }),
  ]);
  const providers: DependencyProvider[] = [];
  api!.events.emit(DEPENDENCY_CHANNEL, { version: 1, provide: (provider: DependencyProvider) => providers.push(provider) });
  assert.deepEqual(providers.map(provider => [provider.id, provider.label, provider.command]), [["pi-gui", "pi-gui", "/gui"]], "answered synchronously inside emit");
  const checked = await providers[0]!.check({ cwd: process.cwd(), isProjectTrusted: () => false });
  assert.equal(item(checked, SERVER_ITEM).status, "unverified");
  assert.deepEqual(installs, [], "check does not install");

  const notes: { text: string; level?: string }[] = [];
  const statuses: (string | undefined)[] = [];
  const gui = session.extensionRunner.getCommand("gui")!;
  const ctx = { hasUI: true, cwd: process.cwd(), isProjectTrusted: () => false, ui: { notify: (text: string, level?: string) => notes.push({ text, level }), setStatus: (_key: string, text?: string) => statuses.push(text) } } as unknown as Parameters<typeof gui.handler>[1];
  const command = async (args: string) => { notes.length = 0; await gui.handler(args, ctx); return notes.at(-1)!; };

  const doctor = await command("doctor");
  assert.match(doctor.text, /^pi-gui doctor: warning\n/, doctor.text);
  assert.match(doctor.text, /\[ok\] private desktop \(live\): private desktop session-[0-9a-f]+ started, listed and torn down/, "the smoke test answers the live item");
  assert.match(doctor.text, /\[unverified\] computer-use-mcp server: not installed locally/);
  assert.match(doctor.text, /\n\nDetails:\nPrerequisites for private desktops \(upstream runner\):/, "the existing report follows");
  assert.match(doctor.text, /Upstream doctor \(host session; matters only for allowPhysicalDesktop\):\n {2}Wayland session: READY/);
  assert.match(doctor.text, /Private desktop smoke test \(upstream `call`, background list_desktop\): ok/);
  assert.equal(doctor.level, "warning");
  assert.deepEqual(installs, [], "doctor does not install");

  const first = gui.handler("install-deps", ctx);
  const second = gui.handler("install-deps", ctx);
  await new Promise(resolve => setImmediate(resolve));
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  release();
  await Promise.all([first, second]);
  assert.equal(installs.length, 1, "overlapping installs share one run");
  const installed = notes.filter(note => /^pi-gui install-deps:/.test(note.text));
  assert.equal(installed.length, 2);
  assert.match(installed[0]!.text, /^pi-gui install-deps: failed\n/);
  assert.match(installed[0]!.text, /\[failed\] npm dependencies: npm install exited 1\n {6}-> Run by hand/);
  assert.equal(installed[0]!.level, "error");
  assert.equal(statuses.at(-1), undefined, "the progress line is cleared");

  // Existing subcommands parse as before; unknown words still get the usage line.
  assert.match((await command("")).text, /^Computer Use: enabled/);
  assert.match((await command("status")).text, /^Computer Use: enabled/);
  assert.match((await command("view list")).text, /main/);
  const usage = await command("bogus");
  assert.equal(usage.level, "warning");
  assert.match(usage.text, /^Usage: \/gui \[status\|doctor\|install-deps\|view/);
  const completions = (await gui.getArgumentCompletions!("in"))?.map(entry => entry.value);
  assert.deepEqual(completions, ["install-deps"]);
});
