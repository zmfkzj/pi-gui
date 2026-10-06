#!/usr/bin/env node
// A stand-in for computer-use-mcp: the same CLI shape and MCP tool names, no desktop. Every routed call answers with
// upstream's header line plus the arguments it received and the session variables it can see, so tests observe both
// the routing policy and the server environment through Pi's real MCP pipeline.
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [command, ...rest] = process.argv.slice(2);
const SESSION = `session-${(process.pid % 0xffff).toString(16).padStart(16, "0")}`;
const visible = ["WAYLAND_DISPLAY", "DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "AT_SPI_BUS_ADDRESS", "XDG_RUNTIME_DIR", "PI_GUI_TEST_MARK"];
const env = Object.fromEntries(visible.map(name => [name, process.env[name] ?? null]));

// The first background call starts a stand-in for upstream's private session, as the runner lays it out: a 0700
// `computer-use-mcp-isolated-*` directory with the readiness marker, Wayland and bus sockets, and a session process
// that carries the runner's variables. Teardown stops every process carrying this session's marker, like the runner.
let privateSession;
function ensurePrivateSession() {
  if (privateSession) return;
  const dir = mkdtempSync(join(tmpdir(), "computer-use-mcp-isolated-"));
  chmodSync(dir, 0o700);
  const display = `wayland-virtual-${process.pid}`;
  const marker = join(dir, "isolation.ready");
  const sockets = [display, "bus"].map(name => createServer().listen(join(dir, name)));
  writeFileSync(marker, `runtime_dir=${dir}\n`);
  const sessionEnv = { ...process.env, XDG_RUNTIME_DIR: dir, WAYLAND_DISPLAY: display, DBUS_SESSION_BUS_ADDRESS: `unix:path=${dir}/bus`, COMPUTER_USE_MCP_ISOLATION_MARKER: marker };
  const service = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { env: sessionEnv, stdio: "ignore" });
  privateSession = { dir, display, marker, sockets, service };
}
function teardown() {
  if (!privateSession) return;
  const { dir, marker, sockets, service } = privateSession;
  privateSession = undefined;
  service.kill("SIGKILL");
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try { if (readFileSync(`/proc/${name}/environ`, "utf8").split("\0").includes(`COMPUTER_USE_MCP_ISOLATION_MARKER=${marker}`)) process.kill(Number(name), "SIGKILL"); } catch { /* not ours or gone */ }
  }
  for (const socket of sockets) socket.close();
  rmSync(dir, { recursive: true, force: true });
}
process.on("exit", teardown);
process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));

if (command === "version") { console.log("0.6.0"); process.exit(0); }
if (command === "doctor") { console.log("[Wayland session]\nStatus: READY\n\n[PipeWire]\nStatus: READY"); process.exit(0); }
if (command === "call") {
  let input = "";
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    const call = JSON.parse(input);
    const desktop = call.arguments?.desktop ?? "foreground";
    console.log(JSON.stringify({ content: [{ type: "text", text: `Desktop: ${desktop} session=${SESSION}\n${JSON.stringify({ env })}` }] }));
  });
} else if (command === "mcp") {
  const compact = rest.includes("--compact-tools");
  const names = compact ? ["help", "dispatch"] : ["list_desktop", "launch_application", "activate_window", "observe", "act", "wait_for"];
  const tools = names.map(name => ({ name, description: `fake ${name}`, inputSchema: { type: "object", additionalProperties: true }, annotations: { readOnlyHint: name === "help" } }));
  const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  createInterface({ input: process.stdin }).on("line", line => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    if (message.method === "initialize") return send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-computer-use-mcp", version: "0.6.0" }, instructions: "fake" } });
    if (message.method === "tools/list") return send({ id: message.id, result: { tools } });
    if (message.method === "tools/call") {
      const { name, arguments: args } = message.params;
      if (name === "help") return send({ id: message.id, result: { content: [{ type: "text", text: "operations: list_desktop, launch_application" }] } });
      if (args?.arguments?.crash === true || args?.crash === true) process.exit(3);
      const operation = name === "dispatch" ? args.action : name;
      const operationArgs = name === "dispatch" ? args.arguments : args;
      const desktop = operationArgs?.desktop ?? "foreground";
      if (desktop === "background") ensurePrivateSession();
      return send({ id: message.id, result: { content: [{ type: "text", text: `Desktop: ${desktop} session=${SESSION}\n${JSON.stringify({ operation, arguments: operationArgs, env, pid: process.pid })}` }] } });
    }
    send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
  }).on("close", () => process.exit(0));
} else {
  console.error(`unknown command ${command}`);
  process.exit(2);
}
