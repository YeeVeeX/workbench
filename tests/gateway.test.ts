import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test, type TestContext } from "node:test";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { PiAdapter } from "../src/adapter.js";
import type { AgentRequest, ModelRoute, WorkbenchConfig } from "../src/contracts.js";
import {
  gatewayFetch, inspectGatewayAuth, isGatewayRoute, readGatewayAuth, validateGatewayEndpoint, validateGatewayRoute,
} from "../src/gateway.js";
import { AdapterError, createNativeProvider, DEFAULT_PROFILE, normalizeRoute, resolveRouteModel, terminalError } from "../src/providers.js";

const usage = { input_tokens: 20, output_tokens: 9, total_tokens: 29, input_tokens_details: { cached_tokens: 5 },
  output_tokens_details: { reasoning_tokens: 4 } };
const text = { type: "message", id: "msg_test", role: "assistant", status: "completed",
  content: [{ type: "output_text", text: "Completed café ✅", annotations: [] }] };
const tool = { type: "function_call", id: "fc_test", call_id: "call_test", name: "remember",
  arguments: '{"value":"saved"}', status: "completed" };
const opaque = { type: "reasoning", id: "rs_test", summary: [], encrypted_content: "opaque-fixture" };

function responses(items: any[] = [opaque, text], status = "completed", extra: Record<string, unknown> = {}) {
  return [
    { type: "response.created", response: { id: "resp_test", status: "in_progress" } },
    ...items.flatMap((item, index) => [
      { type: "response.output_item.added", output_index: index, item },
      { type: "response.output_item.done", output_index: index, item },
    ]),
    { type: `response.${status}`, response: { id: "resp_test", model: "gpt-6-astra-max", status, usage, output: items, ...extra } },
  ];
}

