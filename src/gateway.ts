import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { stream as messagesStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import type { ModelRoute } from "./contracts.js";
import { AdapterError, checkedResponsesBody, providerRefusal, validNativeId, type ProviderDependencies, type TransportMetadata } from "./providers.js";

export type GatewayRoute = ModelRoute & {
  provider: "workbench-gateway-messages" | "workbench-gateway-responses";
  baseUrl: string;
  auth: { env?: string; file?: string };
  contextWindow: number;
  maxTokens: number;
};

export function isGatewayRoute(route: unknown): route is GatewayRoute {
  return !!route && typeof route === "object" &&
    ["workbench-gateway-messages", "workbench-gateway-responses"].includes((route as ModelRoute).provider);
}

function privateHost(host: string): boolean {
  if (host === "localhost" || host === "[::1]") return true;
  if (/^\[(?:fc|fd)[a-f0-9]{2}:/.test(host)) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 127 || a === 10 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127;
  }
  // A node AND a tail-network label are required; arbitrary *.ts.net is public.
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+tail[0-9a-f]+\.ts\.net$/.test(host);
}

export function validateGatewayEndpoint(baseUrl: string, allowPrivateHttp?: boolean): URL {
  try {
    if (typeof baseUrl !== "string" || /[\s\\%?#]/.test(baseUrl) ||
      allowPrivateHttp !== undefined && typeof allowPrivateHttp !== "boolean") throw new Error();
    const url = new URL(baseUrl);
    if (url.username || url.password ||
      url.protocol !== "https:" && !(url.protocol === "http:" && allowPrivateHttp === true && privateHost(url.hostname))) {
      throw new Error();
    }
    return url;
  } catch { throw new AdapterError("configuration"); }
}

function validateAuth(auth: NonNullable<ModelRoute["auth"]>): void {
  if (!auth || typeof auth !== "object" || Array.isArray(auth) || Object.keys(auth).length !== 1 ||
    !Object.keys(auth).every((key) => key === "env" || key === "file")) throw new AdapterError("configuration");
  if ("env" in auth) {
    if (typeof auth.env !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(auth.env) || /^AWS_/i.test(auth.env)) {
      throw new AdapterError("configuration");
    }
  } else if (typeof auth.file !== "string" || !isAbsolute(auth.file) ||
    /[\0\r\n]/.test(auth.file) || /(?:^|[/\\])\.aws(?:[/\\]|$)/i.test(auth.file)) {
    throw new AdapterError("configuration");
  }
}

/** baseUrl accepts an origin or that origin's /v1 root; endpoints are fixed. */
export function validateGatewayRoute(input: ModelRoute): GatewayRoute {
  if (!isGatewayRoute(input)) throw new AdapterError("unsupported_route");
  const allowed = new Set(["provider", "model", "effort", "baseUrl", "auth", "contextWindow", "maxTokens",
    "allowPrivateHttp", "adaptiveThinking", "deploymentId", "gatewayPolicy"]);
  if (Object.keys(input).some((key) => !allowed.has(key)) ||
    typeof input.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(input.model) ||
    !["max", "xhigh"].includes(input.effort) ||
    !Number.isSafeInteger(input.contextWindow) || !Number.isSafeInteger(input.maxTokens) ||
    input.maxTokens <= 0 || input.contextWindow <= input.maxTokens ||
    input.allowPrivateHttp !== undefined && typeof input.allowPrivateHttp !== "boolean" ||
    input.adaptiveThinking !== undefined && typeof input.adaptiveThinking !== "boolean" ||
    input.deploymentId !== undefined && (typeof input.deploymentId !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,256}$/.test(input.deploymentId))) throw new AdapterError("configuration");
  const auth = input.auth;
  validateAuth(auth);
  const url = validateGatewayEndpoint(input.baseUrl, input.allowPrivateHttp);
  if (!["/", "/v1", "/v1/"].includes(url.pathname)) throw new AdapterError("configuration");
  if (input.provider === "workbench-gateway-messages" && input.adaptiveThinking !== true) {
    throw new AdapterError("effort_mismatch");
  }
  if (input.gatewayPolicy !== undefined) {
    if (input.gatewayPolicy !== "studio-fable-astra-max-v1") throw new AdapterError("configuration");
    const alias = input.provider === "workbench-gateway-messages" ? "fable-5.1-max" : "gpt-6-astra-max";
    if (input.model !== alias || input.effort !== "max") throw new AdapterError("effort_mismatch");
    // This preset's server clamps outside this range; refuse an unpreserved limit.
    if (input.maxTokens < 8192 || input.maxTokens > 128000) throw new AdapterError("configuration");
  }
  return { ...input, baseUrl: url.origin, auth: { ...auth } };
}

function validSecret(value: string | undefined): value is string {
  return !!value && value.length <= 16384 && /^[A-Za-z0-9._~+/-]+=*$/.test(value);
}

export async function readGatewayAuth(auth: NonNullable<ModelRoute["auth"]>): Promise<string> {
  validateAuth(auth);
  try {
    let value: string | undefined;
    if (auth.env) value = process.env[auth.env];
    else {
      // An explicitly selected directory may be a junction, but the key itself
      // must be a single regular file. Check identity again after opening it.
      const path = auth.file!;
      const before = await lstat(path);
      const resolved = await realpath(path);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        /(?:^|[/\\])\.aws(?:[/\\]|$)/i.test(resolved)) throw new Error();
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await file.stat();
        const after = await lstat(path);
        if (!info.isFile() || info.nlink !== 1 || info.size > 16386 ||
          after.isSymbolicLink() || after.nlink !== 1 || info.ino !== before.ino || info.dev !== before.dev ||
          info.ino !== after.ino || info.dev !== after.dev || resolved !== await realpath(path)) throw new Error();
        const buffer = Buffer.alloc(16387);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        // A file may have a single trailing line ending, never multiple tokens or JSON.
        value = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)).replace(/\r?\n$/, "");
      } finally { await file.close(); }
    }
    if (!validSecret(value)) throw new Error();
    return value;
  } catch { throw new AdapterError("authentication"); }
}

