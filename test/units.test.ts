import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  invocation, mcpToolName, NO_RUNTIME_DIR, PHYSICAL_SESSION_ENV, resolveBackend, serverConfig, serverToolOf, toolNames,
  type Backend,
} from "../src/backend.ts";
import { DEFAULT_GUI_CONFIG, loadGuiConfig, validateGuiConfig } from "../src/config.ts";
import { desktopGuidance, routeToolCall, sessionOf } from "../src/policy.ts";
import { checkPrerequisites, doctorStatuses, KWIN_PLUGINS, PORTAL_BACKEND_WRAPPER, RUNNER_PROGRAMS } from "../src/prerequisites.ts";

const config = (patch = {}) => ({ ...DEFAULT_GUI_CONFIG, env: {}, ...patch });

test("config: defaults, user then trusted project, strict validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-config-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "gui.config.json"), JSON.stringify({ mode: "direct", command: "computer-use-mcp", allowPhysicalDesktop: true }));
  await writeFile(join(cwd, ".pi", "gui.config.json"), JSON.stringify({ mainSession: false, timeoutSeconds: 90 }));
  const trusted = await loadGuiConfig({ cwd, agentDir, projectTrusted: true });
  assert.deepEqual(trusted.errors, []);
  assert.equal(trusted.config.mode, "direct");
  assert.equal(trusted.config.mainSession, false);
  assert.equal(trusted.config.timeoutSeconds, 90);
  assert.equal(trusted.config.allowPhysicalDesktop, true);
  const untrusted = await loadGuiConfig({ cwd, agentDir, projectTrusted: false });
  assert.equal(untrusted.config.mainSession, true);
  assert.equal(untrusted.sources.length, 1);
  // A project may not pick the program or open the physical desktop.
  await writeFile(join(cwd, ".pi", "gui.config.json"), JSON.stringify({ allowPhysicalDesktop: true, mode: "compact" }));
  const refused = await loadGuiConfig({ cwd, agentDir, projectTrusted: true });
  assert.match(refused.errors[0]!, /allowPhysicalDesktop" is only allowed in the user config/);
  assert.equal(refused.config.mode, "direct", "an invalid file applies nothing");
  assert.throws(() => validateGuiConfig({ mode: "fast", bogus: 1, timeoutSeconds: 1 }), /mode must be.*unknown key "bogus".*timeoutSeconds must be/);
});

test("backend: bundled binary first, then PATH, then npx; explicit command and args", () => {
  const exec = (paths: string[]) => (path: string) => paths.includes(path);
  const env = { PATH: "/usr/local/bin:/usr/bin" };
  const bundled = resolveBackend(config(), { env, bundled: () => "/pkg/vendor/bin/computer-use-mcp", isExecutable: exec(["/pkg/vendor/bin/computer-use-mcp", "/usr/bin/npx"]) });
  assert.ok(bundled.ok && bundled.backend.source === "bundled");
  assert.deepEqual(bundled.ok && bundled.backend.mcpArgs, ["--compact-tools"]);
  const onPath = resolveBackend(config({ mode: "direct" }), { env, bundled: () => undefined, isExecutable: exec(["/usr/local/bin/computer-use-mcp"]) });
  assert.ok(onPath.ok && onPath.backend.source === "path" && onPath.backend.command === "/usr/local/bin/computer-use-mcp");
  assert.deepEqual(onPath.ok && onPath.backend.mcpArgs, []);
  const npx = resolveBackend(config(), { env, bundled: () => undefined, isExecutable: exec(["/usr/bin/npx"]) });
  assert.ok(npx.ok && npx.backend.source === "npx");
  assert.deepEqual(npx.ok && npx.backend.prefix, ["-y", "@mirsella/opencode-computer-use-mcp@0.6.0"]);
  assert.equal(resolveBackend(config(), { env, bundled: () => undefined, isExecutable: exec([]) }).ok, false);
  const custom = resolveBackend(config({ command: "npx", args: ["-y", "@mirsella/opencode-computer-use-mcp@latest", "mcp"] }), { env, isExecutable: exec(["/usr/bin/npx"]) });
  assert.ok(custom.ok);
  assert.deepEqual(custom.ok && [custom.backend.prefix, custom.backend.mcpArgs], [["-y", "@mirsella/opencode-computer-use-mcp@latest"], ["--compact-tools"]]);
  assert.match((resolveBackend(config({ command: "npx", args: ["-y", "x"] }), { env, isExecutable: exec(["/usr/bin/npx"]) }) as { error: string }).error, /must contain the "mcp" subcommand/);
  assert.match((resolveBackend(config({ mode: "direct", command: "npx", args: ["mcp", "--compact-tools"] }), { env, isExecutable: exec(["/usr/bin/npx"]) }) as { error: string }).error, /conflicts/);
});