function messages(args?: string, stop = args === undefined ? "end_turn" : "tool_use") {
  return [
    { type: "message_start", message: { id: "msg_test", model: "fable-5.1-max", role: "assistant", content: [],
      usage: { input_tokens: 20, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Inspect fixture." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque-signature" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: args === undefined
      ? { type: "text", text: "" } : { type: "tool_use", id: "tool_test", name: "remember", input: {} } },
    { type: "content_block_delta", index: 1, delta: args === undefined
      ? { type: "text_delta", text: "Completed café ✅" } : { type: "input_json_delta", partial_json: args } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 9, output_tokens_details: { thinking_tokens: 4 } } },
    { type: "message_stop" },
  ];
}

function encoded(events: unknown[]): Buffer {
  return Buffer.from(events.map((event) => {
    const type = (event as any).type;
    return `event: ${type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
  }).join(""));
}

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    const target = resolve(dir);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep));
    await rm(target, { recursive: true, force: true });
  });
  return dir;
}

async function mockGateway(t: TestContext) {
  const requests: { path: string; headers: IncomingHttpHeaders; body: any }[] = [];
  let reply: { events?: unknown[]; status?: number; headers?: Record<string, string>; body?: string } = { events: responses() };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    requests.push({ path: request.url!, headers: request.headers, body: raw ? JSON.parse(raw) : undefined });
    response.writeHead(reply.status ?? 200, { "content-type": "text/event-stream", ...reply.headers });
    if (reply.events) {
      const bytes = encoded(reply.events);
      // Split SSE framing, JSON and multi-byte text on the actual local socket.
      for (let index = 0; index < bytes.length; index += 17) {
        response.write(bytes.subarray(index, index + 17));
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      response.end();
    } else response.end(reply.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = (server.address() as { port: number }).port;
  const env = `WB_GATEWAY_TEST_${randomUUID().replaceAll("-", "")}`;
  const secret = `fixture-key-${randomUUID()}`;
  process.env[env] = secret;
  t.after(() => { delete process.env[env]; });
  const route = (kind: "messages" | "responses" = "responses"): ModelRoute => ({
    provider: `workbench-gateway-${kind}`, model: kind === "messages" ? "fable-5.1-max" : "gpt-6-astra-max",
    effort: "max", baseUrl: `http://127.0.0.1:${port}`, auth: { env }, allowPrivateHttp: true,
    contextWindow: 200000, maxTokens: 8192, ...(kind === "messages" ? { adaptiveThinking: true } : {}),
    gatewayPolicy: "studio-fable-astra-max-v1",
  });
  return { requests, secret, env, route, reply: (value: typeof reply) => { reply = value; } };
}

const context: Context = { systemPrompt: "Parent instructions", messages: [{ role: "user", content: "Fixture", timestamp: 1 }] };
const hasCode = (code: string) => (error: unknown) => error instanceof AdapterError && error.code === code;

async function attempt(route: ModelRoute, options: SimpleStreamOptions = {}) {
  const events: any[] = [];
  let awsCalls = 0;
  const native = createNativeProvider(route, (type, data) => events.push({ type, data }), {
    credentials: async () => { awsCalls++; throw new Error("AWS MUST NOT RUN"); },
  });
  const stream = native.provider.streamSimple(native.model, context, { reasoning: route.effort, ...options });
  const output = [];
  for await (const event of stream) output.push(event);
  return { final: await stream.result(), events, output, awsCalls, native };
}

test("gateway route validation pins origins, capacities, auth references and Studio permissions", async (t) => {
  const fixture = await mockGateway(t);
  const route = fixture.route();
  assert.equal(isGatewayRoute(route), true);
  assert.equal(validateGatewayRoute(route).baseUrl, route.baseUrl);
  assert.equal(resolveRouteModel(route).contextWindow, 200000);
  assert.equal(resolveRouteModel(route).maxTokens, 8192);
  assert.equal(DEFAULT_PROFILE, "default");
  assert.equal(normalizeRoute({ provider: "workbench-responses", model: "test", effort: "max" }).profile, "default");
  for (const change of [
    { auth: undefined }, { auth: {} }, { auth: { env: fixture.env, file: "file" } }, { auth: { apiKey: fixture.secret } },
    { auth: { env: "AWS_SESSION_TOKEN" } }, { auth: { file: "relative-key" } },
    { auth: { file: join(tmpdir(), ".aws", "credentials") } }, { auth: { env: "key\nvalue" } },
    { headers: { authorization: fixture.secret } }, { profile: "default" }, { region: "us-east-1" },
    { contextWindow: undefined }, { maxTokens: undefined }, { maxTokens: 1.5 }, { maxTokens: -1 },
    { contextWindow: 8192 }, { maxTokens: 8191 }, { maxTokens: 128001 },
    { baseUrl: "https://user:password@example.test" }, { baseUrl: "https://example.test/?key=value" },
    { baseUrl: "https://example.test/#fragment" }, { baseUrl: "https://example.test/custom" },
    { baseUrl: "http://example.test", allowPrivateHttp: true }, { baseUrl: "http://127.0.0.1", allowPrivateHttp: false },
    { baseUrl: "https://example.test\\@127.0.0.1" }, { baseUrl: "https://example.test/%2e%2e" },
  ]) assert.throws(() => validateGatewayRoute({ ...route, ...change } as ModelRoute), hasCode("configuration"));
  for (const change of [{ model: "other" }, { effort: "xhigh" }, { provider: "workbench-gateway-messages" }]) {
    assert.throws(() => validateGatewayRoute({ ...route, ...change } as ModelRoute), hasCode("effort_mismatch"));
  }
  for (const host of ["localhost", "127.0.0.1", "[::1]", "[fd7a:115c:a1e0::1]", "10.1.2.3", "172.16.0.1",
    "172.31.255.255", "192.168.1.3", "100.64.0.1", "100.127.255.254", "fixture.tail123abc.ts.net"]) {
    assert.equal(validateGatewayEndpoint(`http://${host}/mcp`, true).hostname, host);
  }
  for (const host of ["100.63.255.255", "100.128.0.1", "172.32.0.1", "169.254.169.254", "example.ts.net",
    "tail123abc.ts.net", "fixture.tail123abc.ts.net.example.test", "fixture.tail-no.ts.net", "localhost.example.test"]) {
    assert.throws(() => validateGatewayEndpoint(`http://${host}/mcp`, true), hasCode("configuration"));
  }
  assert.equal(validateGatewayEndpoint("https://example.test/mcp").pathname, "/mcp");
  assert.equal(validateGatewayRoute({ ...route, baseUrl: "https://example.test/v1/" }).baseUrl, "https://example.test");
});

test("gateway auth readiness reads env or a bounded key file and never returns secrets", async (t) => {
  const fixture = await mockGateway(t);
  const dir = await temporaryDirectory(t, "workbench-gateway-auth-");
  const file = join(dir, "key");
  await writeFile(file, `${fixture.secret}\r\n`);
  assert.equal(await readGatewayAuth({ file }), fixture.secret);
  assert.deepEqual(await inspectGatewayAuth({ ...fixture.route(), auth: { file } }), {
    configured: true, source: "file", authChecked: "configuration-only",
  });
  const hardlink = join(dir, "linked-key");
  const linkTarget = join(dir, "link-target");
  await writeFile(linkTarget, fixture.secret);
  await link(linkTarget, hardlink);
  await assert.rejects(readGatewayAuth({ file: hardlink }), hasCode("authentication"));
  await assert.rejects(readGatewayAuth({ file: linkTarget }), hasCode("authentication"));
  const regular = join(dir, "regular-key");
  await writeFile(regular, fixture.secret);
  try {
    const symbolic = join(dir, "symbolic-key");
    await symlink(regular, symbolic, "file");
    await assert.rejects(readGatewayAuth({ file: symbolic }), hasCode("authentication"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error; // Windows may lack symlink privilege.
    t.diagnostic("File-symlink fixture unavailable: OS denied symlink creation.");
  }
  for (const change of [{ baseUrl: "https://gateway.example.invalid/v1" }, { model: "configure-your-model", gatewayPolicy: undefined }]) {
    assert.equal((await inspectGatewayAuth({ ...fixture.route(), ...change })).configured, false);
  }
  await writeFile(file, `{"key":"${fixture.secret}"}`);
  await assert.rejects(readGatewayAuth({ file }), hasCode("authentication"));
  await writeFile(file, "key with spaces");
  assert.equal((await inspectGatewayAuth({ ...fixture.route(), auth: { file } })).configured, false);
  await writeFile(file, "x".repeat(20000));
  await assert.rejects(readGatewayAuth({ file }), hasCode("authentication"));
  await assert.rejects(readGatewayAuth({ file: dir }), hasCode("authentication"));
  const missing = await inspectGatewayAuth({ ...fixture.route(), auth: { env: "WB_GATEWAY_MISSING_FIXTURE" } });
  assert.equal(missing.configured, false);
  assert.ok(!JSON.stringify(missing).includes(fixture.secret));
  assert.equal(fixture.requests.length, 0);
});

test("both native codecs send exact effort, output reserve, auth and honest Studio compatibility headers", async (t) => {
  const fixture = await mockGateway(t);
  for (const kind of ["messages", "responses"] as const) {
    fixture.reply({ events: kind === "messages" ? messages() : responses() });
    const result = await attempt(fixture.route(kind));
    assert.equal(terminalError(result.final), undefined, JSON.stringify(result.events));
    assert.equal(result.final.stopReason, "stop");
    assert.equal(result.final.providerThinkingLevel, "max");
    assert.equal(result.awsCalls, 0);
    const wire = fixture.requests.at(-1)!;
    assert.equal(wire.path, `/v1/${kind}`);
    assert.equal(wire.headers.authorization, `Bearer ${fixture.secret}`);
    assert.equal(wire.headers["x-api-key"], kind === "messages" ? fixture.secret : undefined);
    assert.equal(wire.headers["x-game-policy"], "fable-astra-max-v1");
    assert.equal(wire.headers["x-game-agent"], kind === "messages" ? "game-director" : "workbench-agent");
    assert.match(String(wire.headers["x-game-session"]), /^[0-9a-f-]{36}$/);
    assert.equal(wire.headers["x-workbench-client"], "workbench");
    assert.equal(wire.headers["user-agent"], "workbench/0.2");
    assert.equal(wire.headers["x-amz-security-token"], undefined);
    assert.equal(wire.body.model, fixture.route(kind).model);
    assert.equal(wire.body.max_tokens ?? wire.body.max_output_tokens, 8192);
    assert.equal(wire.body.fallbacks, undefined);
    if (kind === "messages") {
      assert.equal(wire.headers["anthropic-version"], "2023-06-01");
      assert.equal(wire.body.thinking.type, "adaptive");
      assert.equal(wire.body.thinking.budget_tokens, undefined);
      assert.equal(wire.body.output_config.effort, "max");
    } else {
      assert.equal(wire.body.reasoning.effort, "max");
      assert.equal(wire.body.store, false);
      assert.ok(wire.body.include.includes("reasoning.encrypted_content"));
    }
    assert.ok(result.final.content.some((block) => block.type === "text" && block.text.includes("café ✅")));
    assert.ok(!JSON.stringify([result.events, result.output, result.final]).includes(fixture.secret));
  }
  assert.notEqual(fixture.requests[0].headers["x-game-session"], fixture.requests[1].headers["x-game-session"]);
});

test("custom gateways preserve xhigh, prohibit overrides, and do not imply Studio permissions", async (t) => {
  const fixture = await mockGateway(t);
  for (const kind of ["messages", "responses"] as const) {
    fixture.reply({ events: kind === "messages" ? messages() : responses() });
    const route = { ...fixture.route(kind), gatewayPolicy: undefined, effort: "xhigh" as const };
    const result = await attempt(route);
    assert.equal(terminalError(result.final), undefined);
    const wire = fixture.requests.at(-1)!;
    assert.equal(wire.body.output_config?.effort ?? wire.body.reasoning.effort, "xhigh");
    assert.equal(wire.headers["x-game-agent"], undefined);
    for (const override of [
      { onPayload: () => { throw new Error("must not execute"); } }, { headers: { authorization: "other" } },
      { apiKey: "other" }, { fetch: globalThis.fetch }, { samplingParams: { model: "other" } },
      { baseUrl: "https://example.test" }, { env: { CUSTOM: "override" } },
    ]) {
      const failed = await attempt(route, override as SimpleStreamOptions);
      assert.equal(terminalError(failed.final)?.code, "configuration");
    }
    const failed = await attempt(route, { reasoning: "high" });
    assert.equal(terminalError(failed.final)?.code, "effort_mismatch");
    const native = createNativeProvider(route);
    const changed = { ...native.model, baseUrl: "https://example.test" };
    const denied = await native.provider.streamSimple(changed, context, { reasoning: "xhigh" }).result();
    assert.equal(terminalError(denied)?.code, "configuration");
  }
  assert.equal(fixture.requests.length, 2);
});

test("gateway errors are redacted, never retried, and redirects never reach the destination", async (t) => {
  const fixture = await mockGateway(t);
  for (const kind of ["messages", "responses"] as const) {
    for (const status of [301, 302, 307, 308, 401, 403, 429, 500, 503]) {
      fixture.reply({ status, body: fixture.secret, headers: {
        location: `${fixture.route().baseUrl}/leak`, "x-request-id": fixture.secret, "x-amzn-errortype": fixture.secret,
      } });
      const before = fixture.requests.length;
      const result = await attempt(fixture.route(kind));
      assert.equal(result.final.stopReason, "error");
      assert.equal(fixture.requests.length, before + 1);
      assert.ok(!JSON.stringify(result.events).includes(fixture.secret));
      assert.ok(!JSON.stringify(result.output).includes(fixture.secret));
      assert.equal(result.awsCalls, 0);
    }
    fixture.reply({ events: kind === "messages"
      ? [{ type: "error", error: { type: fixture.secret, message: fixture.secret } }]
      : responses([], "failed", { id: fixture.secret, error: { code: fixture.secret, type: fixture.secret, message: fixture.secret } }) });
    const result = await attempt(fixture.route(kind));
    assert.equal(result.final.stopReason, "error");
    assert.ok(!JSON.stringify([result.final, result.output, result.events]).includes(fixture.secret));
    fixture.reply({ status: 400, body: JSON.stringify({ error: { code: "content_filter", message: fixture.secret } }) });
    const filtered = await attempt(fixture.route(kind));
    assert.equal(terminalError(filtered.final)?.code, "content_filter");
    assert.equal(terminalError(filtered.final)?.failoverAllowed, false);
    assert.ok(!JSON.stringify(filtered.events).includes(fixture.secret));
  }
  assert.ok(fixture.requests.every((request) => request.path !== "/leak"));
});

test("missing gateway keys and cancellation send no request; event sink failure cannot release tools", async (t) => {
  const fixture = await mockGateway(t);
  const controller = new AbortController();
  controller.abort();
  assert.equal(terminalError((await attempt(fixture.route(), { signal: controller.signal })).final)?.code, "canceled");
  const missing = { ...fixture.route(), auth: { env: "WB_GATEWAY_MISSING_FIXTURE" } };
  assert.equal(terminalError((await attempt(missing)).final)?.code, "authentication");
  const native = createNativeProvider(fixture.route(), () => { throw new Error("sink unavailable"); });
  const failed = await native.provider.streamSimple(native.model, context, { reasoning: "max" }).result();
  assert.equal(terminalError(failed)?.code, "event_sink");
  assert.equal(fixture.requests.length, 0);
});

test("strict native completion, refusal, usage and tool JSON checks prevent unsafe tool terminals", async (t) => {
  const fixture = await mockGateway(t);
  for (const kind of ["messages", "responses"] as const) {
    const cases: [unknown[], string][] = kind === "messages" ? [
      [messages().slice(0, -1), "incomplete"],
      [messages('{"value":'), "incomplete"], [messages("[]"), "incomplete"], [messages("null"), "incomplete"],
      [messages('{"value":"saved"}', "max_tokens"), "length"],
      [messages(undefined, "refusal"), "refusal"],
      [messages(undefined, "end_turn").map((event) => event.type === "message_delta" ? { ...event, usage: {} } : event), "invalid_usage"],
    ] : [
      [responses().slice(0, -1), "incomplete"],
      [responses([{ ...tool, arguments: '{"value":' }]), "incomplete"],
      [responses([{ ...tool, arguments: "[]" }]), "incomplete"],
      [responses([tool], "incomplete", { incomplete_details: { reason: "max_output_tokens" } }), "length"],
      [responses([], "failed", { error: { code: "content_filter" } }), "content_filter"],
      [responses([], "completed", { usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }), "invalid_usage"],
      [responses([{ ...text, content: [{ type: "refusal", refusal: "no" }] }]), "refusal"],
    ];
    for (const [events, code] of cases) {
      fixture.reply({ events });
      const result = await attempt(fixture.route(kind));
      assert.equal(terminalError(result.final)?.code, code, JSON.stringify(result.events));
      assert.equal(result.final.stopReason, "error");
      if (code === "refusal" || code === "content_filter") {
        assert.equal(terminalError(result.final)?.retryable, false);
        assert.equal(terminalError(result.final)?.failoverAllowed, false);
      }
    }
  }
});

test("gateway deployment pins match one exact header before any SSE consumption", async (t) => {
  const fixture = await mockGateway(t);
  for (const kind of ["messages", "responses"] as const) {
    const route = { ...fixture.route(kind), deploymentId: "expected-deployment" };
    for (const header of ["expected-deployment", " \texpected-deployment \t"]) {
      fixture.reply({ events: kind === "messages" ? messages() : responses(), headers: { "x-litellm-model-id": header } });
      assert.equal(terminalError((await attempt(route)).final), undefined);
    }
    for (const header of [undefined, fixture.secret, "expected-deployment, expected-deployment", "expected-deployment-suffix"]) {
      let pulls = 0;
      let canceled = 0;
      const observations: unknown[] = [];
      const native = createNativeProvider(route, (type, data) => observations.push({ type, data }), {
        fetch: async () => new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            controller.enqueue(encoded(kind === "messages" ? messages() : responses()));
            controller.close();
          },
          cancel() { canceled++; },
        }, { highWaterMark: 0 }), {
          headers: { "content-type": "text/event-stream", ...(header === undefined ? {} : { "x-litellm-model-id": header }) },
        }),
      });
      const result = await native.provider.streamSimple(native.model, context, { reasoning: "max" }).result();
      assert.equal(terminalError(result)?.code, "unsupported_route");
      assert.equal(pulls, 0, "deployment rejection must precede all body reads");
      assert.equal(canceled, 1);
      assert.ok(!JSON.stringify([result, observations]).includes(fixture.secret));
    }
  }
});