/** Same-origin HTTP transport for MCP. Omitted auth means no ambient credentials. */
export function gatewayFetch(baseUrl: string, auth?: ModelRoute["auth"], allowPrivateHttp?: boolean,
  fetchImpl: typeof fetch = globalThis.fetch): typeof fetch {
  const endpoint = validateGatewayEndpoint(baseUrl, allowPrivateHttp);
  if (auth !== undefined) validateAuth(auth);
  const reference = auth ? { ...auth } : undefined;
  return async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    try {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== endpoint.origin || url.username || url.password) throw new AdapterError("configuration");
      signal?.throwIfAborted();
      const headers = new Headers(init?.headers ?? request.headers);
      for (const name of ["authorization", "x-api-key", "api-key", "proxy-authorization", "cookie", "host"]) headers.delete(name);
      if (reference) headers.set("authorization", `Bearer ${await readGatewayAuth(reference)}`);
      signal?.throwIfAborted();
      const response = await fetchImpl(request, { ...init, headers, signal, redirect: "error", credentials: "omit" });
      if (response.redirected || response.status >= 300 && response.status < 400 ||
        response.url && new URL(response.url).origin !== endpoint.origin) {
        await response.body?.cancel();
        throw new AdapterError("configuration");
      }
      if (!response.ok) {
        await response.body?.cancel();
        // MCP uses 405 for optional GET/DELETE support and needs the actual
        // status. Preserve it without exposing arbitrary remote error details.
        return new Response(null, { status: response.status });
      }
      return response;
    } catch (error) {
      throw signal?.aborted ? new AdapterError("canceled") :
        error instanceof AdapterError ? error : new AdapterError("model_error");
    }
  };
}

/** Reference readiness only: no inference, AWS discovery, credential processes, or returned secrets. */
export async function inspectGatewayAuth(input: ModelRoute): Promise<{
  configured: boolean; source: "env" | "file"; authChecked: "configuration-only";
}> {
  const route = validateGatewayRoute(input);
  let configured = false;
  if (!placeholderRoute(route)) {
    try { await readGatewayAuth(route.auth); configured = true; } catch { /* Safe readiness failure. */ }
  }
  return { configured, source: route.auth.env ? "env" : "file", authChecked: "configuration-only" };
}

function placeholderRoute(route: GatewayRoute): boolean {
  const host = new URL(route.baseUrl).hostname.replace(/\.$/, "");
  return host === "invalid" || host.endsWith(".invalid") || route.model.toLowerCase() === "configure-your-model";
}