test("backend: private mode strips the physical session from the server environment", () => {
  const backend: Backend = { source: "bundled", command: "/b/computer-use-mcp", prefix: [], mcpArgs: ["--compact-tools"], label: "b" };
  const server = serverConfig(backend, config({ env: { RUST_LOG: "warn" } }), { physical: false, exposure: "direct" });
  assert.equal(server.command, "env");
  for (const name of PHYSICAL_SESSION_ENV) assert.ok(server.args!.join(" ").includes(`-u ${name}`), name);
  assert.ok(server.args!.includes(`XDG_RUNTIME_DIR=${NO_RUNTIME_DIR}`));
  assert.deepEqual(server.args!.slice(-3), ["/b/computer-use-mcp", "mcp", "--compact-tools"]);
  assert.deepEqual(server.env, { RUST_LOG: "warn" });
  assert.equal(server.timeout, 150);
  const physical = invocation(backend, ["mcp"], { physical: true });
  assert.deepEqual(physical, { command: "/b/computer-use-mcp", args: ["mcp"] });
});

test("tool names follow Pi's mcp__<server>__<tool> rule", () => {
  assert.equal(mcpToolName("dispatch"), "mcp__computer_use__dispatch");
  assert.deepEqual(toolNames("compact"), ["mcp__computer_use__help", "mcp__computer_use__dispatch"]);
  assert.equal(toolNames("direct").length, 6);
  assert.equal(serverToolOf("mcp__computer_use__observe"), "observe");
  assert.equal(serverToolOf("mcp__codegraph__codegraph_explore"), undefined);
});

test("policy: private desktop by default, foreground refused unless opted in", () => {
  const strict = { allowPhysicalDesktop: false };
  const list: Record<string, unknown> = { scope: "windows" };
  assert.equal(routeToolCall("list_desktop", list, strict), undefined);
  assert.equal(list.desktop, "background");
  const launch = { action: "launch_application", arguments: { desktop_id: "org.kde.kwrite.desktop" } as Record<string, unknown> };
  assert.equal(routeToolCall("dispatch", launch, strict), undefined);
  assert.equal(launch.arguments.desktop, "background");
  assert.match(routeToolCall("list_desktop", { scope: "windows", desktop: "foreground" }, strict)!, /private desktop/);
  assert.match(routeToolCall("dispatch", { action: "wait_for", arguments: { condition: { type: "human_idle" }, timeout_ms: 1000 } }, strict)!, /human_idle/);
  const opened: Record<string, unknown> = { condition: { type: "window_opened", desktop_id: "org.kde.kwrite" }, timeout_ms: 3000 };
  assert.equal(routeToolCall("wait_for", opened, strict), undefined);
  assert.equal(opened.desktop, "background");
  // Calls that route by returned IDs and do not accept a selector stay untouched.
  const observe: Record<string, unknown> = { target: { app_instance_id: "app-1", window_instance_id: "win-2" }, view: "both" };
  assert.equal(routeToolCall("observe", observe, strict), undefined);
  assert.equal("desktop" in observe, false);
  const targeted: Record<string, unknown> = { target: { app_instance_id: "a", window_instance_id: "w" }, condition: { type: "window_opened", desktop_id: "x" }, timeout_ms: 1 };
  assert.equal(routeToolCall("wait_for", targeted, strict), undefined);
  assert.equal("desktop" in targeted, false);
  assert.equal(routeToolCall("help", { action: "act" }, strict), undefined);
  assert.equal(routeToolCall("dispatch", { action: "list_desktop", arguments: "bad" }, strict), undefined, "upstream validates malformed input");
  const optedIn = { allowPhysicalDesktop: true };
  assert.equal(routeToolCall("list_desktop", { desktop: "foreground" }, optedIn), undefined);
  const implicit: Record<string, unknown> = {};
  routeToolCall("list_desktop", implicit, optedIn);
  assert.equal(implicit.desktop, "background", "even with the opt-in, the private desktop stays the default");
  assert.match(routeToolCall("list_desktop", { desktop: "elsewhere" }, optedIn)!, /not available/);
});

