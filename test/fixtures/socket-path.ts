// Bind fixture sockets inside a long, canonical scratch path without changing the production path/security checks.
// Linux limits the *bind argument* to sun_path bytes; a directory FD alias still creates the socket at the real path.
import { closeSync, openSync, rmSync } from "node:fs";
import type { Server } from "node:net";
import { basename, dirname } from "node:path";

export function listenSocket(server: Server, path: string, listening?: () => void): Server {
  if (process.platform !== "linux" || Buffer.byteLength(path) < 104) return server.listen(path, listening);
  const fd = openSync(dirname(path), "r");
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    closeSync(fd);
    rmSync(path, { force: true });
  };
  server.once("close", cleanup);
  server.once("error", cleanup);
  try { return server.listen(`/proc/${process.pid}/fd/${fd}/${basename(path)}`, listening); }
  catch (error) { cleanup(); throw error; }
}