export function resolveGatewayModel(input: ModelRoute): Model<Api> {
  const route = validateGatewayRoute(input);
  const messages = route.provider === "workbench-gateway-messages";
  return {
    id: route.model, name: route.model, provider: route.provider,
    api: messages ? "anthropic-messages" : "openai-responses",
    baseUrl: messages ? route.baseUrl : `${route.baseUrl}/v1`,
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: "xhigh", max: "max" },
    input: ["text", "image"], contextWindow: route.contextWindow, maxTokens: route.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: messages ? { forceAdaptiveThinking: true, supportsMidConvoEffort: false, supportsStrictTools: false } : {
      supportsStrictMode: false, supportsOpenAIGrammarTools: false, supportsAdditionalTools: false,
      supportsToolSearch: false, supportsLongCacheRetention: false,
    },
  };
}

function inspectGatewayPayload(route: GatewayRoute, payload: unknown): Record<string, unknown> {
  const body = payload as Record<string, any>;
  if (!body || typeof body !== "object" || body.model !== route.model || body.stream !== true) {
    throw new AdapterError("configuration");
  }
  const allowed = route.provider === "workbench-gateway-messages"
    ? ["model", "messages", "system", "tools", "max_tokens", "stream", "thinking", "output_config"]
    : ["model", "input", "instructions", "tools", "max_output_tokens", "stream", "store", "reasoning",
      "include", "prompt_cache_key"];
  if (Object.keys(body).some((key) => body[key] !== undefined && !allowed.includes(key))) throw new AdapterError("configuration");
  if (route.provider === "workbench-gateway-messages") {
    if (body.max_tokens !== route.maxTokens || !Array.isArray(body.messages)) throw new AdapterError("configuration");
    if (body.thinking?.type !== "adaptive" || body.thinking.budget_tokens !== undefined ||
      body.output_config?.effort !== route.effort) throw new AdapterError("effort_mismatch");
    return { api: "anthropic-messages", thinking: "adaptive", maxTokens: route.maxTokens, wireEffort: route.effort };
  }
  if (body.max_output_tokens !== route.maxTokens || body.store !== false || !Array.isArray(body.input) ||
    !Array.isArray(body.include) || !body.include.includes("reasoning.encrypted_content")) throw new AdapterError("configuration");
  if (body.reasoning?.effort !== route.effort) throw new AdapterError("effort_mismatch");
  return { api: "openai-responses", store: false, maxTokens: route.maxTokens, wireEffort: route.effort };
}

/**
 * The stock codecs remain responsible for parsing/replay. Check frame completion
 * and Messages tool JSON before permissive partial-JSON recovery can execute it.
 */
