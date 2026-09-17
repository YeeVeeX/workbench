import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep, toNamespacedPath } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import type {
  ApprovalRecord,
  ArtifactRecord,
  EventRecord,
  OperationRecord,
  OperationState,
  RunRecord,
  RunState,
  TaskInput,
  TaskRecord,
  TaskState,
} from "./contracts.js";

type Row = Record<string, SQLOutputValue>;

// Error messages deliberately contain no caller-supplied values or SQLite errors.
class StoreError extends Error {}

const RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  running: ["paused", "verifying", "accepted", "blocked", "failed", "canceled"],
  paused: ["running", "verifying", "blocked", "failed", "canceled"],
  verifying: ["running", "paused", "accepted", "blocked", "failed", "canceled"],
  blocked: ["running", "paused", "verifying", "failed", "canceled"],
  failed: ["running", "paused", "canceled"],
  accepted: [],
  canceled: [],
};

const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  queued: ["running", "blocked", "failed", "canceled"],
  running: ["queued", "waiting", "verifying", "accepted", "blocked", "failed", "canceled"],
  waiting: ["queued", "verifying", "blocked", "failed", "canceled"],
  verifying: ["queued", "running", "waiting", "accepted", "blocked", "failed", "canceled"],
  blocked: ["queued", "failed", "canceled"],
  failed: ["queued", "canceled"],
  accepted: [],
  canceled: [],
};

const OPERATION_TRANSITIONS: Record<OperationState, readonly OperationState[]> = {
  prepared: ["running", "failed"],
  running: ["succeeded", "failed", "unknown"],
  // Reconciliation can record an outcome, but cannot dispatch the effect again.
  unknown: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
};

const SCHEMA = `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY NOT NULL,
    objective TEXT NOT NULL,
    cwd TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN
      ('running', 'paused', 'verifying', 'accepted', 'blocked', 'failed', 'canceled')),
    result TEXT,
    owner_pid INTEGER CHECK (owner_pid > 0),
    owner_token TEXT CHECK (length(owner_token) > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((owner_pid IS NULL) = (owner_token IS NULL))
  ) STRICT;
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id),
    parent_id TEXT,
    objective TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('coordinator', 'worker', 'reviewer')),
    state TEXT NOT NULL CHECK (state IN
      ('queued', 'running', 'waiting', 'verifying', 'accepted', 'blocked', 'failed', 'canceled')),
    write_paths TEXT NOT NULL CHECK (json_valid(write_paths)),
    acceptance TEXT NOT NULL CHECK (json_valid(acceptance)),
    result TEXT,
    evidence TEXT NOT NULL CHECK (json_valid(evidence)),
    attempt INTEGER NOT NULL CHECK (attempt >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, run_id),
    FOREIGN KEY (parent_id, run_id) REFERENCES tasks(id, run_id),
    CHECK (parent_id IS NULL OR parent_id <> id)
  ) STRICT;
  CREATE TABLE task_dependencies (
    task_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    dependency_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (task_id, dependency_id),
    UNIQUE (task_id, position),
    FOREIGN KEY (task_id, run_id) REFERENCES tasks(id, run_id),
    FOREIGN KEY (dependency_id, run_id) REFERENCES tasks(id, run_id),
    CHECK (task_id <> dependency_id)
  ) STRICT;
  CREATE TABLE operations (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id),
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
    input TEXT NOT NULL CHECK (json_valid(input)),
    state TEXT NOT NULL CHECK (state IN ('prepared', 'running', 'succeeded', 'failed', 'unknown')),
    result TEXT CHECK (result IS NULL OR json_valid(result)),
    pid INTEGER CHECK (pid > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (task_id, run_id) REFERENCES tasks(id, run_id)
  ) STRICT;
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id),
    task_id TEXT NOT NULL,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    bytes INTEGER NOT NULL CHECK (bytes >= 0),
    media_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id, run_id) REFERENCES tasks(id, run_id)
  ) STRICT;
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id),
    task_id TEXT NOT NULL,
    action_hash TEXT NOT NULL CHECK (length(action_hash) = 64),
    action TEXT NOT NULL CHECK (json_valid(action)),
    state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'consumed')),
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id, run_id) REFERENCES tasks(id, run_id)
  ) STRICT;
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id),
    task_id TEXT,
    type TEXT NOT NULL,
    data TEXT NOT NULL CHECK (json_valid(data)),
    at TEXT NOT NULL,
    FOREIGN KEY (task_id, run_id) REFERENCES tasks(id, run_id)
  ) STRICT;
  CREATE INDEX tasks_run ON tasks(run_id);
  CREATE INDEX tasks_active ON tasks(state, role);
  CREATE INDEX dependencies_run ON task_dependencies(run_id);
  CREATE INDEX operations_run ON operations(run_id);
  CREATE INDEX artifacts_run_task ON artifacts(run_id, task_id);
  CREATE INDEX approvals_run ON approvals(run_id);
  CREATE INDEX events_run_seq ON events(run_id, seq);
  PRAGMA user_version = 1;
`;

