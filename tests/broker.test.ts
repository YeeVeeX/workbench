import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { BrokerOperationError, ToolBroker } from "../src/broker.js";
import type { AgentTool, BrokerContext, TaskRecord, WorkbenchConfig } from "../src/contracts.js";
import { overlaps, safePath } from "../src/paths.js";
import { Store } from "../src/store.js";

const digest = (content: string | Buffer): string => createHash("sha256").update(content).digest("hex");

function fixture(t: TestContext, role: TaskRecord["role"] = "worker", writes = ["owned"]) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "workbench-broker-"));
  const root = path.join(directory, "project");
  const stateDir = path.join(directory, "private-state");
  mkdirSync(root);
  mkdirSync(path.join(root, "owned"));
  const store = new Store(stateDir);
  const run = store.createRun("Broker integration fixture", root);
  const created = store.createTask(run.id, { objective: "Fixture task", role, writePaths: writes });
  assert.equal(store.startTask(created.id), true);
  const task = store.getTask(created.id);
  const controller = new AbortController();
  const context: BrokerContext = { run, task, signal: controller.signal };
  const route = { provider: "fixture", model: "fixture", effort: "max" as const };
  const config: WorkbenchConfig = {
    version: 1, stateDir, maxWorkers: 2, noProgressLimit: 3, execution: "trusted-local",
    coordinator: route, worker: route, reviewer: route, fallbacks: [], capabilities: ["software"], mcp: {},
  };
  const broker = new ToolBroker(store, config);
  const cleanupExpectation = { unknown: false };
  const tools = broker.tools(context);
  const invoke = (name: string, args: unknown, signal?: AbortSignal): Promise<any> => {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `Missing tool ${name}`);
    return tool.execute(args, signal);
  };
  t.after(async () => {
    try {
      if (cleanupExpectation.unknown) await assert.rejects(broker.close(), /unresolved process cleanup/);
      else await broker.close();
    } finally {
      store.close();
      // Delete only this test's freshly allocated directory, never a derived project path.
      const target = path.resolve(directory);
      assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
      assert.match(path.basename(target), /^workbench-broker-/);
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
  return { directory, root, stateDir, store, run, task, controller, context, config, broker, tools, invoke, cleanupExpectation };
}

async function failure(action: Promise<unknown>, state: "failed" | "unknown" = "failed"): Promise<BrokerOperationError> {
  try { await action; assert.fail("Expected a durable broker failure."); }
  catch (error) {
    assert.ok(error instanceof BrokerOperationError, String(error));
    assert.equal(error.state, state);
    return error;
  }
}

async function server(t: TestContext, handler: http.RequestListener): Promise<string> {
  const listener = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });
  t.after(async () => {
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  });
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function waitFor(predicate: () => boolean, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("Fixture readiness deadline exceeded.");
    await delay(25);
  }
}

test("safePath confines paths, rejects protected writes and handles sibling prefixes", (t) => {
  const f = fixture(t);
  assert.equal(safePath(f.root, "owned/new.txt", { write: true }), path.join(f.root, "owned", "new.txt"));
  assert.throws(() => safePath(f.root, "../escaped.txt", { write: true }), /outside/);
  assert.throws(() => safePath(f.root, f.root + "-sibling/file.txt"), /outside/);
  for (const input of [".git/config", ".workbench/output", "state/db", ".env", ".env.local", ".aws/config", "credentials.json", "owned/key.pem", ".ssh/id_rsa"]) {
    assert.throws(() => safePath(f.root, input, { write: true }), /denied/, input);
  }
  assert.equal(overlaps(path.join(f.root, "owned"), path.join(f.root, "owned", "x")), true);
  assert.equal(overlaps(path.join(f.root, "owned"), path.join(f.root, "owned-two")), false);
  assert.equal(overlaps(path.join(f.root, "owned", ".."), f.root), true);
  if (process.platform === "win32") {
    for (const input of ["owned\\file:stream", "owned\\file.", "owned\\NUL.txt", "\\\\?\\C:\\x", "owned\\FILENA~1"]) {
      assert.throws(() => safePath(f.root, input, { write: true }), /not allowed/);
    }
    assert.equal(overlaps(f.root.toUpperCase(), path.join(f.root, "owned")), true);
  }
});

test("native paths refuse junctions/symlinks, including safe-looking in-root targets and a linked root", async (t) => {
  const f = fixture(t);
  const external = path.join(f.directory, "external");
  mkdirSync(external);
  writeFileSync(path.join(external, "value.txt"), "outside");
  const kind = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(external, path.join(f.root, "owned", "outside-link"), kind);
  symlinkSync(path.join(f.root, "owned"), path.join(f.root, "inside-link"), kind);
  symlinkSync(f.root, path.join(f.directory, "root-link"), kind);
  assert.throws(() => safePath(f.root, "owned/outside-link/value.txt"), /Symlink or junction/);
  assert.throws(() => safePath(f.root, "inside-link/missing.txt", { write: true }), /Symlink or junction/);
  assert.throws(() => safePath(path.join(f.directory, "root-link"), "owned"), /Symlink or junction/);
  await failure(f.invoke("write_file", { path: "owned/outside-link/value.txt", content: "bad" }));
  await failure(f.invoke("read_file", { path: "owned/outside-link/value.txt" }));
  assert.equal(readFileSync(path.join(external, "value.txt"), "utf8"), "outside");
  const listed = await f.invoke("list_files", { depth: 4 });
  assert.ok(listed.skipped.includes(path.join("owned", "outside-link")));
  assert.ok(!listed.files.some((file: string) => file.endsWith("value.txt")));
});

test("native writes record hashes and artifact receipts, and exact edits reject overlapping duplicates", async (t) => {
  const f = fixture(t);
  const content = "one\ntwó\nthree\n";
  const written = await f.invoke("write_file", { path: "owned/new/note.txt", content });
  assert.equal(written.sha256, digest(content));
  assert.equal(written.bytes, Buffer.byteLength(content));
  assert.equal(written.outputPath, path.join(f.root, "owned", "new", "note.txt"));
  assert.equal(written.path, written.outputPath);
  assert.ok(written.artifact.path.startsWith(path.join(f.stateDir, "artifacts") + path.sep));
  assert.notEqual(written.artifact.path, written.outputPath);
  assert.equal(f.store.artifacts(f.run.id).length, 1);
  assert.equal(f.store.getOperation(written.operationId).state, "succeeded");
  const read = await f.invoke("read_file", { path: "owned/new/note.txt", offset: 2, limit: 1 });
  assert.equal(read.content, "twó\n");
  assert.equal(read.truncated, true);
  const edited = await f.invoke("edit_file", { path: "owned/new/note.txt", oldText: "twó", newText: "two" });
  assert.equal(edited.sha256, digest("one\ntwo\nthree\n"));
  await failure(f.invoke("edit_file", { path: "owned/new/note.txt", oldText: "missing", newText: "x" }));
  assert.equal(readFileSync(edited.path, "utf8"), "one\ntwo\nthree\n");
  await f.invoke("write_file", { path: "owned/overlap.txt", content: "aaa" });
  await failure(f.invoke("edit_file", { path: "owned/overlap.txt", oldText: "aa", newText: "x" }));
  assert.equal(readFileSync(path.join(f.root, "owned/overlap.txt"), "utf8"), "aaa");
});