function checkedGatewayBody(response: Response, messages: boolean, onFault: (fault: AdapterError) => void): Response {
  if (!response.body) throw new AdapterError("incomplete");
  let buffer = "";
  let data: string[] = [];
  let started = false;
  let terminal = false;
  let stopped = false;
  const blocks = new Map<number, { tool: boolean; args: string; input?: Record<string, unknown> }>();
  const blockIndices = new Set<number>();
  const toolIds = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const inspect = () => {
    if (!data.length) return;
    const text = data.join("\n");
    data = [];
    if (text === "[DONE]") { if (!terminal) throw new AdapterError("incomplete"); return; }
    const event = JSON.parse(text);
    if (terminal) throw new AdapterError("incomplete");
    if (!messages) {
      if (["response.completed", "response.failed", "response.incomplete", "response.cancelled"].includes(event.type)) terminal = true;
      return;
    }
    if (event.type === "error") {
      throw providerRefusal(event.error?.code ?? event.error?.type) ?? new AdapterError("model_error");
    }
    if (event.type === "message_start") {
      if (started || !validNativeId(event.message?.id)) throw new AdapterError("incomplete");
      started = true;
      if (!Number.isSafeInteger(event.message?.usage?.input_tokens) || event.message.usage.input_tokens < 0) {
        throw new AdapterError("invalid_usage");
      }
    } else if (event.type === "content_block_start") {
      if (!started || stopped || !Number.isSafeInteger(event.index) || event.index < 0 || blockIndices.has(event.index)) {
        throw new AdapterError("incomplete");
      }
      if (event.content_block?.type === "fallback") throw new AdapterError("unsupported_route");
      const item = event.content_block;
      const tool = item?.type === "tool_use";
      if (tool) {
        if (!validNativeId(item.id) || toolIds.has(item.id) || !validNativeId(item.name) ||
          !item.input || typeof item.input !== "object" || Array.isArray(item.input)) throw new AdapterError("incomplete");
        toolIds.add(item.id);
      }
      blockIndices.add(event.index);
      blocks.set(event.index, { tool, args: "", input: tool ? item.input : undefined });
    } else if (event.type === "content_block_delta") {
      const block = blocks.get(event.index);
      if (!block || stopped) throw new AdapterError("incomplete");
      if (event.delta?.type === "input_json_delta") {
        if (!block.tool || typeof event.delta.partial_json !== "string") throw new AdapterError("incomplete");
        block.args += event.delta.partial_json;
      }
    } else if (event.type === "content_block_stop") {
      const block = blocks.get(event.index);
      if (!block) throw new AdapterError("incomplete");
      if (block.tool) {
        const args = JSON.parse(block.args);
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new AdapterError("incomplete");
        if (Object.keys(block.input!).length && !isDeepStrictEqual(args, block.input)) throw new AdapterError("incomplete");
      }
      blocks.delete(event.index);
    } else if (event.type === "message_delta") {
      if (!started || stopped || blocks.size) throw new AdapterError("incomplete");
      stopped = !!event.delta?.stop_reason;
      if (!Number.isSafeInteger(event.usage?.output_tokens) || event.usage.output_tokens < 0) {
        throw new AdapterError("invalid_usage");
      }
    } else if (event.type === "message_stop") {
      if (!started || !stopped || blocks.size) throw new AdapterError("incomplete");
      terminal = true;
    }
  };
  const consume = (chunk: string, end = false) => {
    buffer += chunk;
    let match: RegExpExecArray | null;
    while ((match = /\r\n|\r|\n/.exec(buffer))) {
      if (!end && match[0] === "\r" && match.index === buffer.length - 1) break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (!line) inspect();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (end && (buffer.trim() || data.length || !terminal)) throw new AdapterError("incomplete");
  };
  const checked = (action: () => void) => {
    try { action(); } catch (error) {
      const fault = error instanceof AdapterError ? error : new AdapterError("incomplete");
      onFault(fault);
      throw fault;
    }
  };
  return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      checked(() => consume(decoder.decode(chunk, { stream: true })));
      controller.enqueue(chunk);
    },
    flush() { checked(() => consume(decoder.decode(), true)); },
  })), { status: response.status, headers: response.headers });
}

/**
 * Explicit Studio transport compatibility only: the legacy game-director role
 * selects Fable, workbench-agent selects Astra. These are wire permissions, not
 * a claim that Workbench is the Game Director. Both headers and User-Agent name
 * Workbench. The preset never changes model permissions, effort, or fallbacks.
 */
