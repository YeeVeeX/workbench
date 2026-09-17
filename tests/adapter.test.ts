import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttp2Server, type Http2ServerRequest, type Http2ServerResponse } from "node:http2";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { stream as stockBedrockStream } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { type Context, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { PiAdapter, WorkbenchResourceLoader, contextBudget } from "../src/adapter.js";
import {
  AdapterError,
  MAX_OUTPUT_TOKENS,
  RECOMMENDED_ROUTES,
  bedrockWorkerEnvironment,
  createNativeProvider,
  createSigningFetch,
  normalizeRoute,
  projectNativeContext,
  resolveRouteModel,
  streamNativeIsolated,
  type AdapterErrorCode,
  type ProviderDependencies,
} from "../src/providers.js";
import type { AgentRequest, ModelRoute, WorkbenchConfig } from "../src/contracts.js";
import { Store } from "../src/store.js";

const credentials = async () => ({
  accessKeyId: "AKID_SYNTHETIC_ONLY",
  secretAccessKey: "SYNTHETIC_SECRET_NEVER_LOG",
  sessionToken: "SYNTHETIC_SESSION_NEVER_LOG",
});
const nativeUsage = {
  input_tokens: 20, output_tokens: 9, total_tokens: 29,
  input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 4 },
};
const reasoning = {
  type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "encrypted-fixture-reasoning",
};
const toolCall = {
  type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "remember",
  arguments: '{"value":"saved"}', status: "completed",
};
const textItem = (text = "Completed fixture answer.") => ({
  type: "message", id: "msg_fixture", role: "assistant", phase: "final_answer", status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});

function events(
  items: Record<string, unknown>[] = [reasoning, textItem()],
  status: string | undefined = "completed",
  extra: Record<string, unknown> = {},
) {
  return [
    { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
    ...items.flatMap((item, index) => [
      { type: "response.output_item.added", output_index: index, item },
      { type: "response.output_item.done", output_index: index, item },
    ]),
    {
      type: status === "incomplete" ? "response.incomplete" : status === "failed" ? "response.failed" : "response.completed",
      response: { id: "resp_fixture", model: "global.openai.gpt-6-astra", status, usage: nativeUsage, output: items, ...extra },
    },
  ];
}

/** Fragment across UTF-8 and SSE frame boundaries to exercise the native parser. */
function sse(data: unknown[], status = 200): Response {
  const encoded = new TextEncoder().encode(data.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n");
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < encoded.length; index += 17) controller.enqueue(encoded.slice(index, index + 17));
      controller.close();
    },
  }), { status, headers: { "content-type": "text/event-stream", "x-request-id": "synthetic-request" } });
}

async function fixture(t: TestContext, route: ModelRoute = RECOMMENDED_ROUTES.astra) {
  const root = await mkdtemp(join(tmpdir(), "workbench-adapter-"));
  t.after(async () => {
    // mkdtemp produced this test-owned absolute directory.
    assert.ok(resolve(root).startsWith(resolve(tmpdir())));
    await rm(root, { recursive: true, force: true });
  });
  const cwd = join(root, "project");
  await mkdir(cwd);
  const config: WorkbenchConfig = {
    version: 1, stateDir: join(root, "state"), maxWorkers: 2, noProgressLimit: 3, execution: "trusted-local",
    coordinator: RECOMMENDED_ROUTES.fable, worker: RECOMMENDED_ROUTES.astra, reviewer: RECOMMENDED_ROUTES.fable,
    fallbacks: [], capabilities: [], mcp: {},
  };
  const now = new Date().toISOString();
  const observations: { type: string; data: any }[] = [];
  const request: AgentRequest = {
    run: { id: "run-fixture", objective: "fixture", cwd, state: "running", createdAt: now, updatedAt: now },
    task: {
      id: "task-fixture", runId: "run-fixture", objective: "fixture", role: "worker", state: "running",
      dependsOn: [], writePaths: [], acceptance: [], evidence: [], attempt: 1, createdAt: now, updatedAt: now,
    },
    prompt: "Complete this fixture task.",
    systemPrompt: "Parent instructions: SELECTED_AGENTS_SOURCE SELECTED_CLAUDE_SOURCE.",
    tools: [], route, signal: new AbortController().signal, sessionDir: join(root, "sessions"),
    onEvent: (type, data) => { observations.push({ type, data }); },
  };
  return { root, cwd, config, request, observations };
}

const hasCode = (code: AdapterErrorCode) => (error: unknown) => {
  assert.ok(error instanceof AdapterError);
  assert.equal(error.code, code);
  return true;
};

async function transcript(request: AgentRequest) {
  const key = createHash("sha256").update(JSON.stringify([request.run.id, request.task.id])).digest("hex");
  const dir = join(request.sessionDir, key);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  assert.equal(files.length, 1);
  const path = join(dir, files[0]);
  return { path, dir, text: await readFile(path, "utf8"), manager: SessionManager.continueRecent(request.run.cwd, dir) };
}

test("configured aliases resolve to native models with exact maximum effort", () => {
  for (const route of Object.values(RECOMMENDED_ROUTES)) {
    const model = resolveRouteModel(route);
    assert.equal(model.thinkingLevelMap?.max, "max");
    assert.equal(model.maxTokens, 128000);
    assert.equal(model.provider, route.provider);
    assert.ok(model.baseUrl.startsWith("https://bedrock-runtime.us-east-1.amazonaws.com"));
  }
  assert.throws(() => normalizeRoute({ ...RECOMMENDED_ROUTES.astra, effort: "xhigh" }), hasCode("effort_mismatch"));
  assert.throws(() => resolveRouteModel({ ...RECOMMENDED_ROUTES.fable, model: "us.anthropic.claude-haiku-4-5" }), hasCode("unsupported_route"));
  assert.throws(() => normalizeRoute({ ...RECOMMENDED_ROUTES.astra, provider: "shared-gateway" }), hasCode("unsupported_route"));
  assert.throws(() => normalizeRoute({ ...RECOMMENDED_ROUTES.astra, region: "../../endpoint" }), hasCode("configuration"));
  assert.equal(resolveRouteModel({ ...RECOMMENDED_ROUTES.astra, model: "us.openai.gpt-6-astra" }).id, "us.openai.gpt-6-astra");
});

test("explicit loader has no extensions, skills, templates, context discovery or resource expansion", async () => {
  const loader = new WorkbenchResourceLoader("parent only");
  await loader.reload();
  assert.equal(loader.getSystemPrompt(), "parent only");
  assert.deepEqual(loader.getExtensions().extensions, []);
  assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
  assert.deepEqual(loader.getSkills().skills, []);
  assert.deepEqual(loader.getPrompts().prompts, []);
  assert.deepEqual(loader.getThemes().themes, []);
  assert.deepEqual(loader.getAppendSystemPrompt(), []);
  assert.throws(() => loader.extendResources(), hasCode("configuration"));
});

test("Responses uses SigV4 bedrock with a fixed endpoint, no bearer/affinity headers, and one HTTP attempt", async () => {
  let requests = 0;
  const wire: { url?: string; init?: RequestInit } = {};
  const route = RECOMMENDED_ROUTES.astra;
  const signingFetch = createSigningFetch(route, {
    credentials,
    fetch: async (input, init) => {
      requests++;
      wire.url = String(input);
      wire.init = init;
      return sse(events());
    },
  });
  const body = JSON.stringify({
    model: route.model, input: [], stream: true, store: false,
    reasoning: { effort: "max" }, include: ["reasoning.encrypted_content"], max_output_tokens: 128000,
  });
  await signingFetch(new Request("https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses", {
    method: "POST", body,
    headers: { authorization: "Bearer DO_NOT_FORWARD", "x-stainless-secret": "DO_NOT_FORWARD", session_id: "DO_NOT_FORWARD" },
  }));
  assert.equal(requests, 1);
  assert.equal(wire.init?.body, body);
  assert.equal(wire.init?.redirect, "error");
  const headers = new Headers(wire.init?.headers);
  assert.match(headers.get("authorization")!, /AWS4-HMAC-SHA256.*\/us-east-1\/bedrock\/aws4_request/);
  assert.equal(headers.get("x-amz-content-sha256"), createHash("sha256").update(body).digest("hex"));
  assert.equal(headers.get("session_id"), null);
  assert.equal(headers.get("x-stainless-secret"), null);
  assert.ok(!headers.get("authorization")!.includes("DO_NOT_FORWARD"));
  await assert.rejects(signingFetch("https://example.com/responses", { method: "POST", body }), hasCode("configuration"));
  await assert.rejects(signingFetch(wire.url!, { method: "POST", body: body.replace('"max"', '"high"') }), hasCode("effort_mismatch"));
  assert.equal(requests, 1);
});

test("successful tools and opaque native IDs persist through a failed model attempt and fresh adapter continuation", async (t) => {
  const { cwd, config, request, observations } = await fixture(t);
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await mkdir(join(cwd, ".agents", "skills", "unwanted"), { recursive: true });
  await writeFile(join(cwd, "AGENTS.md"), "UNSELECTED_PROJECT_CONTEXT");
  await writeFile(join(cwd, "CLAUDE.md"), "UNSELECTED_CLAUDE_CONTEXT");
  await writeFile(join(cwd, ".pi", "SYSTEM.md"), "UNSELECTED_SYSTEM_PROMPT");
  await writeFile(join(cwd, ".pi", "settings.json"), '{"retry":{"enabled":true,"maxRetries":99},"defaultTools":["bash"]}');
  await writeFile(join(cwd, ".pi", "extensions", "unwanted.ts"), 'throw new Error("MUST_NOT_AUTOLOAD");');
  await writeFile(join(cwd, ".agents", "skills", "unwanted", "SKILL.md"), "---\nname: unwanted\ndescription: UNSELECTED_SKILL\n---\nUNSELECTED_SKILL");
  let toolExecutions = 0;
  request.tools = [{
    name: "remember", description: "Remember the fixture value.",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    execute: async (args) => { toolExecutions++; return { saved: args.value, effectId: "effect-complete" }; },
  }];
  let calls = 0;
  const bodies: any[] = [];
  const dependencies: ProviderDependencies = {
    credentials,
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      calls++;
      if (calls === 1) return sse(events([reasoning, toolCall]));
      if (calls === 2) return sse(events([], "failed", {
        error: { code: "server_error", message: "SYNTHETIC_SECRET_NEVER_LOG private prompt content" },
      }));
      return sse(events([reasoning, textItem("Completed: café ✅")]));
    },
  };
  await assert.rejects(new PiAdapter(config, dependencies).run(request), hasCode("model_error"));
  assert.equal(calls, 2, "no SDK retry after the failing attempt");
  assert.equal(toolExecutions, 1);
  const failed = await transcript(request);
  assert.ok(failed.text.includes("effect-complete"));
  assert.ok(failed.text.includes("workbench:model_error"));
  assert.ok(!failed.text.includes("private prompt content"), "provider errors are sanitized before persistence");
  const reply = await new PiAdapter(config, dependencies).run({ ...request, task: { ...request.task, attempt: 2 } });
  assert.equal(reply.text, "Completed: café ✅");
  assert.equal(reply.stopReason, "stop");
  assert.equal(toolExecutions, 1, "successful tools were not rerun by adapter recovery");
  assert.equal(calls, 3);
  const resumed = await transcript(request);
  assert.equal(resumed.path, failed.path);
  assert.equal(resumed.manager.getSessionId(), failed.manager.getSessionId());
  for (const body of bodies) {
    assert.equal(body.store, false);
    assert.equal(body.reasoning.effort, "max");
    assert.equal(body.max_output_tokens, MAX_OUTPUT_TOKENS);
    assert.deepEqual(body.tools.map((tool: any) => tool.name), ["remember"]);
    assert.deepEqual(body.tools[0].parameters, request.tools[0].parameters);
    assert.ok(JSON.stringify(body.input).includes("SELECTED_AGENTS_SOURCE"));
    assert.ok(JSON.stringify(body.input).includes("SELECTED_CLAUDE_SOURCE"));
    assert.ok(!JSON.stringify(body).includes("UNSELECTED_"));
    assert.equal(body.previous_response_id, undefined);
  }
  for (const body of bodies.slice(1)) {
    assert.ok(body.input.some((item: any) => item.type === "reasoning" && item.id === "rs_fixture" &&
      item.encrypted_content === reasoning.encrypted_content));
    assert.ok(body.input.some((item: any) => item.type === "function_call" && item.id === "fc_fixture" && item.call_id === "call_fixture"));
    assert.ok(body.input.some((item: any) => item.type === "function_call_output" && item.call_id === "call_fixture" &&
      JSON.stringify(item.output).includes("effect-complete")));
  }
  const summaries = observations.filter((event) => event.type === "provider_end").map((event) => event.data);
  assert.equal(summaries.length, 3);
  assert.equal(summaries[0].stopReason, "toolUse");
  assert.equal(summaries[1].errorCode, "model_error");
  assert.equal(summaries[1].transport.api, "openai-responses");
  assert.equal(summaries[1].transport.errorCategory, "server_error");
  assert.equal(summaries[1].transport.httpStatus, 200);
  assert.equal(summaries[1].transport.responseStatus, "failed");
  assert.equal(summaries[1].usage.totalTokens, 29, "failed response usage must not become a false zero");
  assert.equal(summaries[2].wireEffort, "max");
  assert.deepEqual(summaries[2].usage, { input: 15, output: 9, cacheRead: 5, cacheWrite: 0, reasoning: 4, totalTokens: 29 });
  const eventText = JSON.stringify(observations);
  for (const secret of ["SYNTHETIC_SECRET_NEVER_LOG", "SYNTHETIC_SESSION_NEVER_LOG", "private prompt content", reasoning.encrypted_content, "SELECTED_AGENTS_SOURCE", "effect-complete"]) {
    assert.ok(!eventText.includes(secret), `event metadata contains unexpected content: ${secret}`);
  }
});

