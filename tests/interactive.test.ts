import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as flush } from "node:timers/promises";
import { interactive } from "../src/cli.js";
import type { RunRecord } from "../src/contracts.js";
import { Store } from "../src/store.js";

interface Execution {
  id: string;
  settled: boolean;
  finish: (result?: RunRecord) => void;
}

function fixture(t: TestContext) {
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(join(parent, "workbench-interactive-"));
  const stateDir = join(root, "state");
  const store = new Store(stateDir);
  const input = new PassThrough(), output = new PassThrough();
  const executions: Execution[] = [];
  let text = "", closing = false;
  output.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
  const controller = {
    create(objective: string, cwd: string) {
      const run = store.createRun(objective, cwd);
      store.createTask(run.id, { objective, role: "coordinator" });
      return run;
    },
    execute(id: string): Promise<RunRecord> {
      if (closing) return Promise.resolve(store.getRun(id));
      store.updateRun(id, { state: "running" });
      for (const task of store.tasks(id)) if (task.state === "queued") store.startTask(task.id);
      return new Promise((resolve) => {
        const execution: Execution = {
          id, settled: false,
          finish(result = store.getRun(id)) { execution.settled = true; resolve(result); },
        };
        executions.push(execution);
      });
    },
  };
  const outcome = interactive(controller, store, root, (value) => {
    output.write((typeof value === "string" ? value : JSON.stringify(value)) + "\n");
  }, input, output).then(
    (code) => ({ code, error: undefined }),
    (error: unknown) => ({ code: undefined, error }),
  );
  const done = async () => {
    const result = await outcome;
    assert.ifError(result.error);
    assert.equal(result.code, 0);
  };
  t.after(async () => {
    closing = true;
    input.end();
    for (const execution of executions) if (!execution.settled) execution.finish();
    try { await done(); }
    finally {
      store.close();
      input.destroy(); output.destroy();
      const target = realpathSync(root);
      assert.equal(dirname(target), parent);
      assert.ok(basename(target).startsWith("workbench-interactive-"));
      rmSync(target, { recursive: true, force: true });
    }
  });
  return {
    root, stateDir, store, input, executions, done,
    text: () => text,
    async send(line: string) { input.write(line + "\n"); await flush(); },
  };
}

function snapshot(store: Store, id: string) {
  return {
    run: store.getRun(id), tasks: store.tasks(id), operations: store.operations(id),
    artifacts: store.artifacts(id), approvals: store.approvals(id), events: store.events(id),
  };
}

test("an empty prompt explains goal entry and controls do not start work", async (t) => {
  const f = fixture(t);
  assert.match(f.text(), /text prompt\. Type a goal after > and press Enter to start/);
  assert.match(f.text(), /Example goal:/);
  for (const command of ["/resume", "/cancel", "/status"]) await f.send(command);
  assert.equal(f.store.listRuns().length, 0);
  assert.equal(f.executions.length, 0);
  assert.match(f.text(), /No task is running\. Type a goal to start one/);
  assert.match(f.text(), /For saved work, use workbench status and workbench resume <run-id>/);
  await f.send("Create a summary of the documents in this folder.");
  assert.equal(f.executions.length, 1);
  assert.equal(f.store.listRuns()[0].objective, "Create a summary of the documents in this folder.");
});

function approval(store: Store, id: string) {
  return store.createApproval(id, store.tasks(id)[0].id, {
    method: "POST", url: "https://example.invalid/records", body: "saved exact action",
  });
}

function evidence(f: ReturnType<typeof fixture>, id: string) {
  const task = f.store.tasks(id)[0];
  const bytes = Buffer.from("Preserved command output.\n");
  const path = join(f.root, `${id}.txt`);
  writeFileSync(path, bytes);
  const artifact = f.store.addArtifact(id, task.id, path,
    createHash("sha256").update(bytes).digest("hex"), bytes.length, "text/plain");
  f.store.updateTask(task.id, { result: "Partial result", evidence: [artifact.id] });
  for (const state of ["succeeded", "unknown", "running"] as const) {
    const op = f.store.createOperation(id, task.id, "scripted-operation", { state });
    f.store.updateOperation(op.id, { state: "running" });
    if (state !== "running") f.store.updateOperation(op.id, { state, result: { artifact: artifact.id } });
  }
  return { artifact, bytes };
}