test("native output artifacts retain prior versions and reviewers can read them after a source overwrite", async (t) => {
  const f = fixture(t);
  const first = await f.invoke("write_file", { path: "owned/report.txt", content: "version one\n" });
  const second = await f.invoke("write_file", { path: "owned/report.txt", content: "version two\n" });
  const third = await f.invoke("edit_file", { path: "owned/report.txt", oldText: "two", newText: "three" });
  assert.equal(first.outputPath, second.outputPath);
  assert.equal(second.outputPath, third.outputPath);
  assert.notEqual(first.artifact.path, second.artifact.path);
  assert.notEqual(second.artifact.path, third.artifact.path);
  assert.equal(readFileSync(first.outputPath, "utf8"), "version three\n");
  assert.equal(readFileSync(first.artifact.path, "utf8"), "version one\n");
  assert.equal(readFileSync(second.artifact.path, "utf8"), "version two\n");
  assert.equal(readFileSync(third.artifact.path, "utf8"), "version three\n");
  const reviewer = f.store.createTask(f.run.id, { objective: "Review the first submitted version", role: "reviewer", parentId: f.task.id });
  assert.equal(f.store.startTask(reviewer.id), true);
  const candidate = path.join(f.stateDir, "runs", f.run.id, "candidates", "candidate-old-output", "root");
  mkdirSync(candidate, { recursive: true });
  writeFileSync(path.join(candidate, "report.txt"), "version one\n");
  const read = f.broker.tools({ ...f.context, run: { ...f.run, cwd: candidate }, task: f.store.getTask(reviewer.id) })
    .find((entry) => entry.name === "read_artifact")!;
  const observed = await read.execute({ artifactId: first.artifact.id }) as any;
  assert.equal(observed.content, "version one\n");
  assert.equal(observed.artifact.sha256, digest("version one\n"));
  const current = await read.execute({ artifactId: third.artifact.id }) as any;
  assert.equal(current.content, "version three\n");
  assert.notEqual(observed.artifact.sha256, current.artifact.sha256);
});

test("reviewers can inspect actual command receipts without opening unrelated run state", async (t) => {
  const f = fixture(t);
  await f.invoke("run_command", {
    executable: process.execPath, args: ["-e", "console.log('retained command proof')"], writes: [],
  });
  const command = f.store.operations(f.run.id).find((operation) => operation.kind === "run_command")!;
  assert.equal(command.state, "succeeded");
  const reviewer = f.store.createTask(f.run.id, { objective: "Read original execution evidence.", role: "reviewer", parentId: f.task.id });
  f.store.startTask(reviewer.id);
  const read = f.broker.tools({ ...f.context, task: f.store.getTask(reviewer.id) })
    .find((tool) => tool.name === "read_operation")!;
  const record = await read.execute({ operationId: `operation:${command.id}` }) as any;
  assert.equal(record.state, "succeeded");
  assert.equal(record.result.exitCode, 0);
  assert.deepEqual(record.input.args, ["-e", "console.log('retained command proof')"]);
  assert.ok(record.result.stdout.artifact.id);

  const otherRun = f.store.createRun("Unrelated work.", f.root);
  const otherTask = f.store.createTask(otherRun.id, { objective: "Separate assignment.", writePaths: [] });
  f.store.startTask(otherTask.id);
  const otherOperation = f.store.createOperation(otherRun.id, otherTask.id, "read_file", { path: "private.txt" });
  await assert.rejects(read.execute({ operationId: otherOperation.id }), /not registered to this run/);
});

test("run inspection exposes paged execution metadata without author conversation text", async (t) => {
  const f = fixture(t);
  const first = f.store.addEvent(f.run.id, "provider_start", {
    request: 1, provider: "fixture", model: "fixture", effort: "max", prompt: "AUTHOR_TEXT_MUST_NOT_APPEAR",
  }, f.task.id);
  f.store.addEvent(f.run.id, "provider_end", { request: 1, stopReason: "stop", wireVerified: true }, f.task.id);
  const one = await f.invoke("inspect_run", { afterSeq: first.seq - 1, limit: 1 });
  assert.equal(one.events[0].type, "provider_start");
  assert.equal(one.truncated, true);
  assert.equal(one.nextAfterSeq, first.seq);
  assert.doesNotMatch(JSON.stringify(one), /AUTHOR_TEXT_MUST_NOT_APPEAR/);
  const two = await f.invoke("inspect_run", { afterSeq: one.nextAfterSeq, limit: 1 });
  assert.equal(two.events[0].type, "provider_end");
  assert.equal(two.events[0].data.wireVerified, true);
});

for (const size of [200, 24000]) {
  test(`checkpoint privacy persists through operation receipts and derived artifacts (${size} bytes)`, async (t) => {
    const f = fixture(t);
    const file = path.join(f.stateDir, "visible-context.json");
    const content = "PRIVATE_VISIBLE_CONVERSATION " + "x".repeat(size);
    writeFileSync(file, content);
    const artifact = f.store.addArtifact(f.run.id, f.task.id, file, digest(content), Buffer.byteLength(content), "application/vnd.workbench.context+json");
    await f.invoke("read_artifact", { artifactId: artifact.id, limit: 65536 });
    const originalRead = f.store.operations(f.run.id).find((operation) => operation.kind === "read_artifact")!;
    const ownReceipt = await f.invoke("read_operation", { operationId: originalRead.id });
    const derivedRead = f.store.operations(f.run.id).filter((operation) => operation.kind === "read_operation").at(-1)!;

    const reviewer = f.store.createTask(f.run.id, { objective: "Review outputs without author history.", role: "reviewer", parentId: f.task.id });
    f.store.startTask(reviewer.id);
    const tools = f.broker.tools({ ...f.context, task: f.store.getTask(reviewer.id) });
    const operationReader = tools.find((tool) => tool.name === "read_operation")!;
    const artifactReader = tools.find((tool) => tool.name === "read_artifact")!;
    await assert.rejects(operationReader.execute({ operationId: originalRead.id }), /private|conversation/i);
    await assert.rejects(operationReader.execute({ operationId: derivedRead.id }), /private|conversation/i);
    if (ownReceipt.artifact) {
      await assert.rejects(artifactReader.execute({ artifactId: ownReceipt.artifact.id }), /private|conversation/i);
    } else {
      assert.match(JSON.stringify(ownReceipt), /PRIVATE_VISIBLE_CONVERSATION/);
    }
  });
}