test("native Responses terminal failures cannot become an answer or execute partial tool calls", async (t) => {
  const duplicateDone = events([toolCall]);
  duplicateDone.splice(3, 0, structuredClone(duplicateDone[2]));
  const duplicateTerminal = events([toolCall]);
  duplicateTerminal.push(structuredClone(duplicateTerminal.at(-1)!));
  const streamingArguments = (delta: string, doneArgs: string, itemArgs = doneArgs) => [
    { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...toolCall, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: toolCall.id, delta },
    { type: "response.function_call_arguments.done", output_index: 0, item_id: toolCall.id, arguments: doneArgs },
    { type: "response.output_item.done", output_index: 0, item: { ...toolCall, arguments: itemArgs } },
    events([{ ...toolCall, arguments: itemArgs }]).at(-1)!,
  ];
  const repeatedArgumentsDone = streamingArguments(toolCall.arguments, toolCall.arguments);
  repeatedArgumentsDone.splice(4, 0, structuredClone(repeatedArgumentsDone[3]));
  const malformedTerminals: { name: string; frames: unknown[] }[] = [
    { name: "duplicate output item done", frames: duplicateDone },
    { name: "duplicate terminal response", frames: duplicateTerminal },
    { name: "duplicate call ID across items", frames: events([toolCall, { ...toolCall, id: "fc_other" }]) },
    { name: "duplicate item ID across calls", frames: events([toolCall, { ...toolCall, call_id: "call_other" }]) },
    { name: "missing item and call IDs", frames: events([{ ...toolCall, id: undefined, call_id: undefined }]) },
    { name: "missing call ID", frames: events([{ ...toolCall, call_id: undefined }]) },
    { name: "blank call ID", frames: events([{ ...toolCall, call_id: " " }]) },
    { name: "ambiguous composite ID", frames: events([{ ...toolCall, call_id: "call|other" }]) },
    { name: "missing tool name", frames: events([{ ...toolCall, name: undefined }]) },
    { name: "unfinished item in completed response", frames: events([{ ...toolCall, status: "incomplete" }]) },
    { name: "terminal contradicts arguments", frames: events([toolCall], "completed", { output: [{ ...toolCall, arguments: '{"value":"other"}' }] }) },
    { name: "terminal contradicts call ID", frames: events([toolCall], "completed", { output: [{ ...toolCall, call_id: "call_other" }] }) },
    { name: "terminal contradicts item ID", frames: events([toolCall], "completed", { output: [{ ...toolCall, id: "fc_other" }] }) },
    { name: "terminal contradicts tool name", frames: events([toolCall], "completed", { output: [{ ...toolCall, name: "other" }] }) },
    { name: "terminal omits streamed call", frames: events([toolCall], "completed", { output: [] }) },
    { name: "terminal adds unstreamed call", frames: events([toolCall], "completed", { output: [toolCall, { ...toolCall, id: "fc_other", call_id: "call_other" }] }) },
    { name: "argument done contradicts deltas", frames: streamingArguments('{"value":"other"}', toolCall.arguments) },
    { name: "item done contradicts arguments done", frames: streamingArguments(toolCall.arguments, toolCall.arguments, '{"value":"other"}') },
    { name: "repeated arguments done", frames: repeatedArgumentsDone },
    { name: "completed tool arguments are an array", frames: events([{ ...toolCall, arguments: "[]" }]) },
    { name: "completed tool arguments are null", frames: events([{ ...toolCall, arguments: "null" }]) },
  ];
  const invalidUsage = [
    { total_tokens: 29 }, { input_tokens: 20, total_tokens: 29 }, { output_tokens: 9, total_tokens: 29 },
    { input_tokens: 20, output_tokens: 9 },
    ...["input_tokens", "output_tokens", "total_tokens"].flatMap((key) =>
      [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, "9"].map((value) => ({ ...nativeUsage, [key]: value }))),
    ...[-1, 1.5, 21, null].map((cached_tokens) => ({ ...nativeUsage, input_tokens_details: { cached_tokens } })),
    { ...nativeUsage, input_tokens_details: { cached_tokens: 15, cache_write_tokens: 6 } },
    { ...nativeUsage, input_tokens_details: [] },
    ...[-1, 1.5, 10, null].map((reasoning_tokens) => ({ ...nativeUsage, output_tokens_details: { reasoning_tokens } })),
  ];
  const cases: { name: string; frames: unknown[]; code: AdapterErrorCode }[] = [
    ...malformedTerminals.map((entry) => ({ ...entry, code: "incomplete" as const })),
    ...invalidUsage.map((usage, index) => ({
      name: `invalid raw usage ${index + 1}`, frames: events([toolCall], "completed", { usage }), code: "invalid_usage" as const,
    })),
    { name: "empty", frames: events([reasoning, textItem("   ")]), code: "empty_reply" },
    { name: "error", frames: events([], "failed", { error: { code: "server_error", message: "failure" } }), code: "model_error" },
    { name: "length with tools", frames: events([toolCall], "incomplete", { incomplete_details: { reason: "max_output_tokens" } }), code: "length" },
    { name: "content filter", frames: events([textItem()], "incomplete", { incomplete_details: { reason: "content_filter" } }), code: "content_filter" },
    { name: "canceled", frames: events([textItem()], "cancelled"), code: "canceled" },
    { name: "queued terminal", frames: events([textItem()], "queued"), code: "incomplete" },
    { name: "missing status", frames: events([textItem()], "", { status: undefined }), code: "incomplete" },
    { name: "missing terminal", frames: events([textItem()]).slice(0, -1), code: "incomplete" },
    { name: "missing usage", frames: events([textItem()], "completed", { usage: undefined }), code: "invalid_usage" },
    { name: "malformed completed tool JSON", frames: events([{ ...toolCall, arguments: '{"value":"saved"' }]), code: "incomplete" },
    {
      name: "unclosed text block",
      frames: [
        { type: "response.output_item.added", output_index: 0, item: textItem() },
        { type: "response.output_text.delta", output_index: 0, delta: "plausible but unfinished answer" },
        { type: "response.completed", response: { status: "completed", usage: nativeUsage, output: [] } },
      ],
      code: "incomplete",
    },
  ];
  for (const fault of cases) {
    await t.test(fault.name, async (t) => {
      const { config, request } = await fixture(t);
      let calls = 0;
      let tools = 0;
      request.tools = [{
        name: "remember", description: "fixture", parameters: { type: "object" },
        execute: async () => { tools++; return "unexpected"; },
      }];
      const adapter = new PiAdapter(config, { credentials, fetch: async () => { calls++; return sse(fault.frames); } });
      await assert.rejects(adapter.run(request), hasCode(fault.code));
      assert.equal(calls, 1);
      assert.equal(tools, 0);
    });
  }
});

test("native Responses accepts distinct streamed calls, done-only calls, reasoning enrichment and usage extras", async (t) => {
  const { config, request } = await fixture(t);
  let calls = 0;
  const effects: string[] = [];
  request.tools = [{
    name: "remember", description: "fixture", parameters: { type: "object", properties: { value: { type: "string" } } },
    execute: async (args) => { effects.push(args.value); return "saved"; },
  }];
  const second = { ...toolCall, id: "fc_other", call_id: "call_other", arguments: '{"value":"second"}' };
  const tools = events([toolCall, second]);
  // First call uses deltas; the second arrives as a complete done-only item.
  tools[1] = { type: "response.output_item.added", output_index: 0, item: { ...toolCall, arguments: "" } };
  tools.splice(2, 0,
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: toolCall.id, delta: '{"value":' } as any,
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: toolCall.id, delta: '"saved"}' } as any,
    { type: "response.function_call_arguments.done", output_index: 0, item_id: toolCall.id, arguments: toolCall.arguments } as any);
  const frames = tools.filter((event: any) => !(event.type === "response.output_item.added" && event.output_index === 1));
  const final = events([{ ...reasoning, encrypted_content: null }, textItem()], "completed", {
    output: [reasoning, textItem()],
    usage: { ...nativeUsage, input_tokens_details: { cached_tokens: 5, audio_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 4, accepted_prediction_tokens: 2, audio_tokens: 0 }, provider_extra: true },
  });
  const result = await new PiAdapter(config, { credentials, fetch: async () => sse(++calls === 1 ? frames : final) }).run(request);
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(effects, ["saved", "second"]);
  assert.equal(calls, 2);
  const saved = await transcript(request);
  assert.ok(saved.text.includes(reasoning.encrypted_content));
});

test("HTTP errors have no hidden provider retries and no provider-body leakage", async (t) => {
  const { config, request, observations } = await fixture(t);
  let calls = 0;
  const adapter = new PiAdapter(config, {
    credentials,
    fetch: async () => {
      calls++;
      return new Response('{"error":{"message":"SYNTHETIC_SECRET_NEVER_LOG","type":"server_error","code":"server_error"}}', {
        status: 503, headers: { "content-type": "application/json", "retry-after": "0", "x-request-id": "fixture-http-failure" },
      });
    },
  });
  await assert.rejects(adapter.run(request), hasCode("model_error"));
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(observations).includes("SYNTHETIC_SECRET_NEVER_LOG"));
  const end = observations.find((event) => event.type === "provider_end")!.data;
  assert.equal(end.transport.httpStatus, 503);
  assert.equal(end.transport.errorCategory, "server_error");
  assert.equal(end.transport.requestId, "fixture-http-failure");
  assert.equal(end.usage, null);
});

test("maximum effort drift is rejected before any HTTP request", async () => {
  let calls = 0;
  const native = createNativeProvider(RECOMMENDED_ROUTES.astra, () => {}, {
    credentials, fetch: async () => { calls++; return sse(events()); },
  });
  const result = await native.provider.streamSimple(native.model, { messages: [] }, { reasoning: "high" }).result();
  assert.equal(result.errorMessage, "workbench:effort_mismatch");
  const clamped = await native.provider.streamSimple(native.model, { messages: [] }, {
    reasoning: "max",
    onPayload: (payload) => ({ ...(payload as any), reasoning: { effort: "high" } }),
  }).result();
  assert.equal(clamped.stopReason, "error");
  assert.equal(clamped.errorMessage, "workbench:effort_mismatch");
  assert.equal(calls, 0);
});

