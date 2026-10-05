import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const MAX_BYTES = 1024 * 1024;

/**
 * Lifecycle lines only (registered, connected, private desktop seen, errors), never tool input or output: screenshots,
 * typed text, clipboard contents and accessibility text stay out. `<agentDir>/gui.log`, rotated to `gui.log.1` at 1 MiB.
 */
export class GuiLog {
  readonly path: string;
  private readonly recent: string[] = [];
  private readonly scope: string;

  constructor(agentDir: string, scope: string) {
    this.path = join(agentDir, "gui.log");
    this.scope = scope;
  }

  write(message: string): void {
    const line = `${new Date().toISOString()} [gui] ${this.scope} pid=${process.pid} ${message}`;
    this.recent.push(line);
    if (this.recent.length > 20) this.recent.shift();
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      try { if (statSync(this.path).size > MAX_BYTES) renameSync(this.path, `${this.path}.1`); } catch { /* new file */ }
      appendFileSync(this.path, `${line}\n`, { mode: 0o600 });
    } catch { /* logging never fails the caller */ }
  }

  /** The last lines written by this instance. */
  lines(): readonly string[] {
    return this.recent;
  }
}