test("gateway malformed tool lifecycles and raw usage cannot execute even one tool", async (t) => {
  const fixture = await mockGateway(t);
  const duplicateDone = responses([tool]);
  duplicateDone.splice(3, 0, structuredClone(duplicateDone[2]));
  const duplicateTerminal = responses([tool]);
  duplicateTerminal.push(structuredClone(duplicateTerminal.at(-1)!));
  const duplicateMessages = messages(tool.arguments);
  duplicateMessages.splice(8, 0,
    ...structuredClone(duplicateMessages.slice(5, 8)).map((event) => ({ ...event, index: 2 })));
  const reusedMessageIndex = messages(tool.arguments);
  reusedMessageIndex.splice(8, 0,
    ...structuredClone(reusedMessageIndex.slice(5, 8)).map((event: any) => ({
      ...event, ...(event.content_block ? { content_block: { ...event.content_block, id: "other_tool" } } : {}),
    })));
  const missingMessageId = messages(tool.arguments);
  (missingMessageId[5] as any).content_block.id = undefined;
  const conflictingMessages = messages(tool.arguments);
  (conflictingMessages[5] as any).content_block.input = { value: "other" };
  const cases: { name: string; kind: "messages" | "responses"; frames: unknown[]; code: string }[] = [
    { name: "Responses duplicate done", kind: "responses", frames: duplicateDone, code: "incomplete" },
    { name: "Responses duplicate terminal", kind: "responses", frames: duplicateTerminal, code: "incomplete" },
    { name: "Responses duplicate call ID", kind: "responses", frames: responses([tool, { ...tool, id: "fc_other" }]), code: "incomplete" },
    { name: "Responses missing IDs", kind: "responses", frames: responses([{ ...tool, id: undefined, call_id: undefined }]), code: "incomplete" },
    { name: "Responses terminal argument contradiction", kind: "responses",
      frames: responses([tool], "completed", { output: [{ ...tool, arguments: '{"value":"other"}' }] }), code: "incomplete" },
    { name: "Responses terminal usage lacks input/output", kind: "responses",
      frames: responses([tool], "completed", { usage: { total_tokens: 29 } }), code: "invalid_usage" },
    { name: "Responses fractional raw usage", kind: "responses",
      frames: responses([tool], "completed", { usage: { ...usage, input_tokens: 1.5 } }), code: "invalid_usage" },
    { name: "Responses invalid cache count", kind: "responses",
      frames: responses([tool], "completed", { usage: { ...usage, input_tokens_details: { cached_tokens: 21 } } }), code: "invalid_usage" },
    { name: "Responses invalid reasoning count", kind: "responses",
      frames: responses([tool], "completed", { usage: { ...usage, output_tokens_details: { reasoning_tokens: 10 } } }), code: "invalid_usage" },
    { name: "Messages duplicate tool ID", kind: "messages", frames: duplicateMessages, code: "incomplete" },
    { name: "Messages reused closed block index", kind: "messages", frames: reusedMessageIndex, code: "incomplete" },
    { name: "Messages missing tool ID", kind: "messages", frames: missingMessageId, code: "incomplete" },
    { name: "Messages conflicting initial and streamed arguments", kind: "messages", frames: conflictingMessages, code: "incomplete" },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const root = await temporaryDirectory(t, "workbench-gateway-rejection-");
      const route = fixture.route(scenario.kind);
      const config: WorkbenchConfig = {
        version: 1, stateDir: join(root, "state"), maxWorkers: 1, noProgressLimit: 3, execution: "trusted-local",
        coordinator: route, worker: route, reviewer: route, compactor: route,
        accessMode: "gateway-only", fallbacks: [], capabilities: [], mcp: {},
      };
      const now = new Date().toISOString();
      let effects = 0;
      fixture.reply({ events: scenario.frames });
      const before = fixture.requests.length;
      const request: AgentRequest = {
        run: { id: "run", objective: "fixture", cwd: root, state: "running", createdAt: now, updatedAt: now },
        task: { id: "task", runId: "run", objective: "fixture", role: "worker", state: "running",
          dependsOn: [], writePaths: [], acceptance: [], evidence: [], attempt: 1, createdAt: now, updatedAt: now },
        prompt: "fixture", systemPrompt: "fixture", route, sessionDir: join(root, "sessions"),
        signal: new AbortController().signal, onEvent: () => {},
        tools: [{ name: "remember", description: "fixture", parameters: { type: "object" },
          execute: async () => {
            effects++;
            // A regression should fail promptly, not loop against the malicious fixture.
            fixture.reply({ events: scenario.kind === "messages" ? messages() : responses() });
            return "unexpected effect";
          } }],
      };
      await assert.rejects(new PiAdapter(config).run(request), hasCode(scenario.code));
      assert.equal(effects, 0);
      assert.equal(fixture.requests.length, before + 1);
    });
  }
});

