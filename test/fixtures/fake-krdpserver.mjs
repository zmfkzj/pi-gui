#!/usr/bin/env node
// A stand-in for krdpserver: the same options and readiness line, a plain TCP listener instead of RDP. It records its
// arguments and the session variables it sees to FAKE_KRDP_RECORD (tests only), and starts a child process so tests can
// check that stopping the viewer leaves no process behind. FAKE_KRDP_BUSY_PORT makes it fail like krdp on a taken port.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";

const options = Object.fromEntries(process.argv.slice(2).map(arg => /^--([^=]+)=(.*)$/.exec(arg)).filter(Boolean).map(match => [match[1], match[2]]));
if (!options.certificate || !options["certificate-key"]) {
  console.error("org.kde.krdp: A valid TLS certificate and key is required for the server to run!");
  process.exit(1);
}
if (process.env.FAKE_KRDP_BUSY_PORT && Number(options.port) === Number(process.env.FAKE_KRDP_BUSY_PORT)) {
  console.error(`org.kde.krdp: Failed to listen for connections on ${options.address} ${options.port}`);
  process.exit(1);
}
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
const visible = ["XDG_RUNTIME_DIR", "WAYLAND_DISPLAY", "DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "PIPEWIRE_RUNTIME_DIR", "XDG_CONFIG_HOME", "TMPDIR", "COMPUTER_USE_MCP_ISOLATION_MARKER", "PI_GUI_VIEW_TAG", "QT_QPA_PLATFORM"];
const server = createServer(socket => socket.end("RDP?\n"));
server.listen(Number(options.port), options.address, () => {
  if (process.env.FAKE_KRDP_RECORD) {
    writeFileSync(process.env.FAKE_KRDP_RECORD, JSON.stringify({ args: process.argv.slice(2), options, env: Object.fromEntries(visible.map(name => [name, process.env[name] ?? null])), pid: process.pid, child: child.pid }));
  }
  console.log(`org.kde.krdp: Listening for connections on QHostAddress("${options.address}") ${options.port}`);
});
process.on("SIGTERM", () => { child.kill("SIGKILL"); process.exit(0); });
