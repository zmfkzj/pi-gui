#!/usr/bin/env node
// A stand-in for computer-use-mcp: the same CLI shape and MCP tool names, no desktop. Every routed call answers with
// upstream's header line plus the arguments it received and the session variables it can see, so tests observe both
// the routing policy and the server environment through Pi's real MCP pipeline.
import { createInterface } from "node:readline";

const [command, ...rest] = process.argv.slice(2);
const SESSION = `session-${(process.pid % 0xffff).toString(16).padStart(16, "0")}`;
const visible = ["WAYLAND_DISPLAY", "DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "AT_SPI_BUS_ADDRESS", "XDG_RUNTIME_DIR", "PI_GUI_TEST_MARK"];
const env = Object.fromEntries(visible.map(name => [name, process.env[name] ?? null]));

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
      return send({ id: message.id, result: { content: [{ type: "text", text: `Desktop: ${desktop} session=${SESSION}\n${JSON.stringify({ operation, arguments: operationArgs, env, pid: process.pid })}` }] } });
    }
    send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
  });
} else {
  console.error(`unknown command ${command}`);
  process.exit(2);
}