test("write grants are checked live and read-only review exposes only evidence tools", async (t) => {
  const f = fixture(t);
  await failure(f.invoke("write_file", { path: "elsewhere.txt", content: "denied" }));
  f.store.updateTask(f.task.id, { writePaths: ["owned/allowed.txt"] });
  await failure(f.invoke("write_file", { path: "owned/revoked.txt", content: "denied" }));
  await f.invoke("write_file", { path: "owned/allowed.txt", content: "allowed" });
  const reviewer = f.store.createTask(f.run.id, { objective: "Independent review", role: "reviewer" });
  assert.equal(f.store.startTask(reviewer.id), true);
  const names = f.broker.tools({ ...f.context, task: f.store.getTask(reviewer.id) }).map((entry) => entry.name).sort();
  assert.deepEqual(names, ["fetch_url", "inspect_run", "list_files", "read_artifact", "read_file", "read_operation", "search_files"]);
  const forged = f.broker.tools({ ...f.context, task: { ...reviewer, role: "worker", writePaths: ["."] } });
  await failure(forged.find((entry) => entry.name === "write_file")!.execute({ path: "owned/forged", content: "bad" }));
});

test("coordinator writes avoid active child claims while a child can use its delegated grant", async (t) => {
  const f = fixture(t, "coordinator", ["."]);
  const child = f.store.createTask(f.run.id, { objective: "Child owns directory", role: "worker", parentId: f.task.id, writePaths: ["owned"] });
  assert.equal(f.store.startTask(child.id), true);
  await failure(f.invoke("write_file", { path: "owned/child.txt", content: "bad" }));
  await f.invoke("write_file", { path: "coordinator.txt", content: "integration" });
  const childTool = f.broker.tools({ ...f.context, task: f.store.getTask(child.id) }).find((entry) => entry.name === "write_file")!;
  await childTool.execute({ path: "owned/child.txt", content: "child" });
  f.store.updateTask(child.id, { state: "verifying" });
  f.store.updateTask(child.id, { state: "accepted" });
  await f.invoke("write_file", { path: "owned/child.txt", content: "adopted" });
});

test("another active writer's claim blocks a queued contender and unresolved failed tasks retain claims", async (t) => {
  const f = fixture(t);
  const contender = f.store.createTask(f.run.id, { objective: "Conflicting writer", writePaths: ["owned"] });
  const write = f.broker.tools({ ...f.context, task: contender }).find((entry) => entry.name === "write_file")!;
  await failure(write.execute({ path: "owned/conflict.txt", content: "bad" }));
  const uncertain = f.store.createOperation(f.run.id, f.task.id, "run_command", {});
  f.store.updateOperation(uncertain.id, { state: "running" });
  f.store.updateOperation(uncertain.id, { state: "unknown" });
  f.store.updateTask(f.task.id, { state: "failed" });
  assert.equal(f.store.startTask(contender.id), true);
  await failure(write.execute({ path: "owned/conflict.txt", content: "bad" }));
  f.store.updateOperation(uncertain.id, { state: "failed" });
  await write.execute({ path: "owned/conflict.txt", content: "reconciled" });
});

test("coordinators honor active and unresolved worker claims from other runs in the same filesystem tree", async (t) => {
  const f = fixture(t, "coordinator", ["."]);
  const otherRun = f.store.createRun("Other run in a nested project", path.join(f.root, "owned"));
  const other = f.store.createTask(otherRun.id, { objective: "Own this file", writePaths: ["shared.txt"] });
  assert.equal(f.store.startTask(other.id), true);
  await failure(f.invoke("write_file", { path: "owned/shared.txt", content: "conflict" }));
  await f.invoke("write_file", { path: "owned/shared-other.txt", content: "no prefix conflict" });
  const effect = f.store.createOperation(otherRun.id, other.id, "run_command", {});
  f.store.updateOperation(effect.id, { state: "running" });
  f.store.updateOperation(effect.id, { state: "unknown" });
  f.store.updateTask(other.id, { state: "failed" });
  await failure(f.invoke("write_file", { path: "owned/shared.txt", content: "unresolved conflict" }));
  f.store.updateOperation(effect.id, { state: "failed" });
  await f.invoke("write_file", { path: "owned/shared.txt", content: "reconciled" });
});

test("native writes refuse hardlinks and the configured state directory", async (t) => {
  const f = fixture(t);
  const original = path.join(f.directory, "original.txt");
  writeFileSync(original, "original");
  linkSync(original, path.join(f.root, "owned", "linked.txt"));
  await failure(f.invoke("write_file", { path: "owned/linked.txt", content: "bad" }));
  assert.equal(readFileSync(original, "utf8"), "original");
  const broker = new ToolBroker(f.store, { ...f.config, stateDir: path.join(f.root, "owned", "private") });
  t.after(() => broker.close());
  const write = broker.tools(f.context).find((entry) => entry.name === "write_file")!;
  await failure(write.execute({ path: "owned/private/db", content: "bad" }));
});

test("list/search are literal, bounded, and do not silently traverse private state", async (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, "owned", "a.txt"), "prefix a.* literal\nunrelated\n");
  writeFileSync(path.join(f.root, "owned", "b.txt"), "aZZZ\n");
  mkdirSync(path.join(f.root, ".git"));
  writeFileSync(path.join(f.root, ".git", "evidence"), "a.*");
  const found = await f.invoke("search_files", { query: "a.*" });
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0].line, 1);
  assert.equal(found.matches[0].path, path.join("owned", "a.txt"));
  assert.ok(found.skipped.includes(".git"));
  assert.deepEqual((await f.invoke("list_files", {})).files, ["owned"]);
  const giant = "z".repeat(100_000);
  writeFileSync(path.join(f.root, "owned", "giant.txt"), giant);
  const preview = await f.invoke("read_file", { path: "owned/giant.txt" });
  assert.equal(preview.truncated, true);
  assert.ok(Buffer.byteLength(preview.content) <= 16 * 1024);
});

test("failures stay visible in the ledger and a completed task cannot reuse tools", async (t) => {
  const f = fixture(t);
  const error = await failure(f.invoke("read_file", { path: "missing.txt" }));
  assert.equal(f.store.getOperation(error.operationId).state, "failed");
  assert.ok(f.store.events(f.run.id).some((event) => event.type === "tool_failed"));
  f.store.updateTask(f.task.id, { state: "verifying" });
  f.store.updateTask(f.task.id, { state: "accepted" });
  await failure(f.invoke("read_file", { path: "owned" }));
});