for (const state of ["paused", "blocked"] as const) {
  test(`interactive ${state}-then-cancel uses durable state and retains evidence and unresolved operations`, async (t) => {
    const f = fixture(t);
    await f.send("Preserve my work.");
    const execution = f.executions[0], id = execution.id;
    const saved = evidence(f, id), pending = approval(f.store, id);
    if (state === "paused") await f.send("/pause");
    else f.store.updateRun(id, { state, result: "Owner decision needed." });
    execution.finish();
    await flush();
    const before = snapshot(f.store, id);
    assert.equal(before.run.state, state);

    await f.send("/cancel");
    assert.equal(f.store.getRun(id).state, "canceled");
    assert.equal(f.store.getRun(id).result, before.run.result);
    assert.deepEqual(f.store.tasks(id), before.tasks);
    assert.deepEqual(f.store.operations(id), before.operations);
    assert.deepEqual(f.store.artifacts(id), before.artifacts);
    assert.deepEqual(f.store.approvals(id), before.approvals);
    assert.deepEqual(f.store.events(id).slice(0, before.events.length), before.events);
    assert.match(f.text(), /Cancel requested; evidence retained\./);
    assert.doesNotMatch(f.text(), /No active work\./);

    const canceled = snapshot(f.store, id);
    await f.send("/status");
    await f.send("/resume");
    await f.send(`/approve ${pending.id}`);
    assert.equal(f.executions.length, 1);
    assert.deepEqual(snapshot(f.store, id), canceled);
    assert.match(f.text(), /Unresolved operations: 2\. Pending approvals: 1\./);
    assert.match(f.text(), /Run is canceled\. Start a new run\./);

    const reopened = new Store(f.stateDir);
    try {
      assert.deepEqual(snapshot(reopened, id), canceled);
      assert.deepEqual(readFileSync(saved.artifact.path), saved.bytes);
    } finally { reopened.close(); }
    await f.send("Start a separate objective.");
    assert.equal(f.executions.length, 2);
    assert.notEqual(f.executions[1].id, id);
    assert.equal(f.store.getRun(f.executions[1].id).objective, "Start a separate objective.");
    assert.deepEqual(snapshot(f.store, id), canceled);
  });
}

test("cancel clears a queued approval resume even when execution returns an older blocked snapshot", async (t) => {
  const f = fixture(t);
  await f.send("Wait for an approval.");
  const execution = f.executions[0], id = execution.id;
  evidence(f, id);
  const pending = approval(f.store, id);
  const stale = f.store.updateRun(id, { state: "blocked" });
  await f.send(`/approve ${pending.id}`);
  assert.equal(f.store.getApproval(pending.id).state, "approved");
  assert.equal(f.executions.length, 1);
  await f.send("/cancel");
  const canceled = snapshot(f.store, id);
  execution.finish(stale);
  await flush();
  assert.equal(f.executions.length, 1);
  assert.deepEqual(snapshot(f.store, id), canceled);
  assert.equal(canceled.run.state, "canceled");
  assert.match(f.text(), /canceled: No result submitted\./);
});

for (const state of ["paused", "blocked"] as const) {
  test(`approval resumes settled ${state} work; steering and explicit pause/resume stay usable`, async (t) => {
    const f = fixture(t);
    await f.send("Continue with approval.");
    const id = f.executions[0].id, pending = approval(f.store, id);
    f.store.updateRun(id, { state });
    f.executions[0].finish();
    await flush();
    await f.send("/approvals");
    assert.ok(f.text().includes(pending.actionHash));
    await f.send(`/approve ${pending.id}`);
    assert.equal(f.store.getApproval(pending.id).state, "approved");
    assert.deepEqual(f.executions.map((execution) => execution.id), [id, id]);
    assert.equal(f.store.getRun(id).state, "running");
    await f.send("Keep the original evidence.");
    assert.deepEqual(f.store.events(id).filter((event) => event.type === "user.steering").map((event) => event.data),
      [{ instruction: "Keep the original evidence." }]);
    await f.send("/pause");
    f.executions[1].finish();
    await flush();
    assert.equal(f.store.getRun(id).state, "paused");
    await f.send("/resume");
    await f.send("/resume");
    assert.deepEqual(f.executions.map((execution) => execution.id), [id, id, id]);
    assert.match(f.text(), /Work is already active\./);
  });
}

for (const state of ["paused", "blocked"] as const) {
  test(`approval during cleanup resumes the same ${state} run once after execution settles`, async (t) => {
    const f = fixture(t);
    await f.send("Wait for cleanup.");
    const id = f.executions[0].id, pending = approval(f.store, id);
    if (state === "paused") await f.send("/pause");
    else f.store.updateRun(id, { state });
    await f.send(`/approve ${pending.id}`);
    assert.equal(f.executions.length, 1);
    f.executions[0].finish();
    await flush();
    assert.deepEqual(f.executions.map((execution) => execution.id), [id, id]);
    f.store.updateRun(id, { state: "blocked" });
    f.executions[1].finish();
    await flush();
    assert.equal(f.executions.length, 2);
  });
}

test("an explicit pause clears a queued automatic resume", async (t) => {
  const f = fixture(t);
  await f.send("Stay paused.");
  const id = f.executions[0].id, pending = approval(f.store, id);
  const stale = f.store.updateRun(id, { state: "blocked" });
  await f.send(`/approve ${pending.id}`);
  await f.send("/pause");
  f.executions[0].finish(stale);
  await flush();
  assert.equal(f.store.getRun(id).state, "paused");
  assert.equal(f.executions.length, 1);
  await f.send("/resume");
  assert.deepEqual(f.executions.map((execution) => execution.id), [id, id]);
});