test("guidance names the physical-screen tools only when they exist", () => {
  assert.match(desktopGuidance(false), /private desktop/);
  assert.doesNotMatch(desktopGuidance(false), /physical/);
  assert.match(desktopGuidance(true), /only when the user explicitly asks you to act on their own screen/);
});

test("sessionOf reads only upstream's header line", () => {
  assert.deepEqual(sessionOf([{ type: "image" }, { type: "text", text: "Desktop: background session=session-00ab\nsecret text" }]), { desktop: "background", session: "session-00ab" });
  assert.equal(sessionOf([{ type: "text", text: "operations: a, b" }]), undefined);
});

test("prerequisites mirror the runner's lookup, overrides included", () => {
  const present = new Set(["/usr/bin/kwin_wayland", "/usr/libexec/xdg-desktop-portal", "/usr/bin/pipewire", "/usr/bin/wireplumber", "/usr/bin/dbus-daemon", "/usr/bin/dbus-send", "/usr/libexec/at-spi-bus-launcher", "/usr/libexec/at-spi2-registryd", "/usr/bin/gdbus", "/usr/bin/setsid", "/bin/bash", "/opt/kde/portal-kde"]);
  const isExecutable = (path: string) => present.has(path);
  const plugins = new Set(["/usr/lib/x86_64-linux-gnu/qt6/plugins/kwin/plugins/screencast.so", "/usr/lib/x86_64-linux-gnu/qt6/plugins/kwin/plugins/eis.so"]);
  const base = { platform: "linux", isExecutable, exists: (path: string) => plugins.has(path), pluginDirs: () => ["/usr/lib/x86_64-linux-gnu/qt6/plugins"] };
  const missing = checkPrerequisites(undefined, { ...base, env: { PATH: "/nowhere" }, libexecDirs: () => [] });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ["xdg-desktop-portal-kde (apt: xdg-desktop-portal-kde)"]);
  // Ubuntu installs the KDE portal backend in multiarch libexec, which the runner does not search; it is started with --replace.
  present.add("/usr/lib/x86_64-linux-gnu/libexec/xdg-desktop-portal-kde");
  const multiarch = checkPrerequisites(undefined, { ...base, env: { PATH: "/nowhere" }, libexecDirs: () => ["/usr/lib/x86_64-linux-gnu/libexec"] });
  assert.equal(multiarch.ok, true, multiarch.missing.join());
  assert.deepEqual(multiarch.overrides, { COMPUTER_USE_MCP_PORTAL_BACKEND_BIN: PORTAL_BACKEND_WRAPPER, PI_GUI_PORTAL_BACKEND: "/usr/lib/x86_64-linux-gnu/libexec/xdg-desktop-portal-kde" });
  present.delete("/usr/lib/x86_64-linux-gnu/libexec/xdg-desktop-portal-kde");
  const overridden = checkPrerequisites(undefined, { ...base, env: { PATH: "/nowhere", COMPUTER_USE_MCP_PORTAL_BACKEND_BIN: "/opt/kde/portal-kde" }, libexecDirs: () => [] });
  assert.equal(overridden.ok, true);
  assert.deepEqual(overridden.overrides, {}, "a user override is used as it is");
  assert.equal(RUNNER_PROGRAMS.length + KWIN_PLUGINS.length, overridden.checks.length - 1);
  // kwin-wayland without kwin-common: no screencast/EIS plugins, so no screenshots or input.
  const noPlugins = checkPrerequisites(undefined, { ...base, exists: () => false, env: { PATH: "/nowhere", COMPUTER_USE_MCP_PORTAL_BACKEND_BIN: "/opt/kde/portal-kde" }, libexecDirs: () => [] });
  assert.deepEqual(noPlugins.missing, ["KWin screencast plugin (apt: kwin-common)", "KWin EIS input plugin (apt: kwin-common)"]);
  assert.equal(checkPrerequisites(undefined, { ...base, env: {}, platform: "darwin" }).checks[0]!.ok, false);
});

test("doctor output is summarised by section", () => {
  assert.deepEqual(doctorStatuses("Computer Use MCP doctor\n\n[Wayland session]\nStatus: READY\nDisplay: wayland-0\n\n[Virtual desktop (KWin)]\nStatus: UNAVAILABLE\n"), [
    { section: "Wayland session", status: "READY" },
    { section: "Virtual desktop (KWin)", status: "UNAVAILABLE" },
  ]);
});