function fail(message: string): never {
  throw new StoreError(message);
}

function nonempty(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    fail("Expected a nonempty string.");
  }
}

function stringArray(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) fail("Expected a list of strings.");
  for (const item of value) nonempty(item);
}

function optionalString(value: unknown): void {
  if (value !== undefined && typeof value !== "string") fail("Expected a string.");
}

function positiveInteger(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail("Expected a positive integer.");
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function patchKeys(patch: unknown, allowed: readonly string[]): string[] {
  if (!plainObject(patch) || Object.getOwnPropertySymbols(patch).length !== 0) {
    fail("Expected a record patch.");
  }
  const keys = Object.getOwnPropertyNames(patch);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(patch, key)!;
    if (!allowed.includes(key)) fail("Immutable or unknown record fields cannot be changed.");
    if (!descriptor.enumerable || !("value" in descriptor)) fail("Expected a record patch.");
  }
  return keys;
}

function transition<S extends string>(
  from: S,
  to: S,
  transitions: Record<S, readonly S[]>,
): void {
  if (!Object.hasOwn(transitions, to) || (from !== to && !transitions[from].includes(to))) {
    fail("Invalid state transition.");
  }
}

// Canonical JSON: recursively sorted object keys, ordered arrays, finite numbers.
// Reject lossy/non-JSON values instead of giving distinct actions the same hash.
function json(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown): string {
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null) fail("Expected a JSON value.");
    if (ancestors.has(item)) fail("Expected an acyclic JSON value.");
    ancestors.add(item);
    try {
      if (Object.getOwnPropertySymbols(item).length !== 0) fail("Expected a JSON value.");
      if (Array.isArray(item)) {
        if (Object.getOwnPropertyNames(item).length !== item.length + 1) {
          fail("Expected a JSON array without holes or extra properties.");
        }
        const parts: string[] = [];
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || !("value" in descriptor)) fail("Expected a JSON value.");
          parts.push(encode(descriptor.value));
        }
        return `[${parts.join(",")}]`;
      }
      if (!plainObject(item)) fail("Expected a JSON value.");
      const parts: string[] = [];
      for (const key of Object.getOwnPropertyNames(item).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!descriptor.enumerable || !("value" in descriptor)) fail("Expected a JSON value.");
        parts.push(`${JSON.stringify(key)}:${encode(descriptor.value)}`);
      }
      return `{${parts.join(",")}}`;
    } finally {
      ancestors.delete(item);
    }
  }
  return encode(value);
}

function digest(encoded: string): string {
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}

function text(row: Row, name: string): string {
  const value = row[name];
  if (typeof value !== "string") fail("Store contains invalid data.");
  return value;
}

function integer(row: Row, name: string): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail("Store contains invalid data.");
  }
  return value;
}

function timestamp(previous?: string): string {
  return new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString();
}

function activeRun(state: RunState): boolean {
  return state === "running" || state === "verifying";
}

function activeTask(state: TaskState): boolean {
  return state === "running" || state === "verifying";
}

function within(root: string, path: string): boolean {
  const difference = relative(root, path);
  return difference === "" ||
    (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference));
}