test("/new waits for owned cleanup and discards the previous run's queued resume", async (t) => {
  const f = fixture(t);
  await f.send("First objective.");
  const id = f.executions[0].id, pending = approval(f.store, id);
  evidence(f, id);
  const stale = f.store.updateRun(id, { state: "blocked" });
  await f.send(`/approve ${pending.id}`);
  const before = snapshot(f.store, id);
  await f.send("/new Second objective.");
  assert.equal(f.store.getRun(id).state, "paused");
  assert.equal(f.store.listRuns().length, 1);
  f.executions[0].finish(stale);
  await flush();
  assert.equal(f.executions.length, 2);
  const next = f.store.getRun(f.executions[1].id);
  assert.notEqual(next.id, id);
  assert.equal(next.objective, "Second objective.");
  assert.equal(next.state, "running");
  assert.equal(f.store.getRun(id).state, "paused");
  assert.deepEqual(f.store.operations(id), before.operations);
  assert.deepEqual(f.store.artifacts(id), before.artifacts);
});

test("rejection and foreign approval inspection never resume work", async (t) => {
  const f = fixture(t);
  await f.send("Review saved actions.");
  const id = f.executions[0].id, pending = approval(f.store, id);
  const other = f.store.createRun("Another run.", f.root);
  f.store.createTask(other.id, { objective: other.objective });
  const foreign = approval(f.store, other.id);
  f.store.updateRun(id, { state: "blocked" });
  f.executions[0].finish();
  await flush();
  await f.send(`/approve ${foreign.id}`);
  assert.equal(f.store.getApproval(foreign.id).state, "pending");
  assert.match(f.text(), /Choose an approval from the current run\./);
  await f.send(`/reject ${pending.id}`);
  assert.equal(f.store.getApproval(pending.id).state, "rejected");
  assert.equal(f.store.getRun(id).state, "blocked");
  assert.equal(f.executions.length, 1);
});

for (const exit of ["/quit", "EOF"]) {
  test(`${exit} suppresses a queued approval resume while execution finishes`, async (t) => {
    const f = fixture(t);
    await f.send("Finish cleanup before leaving.");
    const id = f.executions[0].id, pending = approval(f.store, id);
    const stale = f.store.updateRun(id, { state: "blocked" });
    await f.send(`/approve ${pending.id}`);
    if (exit === "/quit") await f.send(exit);
    else { f.input.end(); await flush(); }
    f.executions[0].finish(stale);
    await f.done();
    assert.equal(f.executions.length, 1);
    assert.equal(f.store.getRun(id).state, exit === "/quit" ? "paused" : "blocked");
  });
}

function accept(store: Store, id: string) {
  const task = store.tasks(id)[0];
  store.updateTask(task.id, { state: "verifying" });
  assert.equal(store.acceptRun(id, task.id, "Accepted result.", ["Offline review receipt."], 0), true);
}

for (const settled of [false, true]) {
  test(`accepted work is immutable to interactive commands with execution ${settled ? "settled" : "still pending"}`, async (t) => {
    const f = fixture(t);
    await f.send("Complete this objective.");
    const id = f.executions[0].id, pending = approval(f.store, id);
    accept(f.store, id);
    const accepted = snapshot(f.store, id);
    if (settled) { f.executions[0].finish(); await flush(); }
    for (const command of ["/pause", "/cancel", "/resume", `/approve ${pending.id}`, `/reject ${pending.id}`, "/status", "/approvals"]) {
      await f.send(command);
      assert.deepEqual(snapshot(f.store, id), accepted, command);
    }
    await f.send("/quit");
    if (!settled) f.executions[0].finish();
    await f.done();
    assert.equal(f.executions.length, 1);
    assert.deepEqual(snapshot(f.store, id), accepted);
    assert.match(f.text(), /Run is accepted\. Start a new run\./);
  });
}

for (const command of ["/new Next objective.", "Next objective."]) {
  test(`${command} starts separate work after acceptance without mutating the accepted run`, async (t) => {
    const f = fixture(t);
    await f.send("Complete the first objective.");
    const id = f.executions[0].id;
    accept(f.store, id);
    const accepted = snapshot(f.store, id);
    await f.send(command);
    assert.equal(f.store.listRuns().length, 1);
    assert.deepEqual(snapshot(f.store, id), accepted);
    f.executions[0].finish();
    await flush();
    assert.equal(f.executions.length, 2);
    assert.notEqual(f.executions[1].id, id);
    assert.equal(f.store.getRun(f.executions[1].id).objective, "Next objective.");
    assert.deepEqual(snapshot(f.store, id), accepted);
  });
}