test("issuing fresh tools revokes stale closures even after the same task resumes", async (t) => {
  const f = fixture(t);
  const stale = f.tools.find((entry) => entry.name === "write_file")!;
  f.store.updateTask(f.task.id, { state: "blocked" });
  f.store.updateTask(f.task.id, { state: "queued" });
  assert.equal(f.store.startTask(f.task.id), true);
  const fresh = f.broker.tools({ ...f.context, task: f.store.getTask(f.task.id) });
  await failure(stale.execute({ path: "owned/stale.txt", content: "old grant" }));
  assert.equal(existsSync(path.join(f.root, "owned", "stale.txt")), false);
  await fresh.find((entry) => entry.name === "write_file")!.execute({ path: "owned/fresh.txt", content: "fresh grant" });
  assert.equal(readFileSync(path.join(f.root, "owned", "fresh.txt"), "utf8"), "fresh grant");
});

test("restricted execution refuses commands and trusted execution requires explicit writes", async (t) => {
  const f = fixture(t);
  await failure(f.invoke("run_command", { executable: process.execPath, args: ["-e", "process.exit(0)"] }));
  await failure(f.invoke("run_command", { executable: process.execPath, args: [], writes: ["elsewhere"] }));
  const broker = new ToolBroker(f.store, { ...f.config, execution: "restricted" });
  t.after(() => broker.close());
  const command = broker.tools(f.context).find((entry) => entry.name === "run_command")!;
  const denied = await failure(command.execute({ executable: process.execPath, args: ["-e", "process.exit(0)"], writes: [] }));
  assert.match(denied.message, /Restricted mode/);
  assert.equal(f.store.events(f.run.id).some((event) => event.type === "process_spawned"), false);
});

test("command write declarations resolve against cwd before checking project grants", async (t) => {
  const f = fixture(t);
  const result = await f.invoke("run_command", {
    executable: process.execPath, args: ["-e", "require('fs').writeFileSync('from-cwd.txt','scoped')"],
    cwd: "owned", writes: ["from-cwd.txt"], timeoutSeconds: 30,
  });
  assert.equal(result.state, "succeeded");
  assert.equal(readFileSync(path.join(f.root, "owned", "from-cwd.txt"), "utf8"), "scoped");
  await failure(f.invoke("run_command", {
    executable: process.execPath, args: [], cwd: "owned", writes: ["../outside.txt"],
  }));
});

test("ordinary npm run invokes the installed CLI with argv and executes a real project script", async (t) => {
  const f = fixture(t);
  const packageFile = path.join(f.root, "owned", "package.json");
  writeFileSync(packageFile, JSON.stringify({
    name: "workbench-broker-npm-fixture", private: true, version: "1.0.0",
    scripts: { proof: 'node -e "require(\'fs\').writeFileSync(\'npm-output.txt\',\'npm script ran\');console.log(\'npm-local-proof\')"' },
  }));
  const result = await f.invoke("run_command", {
    executable: "npm", args: ["--offline", "--cache", "./npm-cache", "--no-update-notifier", "run", "proof"],
    cwd: "owned", writes: ["npm-output.txt", "npm-cache"], timeoutSeconds: 30,
  });
  assert.equal(result.state, "succeeded");
  assert.equal(result.cleanup, "confirmed");
  assert.equal(readFileSync(path.join(f.root, "owned", "npm-output.txt"), "utf8"), "npm script ran");
  assert.match(result.stdout.text, /npm-local-proof/);
  if (process.platform === "win32") {
    assert.equal(result.launcher.kind, "npm-cli");
    assert.match(result.launcher.cliPath, /node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/);
    assert.match(result.launcher.executable, /node\.exe$/i);
    assert.ok(f.store.events(f.run.id).some((entry) => entry.type === "process_command_resolved"));
    const version = await f.invoke("run_command", {
      executable: "npx.cmd", args: ["--version"], cwd: "owned", writes: [], timeoutSeconds: 30,
    });
    assert.equal(version.launcher.kind, "npx-cli");
    assert.match(version.stdout.text, /^\d+\.\d+\.\d+/);
  }
});

test("unsupported Windows batch launchers fail with a native argv repair hint", { skip: process.platform !== "win32" }, async (t) => {
  const f = fixture(t);
  const batch = path.join(f.root, "owned", "custom.cmd");
  writeFileSync(batch, "@echo must-not-run");
  const result = await failure(f.invoke("run_command", { executable: batch, args: [], writes: [] }));
  assert.match(result.message, /Windows batch\/script executables are unsupported/);
  assert.match(result.message, /node\.exe.*npm-cli\.js/);
  assert.equal(f.store.events(f.run.id).some((entry) => entry.type === "process_spawned"), false);
});

test("real process output is complete on disk, bounded in the tool view, and has durable PID/lifecycle evidence", async (t) => {
  const f = fixture(t);
  const output = "out\n".repeat(25_000) + "stdout-tail";
  const errors = "err\n".repeat(20_000) + "stderr-tail";
  const result = await f.invoke("run_command", {
    executable: process.execPath,
    args: ["-e", "process.stdout.write('out\\n'.repeat(25000)+'stdout-tail'); process.stderr.write('err\\n'.repeat(20000)+'stderr-tail')"],
    writes: [], timeoutSeconds: 30,
  });
  assert.equal(result.state, "succeeded");
  assert.equal(result.osSandbox, false);
  assert.equal(result.cleanup, "confirmed");
  assert.equal(result.stdout.truncated, true);
  assert.equal(result.stderr.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout.text) <= 16 * 1024);
  assert.equal(readFileSync(result.stdout.artifact.path, "utf8"), output);
  assert.equal(readFileSync(result.stderr.artifact.path, "utf8"), errors);
  assert.equal(result.stdout.artifact.sha256, digest(output));
  assert.equal(result.stderr.artifact.sha256, digest(errors));
  assert.equal(f.store.getOperation(result.operationId).pid, result.pid);
  const events = f.store.events(f.run.id);
  const spawned = events.findIndex((entry) => entry.type === "process_spawned");
  const exited = events.findIndex((entry) => entry.type === "process_exited");
  const cleaned = events.findIndex((entry) => entry.type === "process_cleanup_finished");
  const succeeded = events.findIndex((entry) => entry.type === "operation.updated" && (entry.data as any).state === "succeeded");
  assert.ok(spawned >= 0 && exited > spawned && cleaned > exited && succeeded > cleaned);
  const tail = await f.invoke("read_file", { path: `artifact:${result.stdout.artifact.id}`, offset: 25_001 });
  assert.equal(tail.content, "stdout-tail");
  if (process.platform !== "win32") assert.equal(statSync(result.stdout.artifact.path).mode & 0o077, 0);
});