test("cancellation while resolving signing credentials sends no HTTP request", async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  const native = createNativeProvider(RECOMMENDED_ROUTES.astra, () => {}, {
    credentials: () => {
      entered();
      return new Promise(() => {});
    },
    fetch: async () => { calls++; return sse(events()); },
  });
  const pending = native.provider.streamSimple(native.model, { messages: [] }, {
    reasoning: "max", signal: controller.signal,
  }).result();
  await started;
  controller.abort();
  assert.equal((await pending).errorMessage, "workbench:canceled");
  assert.equal(calls, 0);
});

test("abort cancels the native request, cleans the session lock, and retains the same task identity", async (t) => {
  const { config, request } = await fixture(t);
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let aborted = false;
  const first = new PiAdapter(config, {
    credentials,
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      started();
      init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("canceled fixture")); }, { once: true });
    }),
  });
  const pending = first.run({ ...request, signal: controller.signal });
  await ready;
  controller.abort();
  await assert.rejects(pending, hasCode("canceled"));
  assert.equal(aborted, true);
  const saved = await transcript(request);
  assert.ok(!(await readdir(saved.dir)).includes(".adapter.lock"));
  const reply = await new PiAdapter(config, { credentials, fetch: async () => sse(events()) }).run(request);
  assert.equal(reply.stopReason, "stop");
  assert.equal((await transcript(request)).manager.getSessionId(), saved.manager.getSessionId());
});

test("abort during a tool waits for cleanup and persists a successful tool result", async (t) => {
  const { config, request } = await fixture(t);
  const controller = new AbortController();
  let cleaned = false;
  let calls = 0;
  request.tools = [{
    name: "remember", description: "fixture", parameters: { type: "object" },
    execute: async (_args, signal) => {
      assert.ok(signal);
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 15));
      cleaned = true;
      return { effect: "completed-before-cancel" };
    },
  }];
  const adapter = new PiAdapter(config, {
    credentials, fetch: async () => { calls++; return sse(events([reasoning, toolCall])); },
  });
  await assert.rejects(adapter.run({ ...request, signal: controller.signal }), hasCode("canceled"));
  assert.equal(cleaned, true);
  assert.equal(calls, 1);
  const saved = await transcript(request);
  assert.ok(saved.manager.buildSessionContext().messages.some((message) => message.role === "toolResult" &&
    !message.isError && JSON.stringify(message.content).includes("completed-before-cancel")));
});

test("one active owner per task; independent task IDs do not share transcripts", async (t) => {
  const { config, request } = await fixture(t);
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const adapter = new PiAdapter(config, {
    credentials, fetch: async () => { started(); await waiting; return sse(events()); },
  });
  const first = adapter.run(request);
  await ready;
  await assert.rejects(new PiAdapter(config).run(request), hasCode("session_conflict"));
  const other = { ...request, task: { ...request.task, id: "other-task" } };
  const second = new PiAdapter(config, { credentials, fetch: async () => sse(events()) }).run(other);
  release();
  await Promise.all([first, second]);
  assert.notEqual((await transcript(request)).path, (await transcript(other)).path);
});

test("SQLite task leases support real session paths longer than Windows MAX_PATH", async (t) => {
  const { root, config, request } = await fixture(t);
  request.sessionDir = join(root, "qualified-source-".repeat(5), "persistent-task-".repeat(5), "sessions");
  const key = createHash("sha256").update(JSON.stringify([request.run.id, request.task.id])).digest("hex");
  const lockPath = join(request.sessionDir, key, ".adapter-lock.sqlite");
  assert.ok(lockPath.length > 260, `Regression requires a long SQLite path; got ${lockPath.length}.`);
  let calls = 0;
  const dependencies = { credentials, fetch: async () => { calls++; return sse(events()); } };
  assert.equal((await new PiAdapter(config, dependencies).run(request)).stopReason, "stop");
  const first = await transcript(request);
  assert.equal((await new PiAdapter(config, dependencies).run(request)).stopReason, "stop");
  assert.equal((await transcript(request)).manager.getSessionId(), first.manager.getSessionId());
  assert.equal(calls, 2);
  assert.ok((await readdir(first.dir)).includes(".adapter-lock.sqlite"));
});

test("session setup failures expose safe phases/categories without leaking SDK error bodies", async (t) => {
  const { config, request, observations } = await fixture(t);
  t.mock.method(ModelRuntime, "create", async () => {
    throw Object.assign(new Error("PRIVATE_SETUP_BODY credential detail must never be logged"), { code: "ERR_SESSION_CONFIG" });
  });
  await assert.rejects(new PiAdapter(config).run(request), hasCode("session_setup"));
  const failure = observations.find((event) => event.type === "adapter_failed")!.data;
  assert.equal(failure.phase, "model_runtime");
  assert.equal(failure.errorCategory, "ERR_SESSION_CONFIG");
  assert.match(failure.errorFingerprint, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(observations).includes("PRIVATE_SETUP_BODY"));
  assert.equal(observations.filter((event) => event.type === "provider_start").length, 0);
});

test("SQLite lease errors retain SQLite error numbers and the actual failure phase", async (t) => {
  const { config, request, observations } = await fixture(t);
  const key = createHash("sha256").update(JSON.stringify([request.run.id, request.task.id])).digest("hex");
  await mkdir(join(request.sessionDir, key, ".adapter-lock.sqlite"), { recursive: true });
  await assert.rejects(new PiAdapter(config).run(request), hasCode("persistence"));
  const failure = observations.find((event) => event.type === "adapter_failed")!.data;
  assert.equal(failure.phase, "session_lock");
  assert.equal(failure.errorCategory, "ERR_SQLITE_ERROR");
  assert.equal(failure.sqliteCode & 0xff, 14, "Retain the actual extended SQLite CANTOPEN code.");
  assert.equal(observations.filter((event) => event.type === "provider_start").length, 0);
});

test("direct native provider success/failure events are accepted by the strict canonical Store sink", async (t) => {
  const { root, cwd } = await fixture(t);
  const store = new Store(join(root, "strict-event-store"));
  try {
    const run = store.createRun("Native telemetry fixture", cwd);
    let calls = 0;
    const native = createNativeProvider(RECOMMENDED_ROUTES.astra,
      (type, data) => { store.addEvent(run.id, type, data); }, {
        credentials,
        fetch: async () => sse(++calls === 1 ? events() : events([], "failed", {
          error: { code: "server_error", message: "synthetic failure" },
        })),
      });
    const context = { messages: [{ role: "user" as const, content: "fixture", timestamp: Date.now() }] };
    assert.equal((await native.provider.streamSimple(native.model, context, { reasoning: "max" }).result()).stopReason, "stop");
    assert.equal((await native.provider.streamSimple(native.model, context, { reasoning: "max" }).result()).stopReason, "error");
    const ends = store.events(run.id).filter((event) => event.type === "provider_end").map((event) => event.data as any);
    assert.equal(ends.length, 2);
    assert.equal(Object.hasOwn(ends[0], "errorCode"), false);
    assert.equal(ends[1].errorCode, "model_error");
  } finally { store.close(); }
});

test("adapter failure/checkpoint metadata remains canonical with actual Store run/task records", async (t) => {
  const { root, cwd, config, request } = await fixture(t);
  const store = new Store(join(root, "strict-event-store"));
  try {
    request.run = store.createRun("Canonical session fixture", cwd);
    request.task = store.createTask(request.run.id, { objective: "Exercise canonical events", role: "worker" });
    store.startTask(request.task.id);
    request.task = store.getTask(request.task.id);
    request.onEvent = (type, data) => { store.addEvent(request.run.id, type, data, request.task.id); };
    const adapter = new PiAdapter(config, { credentials, fetch: async () => sse(events()) });
    assert.equal((await adapter.run(request)).stopReason, "stop");
    const saved = await transcript(request);
    await writeFile(join(saved.dir, "checkpoints"), "blocking-file");
    await assert.rejects(adapter.compact(request), hasCode("persistence"));
    assert.ok(store.events(request.run.id).some((event) => event.type === "compaction_failed"));
    assert.ok(store.events(request.run.id).some((event) => event.type === "adapter_failed"));
  } finally { store.close(); }
});

test("a durable Store sink failure remains fatal after JSON cleanup", async (t) => {
  const { root, cwd, config, request } = await fixture(t);
  const store = new Store(join(root, "strict-event-store"));
  let closed = false;
  try {
    request.run = store.createRun("Durable sink failure fixture", cwd);
    request.task = store.createTask(request.run.id, { objective: "Fail the event sink", role: "worker" });
    request.onEvent = (type, data) => {
      if (type === "provider_end" && !closed) { store.close(); closed = true; }
      store.addEvent(request.run.id, type, data, request.task.id);
    };
    await assert.rejects(new PiAdapter(config, { credentials, fetch: async () => sse(events()) }).run(request), hasCode("event_sink"));
  } finally { if (!closed) store.close(); }
});

