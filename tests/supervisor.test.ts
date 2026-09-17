import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { nativeDefaults as defaults } from "../src/config.js";
import { Store } from "../src/store.js";
import { ToolBroker } from "../src/broker.js";
import { Supervisor } from "../src/supervisor.js";
import type { AgentAdapter, AgentRequest, AgentReply } from "../src/contracts.js";

async function call(request: AgentRequest, name: string, args: unknown) {
  const tool = request.tools.find((entry) => entry.name === name);
  assert.ok(tool, `Missing ${name}`);
  return tool.execute(args, request.signal);
}
function reply(request: AgentRequest): AgentReply {
  return { text: "Recorded result.", stopReason: "stop", model: request.route.model, provider: request.route.provider };
}
async function fixture(handler: (request: AgentRequest) => Promise<AgentReply>) {
  const root = await mkdtemp(join(tmpdir(), "workbench-supervisor-"));
  const project = join(root, "project");
  await mkdir(project);
  const config = defaults(join(root, "home"));
  config.maxWorkers = 2;
  const store = new Store(config.stateDir);
  const broker = new ToolBroker(store, config);
  const adapter: AgentAdapter = { run: handler, doctor: async () => ({ ok: true, checks: {} }) };
  const supervisor = new Supervisor(store, broker, adapter, config);
  return { root, project, config, store, supervisor,
    async close() { await supervisor.close(); await broker.close(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("two independent modules execute in parallel and integrated result receives a separate review", async () => {
  let workers = 0, peak = 0, reviews = 0;
  const f = await fixture(async (request) => {
    if (request.task.role === "reviewer") {
      reviews++;
      const list = await call(request, "list_files", {}) as any;
      assert.ok(list);
      await call(request, "review_result", { verdict: "pass", findings: [], evidence: [request.task.objective.includes("beta") ? "beta.txt" : "alpha.txt"] });
    } else if (request.task.role === "worker") {
      workers++; peak = Math.max(peak, workers);
      await delay(40);
      const name = request.task.writePaths[0];
      await call(request, "write_file", { path: name, content: name });
      await call(request, "submit_result", { summary: `Created ${name}`, evidence: [name] });
      workers--;
    } else {
      const first = await call(request, "delegate_task", { objective: "Create alpha", writePaths: ["alpha.txt"], acceptance: ["alpha.txt contains its name"] }) as any;
      const second = await call(request, "delegate_task", { objective: "Create beta", writePaths: ["beta.txt"], acceptance: ["beta.txt contains its name"] }) as any;
      const results = await call(request, "wait_tasks", { ids: [first.id, second.id] }) as any[];
      assert.ok(results.every((task) => task.state === "accepted"), JSON.stringify(results));
      await call(request, "write_file", { path: "result.txt", content: "alpha + beta" });
      await call(request, "submit_result", { summary: "Both modules integrated.", evidence: ["alpha.txt", "beta.txt", "result.txt"] });
    }
    return reply(request);
  });
  try {
    const run = f.supervisor.create("Integrate two independent modules.", f.project);
    const result = await f.supervisor.execute(run.id);
    assert.equal(result.state, "accepted", result.result);
    assert.equal(peak, 2);
    assert.equal(reviews, 3);
    assert.equal(await readFile(join(f.project, "result.txt"), "utf8"), "alpha + beta");
    assert.ok(f.store.events(run.id).some((event) => event.type === "candidate.created"));
    assert.ok(f.store.tasks(run.id).filter((task) => task.role === "reviewer").every((task) => task.state === "accepted"));
  } finally { await f.close(); }
});

test("ordinary model turns continue; repeated absence of progress blocks instead of claiming success", async () => {
  let turns = 0;
  const f = await fixture(async (request) => { turns++; return reply(request); });
  try {
    const run = f.supervisor.create("Produce a deliverable.", f.project);
    const result = await f.supervisor.execute(run.id);
    assert.equal(result.state, "blocked");
    assert.equal(turns, f.config.noProgressLimit);
    assert.match(result.result || "", /no new tool or artifact progress/);
  } finally { await f.close(); }
});

test("a repeating tool loop is stopped inside a model turn without a task-length cap", async () => {
  let calls = 0;
  const f = await fixture(async (request) => {
    for (let index = 0; index < 20; index++) {
      calls++;
      await call(request, "load_capability", { name: "documents" });
    }
    return reply(request);
  });
  try {
    const run = f.supervisor.create("Write a useful document.", f.project);
    const result = await f.supervisor.execute(run.id);
    assert.equal(result.state, "blocked");
    assert.ok(calls <= f.config.noProgressLimit + 1);
    assert.match(result.result || "", /Repeated tool calls/);
    assert.ok(f.store.events(run.id).some((event) => event.type === "task.no_progress"));
  } finally { await f.close(); }
});

test("repeated rejected tools also stop inside the same model turn", async () => {
  let calls = 0;
  const f = await fixture(async (request) => {
    for (let index = 0; index < 20 && !request.signal.aborted; index++) {
      calls++;
      try { await call(request, "read_file", { path: "missing.txt" }); } catch { /* Match SDK tool-error handling. */ }
    }
    return reply(request);
  });
  try {
    const run = f.supervisor.create("Find useful evidence instead of repeating the same failed read.", f.project);
    const result = await f.supervisor.execute(run.id);
    assert.equal(result.state, "blocked");
    assert.ok(calls <= f.config.noProgressLimit + 2, `Repeated ${calls} failed calls.`);
    assert.ok(f.store.operations(run.id).some((operation) => operation.kind === "read_file" && operation.state === "failed"));
  } finally { await f.close(); }
});

test("changed evidence after a rejected tool permits useful continuation", async () => {
  const f = await fixture(async (request) => {
    if (request.task.role === "reviewer") {
      await call(request, "review_result", { verdict: "pass", findings: [], evidence: ["report.txt"] });
    } else {
      try { await call(request, "read_file", { path: "report.txt" }); } catch { /* The output does not yet exist. */ }
      await call(request, "write_file", { path: "report.txt", content: "New useful evidence." });
      await call(request, "read_file", { path: "report.txt" });
      await call(request, "submit_result", { summary: "Created and read the report.", evidence: ["report.txt"] });
    }
    return reply(request);
  });
  try {
    const run = f.supervisor.create("Produce a report.", f.project);
    const result = await f.supervisor.execute(run.id);
    assert.equal(result.state, "accepted", result.result);
  } finally { await f.close(); }
});

test("repeated SDK tool-validation failures stop even when no broker tool is reached", async () => {
  let attempts = 0;
  const f = await fixture(async (request) => {
    while (attempts < 20 && !request.signal.aborted) {
      attempts++;
      request.onEvent("tool_execution_start", { toolName: "unknown", toolCallId: `call-${attempts}` });
      request.onEvent("tool_execution_end", { toolName: "unknown", toolCallId: `call-${attempts}`, isError: true });
    }
    return reply(request);
  });
  try {
    const run = f.supervisor.create("Use actual available tools.", f.project);
    const result = await f.supervisor.execute(run.id);
    assert.equal(result.state, "blocked");
    assert.equal(attempts, f.config.noProgressLimit);
    assert.match(result.result || "", /failed validation/);
  } finally { await f.close(); }
});

test("optional SDK telemetry fields do not abort a completed model operation", async () => {
  const f = await fixture(async (request) => {
    request.onEvent("provider_end", { stopReason: "stop", errorCode: undefined, rawStopReason: undefined, usage: { input: 1, output: 1 } });
    if (request.task.role === "reviewer") {
      await call(request, "review_result", { verdict: "pass", findings: [], evidence: ["report.txt"] });
    } else {
      await call(request, "write_file", { path: "report.txt", content: "Retained evidence." });
      await call(request, "submit_result", { summary: "Report complete.", evidence: ["report.txt"] });
    }
    return reply(request);
  });
  try {
    const run = f.supervisor.create("Write a report.", f.project);
    const result = await f.supervisor.execute(run.id);
    assert.equal(result.state, "accepted", result.result);
    const event = f.store.events(run.id).find((entry) => entry.type === "provider_end");
    assert.ok(event);
    assert.deepEqual(event.data, { stopReason: "stop", usage: { input: 1, output: 1 } });
  } finally { await f.close(); }
});

test("checkpoint references recover full visible evidence without exposing author history to a reviewer", async () => {
  let contextArtifact = "";
  const f = await fixture(async (request) => {
    if (request.task.role === "reviewer") {
      await assert.rejects(call(request, "read_artifact", { artifactId: contextArtifact }), /private to their task/);
      await call(request, "review_result", { verdict: "pass", findings: [], evidence: ["report.txt"] });
    } else {
      const directory = join(request.sessionDir, "checkpoints");
      await mkdir(directory, { recursive: true });
      const path = join(directory, "fixture.json");
      const original = JSON.stringify({ version: 1, runId: request.run.id, taskId: request.task.id, entries: [
        { type: "message", message: { role: "assistant", content: [
          { type: "thinking", thinking: "PRIVATE_VENDOR_SENTINEL" }, { type: "text", text: "Visible answer" },
        ] } },
        { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "COMPLETE_TOOL_EVIDENCE" }],
          details: { encrypted_content: "legitimate tool data" } } },
      ] });
      await writeFile(path, original);
      request.onEvent("checkpoint_end", { path, bytes: Buffer.byteLength(original), sha256: createHash("sha256").update(original).digest("hex") });
      const restored = await call(request, "read_file", { path }) as any;
      assert.match(restored.content, /COMPLETE_TOOL_EVIDENCE/);
      assert.match(restored.content, /legitimate tool data/);
      assert.doesNotMatch(restored.content, /PRIVATE_VENDOR_SENTINEL/);
      contextArtifact = restored.artifact.id;
      await call(request, "write_file", { path: "report.txt", content: "Visible evidence restored." });
      await call(request, "submit_result", { summary: "Report complete.", evidence: ["report.txt"] });
    }
    return reply(request);
  });
  try {
    const run = f.supervisor.create("Continue from retained visible evidence.", f.project);
    const result = await f.supervisor.execute(run.id);
    assert.equal(result.state, "accepted", result.result);
    assert.ok(contextArtifact);
  } finally { await f.close(); }
});

test("failed independent review returns repairs to the author before acceptance", async () => {
  let written = 0, reviewed = 0;
  const f = await fixture(async (request) => {
    if (request.task.role === "reviewer") {
      reviewed++;
      await call(request, "review_result", { verdict: reviewed === 1 ? "fail" : "pass",
        findings: reviewed === 1 ? ["Improve the first version."] : [], evidence: ["report.txt"] });
    } else {
      written++;
      await call(request, "write_file", { path: "report.txt", content: `version ${written}` });
      await call(request, "submit_result", { summary: "Report complete.", evidence: ["report.txt"] });
    }
    return reply(request);
  });
  try {
    const run = f.supervisor.create("Write a report.", f.project);
    const result = await f.supervisor.execute(run.id);
    assert.equal(result.state, "accepted", result.result);
    assert.equal(written, 2);
    assert.equal(reviewed, 2);
    assert.equal(f.store.tasks(run.id).filter((task) => task.state === "failed").length, 1);
  } finally { await f.close(); }
});

test("a tool-submitted verdict followed by model failure is NO_VERDICT", async () => {
  const f = await fixture(async (request) => {
    if (request.task.role === "reviewer") {
      await call(request, "review_result", { verdict: "pass", findings: [], evidence: ["report.txt"] });
      throw new Error("Provider failed after partial output.");
    }
    await call(request, "write_file", { path: "report.txt", content: "evidence" });
    await call(request, "submit_result", { summary: "Report complete.", evidence: ["report.txt"] });
    return reply(request);
  });
  try {
    const run = f.supervisor.create("Write a report.", f.project);
    const result = await f.supervisor.execute(run.id);
    assert.equal(result.state, "blocked");
    const review = f.store.tasks(run.id).find((task) => task.role === "reviewer");
    assert.match(review?.result || "", /NO_VERDICT/);
  } finally { await f.close(); }
});

test("new steering invalidates a submission produced before the correction was read", async () => {
  let turns = 0;
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(async (request) => {
    if (request.task.role === "reviewer") {
      await call(request, "review_result", { verdict: "pass", findings: [], evidence: ["report.txt"] });
    } else {
      turns++;
      await call(request, "write_file", { path: "report.txt", content: turns === 1 ? "old requirement" : "new requirement" });
      if (turns === 1) f.store.addEvent(request.run.id, "user.steering", { instruction: "Use the new requirement." });
      await call(request, "submit_result", { summary: "Report complete.", evidence: ["report.txt"] });
    }
    return reply(request);
  });
  try {
    const run = f.supervisor.create("Write a report.", f.project);
    const result = await f.supervisor.execute(run.id);
    assert.equal(result.state, "accepted", result.result);
    assert.equal(turns, 2);
    assert.equal(await readFile(join(f.project, "report.txt"), "utf8"), "new requirement");
  } finally { await f.close(); }
});

test("unresolved effects prevent resume and remain visible in the ledger", async () => {
  const f = await fixture(async (request) => reply(request));
  try {
    const run = f.supervisor.create("Update external records.", f.project);
    const task = f.store.tasks(run.id)[0];
    f.store.startTask(task.id);
    const operation = f.store.createOperation(run.id, task.id, "http.mutate", { target: "fixture" });
    f.store.updateOperation(operation.id, { state: "running" });
    f.store.updateOperation(operation.id, { state: "unknown" });
    await assert.rejects(f.supervisor.execute(run.id), /reconciliation/);
    assert.equal(f.store.getOperation(operation.id).state, "unknown");
  } finally { await f.close(); }
});

test("a non-retryable provider refusal never selects a configured peer", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    throw Object.assign(new Error("Provider policy refusal."), { retryable: false });
  });
  try {
    f.config.fallbacks = [{ ...f.config.worker }];
    const run = f.supervisor.create("Prepare a report.", f.project);
    const result = await f.supervisor.execute(run.id);
    assert.equal(result.state, "blocked");
    assert.equal(calls, 1);
    assert.match(result.result || "", /policy refusal/);
  } finally { await f.close(); }
});