test("MCP fetch helper supports unauthenticated requests and pins credential forwarding to the configured origin", async (t) => {
  const fixture = await mockGateway(t);
  fixture.reply({ body: "{}" });
  const base = `${fixture.route().baseUrl}/mcp`;
  const authenticated = gatewayFetch(base, fixture.route().auth, true);
  await authenticated(base, { headers: { authorization: "wrong", "x-api-key": "wrong", cookie: "wrong" } });
  assert.equal(fixture.requests[0].headers.authorization, `Bearer ${fixture.secret}`);
  assert.equal(fixture.requests[0].headers["x-api-key"], undefined);
  assert.equal(fixture.requests[0].headers.cookie, undefined);
  const anonymous = gatewayFetch(base, undefined, true);
  await anonymous(base, { headers: { authorization: "wrong", "x-api-key": "wrong" } });
  assert.equal(fixture.requests[1].headers.authorization, undefined);
  await assert.rejects(authenticated("https://example.test/mcp"), hasCode("configuration"));
  fixture.reply({ status: 307, headers: { location: "/leak" } });
  await assert.rejects(authenticated(base), hasCode("model_error"));
  assert.equal(fixture.requests.length, 3);
  fixture.reply({ status: 500, body: fixture.secret });
  const failed = await authenticated(base);
  assert.equal(failed.status, 500);
  assert.equal(await failed.text(), "");
  fixture.reply({ status: 405, body: fixture.secret });
  assert.equal((await authenticated(base)).status, 405);
});