export function createGatewayTransport(input: ModelRoute, dependencies: ProviderDependencies = {}) {
  const route = validateGatewayRoute(input);
  const model = resolveGatewayModel(route);
  const messages = route.provider === "workbench-gateway-messages";
  const endpoint = new URL(messages ? "/v1/messages" : "/v1/responses", route.baseUrl);
  const session = randomUUID();
  const secrets = new Set<string>();
  const sanitize = <T>(value: T): T => {
    // Clone SDK partials too: a later SDK error mutation must not change an emitted event.
    const clone = (item: any): any => {
      if (typeof item === "string") {
        for (const secret of secrets) item = item.split(secret).join("[REDACTED]");
        return item;
      }
      if (Array.isArray(item)) return item.map(clone);
      if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [clone(key), clone(child)]));
      return item;
    };
    const result = clone(value);
    for (const message of [result?.partial, result?.message, result?.error]) {
      if (messages && message?.role === "assistant" && message.model !== route.model) {
        // The gateway alias is the replay route. Preserve the server's actual
        // reported name separately; an alias is not proof of upstream identity.
        message.responseModel = message.model;
        message.model = route.model;
      }
    }
    return result;
  };
  return {
    route,
    sanitize,
    inspectPayload: (payload: unknown) => inspectGatewayPayload(route, payload),
    checkAuth: async () => (await inspectGatewayAuth(route)).configured
      ? { type: "api_key" as const, source: "Gateway credential reference" } : undefined,
    validateOptions(selected: Model<Api>, options: SimpleStreamOptions) {
      if (placeholderRoute(route)) throw new AdapterError("configuration");
      if (!isDeepStrictEqual(selected, model)) throw new AdapterError("configuration");
      for (const key of ["headers", "env"] as const) {
        if (options[key] !== undefined && Object.keys(options[key]!).length) throw new AdapterError("configuration");
      }
      // Request-level transport/auth/body escape hatches are never accepted.
      for (const key of ["onPayload", "onResponse", "fetch", "apiKey", "samplingParams",
        "baseUrl", "baseURL", "extra_body", "client", "metadata", "reasoningEffort", "thinkingEnabled", "effort"]) {
        if ((options as Record<string, unknown>)[key] !== undefined) throw new AdapterError("configuration");
      }
    },
    stream(context: Context, options: SimpleStreamOptions, onFault: (fault: AdapterError) => void,
      onTransport: (metadata: TransportMetadata) => void) {
      const guardedFetch: typeof globalThis.fetch = async (input, init) => {
        try {
          const request = input instanceof Request ? input : undefined;
          const url = new URL(request ? request.url : String(input));
          // pi-ai uses the SDK's beta Messages entrypoint. Its fixed SDK query
          // is not a caller routing option; the gateway receives /v1/messages.
          if (messages && url.search === "?beta=true") url.search = "";
          const signal = init?.signal ?? request?.signal;
          signal?.throwIfAborted();
          const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
          if (url.href !== endpoint.href || method !== "POST") throw new AdapterError("configuration");
          const body = init?.body ?? (request ? await request.clone().text() : undefined);
          if (typeof body !== "string") throw new AdapterError("configuration");
          inspectGatewayPayload(route, JSON.parse(body));
          const secret = await readGatewayAuth(route.auth);
          secrets.add(secret);
          signal?.throwIfAborted();
          const headers = new Headers({
            authorization: `Bearer ${secret}`, "content-type": "application/json", accept: "text/event-stream",
            "user-agent": "workbench/0.2", "x-workbench-client": "workbench",
          });
          if (messages) {
            headers.set("x-api-key", secret);
            headers.set("anthropic-version", "2023-06-01");
          }
          if (route.gatewayPolicy === "studio-fable-astra-max-v1") {
            headers.set("x-game-policy", "fable-astra-max-v1");
            headers.set("x-game-session", session);
            headers.set("x-game-agent", messages ? "game-director" : "workbench-agent");
          }
          const response = await (dependencies.fetch ?? globalThis.fetch)(endpoint, {
            method, headers, body, signal, redirect: "error",
          });
          onTransport({ httpStatus: response.status });
          if (response.redirected || response.status >= 300 && response.status < 400 ||
            response.url && new URL(response.url).origin !== endpoint.origin) {
            await response.body?.cancel();
            throw new AdapterError("configuration");
          }
          // Headers normalizes HTTP whitespace and joins duplicates with commas.
          // A configured pin requires one exact value, never a substring/list match.
          // Check before any response-body reader or SSE transform is installed.
          if (route.deploymentId !== undefined &&
            response.headers.get("x-litellm-model-id")?.trim() !== route.deploymentId) {
            await response.body?.cancel();
            throw new AdapterError("unsupported_route");
          }
          if (!response.ok) {
            // Do not hand SDKs untrusted HTTP errors (body, headers, statusText).
            let refusal: AdapterError | undefined;
            try {
              const body = await response.json() as any;
              refusal = providerRefusal(body?.error?.code ?? body?.code ?? body?.error?.type);
            } catch { /* Only recognized refusal categories may cross the transport boundary. */ }
            throw refusal ?? new AdapterError([401, 403].includes(response.status) ? "authentication" : "model_error");
          }
          const safe = new Response(response.body, { status: response.status, headers: { "content-type": "text/event-stream" } });
          const checked = checkedGatewayBody(safe, messages, onFault);
          return messages ? checked : checkedResponsesBody(checked, onFault, (metadata) => {
            // Remote IDs/classes can contain credentials even when token-shaped.
            if (metadata.usage) onTransport({ usage: metadata.usage });
          });
        } catch (error) {
          const fault = options.signal?.aborted ? new AdapterError("canceled") :
            error instanceof AdapterError ? error : new AdapterError("model_error");
          onFault(fault);
          throw fault;
        }
      };
      const shared = { ...options, apiKey: "workbench-gateway-placeholder", fetch: guardedFetch, maxRetries: 0 };
      return messages
        ? messagesStream(model as Model<"anthropic-messages">, context, {
          ...shared, thinkingEnabled: true, effort: route.effort,
        })
        : responsesStream(model as Model<"openai-responses">, context, { ...shared, reasoningEffort: route.effort });
    },
  };
}