test("real process children receive minimal environment and argument quoting survives spaces and quotes", async (t) => {
  const f = fixture(t);
  const secret = "fixture-secret-do-not-inherit";
  const prior = process.env.WORKBENCH_TEST_SECRET;
  const priorAws = process.env.AWS_SECRET_ACCESS_KEY;
  process.env.WORKBENCH_TEST_SECRET = secret;
  process.env.AWS_SECRET_ACCESS_KEY = secret;
  t.after(() => {
    if (prior === undefined) delete process.env.WORKBENCH_TEST_SECRET; else process.env.WORKBENCH_TEST_SECRET = prior;
    if (priorAws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = priorAws;
  });
  const argumentsToTest = ["space here", 'quote"inside', "trailing\\", "", "雪"];
  const result = await f.invoke("run_command", {
    executable: process.execPath,
    args: ["-e", "console.log(JSON.stringify({env:process.env,args:process.argv.slice(1)}))", ...argumentsToTest],
    writes: [], timeoutSeconds: 30,
  });
  const child = JSON.parse(readFileSync(result.stdout.artifact.path, "utf8"));
  assert.deepEqual(child.args, argumentsToTest);
  assert.equal(child.env.WORKBENCH_TEST_SECRET, undefined);
  assert.equal(child.env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(child.env.NODE_OPTIONS, undefined);
  assert.ok(Object.keys(child.env).some((key) => key.toLowerCase() === "path"));
  assert.ok(!JSON.stringify(child.env).includes(secret));
});

test("nonzero exits and nonexistent executables never return success", async (t) => {
  const f = fixture(t);
  const exited = await failure(f.invoke("run_command", {
    executable: process.execPath, args: ["-e", "process.stderr.write('diagnostic');process.exit(7)"], writes: [], timeoutSeconds: 30,
  }));
  assert.equal(exited.details.exitCode, 7);
  assert.equal(readFileSync((exited.details.stderr as any).artifact.path, "utf8"), "diagnostic");
  assert.equal(f.store.getOperation(exited.operationId).state, "failed");
  await failure(f.invoke("run_command", { executable: "workbench-certainly-no-such-command-61739", args: [], writes: [] }));
});

test("AbortSignal kills the owned process tree, retains output, and confirms cleanup", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const ready = path.join(f.root, "owned", "ready.txt");
  const childPidFile = path.join(f.root, "owned", "child-pid.txt");
  const descendant = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const command = [
    "const fs=require('fs'),cp=require('child_process');",
    `const child=cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});`,
    `fs.writeFileSync(${JSON.stringify(childPidFile)},String(child.pid));`,
    "process.stdout.write('before-abort\\n');",
    `fs.writeFileSync(${JSON.stringify(ready)},'ready');`,
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",
  ].join("");
  const running = f.invoke("run_command", { executable: process.execPath, args: ["-e", command], writes: ["owned"], timeoutSeconds: 30 }, controller.signal);
  const outcome = failure(running);
  await waitFor(() => existsSync(ready));
  controller.abort();
  const result = await outcome;
  assert.equal(result.details.cleanup, "confirmed");
  assert.equal((result.details.stdout as any).text, "before-abort\n");
  const childPid = Number(readFileSync(childPidFile, "utf8"));
  assert.throws(() => process.kill(childPid, 0), (error: any) => error.code === "ESRCH");
  assert.equal(f.store.getOperation(result.operationId).state, "failed");
});

test("command timeout is a safety deadline, not a successful result", async (t) => {
  const f = fixture(t);
  const began = Date.now();
  const result = await failure(f.invoke("run_command", {
    executable: process.execPath, args: ["-e", "process.stdout.write('started');setInterval(()=>{},1000)"], writes: [], timeoutSeconds: 3,
  }));
  assert.match(result.message, /timeout/);
  assert.equal(result.details.cleanup, "confirmed");
  assert.ok(Date.now() - began < 12_000);
  assert.equal(f.store.getOperation(result.operationId).state, "failed");
});

test("a parent that exits leaving descendants is cleaned and cannot report success", async (t) => {
  const f = fixture(t);
  const childPidFile = path.join(f.root, "owned", "orphan-pid.txt");
  const command = [
    "const cp=require('child_process'),fs=require('fs');",
    "const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:process.platform==='win32'});",
    `fs.writeFileSync(${JSON.stringify(childPidFile)},String(child.pid));`,
    "child.unref();",
  ].join("");
  const result = await failure(f.invoke("run_command", {
    executable: process.execPath, args: ["-e", command], writes: ["owned"], timeoutSeconds: 30,
  }));
  assert.equal(result.details.cleanup, "confirmed");
  const childPid = Number(readFileSync(childPidFile, "utf8"));
  assert.throws(() => process.kill(childPid, 0), (error: any) => error.code === "ESRCH");
});

test("broker.close cancels an active process, awaits cleanup, and prevents subsequent execution", async (t) => {
  const f = fixture(t);
  const ready = path.join(f.root, "owned", "close-ready.txt");
  const running = f.invoke("run_command", {
    executable: process.execPath,
    args: ["-e", `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`],
    writes: ["owned"], timeoutSeconds: 30,
  });
  const outcome = failure(running);
  await waitFor(() => existsSync(ready));
  await f.broker.close();
  assert.equal((await outcome).details.cleanup, "confirmed");
  await failure(f.invoke("read_file", { path: "owned/close-ready.txt" }));
});

test("missing durable cleanup evidence leaves the operation unknown and close reports it", async (t) => {
  const f = fixture(t);
  const original = f.store.addEvent.bind(f.store);
  f.store.addEvent = (runId, type, data, taskId) => {
    if (type === "process_cleanup_finished") throw new Error("Injected lifecycle persistence failure.");
    return original(runId, type, data, taskId);
  };
  const result = await failure(f.invoke("run_command", {
    executable: process.execPath, args: ["-e", "process.stdout.write('finished')"], writes: [], timeoutSeconds: 30,
  }), "unknown");
  f.store.addEvent = original;
  f.cleanupExpectation.unknown = true;
  assert.equal(result.details.cleanup, "unknown");
  assert.equal(f.store.getOperation(result.operationId).state, "unknown");
  assert.equal((result.details.stdout as any).text, "finished");
  await assert.rejects(f.broker.close(), /unresolved process cleanup/);
});

test("fetch_url preserves full response bytes, produces readable text, and labels evidence", async (t) => {
  const f = fixture(t);
  const body = "<html><script>ignore this code</script><h1>Evidence</h1><p>" + "measured text ".repeat(10_000) + "</p></html>";
  const url = await server(t, (request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  });
  const result = await f.invoke("fetch_url", { url });
  assert.equal(result.complete, true);
  assert.equal(result.truncated, true);
  assert.equal(result.trust, "untrusted-evidence");
  assert.match(result.content, /Evidence/);
  assert.ok(!result.content.includes("<html>"));
  assert.ok(!result.content.includes("ignore this code"));
  assert.equal(readFileSync(result.artifact.path, "utf8"), body);
  assert.equal(result.artifact.sha256, digest(body));
  assert.equal(result.artifact.bytes, Buffer.byteLength(body));
  assert.ok(result.artifact.path.startsWith(f.stateDir + path.sep));
});

test("fetch_url follows bounded credential-free redirects and retains binary bytes", async (t) => {
  const f = fixture(t);
  const binary = Buffer.from([0, 255, 254, 1, 2, 3]);
  const url = await server(t, (request, response) => {
    if (request.url === "/redirect") { response.writeHead(302, { location: "/binary" }); response.end("redirect evidence"); }
    else { response.writeHead(200, { "content-type": "application/octet-stream" }); response.end(binary); }
  });
  const result = await f.invoke("fetch_url", { url: url + "/redirect" });
  assert.equal(result.redirects.length, 1);
  assert.equal(result.redirects[0].status, 302);
  assert.equal(result.url, url + "/binary");
  assert.deepEqual(readFileSync(result.artifact.path), binary);
  assert.match(result.content, /Binary response/);
});

test("HTTP read limits and cancellation leave explicit incomplete evidence and failure", async (t) => {
  const f = fixture(t);
  let observedSlow!: () => void;
  const slow = new Promise<void>((resolve) => { observedSlow = resolve; });
  const url = await server(t, (request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    if (request.url === "/large") response.end(Buffer.alloc(8 * 1024 * 1024 + 1024, 97));
    else { response.write("partial"); observedSlow(); }
  });
  const oversized = await failure(f.invoke("fetch_url", { url: url + "/large" }));
  assert.equal(oversized.details.complete, false);
  assert.equal((oversized.details.artifact as any).bytes, 8 * 1024 * 1024);
  const controller = new AbortController();
  const pending = failure(f.invoke("fetch_url", { url: url + "/slow" }, controller.signal));
  await slow;
  controller.abort();
  const aborted = await pending;
  assert.equal(aborted.details.complete, false);
  assert.equal(f.store.getOperation(aborted.operationId).state, "failed");
});

test("prepared HTTP actions are canonical, approved once, use a stable key and cannot replay", async (t) => {
  const f = fixture(t);
  const received: { method: string; body: string; key: string | string[] | undefined; headers: http.IncomingHttpHeaders }[] = [];
  const url = await server(t, (request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received.push({ method: request.method!, body, key: request.headers["idempotency-key"], headers: request.headers });
      response.writeHead(201, { "content-type": "application/json" });
      response.end('{"created":true}');
    });
  });
  const prepared = await f.invoke("prepare_http_request", {
    method: "post", url: url + "/records#irrelevant",
    headers: { "X-Trace": " fixture ", "Content-Type": "application/json" }, body: '{"name":"test"}',
  });
  assert.equal(prepared.state, "prepared");
  assert.equal(prepared.action.url, url + "/records");
  assert.equal(prepared.action.method, "POST");
  assert.deepEqual(prepared.action.headers, { "content-type": "application/json", "x-trace": "fixture" });
  assert.equal(received.length, 0);
  assert.equal(f.store.getApproval(prepared.approvalId).state, "pending");
  await failure(f.invoke("execute_http_request", { approvalId: prepared.approvalId }));
  f.store.decideApproval(prepared.approvalId, true);
  const result = await f.invoke("execute_http_request", { approvalId: prepared.approvalId });
  assert.equal(result.operationId, prepared.operationId);
  assert.equal(result.state, "succeeded");
  assert.equal(f.store.getApproval(prepared.approvalId).state, "consumed");
  assert.equal(received.length, 1);
  assert.equal(received[0].method, "POST");
  assert.equal(received[0].body, '{"name":"test"}');
  assert.equal(received[0].key, prepared.operationId);
  assert.equal(received[0].headers.authorization, undefined);
  assert.equal(received[0].headers.cookie, undefined);
  assert.equal(result.artifact.sha256, digest('{"created":true}'));
  await failure(f.invoke("execute_http_request", { approvalId: prepared.approvalId }));
  assert.equal(received.length, 1);
  assert.equal(f.store.getOperation(prepared.operationId).state, "succeeded");
});