// Resolve existing ancestors as well as purely lexical aliases. This covers a
// new file beneath a symlink/junction without requiring the file to exist.
function physicalPath(path: string): string {
  const tail: string[] = [];
  let ancestor = path;
  for (;;) {
    try {
      const actual = realpathSync.native(ancestor);
      return resolve(actual, ...tail.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") fail("Unable to resolve a write path.");
      const parent = dirname(ancestor);
      if (parent === ancestor) return path;
      tail.push(relative(parent, ancestor));
      ancestor = parent;
    }
  }
}

function claimPath(cwd: string, path: string): string {
  nonempty(path);
  const lexicalRoot = resolve(cwd);
  const lexicalPath = resolve(lexicalRoot, path);
  if (!within(lexicalRoot, lexicalPath)) fail("Write paths must stay inside the run directory.");
  const root = physicalPath(lexicalRoot);
  const target = physicalPath(lexicalPath);
  if (!within(root, target)) fail("Write paths must stay inside the run directory.");
  return process.platform === "win32" ? target.toLowerCase() : target;
}

function overlaps(left: string, right: string): boolean {
  return within(left, right) || within(right, left);
}

/** Durable state and claims. Only the caller's supervisor decides acceptance. */
export class Store {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(stateDir: string) {
    let database: DatabaseSync | undefined;
    try {
      nonempty(stateDir);
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      database = new DatabaseSync(toNamespacedPath(join(stateDir, "workbench.sqlite")), {
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
        timeout: 5_000,
      });
      this.db = database;
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
      `);
      this.transaction(() => {
        const version = integer(this.db.prepare("PRAGMA user_version").get()!, "user_version");
        if (version === 0) this.db.exec(SCHEMA);
        else if (version !== 1) fail("Store schema version is not supported.");
      });
    } catch (error) {
      try { database?.close(); } catch { /* Keep the original safe error. */ }
      if (error instanceof StoreError) throw error;
      throw new StoreError("Unable to open the store.");
    }
  }

  close(): void {
    if (this.closed) return;
    this.read(() => this.db.close());
    this.closed = true;
  }

  createRun(objective: string, cwd: string): RunRecord {
    return this.transaction(() => {
      nonempty(objective);
      nonempty(cwd);
      const id = randomUUID();
      const at = timestamp();
      this.db.prepare(`
        INSERT INTO runs (id, objective, cwd, state, created_at, updated_at)
        VALUES (?, ?, ?, 'running', ?, ?)
      `).run(id, objective, resolve(cwd), at, at);
      const run = this.getRun(id);
      this.insertEvent(id, "run.created", run);
      return run;
    });
  }

  getRun(id: string): RunRecord {
    return this.read(() => {
      nonempty(id);
      const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
      if (!row) fail("Run not found.");
      return this.runRecord(row);
    });
  }

  listRuns(): RunRecord[] {
    return this.read(() => this.db.prepare(
      "SELECT * FROM runs ORDER BY created_at, rowid",
    ).all().map((row) => this.runRecord(row)));
  }

  updateRun(id: string, patch: Partial<RunRecord>): RunRecord {
    return this.transaction(() => {
      const run = this.getRun(id);
      if (patchKeys(patch, ["state", "result"]).length === 0) return run;
      const next = { ...run, ...patch };
      transition(run.state, next.state, RUN_TRANSITIONS);
      optionalString(next.result);
      this.db.prepare("UPDATE runs SET state = ?, result = ?, updated_at = ? WHERE id = ?")
        .run(next.state, next.result ?? null, timestamp(run.updatedAt), id);
      const updated = this.getRun(id);
      const { ownerToken: _token, ...history } = updated;
      this.insertEvent(id, "run.updated", history);
      return updated;
    });
  }

  /** Commit the supervisor's final verdict before it invokes external callbacks. */
  acceptRun(
    runId: string,
    rootTaskId: string,
    result: string,
    evidence: string[],
    expectedSteeringSeq: number,
  ): boolean {
    return this.transaction(() => {
      if (typeof result !== "string") fail("Expected a string.");
      stringArray(evidence);
      if (!Number.isSafeInteger(expectedSteeringSeq) || expectedSteeringSeq < 0) {
        fail("Invalid steering cursor.");
      }
      const run = this.getRun(runId);
      const root = this.taskInRun(runId, rootTaskId);
      if (!activeRun(run.state) || root.role !== "coordinator" ||
          root.parentId !== undefined || root.state !== "verifying") return false;
      const steeringSeq = integer(this.db.prepare(`
        SELECT COALESCE(MAX(seq), 0) AS seq FROM events
        WHERE run_id = ? AND type = 'user.steering'
      `).get(runId)!, "seq");
      if (steeringSeq !== expectedSteeringSeq) return false;
      if (this.db.prepare(`
        SELECT 1 FROM tasks WHERE run_id = ? AND role = 'worker'
          AND state NOT IN ('accepted', 'canceled') LIMIT 1
      `).get(runId)) return false;
      if (this.db.prepare(`
        SELECT 1 FROM operations WHERE run_id = ? AND state IN ('running', 'unknown') LIMIT 1
      `).get(runId)) return false;

      const at = timestamp(run.updatedAt > root.updatedAt ? run.updatedAt : root.updatedAt);
      const acceptedRoot = this.db.prepare(`
        UPDATE tasks SET state = 'accepted', result = ?, evidence = ?, updated_at = ?
        WHERE id = ? AND run_id = ? AND role = 'coordinator'
          AND parent_id IS NULL AND state = 'verifying'
      `).run(result, json(evidence), at, rootTaskId, runId);
      const acceptedRun = this.db.prepare(`
        UPDATE runs SET state = 'accepted', result = ?, updated_at = ?
        WHERE id = ? AND state IN ('running', 'verifying')
      `).run(result, at, runId);
      if (acceptedRoot.changes !== 1 || acceptedRun.changes !== 1) {
        fail("Run acceptance could not be committed.");
      }
      // Avoid public update methods: their callers may notify external code.
      // Both snapshots and both events must be durable before this call returns.
      const task = this.taskRecord(this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(rootTaskId)!);
      const { ownerToken: _token, ...history } = this.runRecord(
        this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId)!,
      );
      this.insertEvent(runId, "task.accepted", task, rootTaskId);
      this.insertEvent(runId, "run.accepted", {
        ...history, rootTaskId, evidence: task.evidence, steeringSeq,
      });
      return true;
    });
  }

  claimRun(id: string, pid: number, token: string): void {
    this.transaction(() => {
      positiveInteger(pid);
      nonempty(token);
      const run = this.getRun(id);
      if (run.ownerToken !== undefined) {
        if (run.ownerToken === token && run.ownerPid === pid) return;
        fail("Run already has an owner; release it explicitly before recovery.");
      }
      this.db.prepare(
        "UPDATE runs SET owner_pid = ?, owner_token = ?, updated_at = ? WHERE id = ?",
      ).run(pid, token, timestamp(run.updatedAt), id);
      this.insertEvent(id, "run.claimed", { ownerPid: pid });
    });
  }

  releaseRun(id: string, token: string): void {
    this.transaction(() => {
      nonempty(token);
      const run = this.getRun(id);
      if (run.ownerToken === undefined) return;
      if (run.ownerToken !== token) fail("Run ownership token does not match.");
      this.db.prepare(
        "UPDATE runs SET owner_pid = NULL, owner_token = NULL, updated_at = ? WHERE id = ?",
      ).run(timestamp(run.updatedAt), id);
      this.insertEvent(id, "run.released", {});
    });
  }

  createTask(runId: string, input: TaskInput): TaskRecord {
    return this.transaction(() => {
      const run = this.getRun(runId);
      patchKeys(input, ["objective", "parentId", "role", "dependsOn", "writePaths", "acceptance"]);
      nonempty(input.objective);
      const id = randomUUID();
      const role = input.role ?? "worker";
      if (role !== "worker" && role !== "coordinator" && role !== "reviewer") {
        fail("Invalid task role.");
      }
      if (input.parentId !== undefined) this.taskInRun(runId, input.parentId);
      const dependsOn = input.dependsOn ?? [];
      const writePaths = input.writePaths ?? [];
      const acceptance = input.acceptance ?? [];
      this.validateDependencies(runId, id, dependsOn);
      this.validatePaths(run.cwd, writePaths);
      stringArray(acceptance);
      const at = timestamp();
      this.db.prepare(`
        INSERT INTO tasks
          (id, run_id, parent_id, objective, role, state, write_paths, acceptance,
           evidence, attempt, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, '[]', 0, ?, ?)
      `).run(id, runId, input.parentId ?? null, input.objective, role,
        json(writePaths), json(acceptance), at, at);
      this.replaceDependencies(runId, id, dependsOn);
      const task = this.getTask(id);
      this.insertEvent(runId, "task.created", task, id);
      return task;
    });
  }

  getTask(id: string): TaskRecord {
    return this.snapshot(() => {
      nonempty(id);
      const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
      if (!row) fail("Task not found.");
      return this.taskRecord(row);
    });
  }

  tasks(runId: string): TaskRecord[] {
    return this.snapshot(() => {
      this.getRun(runId);
      return this.db.prepare(
        "SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at, rowid",
      ).all(runId).map((row) => this.taskRecord(row));
    });
  }

  updateTask(id: string, patch: Partial<TaskRecord>): TaskRecord {
    return this.transaction(() => {
      const task = this.getTask(id);
      const keys = patchKeys(patch, [
        "objective", "state", "dependsOn", "writePaths", "acceptance", "result", "evidence", "attempt",
      ]);
      if (keys.length === 0) return task;
      if (task.state === "accepted") fail("Accepted tasks are immutable; create a new task.");
      const next = { ...task, ...patch };
      transition(task.state, next.state, TASK_TRANSITIONS);
      if (next.state === "accepted" && task.role !== "reviewer" && task.state !== "verifying") {
        fail("Worker and coordinator tasks must be verifying before acceptance.");
      }
      nonempty(next.objective);
      optionalString(next.result);
      stringArray(next.acceptance);
      stringArray(next.evidence);
      if (!Number.isSafeInteger(next.attempt) || next.attempt < task.attempt) {
        fail("Task attempts must be nonnegative and cannot decrease.");
      }
      const run = this.getRun(task.runId);
      this.validateDependencies(task.runId, id, next.dependsOn);
      this.validatePaths(run.cwd, next.writePaths);
      if (activeTask(next.state) || next.state === "accepted") {
        if (!this.dependenciesAccepted(next.dependsOn)) fail("Task dependencies are not accepted.");
      }
      if (activeTask(next.state)) {
        if (next.state !== task.state && !activeRun(run.state)) fail("Run is not active.");
        if (this.hasPathConflict(next, run.cwd)) fail("Task write paths are already claimed.");
      }
      // A queued -> running patch receives the same checks as startTask, so
      // callers cannot bypass claims. The supervisor counts inference attempts.
      const starting = task.state === "queued" && next.state === "running";
      this.db.prepare(`
        UPDATE tasks SET objective = ?, state = ?, write_paths = ?, acceptance = ?,
          result = ?, evidence = ?, attempt = ?, updated_at = ? WHERE id = ?
      `).run(next.objective, next.state, json(next.writePaths), json(next.acceptance),
        next.result ?? null, json(next.evidence), next.attempt, timestamp(task.updatedAt), id);
      this.replaceDependencies(task.runId, id, next.dependsOn);
      const updated = this.getTask(id);
      this.insertEvent(task.runId, starting ? "task.started" : "task.updated", updated, id);
      return updated;
    });
  }

  startTask(id: string): boolean {
    return this.transaction(() => {
      const task = this.getTask(id);
      if (task.state !== "queued") return false;
      const run = this.getRun(task.runId);
      if (!activeRun(run.state) || !this.dependenciesAccepted(task.dependsOn) ||
          this.hasPathConflict(task, run.cwd)) return false;
      const changed = this.db.prepare(`
        UPDATE tasks SET state = 'running', updated_at = ?
        WHERE id = ? AND state = 'queued'
      `).run(timestamp(task.updatedAt), id);
      if (changed.changes !== 1) return false;
      this.insertEvent(task.runId, "task.started", this.getTask(id), id);
      return true;
    });
  }

  addEvent(runId: string, type: string, data: unknown, taskId?: string): EventRecord {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (type === "user.steering" && (run.state === "accepted" || run.state === "canceled")) {
        fail("Cannot steer an accepted or canceled run.");
      }
      if (taskId !== undefined) this.taskInRun(runId, taskId);
      return this.insertEvent(runId, type, data, taskId);
    });
  }

  events(runId: string, afterSeq = 0): EventRecord[] {
    return this.read(() => {
      this.getRun(runId);
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) fail("Invalid event cursor.");
      return this.db.prepare(
        "SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq",
      ).all(runId, afterSeq).map((row) => this.eventRecord(row));
    });
  }

  createOperation(runId: string, taskId: string, kind: string, input: unknown): OperationRecord {
    return this.transaction(() => {
      this.taskInRun(runId, taskId);
      nonempty(kind);
      const encoded = json(input);
      const id = randomUUID();
      const at = timestamp();
      this.db.prepare(`
        INSERT INTO operations
          (id, run_id, task_id, kind, input_hash, input, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?)
      `).run(id, runId, taskId, kind, digest(encoded), encoded, at, at);
      const operation = this.getOperation(id);
      this.insertEvent(runId, "operation.prepared", operation, taskId);
      return operation;
    });
  }

  getOperation(id: string): OperationRecord {
    return this.read(() => {
      nonempty(id);
      const row = this.db.prepare("SELECT * FROM operations WHERE id = ?").get(id);
      if (!row) fail("Operation not found.");
      return this.operationRecord(row);
    });
  }

  operations(runId: string): OperationRecord[] {
    return this.read(() => {
      this.getRun(runId);
      return this.db.prepare(
        "SELECT * FROM operations WHERE run_id = ? ORDER BY created_at, rowid",
      ).all(runId).map((row) => this.operationRecord(row));
    });
  }

  updateOperation(id: string, patch: Partial<OperationRecord>): OperationRecord {
    return this.transaction(() => {
      const operation = this.getOperation(id);
      if (patchKeys(patch, ["state", "result", "pid"]).length === 0) return operation;
      if (operation.state === "succeeded") fail("Succeeded operations are immutable and cannot replay.");
      const next = { ...operation, ...patch };
      transition(operation.state, next.state, OPERATION_TRANSITIONS);
      if (next.pid !== undefined) positiveInteger(next.pid);
      if (operation.pid !== undefined && operation.pid !== next.pid) {
        fail("Operation process identity cannot be changed.");
      }
      const result = next.result === undefined ? null : json(next.result);
      this.db.prepare(
        "UPDATE operations SET state = ?, result = ?, pid = ?, updated_at = ? WHERE id = ?",
      ).run(next.state, result, next.pid ?? null, timestamp(operation.updatedAt), id);
      const updated = this.getOperation(id);
      this.insertEvent(operation.runId, "operation.updated", updated, operation.taskId);
      return updated;
    });
  }

  addArtifact(
    runId: string, taskId: string, path: string, sha256: string, bytes: number, mediaType: string,
  ): ArtifactRecord {
    return this.transaction(() => {
      this.taskInRun(runId, taskId);
      nonempty(path);
      nonempty(mediaType);
      if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sha256)) {
        fail("Invalid artifact digest.");
      }
      if (!Number.isSafeInteger(bytes) || bytes < 0) fail("Invalid artifact size.");
      const id = randomUUID();
      this.db.prepare(`
        INSERT INTO artifacts (id, run_id, task_id, path, sha256, bytes, media_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, runId, taskId, path, sha256.toLowerCase(), bytes, mediaType, timestamp());
      const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id)!;
      const artifact = this.artifactRecord(row);
      this.insertEvent(runId, "artifact.added", artifact, taskId);
      return artifact;
    });
  }

  artifacts(runId: string, taskId?: string): ArtifactRecord[] {
    return this.read(() => {
      this.getRun(runId);
      if (taskId !== undefined) this.taskInRun(runId, taskId);
      const rows = taskId === undefined
        ? this.db.prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at, rowid").all(runId)
        : this.db.prepare(
          "SELECT * FROM artifacts WHERE run_id = ? AND task_id = ? ORDER BY created_at, rowid",
        ).all(runId, taskId);
      return rows.map((row) => this.artifactRecord(row));
    });
  }

  createApproval(runId: string, taskId: string, action: unknown): ApprovalRecord {
    return this.transaction(() => {
      this.taskInRun(runId, taskId);
      const encoded = json(action);
      const id = randomUUID();
      this.db.prepare(`
        INSERT INTO approvals (id, run_id, task_id, action_hash, action, state, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `).run(id, runId, taskId, digest(encoded), encoded, timestamp());
      const approval = this.getApproval(id);
      this.insertEvent(runId, "approval.created", approval, taskId);
      return approval;
    });
  }

  getApproval(id: string): ApprovalRecord {
    return this.read(() => {
      nonempty(id);
      const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
      if (!row) fail("Approval not found.");
      return this.approvalRecord(row);
    });
  }

  approvals(runId: string): ApprovalRecord[] {
    return this.read(() => {
      this.getRun(runId);
      return this.db.prepare(
        "SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at, rowid",
      ).all(runId).map((row) => this.approvalRecord(row));
    });
  }

  decideApproval(id: string, approved: boolean): ApprovalRecord {
    return this.transaction(() => {
      if (typeof approved !== "boolean") fail("Expected an approval decision.");
      const approval = this.getApproval(id);
      if (approval.state !== "pending") fail("Approval has already been decided.");
      const state = approved ? "approved" : "rejected";
      const changed = this.db.prepare(
        "UPDATE approvals SET state = ? WHERE id = ? AND state = 'pending'",
      ).run(state, id);
      if (changed.changes !== 1) fail("Approval has already been decided.");
      const updated = this.getApproval(id);
      this.insertEvent(approval.runId, `approval.${state}`, updated, approval.taskId);
      return updated;
    });
  }

  consumeApproval(id: string, action: unknown): ApprovalRecord {
    return this.transaction(() => {
      const approval = this.getApproval(id);
      if (approval.state !== "approved") fail("Approval is not available for consumption.");
      const actionHash = digest(json(action));
      if (actionHash !== approval.actionHash) fail("Approval action does not match.");
      const run = this.getRun(approval.runId);
      const task = this.taskInRun(approval.runId, approval.taskId);
      if (!activeRun(run.state) || !activeTask(task.state)) fail("Approval owner is not active.");
      const changed = this.db.prepare(`
        UPDATE approvals SET state = 'consumed'
        WHERE id = ? AND state = 'approved' AND action_hash = ?
      `).run(id, actionHash);
      if (changed.changes !== 1) fail("Approval is not available for consumption.");
      const updated = this.getApproval(id);
      this.insertEvent(approval.runId, "approval.consumed", updated, approval.taskId);
      return updated;
    });
  }

  private read<T>(body: () => T): T {
    if (this.closed) fail("Store is closed.");
    try {
      return body();
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw new StoreError("Store database operation failed.");
    }
  }

  private snapshot<T>(body: () => T): T {
    return this.read(() => this.db.isTransaction ? body() : this.transaction(body, "DEFERRED"));
  }

  private transaction<T>(body: () => T, mode: "IMMEDIATE" | "DEFERRED" = "IMMEDIATE"): T {
    return this.read(() => {
      this.db.exec(`BEGIN ${mode}`);
      try {
        const result = body();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original safe error. */ }
        throw error;
      }
    });
  }

  private taskInRun(runId: string, taskId: string): TaskRecord {
    this.getRun(runId);
    const task = this.getTask(taskId);
    if (task.runId !== runId) fail("Task does not belong to this run.");
    return task;
  }

  private validatePaths(cwd: string, paths: unknown): asserts paths is string[] {
    stringArray(paths);
    for (const path of paths) claimPath(cwd, path);
  }

  private validateDependencies(runId: string, id: string, dependencies: unknown): asserts dependencies is string[] {
    stringArray(dependencies);
    if (new Set(dependencies).size !== dependencies.length) fail("Duplicate task dependency.");
    const reachable = this.db.prepare(`
      WITH RECURSIVE reachable(id) AS (
        SELECT ?
        UNION
        SELECT d.dependency_id FROM task_dependencies d
          JOIN reachable r ON d.task_id = r.id WHERE d.run_id = ?
      )
      SELECT 1 FROM reachable WHERE id = ? LIMIT 1
    `);
    for (const dependency of dependencies) {
      this.taskInRun(runId, dependency);
      if (reachable.get(dependency, runId, id)) fail("Task dependencies must be acyclic.");
    }
  }

  private replaceDependencies(runId: string, id: string, dependencies: string[]): void {
    this.db.prepare("DELETE FROM task_dependencies WHERE task_id = ?").run(id);
    const insert = this.db.prepare(`
      INSERT INTO task_dependencies (task_id, run_id, dependency_id, position) VALUES (?, ?, ?, ?)
    `);
    dependencies.forEach((dependency, position) => insert.run(id, runId, dependency, position));
  }

  private dependenciesAccepted(dependencies: string[]): boolean {
    return dependencies.every((id) => this.getTask(id).state === "accepted");
  }

  private hasPathConflict(task: TaskRecord, cwd: string): boolean {
    if (task.role === "coordinator" || task.writePaths.length === 0) return false;
    const claims = task.writePaths.map((path) => claimPath(cwd, path));
    // Claims cover the filesystem, including other runs rooted in the same tree.
    // Coordinators are excluded; the broker arbitrates their writes separately.
    const rows = this.db.prepare(`
      SELECT t.write_paths, r.cwd FROM tasks t JOIN runs r ON r.id = t.run_id
      WHERE t.id <> ? AND t.role <> 'coordinator' AND t.state IN ('running', 'verifying')
    `).all(task.id);
    return rows.some((row) => {
      const paths = JSON.parse(text(row, "write_paths")) as string[];
      return paths.some((path) => {
        const other = claimPath(text(row, "cwd"), path);
        return claims.some((claim) => overlaps(claim, other));
      });
    });
  }

  private insertEvent(runId: string, type: string, data: unknown, taskId?: string): EventRecord {
    nonempty(type);
    const at = timestamp();
    const result = this.db.prepare(
      "INSERT INTO events (run_id, task_id, type, data, at) VALUES (?, ?, ?, ?, ?)",
    ).run(runId, taskId ?? null, type, json(data), at);
    const row = this.db.prepare("SELECT * FROM events WHERE seq = ?").get(result.lastInsertRowid)!;
    return this.eventRecord(row);
  }

  private runRecord(row: Row): RunRecord {
    return {
      id: text(row, "id"),
      objective: text(row, "objective"),
      cwd: text(row, "cwd"),
      state: text(row, "state") as RunState,
      ...(row.result === null ? {} : { result: text(row, "result") }),
      ...(row.owner_pid === null ? {} : { ownerPid: integer(row, "owner_pid") }),
      ...(row.owner_token === null ? {} : { ownerToken: text(row, "owner_token") }),
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
    };
  }

  private taskRecord(row: Row): TaskRecord {
    return {
      id: text(row, "id"),
      runId: text(row, "run_id"),
      ...(row.parent_id === null ? {} : { parentId: text(row, "parent_id") }),
      objective: text(row, "objective"),
      role: text(row, "role") as TaskRecord["role"],
      state: text(row, "state") as TaskState,
      dependsOn: this.db.prepare(
        "SELECT dependency_id FROM task_dependencies WHERE task_id = ? ORDER BY position",
      ).all(text(row, "id")).map((dependency) => text(dependency, "dependency_id")),
      writePaths: JSON.parse(text(row, "write_paths")) as string[],
      acceptance: JSON.parse(text(row, "acceptance")) as string[],
      evidence: JSON.parse(text(row, "evidence")) as string[],
      ...(row.result === null ? {} : { result: text(row, "result") }),
      attempt: integer(row, "attempt"),
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
    };
  }

  private operationRecord(row: Row): OperationRecord {
    return {
      id: text(row, "id"),
      runId: text(row, "run_id"),
      taskId: text(row, "task_id"),
      kind: text(row, "kind"),
      inputHash: text(row, "input_hash"),
      input: JSON.parse(text(row, "input")) as unknown,
      state: text(row, "state") as OperationState,
      ...(row.result === null ? {} : { result: JSON.parse(text(row, "result")) as unknown }),
      ...(row.pid === null ? {} : { pid: integer(row, "pid") }),
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
    };
  }

  private artifactRecord(row: Row): ArtifactRecord {
    return {
      id: text(row, "id"),
      runId: text(row, "run_id"),
      taskId: text(row, "task_id"),
      path: text(row, "path"),
      sha256: text(row, "sha256"),
      bytes: integer(row, "bytes"),
      mediaType: text(row, "media_type"),
      createdAt: text(row, "created_at"),
    };
  }

  private eventRecord(row: Row): EventRecord {
    return {
      seq: integer(row, "seq"),
      runId: text(row, "run_id"),
      ...(row.task_id === null ? {} : { taskId: text(row, "task_id") }),
      type: text(row, "type"),
      data: JSON.parse(text(row, "data")) as unknown,
      at: text(row, "at"),
    };
  }

  private approvalRecord(row: Row): ApprovalRecord {
    return {
      id: text(row, "id"),
      runId: text(row, "run_id"),
      taskId: text(row, "task_id"),
      actionHash: text(row, "action_hash"),
      action: JSON.parse(text(row, "action")) as unknown,
      state: text(row, "state") as ApprovalRecord["state"],
      createdAt: text(row, "created_at"),
    };
  }
}