test("task ownership is exclusive across processes and is released by process exit", async (t) => {
  const { config, request } = await fixture(t);
  const dependencies = { credentials, fetch: async () => sse(events()) };
  await new PiAdapter(config, dependencies).run(request);
  const saved = await transcript(request);
  const holder = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from "node:sqlite";
    const lock = new DatabaseSync(process.argv[1]);
    lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1000);
  `, join(saved.dir, ".adapter-lock.sqlite")], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { holder.kill(); });
  const firstOutput = await once(holder.stdout!, "data");
  assert.match(String(firstOutput[0]), /ready/);
  await assert.rejects(new PiAdapter(config, dependencies).run(request), hasCode("session_conflict"));
  const closed = once(holder, "exit");
  holder.kill();
  await closed;
  await new PiAdapter(config, dependencies).run(request);
  assert.equal((await transcript(request)).manager.getSessionId(), saved.manager.getSessionId());
});

test("an event sink failure stops the attempt and does not execute the pending tool", async (t) => {
  const { config, request } = await fixture(t);
  let executed = 0;
  request.tools = [{
    name: "remember", description: "fixture", parameters: { type: "object" },
    execute: async () => { executed++; return "unexpected"; },
  }];
  request.onEvent = (type) => { if (type === "provider_end") throw new Error("sink unavailable"); };
  await assert.rejects(new PiAdapter(config, {
    credentials, fetch: async () => sse(events([reasoning, toolCall])),
  }).run(request), hasCode("event_sink"));
  assert.equal(executed, 0);
});

test("unknown tool effects block continuation before inference", async (t) => {
  const { config, request } = await fixture(t);
  const adapter = new PiAdapter(config, { credentials, fetch: async () => sse(events()) });
  await adapter.run(request);
  const saved = await transcript(request);
  const previous = saved.manager.buildSessionContext().messages.find((message) => message.role === "assistant")!;
  assert.equal(previous.role, "assistant");
  saved.manager.appendMessage({
    ...previous, stopReason: "toolUse",
    content: [{ type: "toolCall", id: "orphan-call", name: "effect", arguments: {} }],
  });
  let calls = 0;
  await assert.rejects(new PiAdapter(config, {
    credentials, fetch: async () => { calls++; return sse(events()); },
  }).run(request), hasCode("tool_state_unknown"));
  assert.equal(calls, 0);
});

test("Fable stock Bedrock codec sends adaptive max and retains thinking signatures/tool IDs", async (t) => {
  const { config, request, observations } = await fixture(t, RECOMMENDED_ROUTES.fable);
  const bodies: any[] = [];
  let calls = 0;
  t.mock.method(BedrockRuntimeClient.prototype, "send", async (command: any) => {
    bodies.push(command.input);
    const initial = ++calls === 1;
    const frames = initial ? [
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "fixture reasoning" } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: "bedrock-opaque-signature" } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "bedrock-call-1", name: "remember" } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"value":"saved"}' } } } },
      { contentBlockStop: { contentBlockIndex: 1 } },
      { messageStop: { stopReason: "tool_use" } },
    ] : [
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Fable fixture complete." } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } },
    ];
    return {
      $metadata: { httpStatusCode: 200, requestId: "bedrock-fixture" },
      stream: (async function* () {
        yield* frames;
        yield { metadata: { usage: { inputTokens: 21, outputTokens: 9, totalTokens: 30 } } };
      })(),
    };
  });
  request.tools = [{
    name: "remember", description: "fixture",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    execute: async (args) => ({ saved: args.value }),
  }];
  const reply = await new PiAdapter(config, { bedrockStream: stockBedrockStream }).run(request);
  assert.equal(reply.text, "Fable fixture complete.");
  assert.equal(calls, 2);
  for (const body of bodies) {
    assert.equal(body.modelId, RECOMMENDED_ROUTES.fable.model);
    assert.equal(body.inferenceConfig.maxTokens, 128000);
    assert.equal(body.additionalModelRequestFields.thinking.type, "adaptive");
    assert.equal(body.additionalModelRequestFields.output_config.effort, "max");
    assert.equal(body.additionalModelRequestFields.thinking.budget_tokens, undefined);
    assert.deepEqual(body.toolConfig.tools.map((tool: any) => tool.toolSpec.name), ["remember"]);
  }
  const replay = JSON.stringify(bodies[1].messages);
  assert.ok(replay.includes("bedrock-opaque-signature"));
  assert.ok(replay.includes("bedrock-call-1"));
  assert.ok(replay.includes('"saved"'));
  assert.ok(observations.some((event) => event.type === "provider_payload" && event.data.thinking === "adaptive" &&
    event.data.wireEffort === "max"));
});

test("Fable SDK exception categories survive sanitization without exception messages", async (t) => {
  const { config, request, observations } = await fixture(t, RECOMMENDED_ROUTES.fable);
  t.mock.method(BedrockRuntimeClient.prototype, "send", async () => {
    throw Object.assign(new Error("SYNTHETIC_SECRET_NEVER_LOG raw service body"), {
      name: "ValidationException",
      $metadata: { httpStatusCode: 400, requestId: "fixture-validation-request" },
    });
  });
  await assert.rejects(new PiAdapter(config, { bedrockStream: stockBedrockStream }).run(request), hasCode("model_error"));
  const end = observations.find((event) => event.type === "provider_end")!.data;
  assert.deepEqual(end.transport, {
    api: "bedrock-converse-stream", httpStatus: 400, errorCategory: "ValidationException", requestId: "fixture-validation-request",
    errorFingerprint: createHash("sha256").update("SYNTHETIC_SECRET_NEVER_LOG raw service body").digest("hex"),
  });
  assert.ok(!JSON.stringify(observations).includes("raw service body"));
  assert.ok(!(await transcript(request)).text.includes("raw service body"));
});

test("Fable diagnostics classify callback failures without copying arbitrary error text", async (t) => {
  const { config, request, observations } = await fixture(t, RECOMMENDED_ROUTES.fable);
  t.mock.method(BedrockRuntimeClient.prototype, "send", async () => {
    throw new TypeError('Headers.append: ":status" is an invalid header name.');
  });
  await assert.rejects(new PiAdapter(config, { bedrockStream: stockBedrockStream }).run(request), hasCode("model_error"));
  const end = observations.find((event) => event.type === "provider_end")!.data;
  assert.equal(end.transport.errorClass, "invalid_http2_pseudo_header");
  assert.match(end.transport.errorSummary, /HTTP\/2 :status/);
  assert.match(end.transport.errorFingerprint, /^[a-f0-9]{64}$/);
});

test("stock Bedrock worker runs with isolated retries and aborts before inference in a transport probe", async () => {
  const route = normalizeRoute(RECOMMENDED_ROUTES.fable);
  const previousAttempts = process.env.AWS_MAX_ATTEMPTS;
  const env = bedrockWorkerEnvironment(route);
  assert.equal(env.AWS_MAX_ATTEMPTS, "1");
  assert.equal(env.AWS_PROFILE, "default");
  assert.equal(env.AWS_BEARER_TOKEN_BEDROCK, undefined);
  assert.equal(process.env.AWS_MAX_ATTEMPTS, previousAttempts);
  let captured: any;
  const native = streamNativeIsolated(
    resolveRouteModel(route) as Model<"bedrock-converse-stream">,
    {
      messages: [{ role: "user", content: "offline fixture", timestamp: 0 }],
      tools: [{
        name: "remember", description: "fixture", parameters: { type: "object" },
        execute: async () => { throw new Error("tool stays in parent"); },
      } as any],
    },
    {
      reasoning: "max",
      onPayload: (payload) => { captured = payload; throw new AdapterError("configuration"); },
    },
    route,
  );
  const result = await native.result();
  assert.equal(result.errorMessage, "workbench:configuration");
  assert.equal(captured.additionalModelRequestFields.output_config.effort, "max");
  assert.equal(captured.inferenceConfig.maxTokens, 128000);
  assert.equal(captured.toolConfig.tools[0].toolSpec.name, "remember");
  assert.equal(process.env.AWS_MAX_ATTEMPTS, previousAttempts);
});

test("stock Responses also runs in the isolated worker and can be stopped before inference", async () => {
  const route = normalizeRoute(RECOMMENDED_ROUTES.astra);
  let captured: any;
  const native = streamNativeIsolated(
    resolveRouteModel(route),
    {
      messages: [{ role: "user", content: "offline fixture", timestamp: 0 }],
      tools: [{
        name: "remember", description: "fixture", parameters: { type: "object" },
        execute: async () => { throw new Error("tool stays in parent"); },
      } as any],
    },
    {
      reasoning: "max",
      onPayload: (payload) => { captured = payload; throw new AdapterError("configuration"); },
    },
    route,
  );
  const result = await native.result();
  assert.equal(result.errorMessage, "workbench:configuration");
  assert.equal(captured.reasoning.effort, "max");
  assert.equal(captured.store, false);
  assert.equal(captured.max_output_tokens, 128000);
  assert.equal(captured.tools[0].name, "remember");
});

for (const protocol of ["http/1.1", "h2"]) test(`stock Bedrock ${protocol} transport reports a retryable 503 category and makes one attempt`, async (t) => {
  const { root } = await fixture(t);
  const configPath = join(root, "mock-aws-config");
  const credentialsPath = join(root, "mock-aws-credentials");
  await writeFile(configPath, "[profile transport-fixture]\nregion=us-east-1\n");
  await writeFile(credentialsPath, "[transport-fixture]\naws_access_key_id=FIXTURE_ONLY\naws_secret_access_key=FIXTURE_ONLY\n");
  const overrides = {
    AWS_CONFIG_FILE: configPath, AWS_SHARED_CREDENTIALS_FILE: credentialsPath,
    AWS_BEDROCK_FORCE_HTTP1: protocol === "http/1.1" ? "1" : "0", AWS_MAX_ATTEMPTS: "9",
  };
  const before = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  let calls = 0;
  let body: any;
  let attemptHeader: unknown;
  const handler = async (request: IncomingMessage | Http2ServerRequest, response: ServerResponse | Http2ServerResponse) => {
    calls++;
    attemptHeader = request.headers["amz-sdk-request"];
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.statusCode = 503;
    response.setHeader("content-type", "application/json");
    response.setHeader("x-amzn-requestid", "fixture-bedrock-http-failure");
    response.end('{"__type":"ServiceUnavailableException","message":"synthetic retryable failure"}');
  };
  const server = protocol === "http/1.1" ? createServer(handler) : createHttp2Server(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const route = normalizeRoute({ ...RECOMMENDED_ROUTES.fable, profile: "transport-fixture" });
  const model = {
    ...resolveRouteModel(route),
    // Low-level transport fixture only. PiAdapter always resolves the real AWS endpoint.
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
  const transport: any = {};
  const result = await streamNativeIsolated(model, { messages: [{ role: "user", content: "fixture", timestamp: 0 }] }, {
    reasoning: "max",
  }, route, (metadata) => {
    for (const [key, value] of Object.entries(metadata)) if (value !== undefined) transport[key] = value;
  }).result();
  assert.equal(result.stopReason, "error");
  assert.equal(calls, 1);
  assert.match(String(attemptHeader), /attempt=1; max=1/);
  assert.equal(transport.httpStatus, 503);
  assert.equal(transport.errorCategory, "ServiceUnavailableException");
  assert.equal(transport.requestId, "fixture-bedrock-http-failure");
  assert.equal(body.additionalModelRequestFields.thinking.type, "adaptive");
  assert.equal(body.additionalModelRequestFields.output_config.effort, "max");
  assert.equal(body.inferenceConfig.maxTokens, 128000);
  assert.equal(process.env.AWS_MAX_ATTEMPTS, "9", "worker settings did not change the parent");
});

test("Doctor is offline and distinguishes profile configuration from valid credentials/live qualification", async (t) => {
  const { root, config } = await fixture(t);
  const awsConfig = join(root, "aws-config");
  const awsCredentials = join(root, "aws-credentials");
  await writeFile(awsConfig, "[profile default]\nrole_arn = arn:aws:iam::123456789012:role/FixtureRole\nsource_profile = fixture\n");
  await writeFile(awsCredentials, "[fixture]\naws_access_key_id = SYNTHETIC_ONLY\naws_secret_access_key = SYNTHETIC_SECRET_NEVER_LOG\n");
  const oldConfig = process.env.AWS_CONFIG_FILE;
  const oldCredentials = process.env.AWS_SHARED_CREDENTIALS_FILE;
  process.env.AWS_CONFIG_FILE = awsConfig;
  process.env.AWS_SHARED_CREDENTIALS_FILE = awsCredentials;
  t.after(() => {
    if (oldConfig === undefined) delete process.env.AWS_CONFIG_FILE; else process.env.AWS_CONFIG_FILE = oldConfig;
    if (oldCredentials === undefined) delete process.env.AWS_SHARED_CREDENTIALS_FILE; else process.env.AWS_SHARED_CREDENTIALS_FILE = oldCredentials;
  });
  let calls = 0;
  const result = await new PiAdapter(config, { fetch: async () => { calls++; throw new Error("inference forbidden"); } }).doctor();
  assert.equal(result.ok, true);
  assert.equal(calls, 0);
  assert.equal(result.checks.inferencePerformed, false);
  assert.equal(result.checks.credentialsResolved, false);
  assert.ok((result.checks.routes as any[]).every((route) => route.liveQualified === false && route.auth.assumedRole));
  assert.ok(!JSON.stringify(result).includes("SYNTHETIC_SECRET_NEVER_LOG"));
  await assert.rejects(readdir(config.stateDir), { code: "ENOENT" });
});

function bedrockFixture(tool = false, text = "saved", inputTokens = 21) {
  const frames = tool ? [
    { messageStart: { role: "assistant" } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "private Fable reasoning" } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: "private-fable-signature" } } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "fable-call", name: "remember" } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"value":"saved"}' } } } },
    { contentBlockStop: { contentBlockIndex: 1 } },
    { messageStop: { stopReason: "tool_use" } },
  ] : [
    { messageStart: { role: "assistant" } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: "end_turn" } },
  ];
  return {
    $metadata: { httpStatusCode: 200, requestId: "bedrock-fixture" },
    stream: (async function* () {
      yield* frames;
      yield { metadata: { usage: { inputTokens, outputTokens: 9, totalTokens: inputTokens + 9 } } };
    })(),
  };
}

test("context capacity follows the model window/output reserve and ignores stale pre-compaction usage", () => {
  const model = resolveRouteModel(RECOMMENDED_ROUTES.astra);
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "Original request", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant", api: model.api, model: model.id, provider: model.provider,
    content: [{ type: "text", text: "Short but expensive native context." }], stopReason: "stop", timestamp: Date.now(),
    usage: { input: 900000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 900010,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const before = contextBudget(manager, model, "parent", []);
  assert.equal(before.contextWindow, model.contextWindow);
  assert.equal(before.outputReserve, model.maxTokens);
  assert.equal(before.inputCapacity, model.contextWindow - model.maxTokens);
  assert.equal(before.needsCompaction, true);
  assert.equal(contextBudget(manager, { ...model, contextWindow: 2000000 }, "parent", []).needsCompaction, false);
  manager.appendCompaction("Short summary.", manager.getLeafId()!, before.tokens);
  const after = contextBudget(manager, model, "parent", []);
  assert.equal(after.basis, "message-estimate");
  assert.equal(after.needsCompaction, false);
});

test("automatic compaction keeps complete source artifacts and executes successful tools only once", async (t) => {
  const { config, request, observations } = await fixture(t);
  let calls = 0;
  let tools = 0;
  const tail = "EXACT_TOOL_EVIDENCE_TAIL";
  request.tools = [{
    name: "remember", description: "fixture", parameters: { type: "object" },
    execute: async () => { tools++; return `${"evidence ".repeat(4000)}${tail}`; },
  }];
  const bodies: any[] = [];
  const adapter = new PiAdapter(config, {
    credentials,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      calls++;
      if (calls === 1) return sse(events([reasoning, toolCall], "completed", {
        usage: { ...nativeUsage, input_tokens: 900000, total_tokens: 900009 },
      }));
      if (calls === 2) {
        assert.equal(body.tools, undefined, "summary helper must not execute tools");
        assert.equal(body.reasoning.effort, "max");
        assert.equal(body.max_output_tokens, 128000);
        assert.ok(JSON.stringify(body).includes("SELECTED_AGENTS_SOURCE"));
        return sse(events([textItem("Original task: finish the fixture. Completed effects stay completed.")]));
      }
      return sse(events());
    },
  });
  assert.equal((await adapter.run(request)).stopReason, "stop");
  assert.equal(calls, 3);
  assert.equal(tools, 1);
  const compacted = observations.find((event) => event.type === "compaction_end")!.data;
  assert.equal(compacted.reason, "threshold");
  assert.equal(compacted.contextWindow, 1000000);
  assert.equal(compacted.outputReserve, 128000);
  assert.ok(compacted.estimatedTokensAfter < compacted.tokensBefore);
  const sourceBytes = await readFile(compacted.checkpoint.path);
  assert.equal(createHash("sha256").update(sourceBytes).digest("hex"), compacted.checkpoint.sha256);
  assert.ok(sourceBytes.toString().includes(tail));
  assert.ok(sourceBytes.toString().includes(request.systemPrompt));
  assert.ok(sourceBytes.toString().includes(request.prompt));
  const summaryReceipt = JSON.parse(await readFile(compacted.summaryReceipt.path, "utf8"));
  assert.equal(summaryReceipt.effort, "max");
  assert.equal(summaryReceipt.response.providerThinkingLevel, "max");
  assert.ok(observations.some((event) => event.type === "provider_end" && event.data.purpose === "compaction" &&
    event.data.wireEffort === "max"));
  assert.ok(JSON.stringify(bodies[2].input).includes(compacted.checkpoint.sha256));
  assert.ok(JSON.stringify(bodies[2].input).includes(tail), "the native retained tool result stays complete");
  const saved = await transcript(request);
  assert.ok(saved.text.includes(tail));
  assert.equal(saved.manager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
  await adapter.run(request);
  assert.equal(observations.filter((event) => event.type === "compaction_start").length, 1, "old usage must not compact again");
  assert.equal(tools, 1);
});

test("explicit compaction is durable and Fable's public summary helper uses adaptive max", async (t) => {
  const { config, request, observations } = await fixture(t, RECOMMENDED_ROUTES.fable);
  config.compactor = RECOMMENDED_ROUTES.fable; // Offline codec coverage only; never a live Fable summary probe.
  request.prompt += "\n" + "Recorded synthetic source material.\n".repeat(300);
  const bodies: any[] = [];
  t.mock.method(BedrockRuntimeClient.prototype, "send", async (command: any) => {
    bodies.push(command.input);
    return bedrockFixture(false, bodies.length === 1 ? "saved" : "Completed effect: saved. Evidence remains in the checkpoint.", bodies.length === 1 ? 3500 : 21);
  });
  const adapter = new PiAdapter(config, { bedrockStream: stockBedrockStream });
  await adapter.run(request);
  const prior = await transcript(request);
  const result = await new PiAdapter(config, { bedrockStream: stockBedrockStream }).compact(request);
  const after = await transcript(request);
  assert.equal(after.path, prior.path);
  assert.equal(result.effort, "max");
  assert.ok(after.text.startsWith(prior.text), "compaction must append, not rewrite old prompts/results");
  assert.equal(bodies[1].additionalModelRequestFields.output_config.effort, "max");
  assert.equal(bodies[1].additionalModelRequestFields.thinking.type, "adaptive");
  assert.equal(bodies[1].inferenceConfig.maxTokens, 128000);
  assert.equal(bodies[1].toolConfig, undefined);
  assert.ok(after.manager.buildSessionContext().messages.some((message) => JSON.stringify(message).includes(result.checkpoint.sha256)));
  assert.ok(observations.some((event) => event.type === "compaction_model_receipt"));
});

test("failed, canceled, empty, and length-limited summaries are never saved as compactions", async (t) => {
  for (const [name, frames, code] of [
    ["failed", events([], "failed", { error: { code: "server_error", message: "fixture failure" } }), "model_error"],
    ["canceled", events([textItem("plausible partial summary")], "cancelled"), "canceled"],
    ["empty", events([textItem("")]), "empty_reply"],
    ["length", events([textItem("plausible partial summary")], "incomplete", { incomplete_details: { reason: "max_output_tokens" } }), "length"],
  ] as const) await t.test(name, async (t) => {
    const { config, request, observations } = await fixture(t);
    let calls = 0;
    const adapter = new PiAdapter(config, { credentials, fetch: async () => sse(++calls === 1 ? events() : [...frames]) });
    await adapter.run(request);
    const before = await transcript(request);
    await assert.rejects(adapter.compact(request), hasCode(code));
    assert.equal(calls, 2, "the helper must not retry itself");
    const after = await transcript(request);
    assert.ok(after.text.startsWith(before.text));
    assert.equal(after.manager.getEntries().filter((entry) => entry.type === "compaction").length, 0);
    const failed = observations.find((event) => event.type === "compaction_failed")!.data;
    assert.equal(failed.errorCode, code);
    assert.ok(JSON.parse(await readFile(failed.checkpoint.path, "utf8")).entries.length);
    const artifact = JSON.parse(await readFile(failed.summaryReceipt.path, "utf8"));
    assert.ok(["error", "aborted"].includes(artifact.response.stopReason));
  });
});

test("checkpoint persistence failure prevents a summarizer request", async (t) => {
  const { config, request, observations } = await fixture(t);
  let calls = 0;
  const adapter = new PiAdapter(config, { credentials, fetch: async () => { calls++; return sse(events()); } });
  await adapter.run(request);
  const saved = await transcript(request);
  await writeFile(join(saved.dir, "checkpoints"), "blocking-file");
  await assert.rejects(adapter.compact(request), hasCode("persistence"));
  assert.equal(calls, 1);
  assert.ok(observations.some((event) => event.type === "checkpoint_failed"));
  assert.ok(observations.some((event) => event.type === "compaction_failed"));
});

test("a request exceeding context capacity remains explicit without an arbitrary task cap", async (t) => {
  const { config, request, observations } = await fixture(t);
  request.prompt = "x".repeat(3600000);
  let calls = 0;
  await assert.rejects(new PiAdapter(config, {
    credentials, fetch: async () => { calls++; return sse(events()); },
  }).run(request), hasCode("context_capacity"));
  assert.equal(calls, 0);
  assert.ok(observations.some((event) => event.type === "checkpoint_end"));
});

test("Fable to Astra to Fable uses one task state, omits foreign reasoning, and does not repeat a completed tool", async (t) => {
  const { config, request, observations } = await fixture(t, RECOMMENDED_ROUTES.fable);
  let tools = 0;
  let fableCalls = 0;
  const fableBodies: any[] = [];
  const astraBodies: any[] = [];
  request.tools = [{
    name: "remember", description: "fixture", parameters: { type: "object" },
    execute: async () => { tools++; return { saved: "saved" }; },
  }];
  t.mock.method(BedrockRuntimeClient.prototype, "send", async (command: any) => {
    fableBodies.push(command.input);
    fableCalls++;
    if (fableCalls === 1) return bedrockFixture(true);
    if (fableCalls === 2) throw Object.assign(new Error("fixture service failure"), { name: "ServiceUnavailableException" });
    return bedrockFixture();
  });
  const deps = {
    bedrockStream: stockBedrockStream, credentials,
    fetch: async (_input: unknown, init?: RequestInit) => {
      astraBodies.push(JSON.parse(String(init?.body)));
      return sse(events([reasoning, textItem("saved")]));
    },
  };
  await assert.rejects(new PiAdapter(config, deps).run(request), hasCode("model_error"));
  const original = await transcript(request);
  assert.equal((await new PiAdapter(config, deps).run({ ...request, route: RECOMMENDED_ROUTES.astra })).text, "saved");
  assert.equal((await new PiAdapter(config, deps).run(request)).text, "saved");
  assert.equal(tools, 1);
  const astraInput = astraBodies[0].input;
  assert.ok(!JSON.stringify(astraInput).includes("private-fable"));
  assert.ok(!JSON.stringify(astraInput).includes("private Fable reasoning"));
  const call = astraInput.find((item: any) => item.type === "function_call");
  const result = astraInput.find((item: any) => item.type === "function_call_output");
  assert.match(call.call_id, /^wb_[a-f0-9]+$/);
  assert.equal(call.call_id, result.call_id);
  assert.ok(JSON.stringify(result.output).includes("saved"));
  assert.ok(!JSON.stringify(fableBodies.at(-1)).includes(reasoning.encrypted_content));
  const after = await transcript(request);
  assert.equal(original.path, after.path);
  assert.ok(after.text.startsWith(original.text));
  assert.ok(after.text.includes("private-fable-signature"), "native original stays in SDK history");
  assert.ok(after.text.includes(reasoning.encrypted_content));
  assert.equal(observations.filter((event) => event.type === "adapter_route_change").length, 2);
  for (const event of observations.filter((event) => event.type === "adapter_route_change")) {
    assert.equal(createHash("sha256").update(await readFile(event.data.checkpoint.path)).digest("hex"), event.data.checkpoint.sha256);
  }
});

test("Astra successful tools replay as matching native Fable tool pairs with collision-resistant IDs", async (t) => {
  const { config, request } = await fixture(t);
  let calls = 0;
  let tools = 0;
  request.tools = [{
    name: "remember", description: "fixture", parameters: { type: "object" },
    execute: async () => { tools++; return "saved"; },
  }];
  await assert.rejects(new PiAdapter(config, {
    credentials, fetch: async () => sse(++calls === 1 ? events([reasoning, toolCall]) :
      events([], "failed", { error: { code: "server_error", message: "fixture" } })),
  }).run(request), hasCode("model_error"));
  let payload: any;
  t.mock.method(BedrockRuntimeClient.prototype, "send", async (command: any) => {
    payload = command.input;
    return bedrockFixture();
  });
  await new PiAdapter(config, { bedrockStream: stockBedrockStream }).run({ ...request, route: RECOMMENDED_ROUTES.fable });
  assert.equal(tools, 1);
  const content = payload.messages.flatMap((message: any) => message.content);
  const call = content.find((block: any) => block.toolUse).toolUse;
  const result = content.find((block: any) => block.toolResult).toolResult;
  assert.match(call.toolUseId, /^wb_[a-f0-9]+$/);
  assert.equal(call.toolUseId, result.toolUseId);
  assert.ok(!JSON.stringify(payload).includes(reasoning.encrypted_content));
  // Truncating two long foreign IDs to 64 characters would alias their results.
  const source = (await transcript(request)).manager.buildSessionContext().messages.find((message) => message.role === "assistant")!;
  assert.equal(source.role, "assistant");
  const long = "same".repeat(30);
  const projected = projectNativeContext({ messages: [{
    ...source, content: [
      { type: "toolCall", id: `${long}A`, name: "remember", arguments: {} },
      { type: "toolCall", id: `${long}B`, name: "remember", arguments: {} },
    ],
  }] }, resolveRouteModel(RECOMMENDED_ROUTES.fable));
  const ids = (projected.context.messages[0] as any).content.map((block: any) => block.id);
  assert.notEqual(ids[0], ids[1]);
  assert.ok(ids.every((id: string) => id.length <= 64));
});

test("automatic compaction failure and supervisor retry preserve successful effects", async (t) => {
  const { config, request, observations } = await fixture(t);
  let calls = 0;
  let tools = 0;
  request.tools = [{
    name: "remember", description: "fixture", parameters: { type: "object" },
    execute: async () => { tools++; return { saved: "completed-effect" }; },
  }];
  const adapter = new PiAdapter(config, {
    credentials,
    fetch: async () => {
      calls++;
      if (calls === 1) return sse(events([reasoning, toolCall], "completed", {
        usage: { ...nativeUsage, input_tokens: 900000, total_tokens: 900009 },
      }));
      if (calls === 2) return sse(events([], "failed", { error: { code: "server_error", message: "summary fixture failure" } }));
      return sse(events([textItem("Completed effect: completed-effect; do not repeat it.")]));
    },
  });
  await assert.rejects(adapter.run(request), hasCode("model_error"));
  assert.equal(calls, 2);
  assert.equal(tools, 1);
  const failure = observations.find((event) => event.type === "compaction_failed")!.data;
  assert.ok(JSON.stringify(JSON.parse(await readFile(failure.checkpoint.path, "utf8"))).includes("completed-effect"));
  assert.equal((await transcript(request)).manager.getEntries().filter((entry) => entry.type === "compaction").length, 0);
  await adapter.run({ ...request, task: { ...request.task, attempt: 2 } });
  assert.equal(tools, 1);
  assert.equal(observations.filter((event) => event.type === "compaction_end").length, 1);
});

test("abort during a summary releases ownership without committing partial compaction", async (t) => {
  const { config, request } = await fixture(t);
  const controller = new AbortController();
  request.signal = controller.signal;
  let calls = 0;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const adapter = new PiAdapter(config, {
    credentials,
    fetch: async (_input, init) => {
      if (++calls === 1) return sse(events());
      return await new Promise<Response>((_resolve, reject) => {
        started();
        init!.signal!.addEventListener("abort", () => reject(new Error("aborted fixture")), { once: true });
      });
    },
  });
  await adapter.run(request);
  const pending = adapter.compact(request);
  await ready;
  controller.abort();
  await assert.rejects(pending, hasCode("canceled"));
  assert.equal((await transcript(request)).manager.getEntries().filter((entry) => entry.type === "compaction").length, 0);
  await new PiAdapter(config, { credentials, fetch: async () => sse(events()) }).run({
    ...request, signal: new AbortController().signal,
  });
});

test("summary input excludes vendor thinking while its full original remains archived", async (t) => {
  const { config, request } = await fixture(t);
  request.prompt += "\n" + "Recorded synthetic source material.\n".repeat(300);
  let calls = 0;
  request.tools = [{
    name: "remember", description: "fixture", parameters: { type: "object" }, execute: async () => "saved",
  }];
  const adapter = new PiAdapter(config, {
    credentials,
    fetch: async (_input, init) => {
      calls++;
      if (calls === 1) return sse(events([{ ...reasoning, summary: [{ type: "summary_text", text: "private summary reasoning" }] }, toolCall]));
      if (calls === 3) {
        const body = String(init?.body);
        assert.ok(!body.includes("private summary reasoning"));
        assert.ok(!body.includes("[Assistant thinking]"));
        assert.ok(body.includes("saved"));
      }
      return sse(events([textItem("Completed effect: saved.")], "completed",
        calls === 2 ? { usage: { ...nativeUsage, input_tokens: 3500, total_tokens: 3509 } } : {}));
    },
  });
  await adapter.run(request);
  const compacted = await adapter.compact(request);
  assert.ok((await readFile(compacted.checkpoint.path, "utf8")).includes("private summary reasoning"));
  assert.equal(calls, 3);
});

test("explicit non-reducing summaries preserve their receipt but cannot change active context", async (t) => {
  const { config, request, observations } = await fixture(t);
  let calls = 0;
  const adapter = new PiAdapter(config, {
    credentials, fetch: async () => sse(events([textItem(++calls === 1 ? "saved" : "Verbose summary. ".repeat(100))])),
  });
  await adapter.run(request);
  const before = await transcript(request);
  await assert.rejects(adapter.compact(request), hasCode("compaction_no_progress"));
  const after = await transcript(request);
  assert.equal(after.manager.getEntries().filter((entry) => entry.type === "compaction").length, 0);
  assert.ok(after.text.startsWith(before.text));
  const failure = observations.find((event) => event.type === "compaction_failed")!.data;
  assert.ok(failure.summaryReceipt.path);
  assert.equal(calls, 2);
});

test("Fable task compacts through preselected Astra Max without changing its model or native suffix", async (t) => {
  const { config, request, observations } = await fixture(t, RECOMMENDED_ROUTES.fable);
  config.compactor = RECOMMENDED_ROUTES.astra;
  let fableCalls = 0;
  let helperCalls = 0;
  let toolCalls = 0;
  const fableBodies: any[] = [];
  request.tools = [{
    name: "remember", description: "fixture", parameters: { type: "object" },
    execute: async () => { toolCalls++; return "saved"; },
  }];
  t.mock.method(BedrockRuntimeClient.prototype, "send", async (command: any) => {
    fableBodies.push(command.input);
    return bedrockFixture(++fableCalls === 1, "saved", fableCalls === 1 ? 900000 : 21);
  });
  const adapter = new PiAdapter(config, {
    bedrockStream: stockBedrockStream, credentials,
    fetch: async (_input, init) => {
      helperCalls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, RECOMMENDED_ROUTES.astra.model);
      assert.equal(body.reasoning.effort, "max");
      assert.equal(body.max_output_tokens, 128000);
      assert.equal(body.tools, undefined);
      return sse(events([textItem("Continue the fixture. Keep completed effects completed.")]));
    },
  });
  const reply = await adapter.run(request);
  assert.equal(reply.provider, RECOMMENDED_ROUTES.fable.provider);
  assert.equal(reply.model, RECOMMENDED_ROUTES.fable.model);
  assert.equal(fableCalls, 2);
  assert.equal(helperCalls, 1);
  assert.equal(toolCalls, 1);
  const end = observations.find((event) => event.type === "compaction_end")!.data;
  assert.equal(end.provider, RECOMMENDED_ROUTES.astra.provider);
  assert.equal(end.model, RECOMMENDED_ROUTES.astra.model);
  assert.equal(end.taskProvider, RECOMMENDED_ROUTES.fable.provider);
  assert.equal(end.taskModel, RECOMMENDED_ROUTES.fable.model);
  assert.equal(end.contextWindow, 1000000);
  assert.equal(end.outputReserve, 128000);
  const start = observations.find((event) => event.type === "compaction_start")!.data;
  assert.equal(start.helper.selection, "preselected_compactor");
  assert.equal(start.helper.effort, "max");
  assert.ok(JSON.stringify(fableBodies[1]).includes("private-fable-signature"));
  assert.ok(JSON.stringify(fableBodies[1]).includes("fable-call"));
  assert.deepEqual((await transcript(request)).manager.buildSessionContext().model, {
    provider: RECOMMENDED_ROUTES.fable.provider, modelId: RECOMMENDED_ROUTES.fable.model,
  });
  assert.equal(observations.filter((event) => event.type === "adapter_route_change").length, 0);
});

test("a helper sharing the provider ID cannot replace the main task model", async (t) => {
  const { config, request } = await fixture(t, { ...RECOMMENDED_ROUTES.astra, model: "us.openai.gpt-6-astra" });
  config.compactor = RECOMMENDED_ROUTES.astra;
  const models: string[] = [];
  const adapter = new PiAdapter(config, {
    credentials,
    fetch: async (_input, init) => {
      models.push(JSON.parse(String(init?.body)).model);
      return sse(events([textItem("Saved state.")], "completed",
        models.length === 1 ? { usage: { ...nativeUsage, input_tokens: 900000, total_tokens: 900009 } } : {}));
    },
  });
  await adapter.run(request);
  const compacted = await adapter.compact(request);
  assert.equal(compacted.model, RECOMMENDED_ROUTES.astra.model);
  assert.equal(compacted.taskModel, request.route.model);
  assert.equal((await adapter.run(request)).model, request.route.model);
  assert.deepEqual(models, [request.route.model, RECOMMENDED_ROUTES.astra.model, request.route.model]);
});

test("configured helper refuses sub-Max effort before any model request and Doctor identifies its role", async (t) => {
  const { config, request } = await fixture(t);
  config.compactor = { ...RECOMMENDED_ROUTES.fable, effort: "xhigh" };
  let calls = 0;
  const adapter = new PiAdapter(config, { credentials, fetch: async () => { calls++; return sse(events()); } });
  await assert.rejects(adapter.run(request), hasCode("effort_mismatch"));
  assert.equal(calls, 0);
  const doctor = await adapter.doctor();
  const helper = (doctor.checks.compaction as any).helper;
  assert.equal(helper.role, "compactor");
  assert.equal(helper.errorCode, "effort_mismatch");
  config.compactor = RECOMMENDED_ROUTES.astra;
  const valid = (await adapter.doctor()).checks.compaction as any;
  assert.equal(valid.helper.provider, RECOMMENDED_ROUTES.astra.provider);
  assert.equal(valid.helper.model, RECOMMENDED_ROUTES.astra.model);
  assert.equal(valid.helper.effort, "max");
});

test("content filters and structured refusals are non-retryable and forbid failover", async (t) => {
  const refused = { ...textItem(), content: [{ type: "refusal", refusal: "Synthetic refusal." }] };
  for (const [name, frames, expected] of [
    ["SSE filter", events([], "failed", { error: { code: "content_policy_violation", message: "synthetic filter" } }), "content_filter"],
    ["SSE refusal", events([refused]), "refusal"],
    ["refusal before incomplete tool JSON", events([refused, { ...toolCall, arguments: "{" }]), "refusal"],
  ] as const) await t.test(name, async (t) => {
    const { config, request, observations } = await fixture(t);
    let calls = 0;
    await assert.rejects(new PiAdapter(config, {
      credentials, fetch: async () => { calls++; return sse([...frames]); },
    }).run(request), (error: any) => {
      assert.equal(error.code, expected);
      assert.equal(error.retryable, false);
      assert.equal(error.failoverAllowed, false);
      return true;
    });
    assert.equal(calls, 1);
    const end = observations.find((event) => event.type === "provider_end")!.data;
    assert.equal(end.retryable, false);
    assert.equal(end.failoverAllowed, false);
  });
  for (const stopReason of ["content_filtered", "guardrail_intervened", "refusal"]) await t.test(stopReason, async (t) => {
    const { config, request } = await fixture(t, RECOMMENDED_ROUTES.fable);
    let calls = 0;
    t.mock.method(BedrockRuntimeClient.prototype, "send", async () => {
      calls++;
      return { $metadata: { httpStatusCode: 200 }, stream: (async function* () {
        yield { messageStart: { role: "assistant" } };
        yield { messageStop: { stopReason } };
      })() };
    });
    await assert.rejects(new PiAdapter(config, { bedrockStream: stockBedrockStream }).run(request), (error: any) => {
      assert.equal(error.code, stopReason === "refusal" ? "refusal" : "content_filter");
      assert.equal(error.retryable, false);
      assert.equal(error.failoverAllowed, false);
      return true;
    });
    assert.equal(calls, 1);
  });
});

test("a refused configured compactor leaves the task intact and never switches helpers", async (t) => {
  const { config, request, observations } = await fixture(t, RECOMMENDED_ROUTES.fable);
  config.compactor = RECOMMENDED_ROUTES.astra;
  let fableCalls = 0;
  let helperCalls = 0;
  t.mock.method(BedrockRuntimeClient.prototype, "send", async () => { fableCalls++; return bedrockFixture(); });
  const adapter = new PiAdapter(config, {
    bedrockStream: stockBedrockStream, credentials,
    fetch: async () => {
      helperCalls++;
      return new Response('{"error":{"code":"content_filter","message":"synthetic filter"}}', {
        status: 400, headers: { "content-type": "application/json" },
      });
    },
  });
  await adapter.run(request);
  await assert.rejects(adapter.compact(request), (error: any) => {
    assert.equal(error.code, "content_filter");
    assert.equal(error.retryable, false);
    assert.equal(error.failoverAllowed, false);
    return true;
  });
  assert.equal(fableCalls, 1);
  assert.equal(helperCalls, 1);
  const failed = observations.find((event) => event.type === "compaction_failed")!.data;
  assert.equal(failed.model, RECOMMENDED_ROUTES.astra.model);
  assert.equal(failed.taskModel, RECOMMENDED_ROUTES.fable.model);
  assert.equal(failed.failoverAllowed, false);
  const session = (await transcript(request)).manager;
  assert.equal(session.getEntries().filter((entry) => entry.type === "compaction").length, 0);
  assert.equal(session.buildSessionContext().model?.provider, RECOMMENDED_ROUTES.fable.provider);
});

test("W03b live native cross-model continuity and Max compaction", {
  skip: process.env.WORKBENCH_W03B_LIVE !== "1",
}, async () => {
  // Explicit opt-in. Ordinary npm test/check never makes paid requests.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = process.env.WORKBENCH_W03B_EVIDENCE_DIR ??
    join(process.env.LOCALAPPDATA ?? tmpdir(), "Workbench", "qualification", `w03b-${stamp}`);
  await mkdir(directory, { recursive: true });
  const identity = JSON.parse(execFileSync("aws", ["sts", "get-caller-identity", "--profile", "default", "--region", "us-east-1", "--output", "json"], {
    encoding: "utf8", windowsHide: true,
  }));
  assert.ok(process.env.WORKBENCH_LIVE_EXPECTED_ACCOUNT, "Set the expected account before opting into native paid tests.");
  assert.ok(process.env.WORKBENCH_LIVE_EXPECTED_ROLE_PREFIX, "Set the expected assumed-role ARN prefix.");
  assert.equal(identity.Account, process.env.WORKBENCH_LIVE_EXPECTED_ACCOUNT);
  assert.ok(identity.Arn.startsWith(process.env.WORKBENCH_LIVE_EXPECTED_ROLE_PREFIX!));
  const now = new Date().toISOString();
  const id = randomUUID();
  const token = randomUUID();
  const config: WorkbenchConfig = {
    version: 1, stateDir: join(directory, "state"), maxWorkers: 1, noProgressLimit: 3, execution: "trusted-local",
    coordinator: RECOMMENDED_ROUTES.fable, worker: RECOMMENDED_ROUTES.astra, reviewer: RECOMMENDED_ROUTES.fable,
    fallbacks: [], capabilities: [], mcp: {},
  };
  const receipt: Record<string, any> = {
    startedAt: now, status: "running", syntheticOnly: true, identity: { arn: identity.Arn, account: identity.Account },
    sourceHashes: {}, toolCalls: 0, events: [],
  };
  for (const path of ["src/adapter.ts", "src/providers.ts", "src/contracts.ts", "tests/adapter.test.ts"]) {
    receipt.sourceHashes[path] = createHash("sha256").update(await readFile(path)).digest("hex");
  }
  const receiptPath = join(directory, "receipt.json");
  const save = () => writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  await save();
  const request: AgentRequest = {
    run: { id, objective: "Synthetic continuity qualification.", cwd: directory, state: "running", createdAt: now, updatedAt: now },
    task: {
      id: randomUUID(), runId: id, objective: "Echo once and preserve the result across native models and compaction.",
      role: "worker", state: "running", dependsOn: [], writePaths: [], acceptance: [], evidence: [],
      attempt: 1, createdAt: now, updatedAt: now,
    },
    prompt: `Call echo_probe exactly once with token "${token}". Then reply exactly DONE:${token}.`,
    systemPrompt: "This is a synthetic protocol qualification. Follow the requested exact output. Never repeat a completed echo_probe call.",
    route: RECOMMENDED_ROUTES.fable, signal: new AbortController().signal, sessionDir: join(directory, "sessions"),
    tools: [{
      name: "echo_probe", description: "Return a synthetic token.",
      parameters: { type: "object", properties: { token: { type: "string" } }, required: ["token"], additionalProperties: false },
      execute: async (args) => {
        receipt.toolCalls++;
        assert.equal(args.token, token);
        return { token };
      },
    }],
    onEvent: (type, data) => {
      const event = { type, data };
      receipt.events.push(event);
      appendFileSync(join(directory, "events.jsonl"), JSON.stringify(event) + "\n", "utf8");
      console.log(JSON.stringify(event));
    },
  };
  try {
    receipt.first = await new PiAdapter(config).run(request);
    assert.equal(receipt.toolCalls, 1);
    assert.equal(receipt.first.text.trim(), `DONE:${token}`);
    await save();
    const continuation = "Without calling any tools, reply only with the exact token echo_probe returned earlier.";
    request.prompt = continuation;
    request.task.attempt++;
    request.route = RECOMMENDED_ROUTES.astra;
    receipt.astra = await new PiAdapter(config).run(request);
    assert.equal(receipt.astra.text.trim(), token);
    assert.equal(receipt.toolCalls, 1);
    await save();
    request.task.attempt++;
    request.route = RECOMMENDED_ROUTES.fable;
    receipt.fableReturn = await new PiAdapter(config).run(request);
    assert.equal(receipt.fableReturn.text.trim(), token);
    assert.equal(receipt.toolCalls, 1);
    receipt.compaction = await new PiAdapter(config).compact(request);
    assert.equal(receipt.compaction.effort, "max");
    assert.ok(receipt.compaction.estimatedTokensAfter < receipt.compaction.tokensBefore);
    await save();
    receipt.afterCompaction = await new PiAdapter(config).run(request);
    assert.equal(receipt.afterCompaction.text.trim(), token);
    assert.equal(receipt.toolCalls, 1);
    const sessions = receipt.events.filter((event: any) => event.type === "adapter_session");
    assert.equal(new Set(sessions.map((event: any) => event.data.sessionId)).size, 1);
    const summaryCalls = receipt.events.filter((event: any) => event.type === "provider_end" && event.data.purpose === "compaction");
    assert.equal(summaryCalls.length, 1);
    assert.equal(summaryCalls[0].data.wireEffort, "max");
    assert.equal(summaryCalls[0].data.stopReason, "stop");
    for (const event of receipt.events.filter((event: any) => event.type === "provider_end")) {
      assert.equal(event.data.wireEffort, "max");
      assert.equal(event.data.maxTokens, 128000);
      assert.equal(event.data.transport.httpStatus, 200);
      assert.ok(["stop", "toolUse"].includes(event.data.stopReason));
    }
    const checkpoint = receipt.compaction.checkpoint;
    const source = await readFile(checkpoint.path);
    assert.equal(createHash("sha256").update(source).digest("hex"), checkpoint.sha256);
    assert.ok(source.toString().includes(`DONE:${token}`));
    assert.ok(source.toString().includes(token));
    receipt.status = "pass";
  } catch (error: any) {
    receipt.status = "fail";
    receipt.error = { name: error.name, code: error.code, message: error.message };
    throw error;
  } finally {
    receipt.finishedAt = new Date().toISOString();
    await save();
    console.log(JSON.stringify({ w03b: receipt.status, receipt: receiptPath, toolCalls: receipt.toolCalls }));
  }
});

test("W03b live resume Max compaction of an existing qualified task", {
  skip: process.env.WORKBENCH_W03B_LIVE !== "1" || !process.env.WORKBENCH_W03B_RESUME_DIR,
}, async () => {
  const priorDirectory = resolve(process.env.WORKBENCH_W03B_RESUME_DIR!);
  const priorPath = join(priorDirectory, "receipt.json");
  const priorBytes = await readFile(priorPath);
  const prior = JSON.parse(priorBytes.toString());
  assert.equal(prior.toolCalls, 1);
  assert.ok(prior.astra && prior.fableReturn, "cross-model control must already have completed");
  const priorSessionEvents = prior.events.filter((event: any) => event.type === "adapter_session");
  const taskDirectory = join(priorDirectory, "sessions", priorSessionEvents[0].data.taskSessionKey);
  const manager = SessionManager.continueRecent(priorDirectory, taskDirectory);
  let recovery: Record<string, unknown> | undefined;
  if (process.env.WORKBENCH_W03B_RECOVER_RECEIPT) {
    const failurePath = resolve(process.env.WORKBENCH_W03B_RECOVER_RECEIPT);
    const failureBytes = await readFile(failurePath);
    const failure = JSON.parse(failureBytes.toString());
    assert.equal(failure.status, "fail");
    assert.ok(failure.compaction.estimatedTokensAfter >= failure.compaction.tokensBefore);
    const branch = manager.getBranch();
    const at = branch.findIndex((entry) => entry.id === failure.compaction.compactionEntryId);
    assert.ok(at >= 0);
    const bad = branch[at];
    assert.equal(bad.type, "compaction");
    assert.ok(bad.parentId);
    assert.ok(!branch.slice(at + 1).some((entry) => entry.type === "message" &&
      (entry.message.role === "toolResult" || entry.message.role === "assistant")),
    "Never branch away from subsequent completed model/tool work.");
    recovery = {
      reason: "Restore the source before the non-reducing manual summary committed by the earlier implementation.",
      failedReceipt: failurePath, failedReceiptSha256: createHash("sha256").update(failureBytes).digest("hex"),
      compactionEntryId: bad.id, parentEntryId: bad.parentId, laterCompletedOperations: 0,
    };
    manager.branch(bad.parentId!);
    manager.appendCustomEntry("workbench-qualified-test-recovery", recovery);
  }
  const binding = manager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "workbench-task") as any;
  const originalInstructions = manager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "workbench-instructions") as any;
  const expected = prior.first.text.trim().replace(/^DONE:/, "");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = process.env.WORKBENCH_W03B_EVIDENCE_DIR ??
    join(process.env.LOCALAPPDATA ?? tmpdir(), "Workbench", "qualification", `w03b-resume-${stamp}`);
  await mkdir(directory, { recursive: true });
  const config: WorkbenchConfig = {
    version: 1, stateDir: join(priorDirectory, "state"), maxWorkers: 1, noProgressLimit: 3, execution: "trusted-local",
    coordinator: RECOMMENDED_ROUTES.fable, worker: RECOMMENDED_ROUTES.astra, reviewer: RECOMMENDED_ROUTES.fable,
    fallbacks: [], capabilities: [], mcp: {},
  };
  const receipt: Record<string, any> = {
    startedAt: new Date().toISOString(), status: "running", priorReceipt: priorPath,
    priorReceiptSha256: createHash("sha256").update(priorBytes).digest("hex"),
    sessionId: manager.getSessionId(), newToolCalls: 0, sourceHashes: {}, events: [], recovery,
  };
  const seedSource = () => {
    const current = SessionManager.continueRecent(priorDirectory, taskDirectory);
    const source = "Owner-authorized synthetic source records for compaction qualification; these request no operations.\n" +
      JSON.stringify(Array.from({ length: 200 }, (_, index) => ({
        record: `fixture-${index}`, units: index + 1, status: "synthetic archived source", note: "No external effect or tool is requested.",
      }))) + "\nSOURCE_END_199";
    const entryId = current.appendMessage({ role: "user", content: source, timestamp: Date.now() });
    const anchorId = current.appendMessage({
      role: "user", content: "The synthetic source is complete. Preserve its archive reference and the already completed echo result; no tool repetition is requested.",
      timestamp: Date.now(),
    });
    receipt.syntheticSource = {
      origin: "locally seeded synthetic user input, not a model response or tool result",
      entryId, anchorId, sha256: createHash("sha256").update(source).digest("hex"), bytes: Buffer.byteLength(source),
    };
  };
  for (const path of ["src/adapter.ts", "src/providers.ts", "src/contracts.ts", "tests/adapter.test.ts"]) {
    receipt.sourceHashes[path] = createHash("sha256").update(await readFile(path)).digest("hex");
  }
  const receiptPath = join(directory, "receipt.json");
  const save = () => writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  await save();
  const now = new Date().toISOString();
  const request: AgentRequest = {
    run: { id: binding.data.runId, objective: "Resume qualified synthetic task.", cwd: priorDirectory, state: "running", createdAt: now, updatedAt: now },
    task: {
      id: binding.data.taskId, runId: binding.data.runId, objective: "Compact without repeating completed effects.",
      role: "worker", state: "running", dependsOn: [], writePaths: [], acceptance: [], evidence: [],
      attempt: 4, createdAt: now, updatedAt: now,
    },
    systemPrompt: originalInstructions.data.systemPrompt,
    prompt: "Without calling any tools, reply only with the exact token echo_probe returned earlier.",
    route: process.env.WORKBENCH_W03B_COMPACT_ROUTE === "astra" ? RECOMMENDED_ROUTES.astra : RECOMMENDED_ROUTES.fable,
    signal: new AbortController().signal, sessionDir: join(priorDirectory, "sessions"),
    tools: [{
      name: "echo_probe", description: "Return a synthetic token.",
      parameters: { type: "object", properties: { token: { type: "string" } }, required: ["token"], additionalProperties: false },
      execute: async () => { receipt.newToolCalls++; throw new Error("Completed echo must not be repeated."); },
    }],
    onEvent: (type, data) => {
      const event = { type, data };
      receipt.events.push(event);
      appendFileSync(join(directory, "events.jsonl"), JSON.stringify(event) + "\n", "utf8");
      console.log(JSON.stringify(event));
    },
  };
  try {
    if (process.env.WORKBENCH_W03B_REQUALIFY_CROSS === "1") {
      request.route = RECOMMENDED_ROUTES.fable;
      receipt.fableCross = await new PiAdapter(config).run(request);
      assert.equal(receipt.fableCross.text.trim(), expected);
      assert.equal(receipt.newToolCalls, 0);
      await save();
      request.route = RECOMMENDED_ROUTES.astra;
      receipt.astraCross = await new PiAdapter(config).run(request);
      assert.equal(receipt.astraCross.text.trim(), expected);
      assert.equal(receipt.newToolCalls, 0);
      await save();
    }
    if (process.env.WORKBENCH_W03B_SEED_SOURCE === "1") seedSource();
    receipt.compaction = await new PiAdapter(config).compact(request);
    assert.equal(receipt.compaction.effort, "max");
    assert.ok(receipt.compaction.estimatedTokensAfter < receipt.compaction.tokensBefore);
    if (receipt.syntheticSource) {
      assert.ok((await readFile(receipt.compaction.checkpoint.path, "utf8")).includes("SOURCE_END_199"));
    }
    await save();
    receipt.afterCompaction = await new PiAdapter(config).run(request);
    assert.equal(receipt.afterCompaction.text.trim(), expected);
    assert.equal(receipt.newToolCalls, 0);
    for (const event of receipt.events.filter((event: any) => event.type === "provider_end")) {
      assert.equal(event.data.wireEffort, "max");
      assert.equal(event.data.maxTokens, 128000);
      assert.equal(event.data.transport.httpStatus, 200);
      assert.equal(event.data.stopReason, "stop");
    }
    assert.equal(SessionManager.continueRecent(priorDirectory, taskDirectory).getSessionId(), receipt.sessionId);
    assert.equal(createHash("sha256").update(await readFile(priorPath)).digest("hex"), receipt.priorReceiptSha256);
    receipt.status = "pass";
  } catch (error: any) {
    receipt.status = "fail";
    receipt.error = { name: error.name, code: error.code, message: error.message };
    throw error;
  } finally {
    receipt.finishedAt = new Date().toISOString();
    await save();
    console.log(JSON.stringify({ w03b: receipt.status, receipt: receiptPath, newToolCalls: receipt.newToolCalls }));
  }
});

test("W03b live preselected Astra compactor with fresh Fable and Astra task sessions", {
  skip: process.env.WORKBENCH_W03B_LIVE !== "1",
}, async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = process.env.WORKBENCH_W03B_EVIDENCE_DIR ??
    join(process.env.LOCALAPPDATA ?? tmpdir(), "Workbench", "qualification", `w03b-preselected-${stamp}`);
  await mkdir(directory, { recursive: true });
  const identity = JSON.parse(execFileSync("aws", [
    "sts", "get-caller-identity", "--profile", "default", "--region", "us-east-1", "--output", "json",
  ], { encoding: "utf8", windowsHide: true }));
  assert.ok(process.env.WORKBENCH_LIVE_EXPECTED_ACCOUNT, "Set the expected account before opting into native paid tests.");
  assert.ok(process.env.WORKBENCH_LIVE_EXPECTED_ROLE_PREFIX, "Set the expected assumed-role ARN prefix.");
  assert.equal(identity.Account, process.env.WORKBENCH_LIVE_EXPECTED_ACCOUNT);
  assert.ok(identity.Arn.startsWith(process.env.WORKBENCH_LIVE_EXPECTED_ROLE_PREFIX!));
  const selected = Object.entries(RECOMMENDED_ROUTES).filter(([name]) =>
    !process.env.WORKBENCH_W03B_TASK_ROLE || process.env.WORKBENCH_W03B_TASK_ROLE === name);
  assert.ok(selected.length > 0, "Select fable or astra.");
  const receiptPath = join(directory, "receipt.json");
  const receipt: Record<string, any> = {
    startedAt: new Date().toISOString(), status: "running", syntheticOnly: true,
    identity: { account: identity.Account, arn: identity.Arn }, requestedCases: selected.map(([name]) => name), sourceHashes: {}, cases: [],
  };
  for (const path of ["src/adapter.ts", "src/providers.ts", "src/contracts.ts", "tests/adapter.test.ts"]) {
    receipt.sourceHashes[path] = createHash("sha256").update(await readFile(path)).digest("hex");
  }
  const save = () => writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  const coordinate = (running: unknown) => {
    if (!existsSync(".local/adapter-status.json")) return;
    const status = JSON.parse(readFileSync(".local/adapter-status.json", "utf8"));
    status.updated_at = new Date().toISOString();
    status.running_paid_probe = running;
    writeFileSync(".local/adapter-status.json", JSON.stringify(status, null, 2) + "\n");
  };
  await save();
  try {
    for (const [name, route] of selected) {
      const cwd = join(directory, name);
      await mkdir(cwd);
      const now = new Date().toISOString();
      const id = randomUUID();
      const token = randomUUID();
      const result: Record<string, any> = {
        name, taskRoute: route, compactor: RECOMMENDED_ROUTES.astra,
        status: "running", toolCalls: 0, events: [],
      };
      receipt.cases.push(result);
      const config: WorkbenchConfig = {
        version: 1, stateDir: join(cwd, "state"), maxWorkers: 1, noProgressLimit: 3, execution: "trusted-local",
        coordinator: RECOMMENDED_ROUTES.fable, worker: RECOMMENDED_ROUTES.astra,
        reviewer: RECOMMENDED_ROUTES.fable, compactor: RECOMMENDED_ROUTES.astra,
        fallbacks: [], capabilities: [], mcp: {},
      };
      const request: AgentRequest = {
        run: { id, objective: "Synthetic configured-compactor qualification.", cwd, state: "running", createdAt: now, updatedAt: now },
        task: {
          id: randomUUID(), runId: id, objective: "Preserve one completed echo through configured Max compaction.",
          role: "worker", state: "running", dependsOn: [], writePaths: [], acceptance: [], evidence: [],
          attempt: 1, createdAt: now, updatedAt: now,
        },
        systemPrompt: "This is a synthetic tool protocol qualification. Follow the exact output instruction. Never repeat a completed echo_probe call.",
        prompt: `Call echo_probe exactly once with token "${token}". Then reply exactly DONE:${token}.`,
        tools: [{
          name: "echo_probe", description: "Return a synthetic token.",
          parameters: { type: "object", properties: { token: { type: "string" } }, required: ["token"], additionalProperties: false },
          execute: async (args) => { result.toolCalls++; assert.equal(args.token, token); return { token }; },
        }],
        route, signal: new AbortController().signal, sessionDir: join(cwd, "sessions"),
        onEvent: (type, data) => {
          result.events.push({ type, data });
          appendFileSync(join(directory, "events.jsonl"), JSON.stringify({ case: name, type, data }) + "\n");
          if (type === "adapter_session") result.sessionId = (data as any).sessionId;
          coordinate({ pid: process.pid, case: name, sdk_session: result.sessionId, receipt: receiptPath, last_event: type });
          console.log(JSON.stringify({ case: name, type, data }));
        },
      };
      coordinate({ pid: process.pid, case: name, receipt: receiptPath, last_event: "starting" });
      result.first = await new PiAdapter(config).run(request);
      assert.equal(result.first.text.trim(), `DONE:${token}`);
      assert.equal(result.toolCalls, 1);
      const saved = await transcript(request);
      const source = "Owner-authorized synthetic source records for compaction qualification; no operations requested.\n" +
        JSON.stringify(Array.from({ length: 200 }, (_, index) => ({
          record: `fixture-${index}`, quantity: index + 1, status: "archived synthetic source",
        }))) + "\nSOURCE_END_199";
      result.syntheticSource = {
        origin: "synthetic user input, not a model response or tool result",
        sha256: createHash("sha256").update(source).digest("hex"), bytes: Buffer.byteLength(source),
      };
      saved.manager.appendMessage({ role: "user", content: source, timestamp: Date.now() });
      saved.manager.appendMessage({
        role: "user", content: "The source is complete. Preserve its checkpoint and the completed echo result. Do not repeat tools.",
        timestamp: Date.now(),
      });
      await save();
      result.compaction = await new PiAdapter(config).compact(request);
      assert.equal(result.compaction.provider, RECOMMENDED_ROUTES.astra.provider);
      assert.equal(result.compaction.model, RECOMMENDED_ROUTES.astra.model);
      assert.equal(result.compaction.taskModel, route.model);
      assert.equal(result.compaction.effort, "max");
      assert.equal(result.compaction.outputReserve, 128000);
      assert.ok(result.compaction.estimatedTokensAfter < result.compaction.tokensBefore);
      const checkpoint = await readFile(result.compaction.checkpoint.path);
      assert.equal(createHash("sha256").update(checkpoint).digest("hex"), result.compaction.checkpoint.sha256);
      assert.ok(checkpoint.toString().includes("SOURCE_END_199"));
      assert.ok(checkpoint.toString().includes(token));
      assert.equal((await transcript(request)).manager.buildSessionContext().model?.modelId, route.model);
      request.prompt = "Without calling any tools, reply only with the exact token echo_probe returned earlier.";
      request.task.attempt++;
      result.after = await new PiAdapter(config).run(request);
      assert.equal(result.after.text.trim(), token);
      assert.equal(result.after.model, route.model);
      assert.equal(result.toolCalls, 1);
      assert.equal((await transcript(request)).manager.getSessionId(), saved.manager.getSessionId());
      assert.equal(result.events.filter((event: any) => event.type === "adapter_route_change").length, 0);
      const summaries = result.events.filter((event: any) => event.type === "provider_end" && event.data.purpose === "compaction");
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].data.model, RECOMMENDED_ROUTES.astra.model);
      for (const { data } of result.events.filter((event: any) => event.type === "provider_end")) {
        assert.equal(data.wireEffort, "max");
        assert.equal(data.maxTokens, 128000);
        assert.equal(data.transport.httpStatus, 200);
        assert.ok(["stop", "toolUse"].includes(data.stopReason));
      }
      result.status = "pass";
      await save();
    }
    receipt.status = "pass";
  } catch (error: any) {
    receipt.status = "fail";
    receipt.error = { name: error.name, code: error.code, message: error.message };
    if (receipt.cases.length) {
      receipt.cases.at(-1).status = "fail";
      receipt.cases.at(-1).error = receipt.error;
    }
    throw error;
  } finally {
    receipt.finishedAt = new Date().toISOString();
    await save();
    coordinate(null);
    console.log(JSON.stringify({ w03b: receipt.status, receipt: receiptPath }));
  }
});