test("approval mismatches and approvals belonging to another task cannot dispatch", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const url = await server(t, (_request, response) => { calls++; response.end("ok"); });
  const prepared = await f.invoke("prepare_http_request", { method: "DELETE", url: url + "/one" });
  f.store.decideApproval(prepared.approvalId, true);
  const original = f.store.getApproval.bind(f.store);
  f.store.getApproval = (id) => ({ ...original(id), action: { ...(original(id).action as any), url: url + "/two" } });
  await failure(f.invoke("execute_http_request", { approvalId: prepared.approvalId }));
  f.store.getApproval = original;
  assert.equal(original(prepared.approvalId).state, "approved");
  await failure(f.invoke("execute_http_request", { approvalId: prepared.approvalId, url: url + "/override" }));
  const other = f.store.createTask(f.run.id, { objective: "Other task", writePaths: [] });
  assert.equal(f.store.startTask(other.id), true);
  const otherTool = f.broker.tools({ ...f.context, task: f.store.getTask(other.id) }).find((entry) => entry.name === "execute_http_request")!;
  await failure(otherTool.execute({ approvalId: prepared.approvalId }));
  assert.equal(calls, 0);
});

test("simultaneous approval execution has exactly one dispatch", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const url = await server(t, (_request, response) => { calls++; setTimeout(() => response.end("confirmed"), 30); });
  const prepared = await f.invoke("prepare_http_request", { method: "PUT", url, body: "value" });
  f.store.decideApproval(prepared.approvalId, true);
  const results = await Promise.allSettled([
    f.invoke("execute_http_request", { approvalId: prepared.approvalId }),
    f.invoke("execute_http_request", { approvalId: prepared.approvalId }),
  ]);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(calls, 1);
});

