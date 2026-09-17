import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import type { OperationRecord, RunRecord, TaskRecord, TaskState } from "../src/contracts.js";
import { Store } from "../src/store.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "workbench-store-test-"));
  const cwd = join(root, "project");
  const stateDir = join(root, "state");
  mkdirSync(cwd);
  const stores: Store[] = [];
  const open = () => {
    const store = new Store(stateDir);
    stores.push(store);
    return store;
  };
  t.after(() => {
    for (const store of stores) store.close();
    // Only remove this fixture's exact, checked temporary directory.
    const target = resolve(root);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("workbench-store-test-"));
    rmSync(target, { recursive: true, force: true });
  });
  const store = open();
  const run = store.createRun("Complete the assignment", cwd);
  return { root, cwd, stateDir, dbPath: join(stateDir, "workbench.sqlite"), store, run, open };
}

test("SQLite state remains usable beyond traditional Windows path length", (t) => {
  const f = fixture(t);
  const directory = join(f.root, ...Array.from({ length: 7 }, (_, index) => `long-state-${index}-${"x".repeat(34)}`));
  assert.ok(directory.length > 260);
  const first = new Store(directory);
  const run = first.createRun("Retain long-path state.", f.cwd);
  first.close();
  const reopened = new Store(directory);
  try { assert.equal(reopened.getRun(run.id).objective, "Retain long-path state."); }
  finally { reopened.close(); }
});

function accept(store: Store, id: string): TaskRecord {
  if (store.getTask(id).state === "queued") assert.equal(store.startTask(id), true);
  store.updateTask(id, { state: "verifying" });
  return store.updateTask(id, { state: "accepted", result: "Verified", evidence: ["test receipt"] });
}

function verifyingRoot(store: Store, runId: string): TaskRecord {
  const root = store.createTask(runId, { objective: "Finalize the run", role: "coordinator", writePaths: ["."] });
  assert.equal(store.startTask(root.id), true);
  return store.updateTask(root.id, {
    state: "verifying", result: "Candidate", evidence: ["candidate receipt"], attempt: 1,
  });
}

function runSnapshot(store: Store, runId: string) {
  return {
    run: store.getRun(runId), tasks: store.tasks(runId),
    operations: store.operations(runId), events: store.events(runId),
  };
}

type RaceResult = { ok: boolean; value?: unknown; message?: string };
type RaceAction = "start" | "claim" | "consume" | "accept" | "steer";

async function race(
  stateDir: string,
  action: RaceAction | [RaceAction, RaceAction],
  id: string | [string, string],
  value?: unknown,
): Promise<RaceResult[]> {
  const code = `
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { Store } = await import(workerData.module);
      const store = new Store(workerData.stateDir);
      parentPort.once("message", () => {
        let result;
        try {
          let value;
          if (workerData.action === "start") value = store.startTask(workerData.id);
          if (workerData.action === "claim")
            value = store.claimRun(workerData.id, process.pid, workerData.token);
          if (workerData.action === "consume")
            value = store.consumeApproval(workerData.id, workerData.value).state;
          if (workerData.action === "accept")
            value = store.acceptRun(workerData.id, workerData.value.rootTaskId,
              workerData.value.result, workerData.value.evidence, workerData.value.expectedSteeringSeq);
          if (workerData.action === "steer")
            value = store.addEvent(workerData.id, "user.steering", { instruction: "New requirement" }).seq;
          result = { ok: true, value };
        } catch (error) { result = { ok: false, message: error.message }; }
        finally { store.close(); }
        parentPort.postMessage(result);
        parentPort.close();
      });
      parentPort.postMessage("ready");
    })().catch(error => { throw error; });
  `;
  const workers = [0, 1].map((index) => new Worker(code, {
    eval: true,
    workerData: {
      module: new URL("../src/store.ts", import.meta.url).href,
      stateDir, action: typeof action === "string" ? action : action[index],
      id: typeof id === "string" ? id : id[index], value, token: `owner-${index}`,
    },
  }));
  try {
    const ready = await Promise.all(workers.map((worker) => once(worker, "message")));
    assert.deepEqual(ready, [["ready"], ["ready"]]);
    const results = workers.map((worker) => once(worker, "message"));
    for (const worker of workers) worker.postMessage("go");
    return (await Promise.all(results)).map(([result]) => result as RaceResult);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

test("records, ownership, approvals and ordered history survive close and reopen", (t) => {
  const f = fixture(t);
  const { store, run } = f;
  store.claimRun(run.id, process.pid, "private-owner-token");
  const root = store.createTask(run.id, { objective: "Coordinate", role: "coordinator", writePaths: ["."] });
  assert.equal(store.startTask(root.id), true);
  const prerequisite = store.createTask(run.id, { objective: "Prepare input", writePaths: ["input"] });
  accept(store, prerequisite.id);
  const task = store.createTask(run.id, {
    objective: "Produce résumé", parentId: root.id, dependsOn: [prerequisite.id],
    writePaths: ["output"], acceptance: ["Actual evidence"],
  });
  assert.equal(store.startTask(task.id), true);
  store.updateTask(task.id, { attempt: 1, result: "Candidate", evidence: ["retained receipt"] });
  const input = { z: [1, { enabled: true }], a: "café" };
  const operation = store.createOperation(run.id, task.id, "write", input);
  store.updateOperation(operation.id, { state: "running", pid: process.pid });
  const finished = store.updateOperation(operation.id, { state: "succeeded", result: { bytes: 6 } });
  const artifactPath = join(f.cwd, "result.txt");
  const body = "résumé";
  writeFileSync(artifactPath, body, "utf8");
  const artifact = store.addArtifact(
    run.id, task.id, artifactPath, createHash("sha256").update(body).digest("hex"),
    Buffer.byteLength(body), "text/plain",
  );
  const action = { kind: "publish", destination: "private", artifact: artifact.id };
  const approval = store.createApproval(run.id, task.id, action);
  store.decideApproval(approval.id, true);
  const event = store.addEvent(run.id, "test.checkpoint", { ready: true }, task.id);
  const before = {
    run: store.getRun(run.id), tasks: store.tasks(run.id), events: store.events(run.id),
    approvals: store.approvals(run.id), artifacts: store.artifacts(run.id),
  };
  store.close();
  store.close();
  const reopened = f.open();
  assert.deepEqual(reopened.getRun(run.id), before.run);
  assert.deepEqual(reopened.tasks(run.id), before.tasks);
  assert.deepEqual(reopened.getOperation(operation.id), finished);
  assert.deepEqual(reopened.approvals(run.id), before.approvals);
  assert.deepEqual(reopened.artifacts(run.id, task.id), before.artifacts);
  assert.deepEqual(reopened.events(run.id), before.events);
  assert.equal(reopened.consumeApproval(approval.id, action).state, "consumed");
  const resumed = reopened.addEvent(run.id, "test.resumed", null);
  assert.ok(resumed.seq > event.seq);
  assert.deepEqual(reopened.events(run.id, event.seq).map((item) => item.type),
    ["approval.consumed", "test.resumed"]);
  assert.equal(new Set(reopened.events(run.id).map((item) => item.seq)).size, before.events.length + 2);
  assert.ok(!JSON.stringify(reopened.events(run.id)).includes("private-owner-token"));
});

test("run claims require the exact owner even for the same PID or an apparently dead PID", (t) => {
  const { store, run, open } = fixture(t);
  const second = open();
  store.claimRun(run.id, 2_147_483_647, "old-owner");
  const events = store.events(run.id).length;
  second.claimRun(run.id, 2_147_483_647, "old-owner");
  assert.equal(store.events(run.id).length, events);
  assert.throws(() => second.claimRun(run.id, process.pid, "new-owner"), /already has an owner/);
  assert.throws(() => second.claimRun(run.id, 2_147_483_647, "new-owner"), /already has an owner/);
  assert.throws(() => second.claimRun(run.id, process.pid, "old-owner"), /already has an owner/);
  assert.throws(() => second.releaseRun(run.id, "wrong-owner"), /does not match/);
  store.close();
  assert.throws(() => second.claimRun(run.id, process.pid, "new-owner"), /already has an owner/);
  second.releaseRun(run.id, "old-owner");
  second.claimRun(run.id, process.pid, "new-owner");
  assert.equal(second.getRun(run.id).ownerToken, "new-owner");
  second.releaseRun(run.id, "new-owner");
  assert.equal(second.getRun(run.id).ownerPid, undefined);
  assert.equal(second.getRun(run.id).ownerToken, undefined);
  const releasedEvents = second.events(run.id).length;
  second.releaseRun(run.id, "new-owner");
  assert.equal(second.events(run.id).length, releasedEvents);
});

test("simultaneous run claims from independent SQLite connections have one winner", async (t) => {
  const { stateDir, store, run } = fixture(t);
  const results = await race(stateDir, "claim", run.id);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => /already has an owner/.test(result.message ?? "")).length, 1);
  assert.equal(store.events(run.id).filter((event) => event.type === "run.claimed").length, 1);
});