test("gateway-only doctor and persistent native tool loops never inspect AWS or select its default compactor", async (t) => {
  const fixture = await mockGateway(t);
  const root = await temporaryDirectory(t, "workbench-gateway-session-");
  await mkdir(join(root, "project"));
  const config: WorkbenchConfig = {
    version: 1, stateDir: join(root, "state"), maxWorkers: 1, noProgressLimit: 3, execution: "trusted-local",
    coordinator: fixture.route("messages"), worker: fixture.route(), reviewer: fixture.route("messages"),
    accessMode: "gateway-only", fallbacks: [], capabilities: [], mcp: {},
  };
  const originalEnv = process.env;
  let awsReads = 0;
  const awsReadSites: string[] = [];
  process.env = new Proxy(originalEnv, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^AWS_(?:PROFILE|CONFIG_FILE|SHARED_CREDENTIALS_FILE|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)$/.test(property)) {
        awsReads++;
        awsReadSites.push(new Error(String(property)).stack!);
        throw new Error("AWS discovery is forbidden");
      }
      return Reflect.get(target, property, receiver);
    },
  });
  t.after(() => { process.env = originalEnv; });
  const observations: any[] = [];
  let credentialCalls = 0;
  const adapter = new PiAdapter(config, { credentials: async () => { credentialCalls++; throw new Error("AWS forbidden"); } });
  const doctor = await adapter.doctor();
  assert.equal(doctor.ok, true, JSON.stringify(doctor));
  assert.equal(doctor.checks.inferencePerformed, false);
  assert.equal(fixture.requests.length, 0);
  assert.equal((doctor.checks.compaction as any).helper.provider, "workbench-gateway-responses");
  const now = new Date().toISOString();
  for (const kind of ["messages", "responses"] as const) {
    let toolExecutions = 0;
    const first = kind === "messages" ? messages('{"value":"saved"}') : responses([opaque, tool]);
    if (kind === "messages") (first[0] as any).message.model = "upstream-fable-model";
    fixture.reply({ events: first });
    const request: AgentRequest = {
      run: { id: `run-${kind}`, objective: "Fixture", cwd: join(root, "project"), state: "running", createdAt: now, updatedAt: now },
      task: { id: `task-${kind}`, runId: `run-${kind}`, objective: "Fixture", role: "worker", state: "running",
        dependsOn: [], writePaths: [], acceptance: [], evidence: [], attempt: 1, createdAt: now, updatedAt: now },
      prompt: "Complete fixture.", systemPrompt: "Parent source.", route: fixture.route(kind),
      signal: new AbortController().signal, sessionDir: join(root, "sessions"),
      onEvent: (type, data) => observations.push({ type, data }),
      tools: [{ name: "remember", description: "Remember fixture.", parameters: { type: "object",
        properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
        execute: async (args) => {
          assert.equal(args.value, "saved");
          toolExecutions++;
          fixture.reply({ events: kind === "messages" ? messages() : responses() });
          return { saved: args.value };
        } }],
    };
    const result = await adapter.run(request);
    assert.equal(result.stopReason, "stop");
    assert.equal(result.text, "Completed café ✅");
    assert.equal(toolExecutions, 1);
    const lastTwo = fixture.requests.slice(-2);
    assert.equal(lastTwo[0].headers["x-game-session"], lastTwo[1].headers["x-game-session"]);
    assert.ok(JSON.stringify(lastTwo[1].body).includes(kind === "messages" ? "opaque-signature" : "opaque-fixture"));
    assert.ok(JSON.stringify(lastTwo[1].body).includes(kind === "messages" ? "tool_result" : "function_call_output"));
  }
  assert.equal(credentialCalls, 0);
  assert.equal(awsReads, 0, awsReadSites.join("\n"));
  assert.ok(!JSON.stringify(observations).includes(fixture.secret));
  config.compactor = { provider: "workbench-responses", model: "test", effort: "max", profile: "default" };
  const denied = await adapter.doctor();
  assert.equal(denied.ok, false);
  assert.equal((denied.checks.compaction as any).helper.errorCode, "unsupported_route");
  assert.equal(awsReads, 0);
});