test("owner HTTP grants approve exact-origin path descendants, record authority, and still consume once", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const url = await server(t, (request, response) => {
    calls++;
    assert.equal(request.url, "/records/item");
    response.end("changed");
  });
  Object.assign(f.config, { httpGrants: [{ methods: ["post"], urlPrefix: url + "/records/" }] });
  const prepared = await f.invoke("prepare_http_request", { method: "POST", url: url + "/records/item", body: "permitted" });
  assert.equal(prepared.requiresApproval, false);
  assert.equal(prepared.approvalState, "approved");
  assert.deepEqual(prepared.grantUsed, { index: 0, methods: ["POST"], urlPrefix: url + "/records" });
  assert.equal(f.store.getApproval(prepared.approvalId).state, "approved");
  assert.equal(calls, 0, "Preparation must not dispatch an effect.");
  const result = await f.invoke("execute_http_request", { approvalId: prepared.approvalId });
  assert.equal(result.state, "succeeded");
  assert.deepEqual(result.grantUsed, prepared.grantUsed);
  assert.equal(f.store.getApproval(prepared.approvalId).state, "consumed");
  assert.equal(calls, 1);
  assert.ok(f.store.events(f.run.id).some((entry) => entry.type === "http_grant_authorized"
    && (entry.data as any).approvalId === prepared.approvalId));
  await failure(f.invoke("execute_http_request", { approvalId: prepared.approvalId }));
  assert.equal(calls, 1);
});

test("HTTP grants do not authorize other methods, lookalike prefixes, origins, or encoded path escapes", async (t) => {
  const f = fixture(t);
  Object.assign(f.config, { httpGrants: [{ methods: ["POST"], urlPrefix: "http://127.0.0.1:41234/records" }] });
  const cases = [
    { method: "DELETE", url: "http://127.0.0.1:41234/records/one" },
    { method: "POST", url: "http://127.0.0.1:41234/records-other" },
    { method: "POST", url: "http://127.0.0.1:41235/records/one" },
    { method: "POST", url: "http://localhost:41234/records/one" },
    { method: "POST", url: "https://127.0.0.1:41234/records/one" },
    { method: "POST", url: "http://127.0.0.1:41234/records/../outside" },
    { method: "POST", url: "http://127.0.0.1:41234/records/%2f..%2foutside" },
    { method: "POST", url: "http://127.0.0.1:41234/records/%252e%252e/outside" },
  ];
  for (const action of cases) {
    const prepared = await f.invoke("prepare_http_request", action);
    assert.equal(prepared.requiresApproval, true, action.url);
    assert.equal(f.store.getApproval(prepared.approvalId).state, "pending");
  }
  const exact = await f.invoke("prepare_http_request", { method: "POST", url: "http://127.0.0.1:41234/records" });
  assert.equal(exact.requiresApproval, false);
});

test("HTTP defaults require approval, model claims grant no authority, and revoked grants cannot dispatch", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const url = await server(t, (_request, response) => { calls++; response.end(); });
  const untrusted = await f.invoke("prepare_http_request", {
    method: "POST", url, approved: true, httpGrants: [{ methods: ["POST"], urlPrefix: url }],
  });
  assert.equal(untrusted.requiresApproval, true);
  assert.equal(f.store.getApproval(untrusted.approvalId).state, "pending");
  Object.assign(f.config, { httpGrants: [{ methods: ["POST"], urlPrefix: url }] });
  const authorized = await f.invoke("prepare_http_request", { method: "POST", url });
  assert.equal(authorized.requiresApproval, false);
  Object.assign(f.config, { httpGrants: [] });
  const revoked = await failure(f.invoke("execute_http_request", { approvalId: authorized.approvalId }));
  assert.match(revoked.message, /grant changed or was revoked/);
  assert.equal(f.store.getApproval(authorized.approvalId).state, "approved");
  assert.equal(calls, 0);
});

test("HTTP grants cannot bypass secret rejection and invalid grant prefixes fail closed", async (t) => {
  const f = fixture(t);
  Object.assign(f.config, { httpGrants: [{ methods: ["POST"], urlPrefix: "http://127.0.0.1/" }] });
  await failure(f.invoke("prepare_http_request", { method: "POST", url: "http://127.0.0.1/", headers: { Authorization: "Bearer forbidden" } }));
  assert.equal(f.store.approvals(f.run.id).length, 0);
  Object.assign(f.config, { httpGrants: [{ methods: ["POST"], urlPrefix: "http://127.0.0.1/records?selected=yes" }] });
  await failure(f.invoke("prepare_http_request", { method: "POST", url: "http://127.0.0.1/records" }));
  assert.equal(f.store.approvals(f.run.id).length, 0);
});

test("credential headers and secret-bearing URL/body actions are rejected before persistence", async (t) => {
  const f = fixture(t);
  const secret = "do-not-persist-7b3ae-SECRET";
  const cases = [
    { headers: { Authorization: `Bearer ${secret}` } },
    { headers: { Cookie: `session=${secret}` } },
    { headers: { "X-Api-Key": secret } },
    { headers: { "X-Access-Token": secret } },
    { headers: { "X-ClientSecret": secret } },
    { body: JSON.stringify({ nested: { password: secret } }) },
    { body: `api_key=${secret}` },
    { url: `http://127.0.0.1/test?access_token=${secret}` },
    { url: `http://user:${secret}@127.0.0.1/test` },
    { headers: { "Idempotency-Key": secret } },
  ];
  for (const entry of cases) {
    await failure(f.invoke("prepare_http_request", { method: "POST", url: "http://127.0.0.1/never", ...entry }));
  }
  await failure(f.invoke("fetch_url", { url: `http://127.0.0.1/never?token=${secret}` }));
  assert.equal(f.store.approvals(f.run.id).length, 0);
  const history = JSON.stringify({ operations: f.store.operations(f.run.id), events: f.store.events(f.run.id) });
  assert.ok(!history.includes(secret));
  assert.ok(!history.includes("Bearer "));
});

test("a lost response after an external effect is unknown, survives reopen, and is never automatically replayed", async (t) => {
  const f = fixture(t);
  let effects = 0;
  let seenKey: string | string[] | undefined;
  const url = await server(t, (request) => {
    request.resume();
    request.on("end", () => {
      effects++;
      seenKey = request.headers["idempotency-key"];
      request.socket.destroy();
    });
  });
  const prepared = await f.invoke("prepare_http_request", { method: "POST", url, body: "one-effect" });
  f.store.decideApproval(prepared.approvalId, true);
  const lost = await failure(f.invoke("execute_http_request", { approvalId: prepared.approvalId }), "unknown");
  assert.equal(lost.operationId, prepared.operationId);
  assert.equal(lost.details.retry, "reconcile-first");
  assert.equal(f.store.getOperation(prepared.operationId).state, "unknown");
  assert.equal(f.store.getApproval(prepared.approvalId).state, "consumed");
  assert.equal(effects, 1);
  assert.equal(seenKey, prepared.operationId);
  const reopened = new Store(f.stateDir);
  const broker = new ToolBroker(reopened, f.config);
  try {
    const execute = broker.tools(f.context).find((entry) => entry.name === "execute_http_request")!;
    await failure(execute.execute({ approvalId: prepared.approvalId }));
    assert.equal(reopened.getOperation(prepared.operationId).state, "unknown");
    assert.equal(effects, 1);
  } finally { await broker.close(); reopened.close(); }
});