test("simultaneous task starts have one winner and one committed start event", async (t) => {
  const { stateDir, store, run } = fixture(t);
  const task = store.createTask(run.id, { objective: "Own a file", writePaths: ["one.txt"] });
  const results = await race(stateDir, "start", task.id);
  assert.ok(results.every((result) => result.ok));
  assert.deepEqual(results.map((result) => result.value).sort(), [false, true]);
  assert.equal(store.getTask(task.id).state, "running");
  assert.equal(store.events(run.id).filter((event) => event.type === "task.started").length, 1);
});

test("simultaneous starts of different tasks cannot both acquire overlapping paths", async (t) => {
  const { stateDir, store, run } = fixture(t);
  const first = store.createTask(run.id, { objective: "Directory owner", writePaths: ["shared"] });
  const second = store.createTask(run.id, { objective: "File owner", writePaths: ["shared/result.txt"] });
  const results = await race(stateDir, "start", [first.id, second.id]);
  assert.ok(results.every((result) => result.ok));
  assert.deepEqual(results.map((result) => result.value).sort(), [false, true]);
  assert.equal(store.tasks(run.id).filter((task) => task.state === "running").length, 1);
  assert.equal(store.events(run.id).filter((event) => event.type === "task.started").length, 1);
});

test("busy timeout waits for a competing writer to release its transaction", async (t) => {
  const { dbPath, store, run } = fixture(t);
  const task = store.createTask(run.id, { objective: "Start after the writer commits" });
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync(workerData);
    database.exec("BEGIN IMMEDIATE");
    parentPort.postMessage("locked");
    setTimeout(() => {
      database.exec("COMMIT");
      database.close();
      parentPort.close();
    }, 150);
  `, { eval: true, workerData: dbPath });
  try {
    assert.deepEqual(await once(worker, "message"), ["locked"]);
    assert.equal(store.startTask(task.id), true);
  } finally {
    await worker.terminate();
  }
});

test("dependencies must be accepted, belong to the run, and remain acyclic on edits", (t) => {
  const { store, run, cwd } = fixture(t);
  const first = store.createTask(run.id, { objective: "First" });
  const second = store.createTask(run.id, { objective: "Second", dependsOn: [first.id] });
  const third = store.createTask(run.id, { objective: "Third", dependsOn: [second.id] });
  const otherRun = store.createRun("Other", cwd);
  const foreign = store.createTask(otherRun.id, { objective: "Foreign" });
  const before = store.events(run.id);
  assert.equal(store.startTask(second.id), false);
  assert.throws(() => store.updateTask(second.id, { state: "running" }), /dependencies/);
  assert.throws(() => store.updateTask(first.id, { dependsOn: [third.id] }), /acyclic/);
  assert.throws(() => store.updateTask(first.id, { dependsOn: [first.id] }), /acyclic/);
  assert.throws(() => store.createTask(run.id, { objective: "Bad", dependsOn: [foreign.id] }), /belong/);
  assert.throws(() => store.createTask(run.id, { objective: "Bad", parentId: foreign.id }), /belong/);
  assert.throws(() => store.createTask(run.id, { objective: "Bad", dependsOn: ["missing"] }), /not found/);
  assert.throws(() => store.createTask(run.id, { objective: "Bad", parentId: "missing" }), /not found/);
  assert.throws(() => store.updateTask(second.id, { dependsOn: [first.id, first.id] }), /Duplicate/);
  assert.throws(() => store.updateTask(second.id, { dependsOn: [foreign.id] }), /belong/);
  assert.deepEqual(store.getTask(first.id).dependsOn, []);
  assert.deepEqual(store.events(run.id), before);
  accept(store, first.id);
  assert.equal(store.startTask(second.id), true);
  assert.equal(store.startTask(third.id), false);
  store.updateTask(second.id, { state: "failed" });
  assert.equal(store.startTask(third.id), false);
  store.updateTask(second.id, { state: "queued" });
  accept(store, second.id);
  assert.equal(store.startTask(third.id), true);
});

test("path claims cover descendants, normalized aliases and verification without prefix false positives", (t) => {
  const { store, run, open } = fixture(t);
  const second = open();
  const root = store.createTask(run.id, { objective: "Coordinator", role: "coordinator", writePaths: ["."] });
  const owner = store.createTask(run.id, { objective: "Source", writePaths: ["src"] });
  const nested = store.createTask(run.id, { objective: "Nested", writePaths: ["src/lib/file.ts"] });
  const alias = store.createTask(run.id, { objective: "Alias", writePaths: ["docs/../src/"] });
  const sibling = store.createTask(run.id, { objective: "Sibling", writePaths: ["src-other"] });
  assert.equal(store.startTask(root.id), true);
  assert.equal(store.startTask(owner.id), true);
  assert.equal(second.startTask(nested.id), false);
  assert.equal(second.startTask(alias.id), false);
  assert.equal(second.startTask(sibling.id), true);
  store.updateTask(owner.id, { state: "verifying" });
  assert.equal(second.startTask(nested.id), false);
  accept(store, owner.id);
  assert.equal(second.startTask(nested.id), true);
  assert.equal(second.startTask(alias.id), false);
  assert.equal(store.startTask(root.id), false);
});

test("reviewer claims conflict, and waiting work must reclaim its paths on resuming", (t) => {
  const { store, run } = fixture(t);
  const author = store.createTask(run.id, { objective: "Author", writePaths: ["report.md"] });
  const reviewer = store.createTask(run.id, { objective: "Verifier", role: "reviewer", writePaths: ["report.md"] });
  assert.equal(store.startTask(author.id), true);
  assert.equal(store.startTask(reviewer.id), false);
  store.updateTask(author.id, { state: "waiting" });
  assert.equal(store.startTask(reviewer.id), true);
  store.updateTask(reviewer.id, { state: "verifying" });
  assert.throws(() => store.updateTask(author.id, { state: "verifying" }), /claimed/);
  accept(store, reviewer.id);
  assert.equal(store.updateTask(author.id, { state: "verifying" }).state, "verifying");
  // A failed review can return to repair while retaining the path claim.
  assert.equal(store.updateTask(author.id, { state: "running" }).state, "running");
});

test("claim edits and queued-to-running updates cannot bypass conflict checks", (t) => {
  const { store, run } = fixture(t);
  const first = store.createTask(run.id, { objective: "One", writePaths: ["one"] });
  const second = store.createTask(run.id, { objective: "Two", writePaths: ["two"] });
  const blocked = store.createTask(run.id, { objective: "Blocked", writePaths: ["one/file"] });
  const dependency = store.createTask(run.id, { objective: "Unaccepted" });
  store.startTask(first.id);
  store.startTask(second.id);
  const before = store.events(run.id);
  assert.throws(() => store.updateTask(blocked.id, { state: "running" }), /claimed/);
  assert.throws(() => store.updateTask(second.id, { writePaths: ["."] }), /claimed/);
  assert.throws(() => store.updateTask(second.id, { dependsOn: [dependency.id] }), /dependencies/);
  assert.deepEqual(store.getTask(second.id).writePaths, ["two"]);
  assert.deepEqual(store.getTask(second.id).dependsOn, []);
  assert.deepEqual(store.events(run.id), before);
  store.updateRun(run.id, { state: "paused" });
  assert.equal(store.startTask(dependency.id), false);
  assert.throws(() => store.updateTask(dependency.id, { state: "running" }), /not active/);
  store.updateRun(run.id, { state: "running" });
  assert.equal(store.updateTask(dependency.id, { state: "running" }).state, "running");
});

test("claims use absolute paths across runs sharing a directory tree", (t) => {
  const { store, run, cwd, root } = fixture(t);
  const owner = store.createTask(run.id, { objective: "Own", writePaths: ["shared"] });
  store.startTask(owner.id);
  const nestedRun = store.createRun("Nested project", join(cwd, "shared"));
  const conflict = store.createTask(nestedRun.id, { objective: "Conflict", writePaths: ["file.txt"] });
  assert.equal(store.startTask(conflict.id), false);
  const independentRun = store.createRun("Independent project", join(root, "other"));
  const independent = store.createTask(independentRun.id, { objective: "Independent", writePaths: ["shared"] });
  assert.equal(store.startTask(independent.id), true);
  assert.throws(() => store.createTask(run.id, { objective: "Escape", writePaths: ["../outside"] }), /inside/);
  assert.throws(() => store.createTask(run.id, { objective: "Escape", writePaths: [join(root, "outside")] }), /inside/);
});

test("existing symlink or junction aliases cannot evade ownership or escape the run", (t) => {
  const { store, run, cwd, root } = fixture(t);
  const target = join(cwd, "target");
  mkdirSync(target);
  symlinkSync(target, join(cwd, "alias"), process.platform === "win32" ? "junction" : "dir");
  const first = store.createTask(run.id, { objective: "Real path", writePaths: ["target"] });
  const second = store.createTask(run.id, { objective: "Alias path", writePaths: ["alias/new.txt"] });
  store.startTask(first.id);
  assert.equal(store.startTask(second.id), false);
  const outside = join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(cwd, "escape"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => store.createTask(run.id, { objective: "Escape", writePaths: ["escape/new.txt"] }), /inside/);
});

test("Windows path claims are case insensitive and accept both directory separators",
  { skip: process.platform !== "win32" }, (t) => {
    const { store, run } = fixture(t);
    const first = store.createTask(run.id, { objective: "One", writePaths: ["Source\\Part"] });
    const second = store.createTask(run.id, { objective: "Two", writePaths: ["source/part/file.ts"] });
    assert.equal(store.startTask(first.id), true);
    assert.equal(store.startTask(second.id), false);
  });

test("accepted tasks are immutable; new tasks can depend on their frozen evidence", (t) => {
  const { store, run } = fixture(t);
  const task = store.createTask(run.id, { objective: "Candidate", acceptance: ["Independent review"] });
  assert.throws(() => store.updateTask(task.id, { state: "accepted" }), /transition/);
  store.startTask(task.id);
  assert.throws(() => store.updateTask(task.id, { state: "accepted" }), /must be verifying/);
  store.updateTask(task.id, { attempt: 1 });
  assert.throws(() => store.updateTask(task.id, { attempt: 0 }), /cannot decrease/);
  assert.throws(() => store.updateTask(task.id, { attempt: -1 }), /nonnegative/);
  const accepted = accept(store, task.id);
  const before = store.events(run.id);
  const edits: Partial<TaskRecord>[] = [
    { state: "queued" }, { state: "running" }, { state: "failed" }, { state: "accepted" },
    { objective: "Replacement" }, { acceptance: [] }, { writePaths: ["new"] },
    { dependsOn: [] }, { result: "Replacement" }, { evidence: [] }, { attempt: 2 },
  ];
  for (const edit of edits) assert.throws(() => store.updateTask(task.id, edit), /immutable/);
  assert.equal(store.startTask(task.id), false);
  assert.deepEqual(store.getTask(task.id), accepted);
  assert.deepEqual(store.events(run.id), before);
  const followup = store.createTask(run.id, { objective: "Follow-up", dependsOn: [task.id] });
  assert.equal(store.startTask(followup.id), true);
});

test("supervisor transitions support repair, direct reviewer verdicts and explicit resume", (t) => {
  const { store, run, cwd } = fixture(t);
  const author = store.createTask(run.id, { objective: "Repair then accept" });
  assert.equal(store.startTask(author.id), true);
  assert.equal(store.getTask(author.id).attempt, 0);
  store.updateTask(author.id, { attempt: 1, state: "verifying" });
  store.updateTask(author.id, { state: "running" });
  store.updateTask(author.id, { attempt: 2, state: "verifying" });
  assert.equal(store.updateTask(author.id, { state: "accepted" }).attempt, 2);
  for (const state of ["accepted", "failed"] as const) {
    const reviewer = store.createTask(run.id, { objective: "Independent verdict", role: "reviewer" });
    assert.equal(store.startTask(reviewer.id), true);
    assert.equal(store.updateTask(reviewer.id, { state }).state, state);
  }
  for (const state of ["running", "waiting", "verifying", "blocked", "failed"] as const) {
    const task = store.createTask(run.id, { objective: "Interrupted task" });
    store.startTask(task.id);
    store.updateTask(task.id, { state, attempt: 1 });
    assert.equal(store.updateTask(task.id, { state: "queued" }).attempt, 1);
    assert.equal(store.startTask(task.id), true);
    assert.equal(store.updateTask(task.id, { attempt: 2 }).attempt, 2);
  }
  for (const state of ["paused", "blocked", "failed"] as const) {
    const resumed = store.createRun("Explicit execute", cwd);
    store.updateRun(resumed.id, { state });
    assert.equal(store.updateRun(resumed.id, { state: "running" }).state, "running");
  }
});

test("identities and ownership cannot be rewritten through update patches", (t) => {
  const { store, run } = fixture(t);
  store.claimRun(run.id, process.pid, "owner");
  const task = store.createTask(run.id, { objective: "Original", role: "worker" });
  const operation = store.createOperation(run.id, task.id, "effect", { version: 1 });
  const runEdits: Partial<RunRecord>[] = [
    { id: "other" }, { objective: "other" }, { cwd: "other" }, { createdAt: "other" },
    { updatedAt: "other" }, { ownerPid: 1 }, { ownerToken: "other" },
  ];
  const taskEdits: Partial<TaskRecord>[] = [
    { id: "other" }, { runId: "other" }, { parentId: "other" }, { role: "coordinator" },
    { createdAt: "other" }, { updatedAt: "other" },
  ];
  const operationEdits: Partial<OperationRecord>[] = [
    { id: "other" }, { runId: "other" }, { taskId: "other" }, { kind: "other" },
    { input: { version: 2 } }, { inputHash: "other" }, { createdAt: "other" }, { updatedAt: "other" },
  ];
  const before = store.events(run.id);
  for (const edit of runEdits) assert.throws(() => store.updateRun(run.id, edit), /Immutable/);
  for (const edit of taskEdits) assert.throws(() => store.updateTask(task.id, edit), /Immutable/);
  for (const edit of operationEdits) assert.throws(() => store.updateOperation(operation.id, edit), /Immutable/);
  assert.deepEqual(store.getTask(task.id), task);
  assert.deepEqual(store.getOperation(operation.id), operation);
  assert.deepEqual(store.events(run.id), before);
  // Returned arrays/objects do not alias durable state.
  task.writePaths.push("mutated");
  (operation.input as { version: number }).version = 2;
  assert.deepEqual(store.getTask(task.id).writePaths, []);
  assert.deepEqual(store.getOperation(operation.id).input, { version: 1 });
  store.updateRun(run.id, { state: "accepted", result: "Supervisor accepted" });
  assert.throws(() => store.updateRun(run.id, { state: "running" }), /transition/);
});

test("all missing IDs and mismatched run/task relationships fail without inserting history", (t) => {
  const { store, run, cwd } = fixture(t);
  const other = store.createRun("Other", cwd);
  const task = store.createTask(other.id, { objective: "Other task" });
  const before = store.events(run.id);
  const missing = [
    () => store.getRun("missing"), () => store.updateRun("missing", { state: "paused" }),
    () => store.claimRun("missing", process.pid, "token"), () => store.releaseRun("missing", "token"),
    () => store.getTask("missing"), () => store.updateTask("missing", { state: "running" }),
    () => store.startTask("missing"), () => store.createTask("missing", { objective: "Task" }),
    () => store.tasks("missing"), () => store.events("missing"), () => store.operations("missing"),
    () => store.artifacts("missing"), () => store.approvals("missing"),
    () => store.getOperation("missing"), () => store.updateOperation("missing", { state: "running" }),
    () => store.getApproval("missing"), () => store.decideApproval("missing", true),
    () => store.consumeApproval("missing", {}),
    () => store.addEvent(run.id, "bad", {}, "missing"),
    () => store.createOperation(run.id, "missing", "effect", {}),
    () => store.createApproval(run.id, "missing", {}),
    () => store.addArtifact(run.id, "missing", "a", "a".repeat(64), 1, "text/plain"),
    () => store.artifacts(run.id, "missing"),
  ];
  for (const action of missing) assert.throws(action, /not found/);
  const mismatched = [
    () => store.addEvent(run.id, "bad", {}, task.id),
    () => store.createOperation(run.id, task.id, "effect", {}),
    () => store.createApproval(run.id, task.id, {}),
    () => store.addArtifact(run.id, task.id, "a", "a".repeat(64), 1, "text/plain"),
    () => store.artifacts(run.id, task.id),
  ];
  for (const action of mismatched) assert.throws(action, /belong/);
  assert.deepEqual(store.events(run.id), before);
  assert.deepEqual(store.operations(run.id), []);
  assert.deepEqual(store.approvals(run.id), []);
  assert.deepEqual(store.artifacts(run.id), []);
});

test("canonical hashes ignore recursive key order, preserve arrays, and assign new operation IDs", (t) => {
  const { store, run } = fixture(t);
  const task = store.createTask(run.id, { objective: "Hash input" });
  const input = { z: [{ b: 2, a: 1 }, false], a: { y: null, x: "value" } };
  const equivalent = { a: { x: "value", y: null }, z: [{ a: 1, b: 2 }, false] };
  const first = store.createOperation(run.id, task.id, "effect", input);
  const second = store.createOperation(run.id, task.id, "effect", equivalent);
  assert.notEqual(first.id, second.id);
  assert.equal(first.inputHash, second.inputHash);
  assert.equal(first.inputHash, createHash("sha256").update(
    '{"a":{"x":"value","y":null},"z":[{"a":1,"b":2},false]}',
  ).digest("hex"));
  const reordered = store.createOperation(run.id, task.id, "effect", {
    ...equivalent, z: [false, { a: 1, b: 2 }],
  });
  assert.notEqual(reordered.inputHash, first.inputHash);
  const approval = store.createApproval(run.id, task.id, equivalent);
  assert.equal(approval.actionHash, first.inputHash);
  const special = JSON.parse('{"__proto__":{"allowed":false},"constructor":"literal"}') as unknown;
  assert.deepEqual(store.createOperation(run.id, task.id, "effect", special).input, special);
});

test("non-JSON actions cannot lose distinguishing values or leak credentials in errors", (t) => {
  const { store, run } = fixture(t);
  const task = store.createTask(run.id, { objective: "Validate exact action" });
  const secret = "credential=do-not-expose";
  const cyclic: Record<string, unknown> = { secret };
  cyclic.self = cyclic;
  const getter = Object.defineProperty({}, "token", {
    enumerable: true, get() { throw new Error(secret); },
  });
  const invalid: unknown[] = [
    undefined, { secret, value: undefined }, { secret, value: Number.NaN },
    { secret, value: Infinity }, { secret, value: 1n }, { secret, value() {} },
    cyclic, getter, [, "sparse"], { [Symbol(secret)]: "value" },
  ];
  const before = store.events(run.id);
  for (const value of invalid) {
    assert.throws(() => store.createOperation(run.id, task.id, "effect", value), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(secret));
      return true;
    });
    assert.throws(() => store.createApproval(run.id, task.id, value));
  }
  assert.throws(() => store.getTask(secret), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(secret));
    return true;
  });
  assert.deepEqual(store.events(run.id), before);
  assert.deepEqual(store.operations(run.id), []);
  assert.deepEqual(store.approvals(run.id), []);
});

test("succeeded operations cannot be replayed or edited after restart", (t) => {
  const f = fixture(t);
  const { store, run } = f;
  const task = store.createTask(run.id, { objective: "Effect" });
  const operation = store.createOperation(run.id, task.id, "effect", { command: "once" });
  assert.throws(() => store.updateOperation(operation.id, { state: "succeeded" }), /transition/);
  store.updateOperation(operation.id, { state: "running", pid: process.pid });
  assert.throws(() => store.updateOperation(operation.id, { state: "prepared" }), /transition/);
  assert.throws(() => store.updateOperation(operation.id, { pid: process.pid + 1 }), /identity/);
  const finished = store.updateOperation(operation.id, { state: "succeeded", result: { receipt: "proof" } });
  const before = store.events(run.id);
  store.close();
  const reopened = f.open();
  const edits: Partial<OperationRecord>[] = [
    { state: "prepared" }, { state: "running" }, { state: "failed" },
    { state: "unknown" }, { state: "succeeded" }, { result: "replacement" },
  ];
  for (const edit of edits) assert.throws(() => reopened.updateOperation(operation.id, edit), /cannot replay/);
  assert.deepEqual(reopened.getOperation(operation.id), finished);
  assert.deepEqual(reopened.events(run.id), before);
  assert.equal(reopened.operations(run.id).length, 1);
});

test("unknown effects can be reconciled but cannot run again; failed effects need a new ID", (t) => {
  const { store, run } = fixture(t);
  const task = store.createTask(run.id, { objective: "Reconcile" });
  const unknown = store.createOperation(run.id, task.id, "effect", {});
  store.updateOperation(unknown.id, { state: "running" });
  store.updateOperation(unknown.id, { state: "unknown", result: { lostTerminal: true } });
  assert.throws(() => store.updateOperation(unknown.id, { state: "running" }), /transition/);
  assert.throws(() => store.updateOperation(unknown.id, { state: "prepared" }), /transition/);
  assert.equal(store.updateOperation(unknown.id, { state: "succeeded", result: { reconciled: true } }).state, "succeeded");
  const failed = store.createOperation(run.id, task.id, "effect", {});
  store.updateOperation(failed.id, { state: "failed" });
  assert.throws(() => store.updateOperation(failed.id, { state: "running" }), /transition/);
  assert.throws(() => store.updateOperation(failed.id, { state: "prepared" }), /transition/);
  assert.throws(() => store.updateOperation(failed.id, { state: "succeeded" }), /transition/);
  assert.notEqual(store.createOperation(run.id, task.id, "effect", {}).id, failed.id);
});

test("approval consumption requires the exact approved action and refuses reuse across stores", (t) => {
  const { store, run, open } = fixture(t);
  const task = store.createTask(run.id, { objective: "Publish" });
  store.startTask(task.id);
  const action = { destination: "private", artifact: { id: "one", hash: "original" } };
  const approval = store.createApproval(run.id, task.id, action);
  assert.throws(() => store.consumeApproval(approval.id, action), /not available/);
  store.decideApproval(approval.id, true);
  assert.throws(() => store.decideApproval(approval.id, true), /already been decided/);
  assert.throws(() => store.decideApproval(approval.id, false), /already been decided/);
  const before = store.events(run.id);
  assert.throws(() => store.consumeApproval(approval.id, {
    ...action, artifact: { id: "one", hash: "changed" },
  }), /does not match/);
  assert.equal(store.getApproval(approval.id).state, "approved");
  assert.deepEqual(store.events(run.id), before);
  assert.equal(store.consumeApproval(approval.id, {
    artifact: { hash: "original", id: "one" }, destination: "private",
  }).state, "consumed");
  assert.throws(() => open().consumeApproval(approval.id, action), /not available/);
  assert.throws(() => store.decideApproval(approval.id, true), /already been decided/);
  const rejected = store.createApproval(run.id, task.id, action);
  assert.equal(store.decideApproval(rejected.id, false).state, "rejected");
  assert.throws(() => store.consumeApproval(rejected.id, action), /not available/);
  assert.throws(() => store.decideApproval(rejected.id, true), /already been decided/);
});

test("simultaneous approval consumers commit exactly one consumption and history entry", async (t) => {
  const { store, run, stateDir } = fixture(t);
  const task = store.createTask(run.id, { objective: "One approved effect" });
  store.startTask(task.id);
  const action = { effect: "publish-once" };
  const approval = store.createApproval(run.id, task.id, action);
  store.decideApproval(approval.id, true);
  const results = await race(stateDir, "consume", approval.id, action);
  assert.equal(results.filter((result) => result.ok && result.value === "consumed").length, 1);
  assert.equal(results.filter((result) => !result.ok && /not available/.test(result.message ?? "")).length, 1);
  assert.equal(store.events(run.id).filter((event) => event.type === "approval.consumed").length, 1);
});

test("approvals cannot be consumed by inactive owning runs or tasks", (t) => {
  const { store, cwd } = fixture(t);
  for (const state of ["paused", "blocked", "failed", "accepted", "canceled"] as const) {
    const run = store.createRun("Run owner state", cwd);
    const task = store.createTask(run.id, { objective: "Effect owner" });
    store.startTask(task.id);
    const approval = store.createApproval(run.id, task.id, {});
    store.decideApproval(approval.id, true);
    store.updateRun(run.id, { state });
    assert.throws(() => store.consumeApproval(approval.id, {}), /owner is not active/);
    assert.equal(store.getApproval(approval.id).state, "approved");
  }
  for (const state of ["queued", "waiting", "blocked", "failed", "accepted", "canceled"] satisfies TaskState[]) {
    const run = store.createRun("Task owner state", cwd);
    const task = store.createTask(run.id, { objective: "Effect owner" });
    store.startTask(task.id);
    const approval = store.createApproval(run.id, task.id, {});
    store.decideApproval(approval.id, true);
    if (state === "accepted") store.updateTask(task.id, { state: "verifying" });
    store.updateTask(task.id, { state });
    assert.throws(() => store.consumeApproval(approval.id, {}), /owner is not active/);
    assert.equal(store.getApproval(approval.id).state, "approved");
  }
});

test("record creation and graph edits roll back when event persistence fails", (t) => {
  const { store, run, dbPath } = fixture(t);
  const inspector = new DatabaseSync(dbPath);
  try {
    const first = store.createTask(run.id, { objective: "One" });
    const second = store.createTask(run.id, { objective: "Two" });
    const before = store.events(run.id);
    inspector.exec(`
      CREATE TRIGGER reject_history BEFORE INSERT ON events
      WHEN NEW.type IN ('task.created', 'task.updated', 'run.updated', 'operation.prepared', 'artifact.added')
      BEGIN SELECT RAISE(ABORT, 'credential=hidden-trigger-value'); END;
    `);
    const mutations = [
      () => store.createTask(run.id, { objective: "Orphan", dependsOn: [first.id] }),
      () => store.updateTask(second.id, { objective: "Changed", dependsOn: [first.id] }),
      () => store.updateRun(run.id, { state: "paused" }),
      () => store.createOperation(run.id, first.id, "effect", {}),
      () => store.addArtifact(run.id, first.id, "a", "a".repeat(64), 1, "text/plain"),
    ];
    for (const mutate of mutations) {
      assert.throws(mutate, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Store database operation failed.");
        assert.ok(!String(error).includes("hidden-trigger-value"));
        return true;
      });
    }
    assert.deepEqual(store.getTask(second.id), second);
    assert.equal(store.tasks(run.id).length, 2);
    assert.equal(store.getRun(run.id).state, "running");
    assert.deepEqual(store.operations(run.id), []);
    assert.deepEqual(store.artifacts(run.id), []);
    assert.deepEqual(store.events(run.id), before);
    inspector.exec("DROP TRIGGER reject_history");
    assert.deepEqual(store.updateTask(second.id, { dependsOn: [first.id] }).dependsOn, [first.id]);
  } finally {
    inspector.close();
  }
});

test("approval consumption rolls back with its event if history cannot be written", (t) => {
  const { store, run, dbPath } = fixture(t);
  const task = store.createTask(run.id, { objective: "Atomic effect permission" });
  store.startTask(task.id);
  const approval = store.createApproval(run.id, task.id, { exact: "action" });
  store.decideApproval(approval.id, true);
  const inspector = new DatabaseSync(dbPath);
  try {
    inspector.exec(`
      CREATE TRIGGER reject_consume_history BEFORE INSERT ON events
      WHEN NEW.type = 'approval.consumed'
      BEGIN SELECT RAISE(ABORT, 'simulated history failure'); END;
    `);
    const before = store.events(run.id);
    assert.throws(() => store.consumeApproval(approval.id, { exact: "action" }), /database operation failed/);
    assert.equal(store.getApproval(approval.id).state, "approved");
    assert.deepEqual(store.events(run.id), before);
    inspector.exec("DROP TRIGGER reject_consume_history");
    assert.equal(store.consumeApproval(approval.id, { exact: "action" }).state, "consumed");
  } finally {
    inspector.close();
  }
});

test("SQLite enforces foreign key relationships and stores a versioned WAL schema", (t) => {
  const { store, run, cwd, dbPath } = fixture(t);
  const other = store.createRun("Other", cwd);
  const parent = store.createTask(run.id, { objective: "Parent" });
  const child = store.createTask(run.id, { objective: "Child", parentId: parent.id, dependsOn: [parent.id] });
  const foreign = store.createTask(other.id, { objective: "Foreign" });
  const operation = store.createOperation(run.id, child.id, "effect", {});
  const approval = store.createApproval(run.id, child.id, {});
  const artifact = store.addArtifact(run.id, child.id, "a", "a".repeat(64), 0, "text/plain");
  const inspector = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
  try {
    assert.equal(inspector.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
    assert.equal(inspector.prepare("PRAGMA user_version").get()?.user_version, 1);
    assert.deepEqual(inspector.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => inspector.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?").run(foreign.id, child.id),
      /FOREIGN KEY/);
    assert.throws(() => inspector.prepare("UPDATE task_dependencies SET dependency_id = ? WHERE task_id = ?")
      .run(foreign.id, child.id), /FOREIGN KEY/);
    for (const [table, id] of [
      ["operations", operation.id], ["approvals", approval.id], ["artifacts", artifact.id],
    ]) {
      assert.throws(() => inspector.prepare(`UPDATE ${table} SET run_id = ? WHERE id = ?`).run(other.id, id),
        /FOREIGN KEY/);
    }
    assert.throws(() => inspector.prepare(
      "INSERT INTO events (run_id, task_id, type, data, at) VALUES (?, ?, 'bad', '{}', 'now')",
    ).run(run.id, foreign.id), /FOREIGN KEY/);
    assert.throws(() => inspector.prepare("DELETE FROM runs WHERE id = ?").run(run.id), /FOREIGN KEY/);
  } finally {
    inspector.close();
  }
});

test("future schemas are rejected without downgrading or corrupting the database", (t) => {
  const f = fixture(t);
  f.store.close();
  const inspector = new DatabaseSync(f.dbPath);
  try {
    inspector.exec("PRAGMA user_version = 99");
    assert.throws(() => f.open(), /schema version is not supported/);
    assert.equal(inspector.prepare("PRAGMA user_version").get()?.user_version, 99);
    assert.equal(inspector.prepare("SELECT COUNT(*) AS count FROM runs").get()?.count, 1);
  } finally {
    inspector.close();
  }
});

test("list and history queries stay within a run, and closed stores fail clearly", (t) => {
  const { store, run, cwd, open } = fixture(t);
  const other = store.createRun("Other", cwd);
  const task = store.createTask(run.id, { objective: "First" });
  const otherTask = store.createTask(other.id, { objective: "Other" });
  store.createOperation(run.id, task.id, "one", {});
  store.createOperation(other.id, otherTask.id, "two", {});
  store.createApproval(run.id, task.id, {});
  store.createApproval(other.id, otherTask.id, {});
  store.addArtifact(run.id, task.id, "one", "a".repeat(64), 1, "text/plain");
  store.addArtifact(other.id, otherTask.id, "two", "b".repeat(64), 2, "text/plain");
  assert.deepEqual(store.listRuns().map((item) => item.id), [run.id, other.id]);
  assert.deepEqual(store.tasks(run.id).map((item) => item.id), [task.id]);
  assert.ok(store.operations(run.id).every((item) => item.runId === run.id));
  assert.ok(store.approvals(run.id).every((item) => item.runId === run.id));
  assert.ok(store.artifacts(run.id).every((item) => item.runId === run.id));
  assert.ok(store.events(run.id).every((item) => item.runId === run.id));
  const cursor = store.events(run.id).at(-1)!.seq;
  assert.deepEqual(store.events(run.id, cursor), []);
  assert.throws(() => store.events(run.id, -1), /cursor/);
  assert.throws(() => store.events(run.id, 0.5), /cursor/);
  assert.throws(() => store.addArtifact(run.id, task.id, "a", "bad", 1, "text/plain"), /digest/);
  assert.throws(() => store.addArtifact(run.id, task.id, "a", "a".repeat(64), -1, "text/plain"), /size/);
  store.close();
  assert.throws(() => store.getRun(run.id), /Store is closed/);
  assert.throws(() => store.listRuns(), /Store is closed/);
  assert.throws(() => store.createTask(run.id, { objective: "Closed" }), /Store is closed/);
  store.close();
  assert.equal(open().getRun(run.id).id, run.id);
});

test("acceptRun commits root, run, result, evidence and history together and survives reopening", (t) => {
  const f = fixture(t);
  const { store, run } = f;
  const observer = f.open();
  const root = verifyingRoot(store, run.id);
  store.claimRun(run.id, process.pid, "private-finalization-owner");
  const worker = store.createTask(run.id, { objective: "Accepted work", parentId: root.id });
  const acceptedWorker = accept(store, worker.id);
  const canceled = store.createTask(run.id, { objective: "Superseded work", parentId: root.id });
  store.updateTask(canceled.id, { state: "canceled" });
  const reviewer = store.createTask(run.id, { objective: "Prior review", role: "reviewer", parentId: root.id });
  store.startTask(reviewer.id);
  store.updateTask(reviewer.id, { state: "failed" });
  const steering = store.addEvent(run.id, "user.steering", { instruction: "Final requirement" });
  store.addEvent(run.id, "task.correction", { correction: "Repair a worker" }, worker.id);
  const cursor = store.events(run.id).at(-1)!.seq;
  const evidence = ["final manifest", "independent review"];
  assert.equal(store.acceptRun(run.id, root.id, "Final result", evidence, steering.seq), true);
  evidence.push("changed after commit");

  const acceptedRoot = observer.getTask(root.id);
  const acceptedRun = observer.getRun(run.id);
  assert.equal(acceptedRun.state, "accepted");
  assert.equal(acceptedRun.result, "Final result");
  assert.equal(acceptedRun.ownerToken, "private-finalization-owner");
  assert.equal(acceptedRoot.state, "accepted");
  assert.equal(acceptedRoot.result, "Final result");
  assert.deepEqual(acceptedRoot.evidence, ["final manifest", "independent review"]);
  assert.equal(acceptedRoot.attempt, root.attempt);
  assert.equal(acceptedRoot.createdAt, root.createdAt);
  assert.equal(acceptedRoot.updatedAt, acceptedRun.updatedAt);
  assert.deepEqual(observer.getTask(worker.id), acceptedWorker);
  const events = observer.events(run.id, cursor);
  assert.deepEqual(events.map((event) => event.type), ["task.accepted", "run.accepted"]);
  assert.equal(events[0]!.taskId, root.id);
  assert.deepEqual(events[0]!.data, acceptedRoot);
  const { ownerToken: _token, ...history } = acceptedRun;
  assert.deepEqual(events[1]!.data, {
    ...history, rootTaskId: root.id, evidence: acceptedRoot.evidence, steeringSeq: steering.seq,
  });
  assert.ok(!JSON.stringify(events).includes("private-finalization-owner"));
  const committed = runSnapshot(observer, run.id);
  assert.equal(observer.acceptRun(run.id, root.id, "Replacement", [], steering.seq), false);
  assert.throws(() => observer.updateTask(root.id, { result: "Replacement" }), /immutable/);
  assert.deepEqual(runSnapshot(observer, run.id), committed);
  store.close();
  observer.close();
  assert.deepEqual(runSnapshot(f.open(), run.id), committed);
});

test("acceptRun uses zero when no steering exists and ignores corrections and other runs", (t) => {
  const { store, run, cwd } = fixture(t);
  const root = verifyingRoot(store, run.id);
  store.updateRun(run.id, { state: "verifying" });
  store.addEvent(run.id, "task.correction", { correction: "Agent-requested repair" }, root.id);
  const other = store.createRun("Unrelated", cwd);
  store.addEvent(other.id, "user.steering", { instruction: "Different run" });
  const worker = store.createTask(other.id, { objective: "Unfinished elsewhere" });
  store.startTask(worker.id);
  const operation = store.createOperation(other.id, worker.id, "effect", {});
  store.updateOperation(operation.id, { state: "running" });
  assert.equal(store.acceptRun(run.id, root.id, "Reviewed result", [], 0), true);
  assert.equal(store.getTask(root.id).state, "accepted");
  assert.equal(store.getRun(run.id).state, "accepted");
  assert.equal(store.getTask(worker.id).state, "running");
  assert.equal(store.getOperation(operation.id).state, "running");
});

test("steering injected by a second store between checks and finalization prevents stale acceptance", (t) => {
  const { store, run, cwd, open } = fixture(t);
  const second = open();
  for (const existingSteering of [false, true]) {
    const current = existingSteering ? store.createRun("Existing steering", cwd) : run;
    const root = verifyingRoot(store, current.id);
    const expectedSeq = existingSteering
      ? store.addEvent(current.id, "user.steering", { instruction: "Previous requirement" }).seq : 0;
    // Simulate supervisor checks finishing before another connection writes.
    assert.equal(store.getRun(current.id).state, "running");
    assert.equal(store.getTask(root.id).state, "verifying");
    assert.equal(store.events(current.id).filter((event) => event.type === "user.steering").at(-1)?.seq ?? 0,
      expectedSeq);
    const newer = second.addEvent(current.id, "user.steering", { instruction: "Changed requirement" });
    const before = runSnapshot(second, current.id);
    assert.equal(store.acceptRun(current.id, root.id, "Stale result", ["stale review"], expectedSeq), false);
    assert.deepEqual(runSnapshot(second, current.id), before);
    // The supervisor can repair and review the candidate before retrying with
    // the steering sequence that the new review actually incorporated.
    store.updateTask(root.id, { state: "running" });
    store.updateTask(root.id, { state: "verifying", result: "Revised candidate", evidence: ["new review"] });
    assert.equal(store.acceptRun(current.id, root.id, "Revised result", ["new review"], newer.seq), true);
  }
});

test("late steering cannot pass a stale CLI state check after acceptance or cancellation", (t) => {
  const { store, run, cwd, open } = fixture(t);
  const cli = open();
  for (const state of ["accepted", "canceled"] as const) {
    const current = state === "accepted" ? run : store.createRun("Canceled run", cwd);
    const root = verifyingRoot(store, current.id);
    assert.equal(cli.getRun(current.id).state, "running");
    if (state === "accepted") assert.equal(store.acceptRun(current.id, root.id, "Final", ["review"], 0), true);
    else store.updateRun(current.id, { state: "canceled" });
    const before = runSnapshot(cli, current.id);
    // This represents CLI or onEvent code running after the transaction returns.
    assert.equal(cli.getRun(current.id).state, state);
    assert.equal(cli.getTask(root.id).state, state === "accepted" ? "accepted" : "verifying");
    for (const taskId of [undefined, root.id]) {
      assert.throws(() => cli.addEvent(current.id, "user.steering", {
        instruction: "Too late",
      }, taskId), /Cannot steer an accepted or canceled run/);
    }
    assert.deepEqual(runSnapshot(cli, current.id), before);
    // Audit and agent-correction events keep their existing behavior.
    assert.equal(cli.addEvent(current.id, "task.correction", { correction: "Historical note" }, root.id).type,
      "task.correction");
    assert.equal(cli.addEvent(current.id, "run.stopped", { state }).type, "run.stopped");
  }
});

test("steering remains writable for running, verifying, paused, blocked and failed runs", (t) => {
  const { store, cwd } = fixture(t);
  for (const state of ["running", "verifying", "paused", "blocked", "failed"] as const) {
    const run = store.createRun("Steerable run", cwd);
    store.updateRun(run.id, { state });
    const event = store.addEvent(run.id, "user.steering", { instruction: "Next requirement" });
    assert.equal(event.type, "user.steering");
    assert.equal(store.getRun(run.id).state, state);
    assert.equal(store.events(run.id).at(-1)!.seq, event.seq);
  }
});

test("run state changes racing finalization leave the root and history untouched", (t) => {
  const { store, cwd, open } = fixture(t);
  const second = open();
  for (const state of ["paused", "canceled", "blocked", "failed", "accepted"] as const) {
    const run = store.createRun("Concurrent run state", cwd);
    const root = verifyingRoot(store, run.id);
    assert.equal(store.getRun(run.id).state, "running");
    second.updateRun(run.id, { state });
    const before = runSnapshot(second, run.id);
    assert.equal(store.acceptRun(run.id, root.id, "Stale verdict", ["review"], 0), false);
    assert.deepEqual(runSnapshot(second, run.id), before);
  }
});

test("acceptRun requires a same-run parentless coordinator that is still verifying", (t) => {
  const { store, cwd } = fixture(t);
  for (const state of ["queued", "running", "waiting", "blocked", "failed", "canceled", "accepted"] as const) {
    const run = store.createRun("Root state", cwd);
    const root = store.createTask(run.id, { objective: "Root", role: "coordinator" });
    if (state !== "queued") store.startTask(root.id);
    if (state === "accepted") accept(store, root.id);
    else if (state !== "queued") store.updateTask(root.id, { state });
    const before = runSnapshot(store, run.id);
    assert.equal(store.acceptRun(run.id, root.id, "Result", [], 0), false);
    assert.deepEqual(runSnapshot(store, run.id), before);
  }
  for (const role of ["worker", "reviewer", "coordinator"] as const) {
    const run = store.createRun("Root identity", cwd);
    const parent = store.createTask(run.id, { objective: "Actual root", role: "coordinator" });
    const task = store.createTask(run.id, {
      objective: "Wrong root", role, ...(role === "coordinator" ? { parentId: parent.id } : {}),
    });
    store.startTask(task.id);
    store.updateTask(task.id, { state: "verifying" });
    const before = runSnapshot(store, run.id);
    assert.equal(store.acceptRun(run.id, task.id, "Result", [], 0), false);
    assert.deepEqual(runSnapshot(store, run.id), before);
  }
});

test("acceptRun refuses every worker state except accepted or canceled", (t) => {
  const { store, cwd, open } = fixture(t);
  const second = open();
  for (const state of ["queued", "running", "waiting", "verifying", "blocked", "failed"] as const) {
    const run = store.createRun("Worker readiness", cwd);
    const root = verifyingRoot(store, run.id);
    assert.deepEqual(store.tasks(run.id).filter((task) => task.role === "worker"), []);
    const worker = second.createTask(run.id, { objective: "Concurrent worker", parentId: root.id });
    if (state !== "queued") second.startTask(worker.id);
    if (state !== "queued") second.updateTask(worker.id, { state });
    const before = runSnapshot(second, run.id);
    assert.equal(store.acceptRun(run.id, root.id, "Premature result", [], 0), false);
    assert.deepEqual(runSnapshot(second, run.id), before);
    second.updateTask(worker.id, { state: "canceled" });
    assert.equal(store.acceptRun(run.id, root.id, "Final result", [], 0), true);
  }
});

test("running or unknown operations introduced after prechecks block finalization until reconciled", (t) => {
  const { store, cwd, open } = fixture(t);
  const second = open();
  for (const state of ["running", "unknown"] as const) {
    const run = store.createRun("Operation readiness", cwd);
    const root = verifyingRoot(store, run.id);
    const operation = store.createOperation(run.id, root.id, "effect", {});
    assert.ok(store.operations(run.id).every((item) => !["running", "unknown"].includes(item.state)));
    second.updateOperation(operation.id, { state: "running" });
    if (state === "unknown") second.updateOperation(operation.id, { state: "unknown" });
    const before = runSnapshot(second, run.id);
    assert.equal(store.acceptRun(run.id, root.id, "Premature result", [], 0), false);
    assert.deepEqual(runSnapshot(second, run.id), before);
    second.updateOperation(operation.id, { state: "failed", result: { reconciled: true } });
    store.createOperation(run.id, root.id, "unused prepared effect", {});
    assert.equal(store.acceptRun(run.id, root.id, "Final result", ["effect reconciled"], 0), true);
  }
});

test("acceptRun validates IDs and cursors and requires exact steering equality", (t) => {
  const { store, run, cwd } = fixture(t);
  const root = verifyingRoot(store, run.id);
  const other = store.createRun("Other", cwd);
  const foreign = verifyingRoot(store, other.id);
  const before = runSnapshot(store, run.id);
  assert.throws(() => store.acceptRun("missing", root.id, "Result", [], 0), /not found/);
  assert.throws(() => store.acceptRun(run.id, "missing", "Result", [], 0), /not found/);
  assert.throws(() => store.acceptRun(run.id, foreign.id, "Result", [], 0), /belong/);
  for (const cursor of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => store.acceptRun(run.id, root.id, "Result", [], cursor), /Invalid steering cursor/);
  }
  assert.throws(() => store.acceptRun(run.id, root.id, undefined as unknown as string, [], 0), /string/);
  assert.throws(() => store.acceptRun(run.id, root.id, "Result", [1] as unknown as string[], 0), /string/);
  assert.equal(store.acceptRun(run.id, root.id, "Result", [], 1), false);
  assert.deepEqual(runSnapshot(store, run.id), before);
  const steering = store.addEvent(run.id, "user.steering", {});
  const steered = runSnapshot(store, run.id);
  for (const cursor of [0, steering.seq - 1, steering.seq + 1]) {
    assert.equal(store.acceptRun(run.id, root.id, "Result", [], cursor), false);
    assert.deepEqual(runSnapshot(store, run.id), steered);
  }
});

test("both acceptance records and all events roll back if either acceptance event fails", (t) => {
  const { store, cwd, dbPath, open } = fixture(t);
  const observer = open();
  const inspector = new DatabaseSync(dbPath);
  try {
    for (const type of ["task.accepted", "run.accepted"]) {
      const run = store.createRun("Atomic finalization history", cwd);
      const root = verifyingRoot(store, run.id);
      inspector.exec(`
        CREATE TRIGGER reject_acceptance BEFORE INSERT ON events
        WHEN NEW.type = '${type}'
        BEGIN SELECT RAISE(ABORT, 'credential=private-test-value'); END;
      `);
      const before = runSnapshot(observer, run.id);
      assert.throws(() => store.acceptRun(run.id, root.id, "Final result", ["final evidence"], 0),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, "Store database operation failed.");
          assert.ok(!String(error).includes("private-test-value"));
          return true;
        });
      assert.deepEqual(runSnapshot(observer, run.id), before);
      inspector.exec("DROP TRIGGER reject_acceptance");
      assert.equal(store.acceptRun(run.id, root.id, "Final result", ["final evidence"], 0), true);
      assert.deepEqual(observer.events(run.id, before.events.at(-1)!.seq).map((event) => event.type),
        ["task.accepted", "run.accepted"]);
    }
  } finally {
    inspector.close();
  }
});

test("simultaneous finalizers commit one immutable acceptance with exactly two events", async (t) => {
  const { store, run, stateDir } = fixture(t);
  const root = verifyingRoot(store, run.id);
  const results = await race(stateDir, "accept", run.id, {
    rootTaskId: root.id, result: "Final result", evidence: ["review"], expectedSteeringSeq: 0,
  });
  assert.ok(results.every((result) => result.ok));
  assert.deepEqual(results.map((result) => result.value).sort(), [false, true]);
  assert.equal(store.getRun(run.id).state, "accepted");
  assert.equal(store.getTask(root.id).state, "accepted");
  assert.equal(store.events(run.id).filter((event) => event.type === "task.accepted").length, 1);
  assert.equal(store.events(run.id).filter((event) => event.type === "run.accepted").length, 1);
});

test("simultaneous steering and finalization serialize without accepting stale work", async (t) => {
  const { store, run, stateDir } = fixture(t);
  const root = verifyingRoot(store, run.id);
  const [finalization, steering] = await race(stateDir, ["accept", "steer"], run.id, {
    rootTaskId: root.id, result: "Final result", evidence: ["review"], expectedSteeringSeq: 0,
  });
  assert.equal(finalization!.ok, true);
  const events = store.events(run.id);
  if (finalization!.value === true) {
    assert.equal(steering!.ok, false);
    assert.match(steering!.message!, /Cannot steer an accepted or canceled run/);
    assert.equal(store.getRun(run.id).state, "accepted");
    assert.equal(store.getTask(root.id).state, "accepted");
    assert.equal(events.filter((event) => event.type === "user.steering").length, 0);
    assert.equal(events.filter((event) => event.type === "task.accepted").length, 1);
    assert.equal(events.filter((event) => event.type === "run.accepted").length, 1);
  } else {
    assert.equal(finalization!.value, false);
    assert.equal(steering!.ok, true);
    assert.equal(store.getRun(run.id).state, "running");
    assert.equal(store.getTask(root.id).state, "verifying");
    assert.equal(events.filter((event) => event.type === "user.steering").length, 1);
    assert.equal(events.filter((event) => event.type === "task.accepted").length, 0);
    assert.equal(events.filter((event) => event.type === "run.accepted").length, 0);
  }
});
