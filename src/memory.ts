import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export interface MemoryEntry {
  id: string;
  scope: string;
  text: string;
  source: string;
  createdAt: string;
}

/** Small explicit notebooks. Conversation summaries never become owner rules automatically. */
export class MemoryBook {
  constructor(private readonly stateDir: string) {}
  static project(cwd: string): string {
    const root = realpathSync(resolve(cwd));
    return "project:" + createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex");
  }
  private path(scope: string): string {
    if (!/^(owner|project:[a-f0-9]{64}|area:[A-Za-z0-9_-]{1,80})$/.test(scope)) throw new Error("Use owner, a project scope, or area:<name>.");
    const directory = join(this.stateDir, "memory");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return join(directory, createHash("sha256").update(scope).digest("hex") + ".json");
  }
  list(scope: string, query = ""): MemoryEntry[] {
    const file = this.path(scope);
    const entries: MemoryEntry[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
    if (!Array.isArray(entries) || entries.some((entry) => entry.scope !== scope || typeof entry.text !== "string")) throw new Error("Memory notebook is invalid; inspect it before reuse.");
    return entries.filter((entry) => !query || entry.text.toLowerCase().includes(query.toLowerCase()));
  }
  private save(scope: string, entries: MemoryEntry[]): void {
    const target = this.path(scope), temporary = target + "." + randomUUID() + ".tmp";
    writeFileSync(temporary, JSON.stringify(entries, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
  }
  private withLock<T>(scope: string, change: () => T): T {
    const lock = this.path(scope) + ".lock";
    let handle: number;
    try { handle = openSync(lock, "wx", 0o600); }
    catch { throw new Error("Memory notebook is busy or has an unreconciled writer lock; no changes were made."); }
    try {
      writeFileSync(handle, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return change();
    } finally { closeSync(handle); unlinkSync(lock); }
  }
  add(scope: string, text: string, source: string): MemoryEntry {
    if (!text.trim() || !source.trim()) throw new Error("Memory needs text and a source.");
    const entry = { id: randomUUID(), scope, text, source, createdAt: new Date().toISOString() };
    return this.withLock(scope, () => { this.save(scope, [...this.list(scope), entry]); return entry; });
  }
  remove(scope: string, id: string): void {
    this.withLock(scope, () => {
      const entries = this.list(scope);
      if (!entries.some((entry) => entry.id === id)) throw new Error("Unknown memory entry in this scope.");
      this.save(scope, entries.filter((entry) => entry.id !== id));
    });
  }
}