test("HTTP server errors do not become green or allow redirect-based mutation replay", async (t) => {
  const f = fixture(t);
  let redirected = 0;
  const url = await server(t, (request, response) => {
    if (request.url === "/error") { response.writeHead(500); response.end("after-effect failure"); }
    else if (request.url === "/redirect") { response.writeHead(307, { location: "/destination" }); response.end(); }
    else { redirected++; response.end(); }
  });
  const error = await f.invoke("prepare_http_request", { method: "POST", url: url + "/error" });
  f.store.decideApproval(error.approvalId, true);
  await failure(f.invoke("execute_http_request", { approvalId: error.approvalId }), "unknown");
  const redirect = await f.invoke("prepare_http_request", { method: "POST", url: url + "/redirect" });
  f.store.decideApproval(redirect.approvalId, true);
  await failure(f.invoke("execute_http_request", { approvalId: redirect.approvalId }));
  assert.equal(redirected, 0);
});

test("native artifact registration failure reports an unknown completed write", async (t) => {
  const f = fixture(t);
  const original = f.store.addArtifact.bind(f.store);
  f.store.addArtifact = () => { throw new Error("fixture evidence disk failure"); };
  const result = await failure(f.invoke("write_file", { path: "owned/written.txt", content: "already written" }), "unknown");
  f.store.addArtifact = original;
  assert.equal(readFileSync(path.join(f.root, "owned/written.txt"), "utf8"), "already written");
  assert.equal(f.store.getOperation(result.operationId).state, "unknown");
});

test("registered evidence is isolated by run and checked against its hash", async (t) => {
  const f = fixture(t);
  const url = await server(t, (_request, response) => { response.setHeader("content-type", "text/plain"); response.end("original"); });
  const fetched = await f.invoke("fetch_url", { url });
  const read = await f.invoke("read_file", { path: fetched.artifact.path });
  assert.equal(read.content, "original");
  await failure(f.invoke("read_file", { path: path.join(f.stateDir, "workbench.sqlite") }));
  await failure(f.invoke("read_file", { path: "artifact:not-this-run" }));
  writeFileSync(fetched.artifact.path, "tampered");
  await failure(f.invoke("read_file", { path: `artifact:${fetched.artifact.id}` }));
});

test("reviewers can read/list/search their bound immutable candidate root but cannot browse private-state siblings", async (t) => {
  const f = fixture(t);
  const candidate = path.join(f.stateDir, "runs", f.run.id, "candidates", "candidate-fixture", "root");
  mkdirSync(path.join(candidate, "nested"), { recursive: true });
  writeFileSync(path.join(candidate, "nested", "report.txt"), "immutable evidence\n");
  writeFileSync(path.join(candidate, "..", "manifest.json"), '{"private":"manifest"}');
  const reviewer = f.store.createTask(f.run.id, { objective: "Review immutable copy", parentId: f.task.id, role: "reviewer" });
  assert.equal(f.store.startTask(reviewer.id), true);
  const tools = f.broker.tools({ ...f.context, run: { ...f.run, cwd: candidate }, task: f.store.getTask(reviewer.id) });
  const call = (name: string, args: unknown): Promise<any> => tools.find((entry) => entry.name === name)!.execute(args);
  const listed = await call("list_files", { depth: 2 });
  assert.ok(listed.files.includes(path.join("nested", "report.txt")));
  assert.equal((await call("read_file", { path: "nested/report.txt" })).content, "immutable evidence\n");
  assert.equal((await call("search_files", { query: "immutable" })).matches.length, 1);
  for (const name of ["list_files", "search_files", "read_file"]) {
    await failure(call(name, { path: "..", query: "private" }));
    await failure(call(name, { path: path.join(f.stateDir, "workbench.sqlite"), query: "private" }));
  }
  assert.ok(!tools.some((entry) => ["write_file", "edit_file", "run_command", "prepare_http_request", "execute_http_request"].includes(entry.name)));
  const invalidRoot = f.broker.tools({ ...f.context, run: { ...f.run, cwd: f.stateDir }, task: f.store.getTask(reviewer.id) });
  await failure(invalidRoot.find((entry) => entry.name === "list_files")!.execute({}));
});

test("read_artifact gives reviewers bounded author receipts by ID without granting sibling-task or other-run access", async (t) => {
  const f = fixture(t);
  const receiptPath = path.join(f.stateDir, "receipt.bin");
  const content = "author-command-output\n".repeat(5_000) + "receipt-tail";
  writeFileSync(receiptPath, content);
  const artifact = f.store.addArtifact(f.run.id, f.task.id, receiptPath, digest(content), Buffer.byteLength(content), "text/plain");
  const reviewer = f.store.createTask(f.run.id, { objective: "Review author receipts", parentId: f.task.id, role: "reviewer" });
  assert.equal(f.store.startTask(reviewer.id), true);
  const candidate = path.join(f.stateDir, "runs", f.run.id, "candidates", "candidate-receipts", "root");
  mkdirSync(candidate, { recursive: true });
  const tools = f.broker.tools({ ...f.context, run: { ...f.run, cwd: candidate }, task: f.store.getTask(reviewer.id) });
  const read = tools.find((entry) => entry.name === "read_artifact")!;
  const first = await read.execute({ artifactId: artifact.id }) as any;
  assert.equal(first.bytesRead, 16 * 1024);
  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, 16 * 1024);
  const last = await read.execute({ artifactId: artifact.id, offset: artifact.bytes - 12, limit: 12 }) as any;
  assert.equal(last.content, "receipt-tail");
  assert.equal(last.truncated, false);
  await failure(read.execute({ artifactId: path.join(f.stateDir, "workbench.sqlite") }));
  const sibling = f.store.createTask(f.run.id, { objective: "Unrelated author", writePaths: [] });
  const siblingReceipt = f.store.addArtifact(f.run.id, sibling.id, receiptPath, digest(content), Buffer.byteLength(content), "text/plain");
  await failure(read.execute({ artifactId: siblingReceipt.id }));
  const otherRun = f.store.createRun("Other run", f.root);
  const otherTask = f.store.createTask(otherRun.id, { objective: "Other run task" });
  const otherReceipt = f.store.addArtifact(otherRun.id, otherTask.id, receiptPath, digest(content), Buffer.byteLength(content), "text/plain");
  await failure(read.execute({ artifactId: otherReceipt.id }));
  writeFileSync(receiptPath, "changed");
  await failure(read.execute({ artifactId: artifact.id }));
});
