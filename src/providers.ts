import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { isDeepStrictEqual } from "node:util";
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromIni } from "@aws-sdk/credential-providers";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import {
  createAssistantMessageEventStream,
  createProvider,
  getSupportedThinkingLevels,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Provider,
  type ProviderResponse,
  type SimpleStreamOptions,
  type StreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import { stream as bedrockStream } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { stream as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import type { ModelRoute } from "./contracts.js";
import { createGatewayTransport, isGatewayRoute, resolveGatewayModel } from "./gateway.js";

export const DEFAULT_PROFILE = "default";
export const DEFAULT_REGION = "us-east-1";
export const MAX_OUTPUT_TOKENS = 128000;
export const RECOMMENDED_ROUTES = {
  fable: {
    provider: "workbench-bedrock",
    model: "us.anthropic.claude-fable-5-1",
    effort: "max",
    profile: DEFAULT_PROFILE,
    region: DEFAULT_REGION,
  },
  astra: {
    provider: "workbench-responses",
    model: "global.openai.gpt-6-astra",
    effort: "max",
    profile: DEFAULT_PROFILE,
    region: DEFAULT_REGION,
  },
} as const satisfies Record<string, ModelRoute>;

export type AdapterErrorCode =
  | "configuration"
  | "unsupported_route"
  | "effort_mismatch"
  | "authentication"
  | "model_error"
  | "content_filter"
  | "refusal"
  | "incomplete"
  | "length"
  | "canceled"
  | "empty_reply"
  | "invalid_usage"
  | "session_conflict"
  | "session_setup"
  | "persistence"
  | "tool_state_unknown"
  | "compaction_failed"
  | "compaction_unavailable"
  | "compaction_no_progress"
  | "context_capacity"
  | "event_sink";

const ERROR_TEXT: Record<AdapterErrorCode, string> = {
  configuration: "Invalid adapter configuration.",
  unsupported_route: "This provider or model route is not supported by the adapter.",
  effort_mismatch: "The requested reasoning effort was not preserved. No fallback was selected.",
  authentication: "The configured provider authentication could not be resolved.",
  model_error: "The provider attempt failed. The supervisor owns any retry.",
  content_filter: "The provider filtered this request or response. Automatic retry and failover are not permitted.",
  refusal: "The provider explicitly refused this response. Automatic retry and failover are not permitted.",
  incomplete: "The provider did not finish a complete response.",
  length: "The provider exhausted its output limit. This is not a completed result.",
  canceled: "The agent attempt was canceled.",
  empty_reply: "The provider returned no final answer.",
  invalid_usage: "The provider did not return valid token usage.",
  session_conflict: "The task session is already owned, belongs to another task, or is ambiguous.",
  session_setup: "The Pi session could not be initialized. Inspect the adapter_failed phase and error category.",
  persistence: "The task session could not be read or persisted.",
  tool_state_unknown: "A persisted tool call has no result. Reconcile its effect before resuming.",
  compaction_failed: "Context compaction failed. Original instructions and tool evidence remain in the checkpoint.",
  compaction_unavailable: "There is no complete older context to compact.",
  compaction_no_progress: "The summary did not reduce context. The checkpoint is retained and no compaction was committed.",
  context_capacity: "The current input cannot fit the model context window with its full output reserve.",
  event_sink: "The supervisor event sink failed.",
};

/** Safe to record: messages never incorporate provider bodies, prompts, or credentials. */
export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly retryable: boolean;
  readonly failoverAllowed: boolean;
  readonly stopReason?: string;

  constructor(code: AdapterErrorCode, stopReason?: string) {
    super(ERROR_TEXT[code]);
    this.name = "AdapterError";
    this.code = code;
    this.stopReason = safeToken(stopReason);
    this.retryable = ["model_error", "incomplete", "length", "empty_reply", "invalid_usage"].includes(code);
    this.failoverAllowed = !["content_filter", "refusal"].includes(code);
  }
}

export type ProviderEventSink = (type: string, data: unknown) => void;
export type NativeRoute = ModelRoute & { profile: string; region: string };
type AwsCredentials = Awaited<ReturnType<ReturnType<typeof fromIni>>>;

/** Injection points exercise the real SDK and native codecs without inference or AWS auth. */
export interface ProviderDependencies {
  fetch?: typeof globalThis.fetch;
  credentials?: () => Promise<AwsCredentials>;
  bedrockStream?: typeof bedrockStream;
}

/**
 * Provider-native opaque state cannot move between models. Project only the wire
 * view, retaining the original SDK transcript and using collision-resistant IDs
 * for foreign tool/result pairs. Same-model native IDs/signatures remain exact.
 */
export function projectNativeContext(context: Context, model: Model<Api>): {
  context: Context; foreignMessages: number; omittedReasoningBlocks: number; remappedToolCalls: number;
} {
  const toolIds = new Map<string, string>();
  let foreignMessages = 0;
  let omittedReasoningBlocks = 0;
  let remappedToolCalls = 0;
  const messages = context.messages.map((message) => {
    if (message.role === "toolResult") {
      const toolCallId = toolIds.get(message.toolCallId) ?? message.toolCallId;
      return toolCallId === message.toolCallId ? message : { ...message, toolCallId };
    }
    if (message.role !== "assistant") return message;
    const foreign = message.provider !== model.provider || message.model !== model.id || message.api !== model.api;
    if (foreign) foreignMessages++;
    const content = message.content.flatMap((block): typeof message.content => {
      if (block.type === "thinking" && foreign) {
        omittedReasoningBlocks++;
        return [];
      }
      if (block.type === "text" && foreign) return [{ type: "text", text: block.text }];
      if (block.type === "toolCall") {
        const id = foreign
          ? `wb_${createHash("sha256").update(JSON.stringify([message.provider, message.model, message.api, block.id])).digest("hex").slice(0, 56)}`
          : block.id;
        toolIds.set(block.id, id);
        if (foreign) {
          remappedToolCalls++;
          return [{ type: "toolCall", id, name: block.name, arguments: block.arguments }];
        }
      }
      return [block];
    });
    return foreign ? { ...message, content } : message;
  });
  return { context: { ...context, messages }, foreignMessages, omittedReasoningBlocks, remappedToolCalls };
}

export interface TransportMetadata {
  httpStatus?: number;
  requestId?: string;
  responseId?: string;
  responseModel?: string;
  responseStatus?: string;
  errorCategory?: string;
  errorType?: string;
  errorClass?: string;
  errorSummary?: string;
  errorFingerprint?: string;
  usage?: Record<string, number>;
}

function category(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(value) ? value : undefined;
}

function responseMetadata(response: ProviderResponse): TransportMetadata {
  // Smithy's HTTP/2 response includes pseudo-headers such as ":status".
  // Web Headers rejects these. Read only the needed fields without converting
  // the raw HTTP/2 header map or letting diagnostics interrupt an inference.
  const header = (name: string): string | undefined => {
    const value = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
    return typeof value === "string" ? value : undefined;
  };
  return {
    ...(Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? { httpStatus: response.status } : {}),
    requestId: safeToken(header("x-request-id") ?? header("x-amzn-requestid") ?? header("x-amzn-request-id")),
    errorCategory: category(header("x-amzn-errortype")?.split(":")[0]),
  };
}

function mergeTransport(target: TransportMetadata, metadata: TransportMetadata): void {
  for (const [key, value] of Object.entries(metadata)) if (value !== undefined) (target as Record<string, unknown>)[key] = value;
}

/** Classify known transport failures without logging arbitrary provider bodies. */
function failureMetadata(error: unknown): TransportMetadata {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : undefined;
  const typed = error instanceof Error ? error as Error & { code?: unknown; cause?: { code?: unknown } } : undefined;
  const metadata: TransportMetadata = {
    errorCategory: category(typed?.cause?.code ?? typed?.code ?? typed?.name),
    errorFingerprint: text ? createHash("sha256").update(text).digest("hex") : undefined,
  };
  if (text?.includes('Headers.append: ":status" is an invalid header name.')) {
    metadata.errorClass = "invalid_http2_pseudo_header";
    metadata.errorSummary = "An HTTP/2 :status pseudo-header was passed to the Web Headers constructor.";
  } else if (text?.includes("Could not load credentials from any providers")) {
    metadata.errorClass = "credentials_unavailable";
    metadata.errorSummary = "The AWS SDK could not resolve credentials for the selected profile.";
  } else if (text && /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ERR_HTTP2_STREAM_CANCEL|ERR_HTTP2_ERROR)\b/.test(text)) {
    metadata.errorClass = "connection_failure";
    metadata.errorSummary = "The native HTTP connection failed before a complete response.";
  }
  return metadata;
}

/** Read only SDK diagnostic fields and safe classifications, never arbitrary messages. */
function bedrockFailureMetadata(message: AssistantMessage): TransportMetadata {
  const details = message.diagnostics?.find((entry) => entry.type === "bedrock_response_failure")?.details;
  return {
    ...failureMetadata(message.errorMessage),
    httpStatus: typeof details?.status === "number" && details.status >= 100 && details.status <= 599 ? details.status : undefined,
    errorCategory: category(details?.errorCode),
    requestId: safeToken(details?.requestId),
  };
}

function responsesUsage(value: any): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || !["input_tokens", "output_tokens", "total_tokens"].every((key) =>
    Number.isSafeInteger(value[key]) && value[key] >= 0)) return undefined;
  for (const details of [value.input_tokens_details, value.output_tokens_details]) {
    if (details != null && (typeof details !== "object" || Array.isArray(details))) return undefined;
  }
  const cached = value.input_tokens_details?.cached_tokens === undefined ? 0 : value.input_tokens_details.cached_tokens;
  const written = value.input_tokens_details?.cache_write_tokens === undefined ? 0 : value.input_tokens_details.cache_write_tokens;
  const reasoning = value.output_tokens_details?.reasoning_tokens;
  if (![cached, written].every((count) => Number.isSafeInteger(count) && count >= 0) ||
    !Number.isSafeInteger(cached + written) || cached + written > value.input_tokens ||
    reasoning !== undefined && (!Number.isSafeInteger(reasoning) || reasoning < 0 || reasoning > value.output_tokens)) return undefined;
  return {
    input: value.input_tokens - cached - written, output: value.output_tokens,
    cacheRead: cached, cacheWrite: written, totalTokens: value.total_tokens,
    ...(Number.isSafeInteger(reasoning) && reasoning >= 0 ? { reasoning } : {}),
  };
}

export function normalizeRoute(route: ModelRoute): NativeRoute {
  if (!route || !["workbench-bedrock", "workbench-responses"].includes(route.provider)) {
    throw new AdapterError("unsupported_route");
  }
  const normalized = {
    ...route,
    profile: route.profile ?? DEFAULT_PROFILE,
    region: route.region ?? DEFAULT_REGION,
  };
  if (
    !/^[A-Za-z0-9_.:-]+$/.test(normalized.model) ||
    !/^[A-Za-z0-9_.-]+$/.test(normalized.profile) ||
    !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(normalized.region) ||
    !["max", "xhigh"].includes(normalized.effort)
  ) {
    throw new AdapterError("configuration");
  }
  if (normalized.provider === "workbench-responses" && normalized.effort !== "max") {
    throw new AdapterError("effort_mismatch");
  }
  return normalized;
}

export function resolveRouteModel(input: ModelRoute): Model<Api> {
  if (isGatewayRoute(input)) return resolveGatewayModel(input);
  const route = normalizeRoute(input);
  const baseUrl = `https://bedrock-runtime.${route.region}.amazonaws.com`;
  let model: Model<Api>;
  if (route.provider === "workbench-bedrock") {
    const builtin = amazonBedrockProvider().getModels().find((candidate) => candidate.id === route.model);
    // Only the inspected adaptive Fable 5.1 route is qualified here.
    if (!builtin || !/^(?:(?:us|eu|global)\.)?anthropic\.claude-fable-5-1$/.test(builtin.id)) {
      throw new AdapterError("unsupported_route");
    }
    model = { ...builtin, provider: route.provider, baseUrl };
  } else {
    // A configured candidate is not a claim of Bedrock availability or qualification.
    model = {
      id: route.model,
      name: route.model,
      api: "openai-responses",
      provider: route.provider,
      baseUrl: `${baseUrl}/openai/v1`,
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
      input: ["text", "image"],
      contextWindow: 1000000,
      maxTokens: MAX_OUTPUT_TOKENS,
      // No invented Bedrock prices. Usage events omit unqualified cost estimates.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {
        supportsStrictMode: false,
        supportsOpenAIGrammarTools: false,
        supportsAdditionalTools: false,
        supportsToolSearch: false,
        supportsLongCacheRetention: false,
      },
    };
  }
  if (!getSupportedThinkingLevels(model).includes(route.effort) || model.thinkingLevelMap?.[route.effort] !== route.effort) {
    throw new AdapterError("effort_mismatch");
  }
  return model;
}

function safeToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:|/-]{1,256}$/.test(value) ? value : undefined;
}

export function sanitizedUsage(usage: Usage | undefined): Record<string, number> | undefined {
  if (!usage) return undefined;
  const result: Record<string, number> = {};
  for (const name of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens"] as const) {
    const value = usage[name];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) result[name] = value;
  }
  return result;
}

function usageIsValid(message: AssistantMessage): boolean {
  const usage = sanitizedUsage(message.usage);
  return !!usage && ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) => key in usage) &&
    usage.totalTokens > 0 && usage.output >= (usage.reasoning ?? 0);
}

function parseToolArguments(text: unknown): void {
  if (typeof text !== "string") throw new AdapterError("incomplete");
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdapterError("incomplete");
  } catch { throw new AdapterError("incomplete"); }
}

/** IDs must remain distinct when the Responses codec joins call_id and item.id with "|". */
export function validNativeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\s|]/u.test(value);
}

export function terminalError(message: AssistantMessage): AdapterError | undefined {
  const tagged = /^workbench:([a-z_]+)$/.exec(message.errorMessage ?? "")?.[1];
  if (tagged && Object.hasOwn(ERROR_TEXT, tagged)) return new AdapterError(tagged as AdapterErrorCode, message.rawStopReason);
  const refusal = providerRefusal(message.rawStopReason);
  if (refusal) return refusal;
  if (message.stopReason === "aborted" || /cancel(?:led|ed)/.test(message.rawStopReason ?? "")) {
    return new AdapterError("canceled", message.rawStopReason);
  }
  if (message.stopReason === "length") return new AdapterError("length", message.rawStopReason);
  if (message.stopReason === "error" || message.errorMessage) {
    const incomplete = /incomplete|without a stop reason|before a terminal|without.*terminal/i.test(message.errorMessage ?? "") ||
      message.rawStopReason?.startsWith("incomplete");
    return new AdapterError(incomplete ? "incomplete" : "model_error", message.rawStopReason);
  }
  const nativeStops = message.api === "openai-responses" ? ["completed"] : ["end_turn", "stop_sequence", "tool_use"];
  if (!["stop", "toolUse"].includes(message.stopReason) || !nativeStops.includes(message.rawStopReason ?? "")) {
    return new AdapterError("incomplete", message.rawStopReason);
  }
  if (!usageIsValid(message)) return new AdapterError("invalid_usage", message.rawStopReason);
  const calls = message.content.filter((block) => block.type === "toolCall");
  if (message.stopReason === "toolUse") {
    const ids = calls.map((call) => typeof call.id === "string" ? call.id.split("|") : []);
    if (!calls.length || ids.some((parts) => parts.length !== (message.api === "openai-responses" ? 2 : 1) ||
      parts.some((id) => !validNativeId(id))) ||
      new Set(calls.map((call) => call.id)).size !== calls.length ||
      new Set(ids.map((parts) => parts[0])).size !== calls.length ||
      message.api === "openai-responses" && new Set(ids.map((parts) => parts[1])).size !== calls.length ||
      calls.some((call) => !validNativeId(call.name) || "partialJson" in call ||
        !call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments))) {
      return new AdapterError("incomplete", message.rawStopReason);
    }
  } else if (calls.length || !message.content.some((block) => block.type === "text" && block.text.trim())) {
    return new AdapterError(calls.length ? "incomplete" : "empty_reply", message.rawStopReason);
  }
  return undefined;
}

export function providerRefusal(value: unknown): AdapterError | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.toLowerCase().replace(/^incomplete\./, "");
  if (["content_filter", "content_filtered", "content_policy_violation", "guardrail_intervened", "safety_filter"].includes(code)) {
    return new AdapterError("content_filter", value);
  }
  if (code === "refusal" || code === "refused") return new AdapterError("refusal", value);
  return undefined;
}

function errorMessage(model: Model<Api>, error: AdapterError, partial?: AssistantMessage): AssistantMessage {
  return {
    role: "assistant",
    content: partial?.content ?? [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: partial?.usage ?? {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: partial?.timestamp ?? Date.now(),
    responseId: partial?.responseId,
    rawStopReason: safeToken(partial?.rawStopReason),
    // Error prevents Pi executing tool calls from length/incomplete responses.
    stopReason: error.code === "canceled" ? "aborted" : "error",
    errorMessage: `workbench:${error.code}`,
  };
}

/** Validate the actual native body; do not replace a silently clamped effort. */
export function inspectPayload(route: NativeRoute, payload: unknown): Record<string, unknown> {
  const body = payload as Record<string, any>;
  if (!body || typeof body !== "object") throw new AdapterError("configuration");
  if (route.provider === "workbench-responses") {
    if (body.model !== route.model || body.store !== false || body.stream !== true ||
      body.max_output_tokens !== MAX_OUTPUT_TOKENS || body.previous_response_id !== undefined ||
      !Array.isArray(body.include) || !body.include.includes("reasoning.encrypted_content")) {
      throw new AdapterError("configuration");
    }
    if (body.reasoning?.effort !== route.effort) throw new AdapterError("effort_mismatch");
    return { api: "openai-responses", store: false, maxTokens: body.max_output_tokens, wireEffort: body.reasoning.effort };
  }
  const fields = body.additionalModelRequestFields;
  if (body.modelId !== route.model || body.inferenceConfig?.maxTokens !== MAX_OUTPUT_TOKENS) {
    throw new AdapterError("configuration");
  }
  if (fields?.thinking?.type !== "adaptive" || fields?.output_config?.effort !== route.effort ||
    fields?.thinking?.budget_tokens !== undefined) {
    throw new AdapterError("effort_mismatch");
  }
  return { api: "bedrock-converse-stream", thinking: "adaptive", maxTokens: body.inferenceConfig.maxTokens, wireEffort: fields.output_config.effort };
}

/** Read only configuration shape. Never resolve credentials, run credential_process, or call AWS. */
export async function inspectProfile(profile: string): Promise<{
  configured: boolean; assumedRole: boolean; sourceConfigured: boolean; authChecked: "configuration-only";
}> {
  const configPath = process.env.AWS_CONFIG_FILE ?? join(homedir(), ".aws", "config");
  const credentialsPath = process.env.AWS_SHARED_CREDENTIALS_FILE ?? join(homedir(), ".aws", "credentials");
  const files = await Promise.all([configPath, credentialsPath].map(async (path) => {
    try { return await readFile(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw new AdapterError("authentication");
    }
  }));
  const sections = new Map<string, Record<string, string>>();
  for (const text of files) {
    let current: Record<string, string> | undefined;
    for (const line of text.split(/\r?\n/)) {
      const section = /^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/.exec(line);
      if (section) {
        const name = section[1].replace(/^profile\s+/, "").trim();
        current = sections.get(name) ?? {};
        sections.set(name, current);
      } else {
        const field = /^\s*([a-zA-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (current && field) current[field[1]] = field[2];
      }
    }
  }
  const selected = sections.get(profile);
  const source = selected?.source_profile ? sections.get(selected.source_profile) : selected;
  return {
    configured: !!selected,
    assumedRole: !!selected && /^arn:aws(?:-[a-z]+)?:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/.test(selected.role_arn ?? ""),
    sourceConfigured: !!source && !!(
      (source.aws_access_key_id && source.aws_secret_access_key) || source.credential_process ||
      source.sso_session || source.sso_start_url || source.role_arn && source.source_profile ||
      selected?.credential_source || selected?.web_identity_token_file
    ),
    authChecked: "configuration-only",
  };
}

async function assumedCredentials(route: NativeRoute): Promise<AwsCredentials> {
  const profile = await inspectProfile(route.profile);
  if (!profile.assumedRole || !profile.sourceConfigured) throw new AdapterError("authentication");
  try {
    const credentials = await fromIni({
      profile: route.profile,
      clientConfig: { region: route.region, maxAttempts: 1 },
    })();
    if (!credentials.sessionToken) throw new AdapterError("authentication");
    return credentials;
  } catch { throw new AdapterError("authentication"); }
}

/** SigV4-only native Responses transport. Redirects and other destinations are refused. */
export function createSigningFetch(inputRoute: ModelRoute, dependencies: ProviderDependencies = {}): typeof globalThis.fetch {
  const route = normalizeRoute(inputRoute);
  const endpoint = new URL(`https://bedrock-runtime.${route.region}.amazonaws.com/openai/v1/responses`);
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const signer = new SignatureV4({
    credentials: dependencies.credentials ?? (() => assumedCredentials(route)),
    region: route.region,
    service: "bedrock",
    sha256: Sha256,
  });
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request ? request.url : String(input));
    const signal = init?.signal ?? request?.signal;
    signal?.throwIfAborted();
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    if (url.href !== endpoint.href || method !== "POST") throw new AdapterError("configuration");
    const body = init?.body ?? (request ? await request.clone().text() : undefined);
    if (typeof body !== "string") throw new AdapterError("configuration");
    let parsed: unknown;
    try { parsed = JSON.parse(body); }
    catch { throw new AdapterError("configuration"); }
    inspectPayload(route, parsed);
    // The OpenAI SDK's bearer placeholder and affinity/telemetry headers never reach AWS.
    const headers: Record<string, string> = {
      host: url.host,
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-amz-content-sha256": createHash("sha256").update(body).digest("hex"),
    };
    const signed = await withAbort(signer.sign(new HttpRequest({
      protocol: url.protocol, hostname: url.hostname, method, path: url.pathname, headers, body,
    })), signal);
    signal?.throwIfAborted();
    return fetchImpl(url, { method, headers: signed.headers, body, signal, redirect: "error" });
  };
}

async function withAbort<T>(work: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return work;
  let aborted: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        aborted = () => reject(new AdapterError("canceled"));
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      }),
    ]);
  } finally {
    if (aborted) signal.removeEventListener("abort", aborted);
  }
}

/**
 * Validate final tool argument JSON before the stock parser's permissive partial-JSON
 * recovery can turn malformed completed arguments into executable tools. Bytes pass
 * through unchanged; stock pi-ai still owns Responses parsing and opaque item replay.
 */
export function checkedResponsesBody(
  response: Response,
  onFault: (fault: AdapterError) => void,
  onTransport: (metadata: TransportMetadata) => void,
): Response {
  if (!response.ok || !response.body) return response;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let data: string[] = [];
  let terminal = false;
  let sentinel = false;
  let responseId: string | undefined;
  type ItemState = { added: any; done?: any; arguments: string; sawDelta: boolean; argumentsDone?: string };
  const output = new Map<number, ItemState>();
  const itemIds = new Set<string>();
  const callIds = new Set<string>();
  const register = (index: unknown, item: any): ItemState => {
    if (!Number.isSafeInteger(index) || (index as number) < 0 || output.has(index as number) ||
      !item || !validNativeId(item.id) || !validNativeId(item.type) || itemIds.has(item.id)) {
      throw new AdapterError("incomplete");
    }
    // Grammar/custom tools are disabled on these routes; never execute an
    // unvalidated custom_tool_call through the codec's separate input parser.
    if (item.type === "custom_tool_call") throw new AdapterError("unsupported_route");
    if (item.type === "function_call") {
      if (!validNativeId(item.call_id) || callIds.has(item.call_id) || !validNativeId(item.name) ||
        typeof item.arguments !== "string") throw new AdapterError("incomplete");
      callIds.add(item.call_id);
    }
    itemIds.add(item.id);
    const state: ItemState = { added: item, arguments: item.type === "function_call" ? item.arguments : "", sawDelta: false };
    output.set(index as number, state);
    return state;
  };
  const argumentState = (event: any): ItemState => {
    const state = output.get(event.output_index);
    if (!state || state.done || state.argumentsDone !== undefined || state.added.type !== "function_call" ||
      event.item_id !== state.added.id) throw new AdapterError("incomplete");
    return state;
  };
  const checkArguments = (state: ItemState, args: unknown) => {
    parseToolArguments(args);
    if ((state.sawDelta || state.added.arguments !== "") && args !== state.arguments ||
      state.argumentsDone !== undefined && args !== state.argumentsDone) throw new AdapterError("incomplete");
  };
  const inspect = () => {
    if (!data.length) return;
    const text = data.join("\n");
    data = [];
    if (text === "[DONE]") {
      if (!terminal || sentinel) throw new AdapterError("incomplete");
      sentinel = true;
      return;
    }
    let event: any;
    try { event = JSON.parse(text); }
    catch { throw new AdapterError("incomplete"); }
    const refusal = providerRefusal(event.response?.error?.code ?? event.code ?? event.response?.incomplete_details?.reason);
    if (refusal) onFault(refusal);
    const items = event.item ? [event.item] : event.response?.output;
    if (event.type === "response.refusal.delta" || event.type === "response.refusal.done" ||
      Array.isArray(items) && items.some((item: any) => item?.type === "message" &&
        Array.isArray(item.content) && item.content.some((part: any) => part?.type === "refusal"))) {
      onFault(new AdapterError("refusal"));
    }
    if (terminal || !event || typeof event.type !== "string") throw new AdapterError("incomplete");
    const isTerminal = ["response.completed", "response.incomplete", "response.failed", "response.cancelled"].includes(event.type);
    const usage = responsesUsage(event.response?.usage);
    if (isTerminal && (event.type === "response.completed" || event.response?.usage != null) && !usage) {
      throw new AdapterError("invalid_usage");
    }
    if (event.type === "response.created") {
      if (responseId !== undefined || !validNativeId(event.response?.id)) throw new AdapterError("incomplete");
      responseId = event.response.id;
    }
    if (event.type === "response.output_item.added") register(event.output_index, event.item);
    if (event.type === "response.function_call_arguments.delta") {
      const state = argumentState(event);
      if (typeof event.delta !== "string") throw new AdapterError("incomplete");
      state.arguments += event.delta;
      state.sawDelta = true;
    }
    if (event.type === "response.function_call_arguments.done") {
      const state = argumentState(event);
      checkArguments(state, event.arguments);
      state.argumentsDone = event.arguments;
    }
    if (event.type === "response.output_item.done") {
      // Some providers send a complete item only at done. It still gets exactly
      // one index/identity and one completion; repeated done cannot create tools.
      const state = output.get(event.output_index) ?? register(event.output_index, event.item);
      const item = event.item;
      if (state.done || !item || item.id !== state.added.id || item.type !== state.added.type) {
        throw new AdapterError("incomplete");
      }
      if (item.type === "function_call") {
        if (item.call_id !== state.added.call_id || item.name !== state.added.name ||
          item.namespace !== state.added.namespace) throw new AdapterError("incomplete");
        checkArguments(state, item.arguments);
      }
      state.done = item;
    }
    if (isTerminal) {
      terminal = true;
      if (responseId !== undefined && event.response?.id !== responseId) throw new AdapterError("incomplete");
      if (event.type !== "response.completed" && event.response?.status === "completed") throw new AdapterError("incomplete");
      if (event.type === "response.completed" && event.response?.status === "completed") {
        if (!Array.isArray(event.response.output) ||
          event.response.output.length !== output.size) throw new AdapterError("incomplete");
        for (const [index, item] of event.response.output.entries()) {
          const done = output.get(index)?.done;
          if (!done) throw new AdapterError("incomplete");
          if (item?.status !== undefined && item.status !== "completed") throw new AdapterError("incomplete");
          // The native codec supports terminal-only encrypted reasoning. That
          // enrichment cannot change identity, tool arguments, or other fields.
          const expected = done.type === "reasoning" && !done.encrypted_content && item?.encrypted_content
            ? { ...done, encrypted_content: item.encrypted_content } : done;
          if (!isDeepStrictEqual(item, expected)) throw new AdapterError("incomplete");
          if (item.type === "function_call") parseToolArguments(item.arguments);
        }
      }
    }
    if (event.type === "error" || ["response.created", "response.completed", "response.incomplete", "response.failed", "response.cancelled"].includes(event.type)) {
      onTransport({
        responseId: safeToken(event.response?.id),
        responseModel: safeToken(event.response?.model),
        responseStatus: category(event.response?.status),
        errorCategory: category(event.response?.error?.code ?? event.code ?? event.response?.incomplete_details?.reason),
        errorType: category(event.response?.error?.type),
        usage,
      });
    }
  };
  const consume = (text: string, end = false) => {
    buffer += text;
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
  const check = (action: () => void) => {
    try { action(); }
    catch (error) {
      const fault = error instanceof AdapterError ? error : new AdapterError("incomplete");
      onFault(fault);
      throw fault;
    }
  };
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      check(() => consume(decoder.decode(chunk, { stream: true })));
      controller.enqueue(chunk);
    },
    flush() { check(() => consume(decoder.decode(), true)); },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function responsesFetch(
  route: NativeRoute,
  dependencies: ProviderDependencies,
  onFault: (fault: AdapterError) => void,
  onTransport: (metadata: TransportMetadata) => void,
): typeof globalThis.fetch {
  const signed = createSigningFetch(route, dependencies);
  return async (input, init) => {
    try {
      const response = await signed(input, init);
      onTransport(responseMetadata({ status: response.status, headers: Object.fromEntries(response.headers) }));
      if (!response.ok) {
        try {
          const body = await response.clone().json() as any;
          const refusal = providerRefusal(body?.error?.code ?? body?.code ?? body?.error?.type);
          if (refusal) onFault(refusal);
          onTransport({
            errorCategory: category(body?.error?.code ?? body?.code ?? body?.__type?.split("#").at(-1) ?? body?.error?.type),
            errorType: category(body?.error?.type),
          });
        } catch { /* HTTP status/request ID remain available when an error has no JSON body. */ }
      }
      return checkedResponsesBody(response, onFault, onTransport);
    } catch (error) {
      if (error instanceof AdapterError) onFault(error);
      // Node fetch connection errors expose a stable code separately from their message.
      const cause = (error as { cause?: { code?: unknown } })?.cause;
      const errorCategory = category(cause?.code);
      if (errorCategory) onTransport({ errorCategory });
      throw error;
    }
  };
}

/** Worker-local AWS configuration makes the stock Bedrock client's maxAttempts exactly one. */
export function bedrockWorkerEnvironment(route: NativeRoute): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "AWS_BEDROCK_SKIP_AUTH"]) delete env[key];
  return {
    ...env,
    AWS_PROFILE: route.profile, AWS_REGION: route.region, AWS_DEFAULT_REGION: route.region,
    AWS_MAX_ATTEMPTS: "1", AWS_RETRY_MODE: "standard", AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true",
  };
}

type WorkerPacket =
  | { type: "event"; event: AssistantMessageEvent }
  | { type: "payload"; id: number; payload: unknown }
  | { type: "transport"; metadata: TransportMetadata }
  | { type: "finished" };

export function streamNativeIsolated(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  route: NativeRoute,
  onTransport: (metadata: TransportMetadata) => void = () => {},
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    let worker: Worker | undefined;
    let terminal: AssistantMessageEvent | undefined;
    let failure: AdapterError | undefined;
    let partial: AssistantMessage | undefined;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let outgoing: AssistantMessageEvent | undefined;
    const onAbort = () => {
      worker?.postMessage({ type: "abort" });
      // A credential helper can ignore AbortSignal; terminate this owned worker after grace.
      abortTimer ??= setTimeout(() => { void worker?.terminate(); }, 2000);
      abortTimer.unref();
    };
    try {
      options.signal?.throwIfAborted();
      worker = new Worker(new URL(import.meta.url), {
        // Source-mode workers now also import gateway.js. Resolve TS .js
        // specifiers with the same loader as npm start; built output needs none.
        execArgv: import.meta.url.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : [],
        env: bedrockWorkerEnvironment(route),
        workerData: {
          kind: "workbench-native",
          model, route,
          context: {
            systemPrompt: context.systemPrompt,
            messages: context.messages,
            // Agent-core passes executable AgentTools structurally as protocol Tools.
            // Functions remain in the parent; only the public Tool wire schema is cloned.
            tools: context.tools?.map(({ name, description, parameters, constrainedSampling }) => ({
              name, description, parameters, constrainedSampling,
            })),
          },
          options: {
            reasoning: options.reasoning, maxTokens: MAX_OUTPUT_TOKENS, sessionId: options.sessionId,
            cacheRetention: "short", timeoutMs: options.timeoutMs,
          },
        },
        stdout: true,
        stderr: true,
      });
      // Provider/credential diagnostics belong in typed events, never raw stderr.
      worker.stdout?.resume();
      worker.stderr?.resume();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      await new Promise<void>((resolve, reject) => {
        worker!.on("error", (error) => {
          onTransport(failureMetadata(error));
          reject(new AdapterError("model_error"));
        });
        worker!.on("message", (packet: WorkerPacket) => {
          if (packet.type === "payload") {
            void (async () => {
              try {
                const replacement = await options.onPayload?.(packet.payload, model);
                worker?.postMessage({ type: "payload_result", id: packet.id, payload: replacement ?? packet.payload });
              } catch (error) {
                failure = error instanceof AdapterError ? error : new AdapterError("model_error");
                worker?.postMessage({ type: "payload_error", id: packet.id });
              }
            })();
          } else if (packet.type === "transport") {
            onTransport(packet.metadata);
          } else if (packet.type === "event") {
            const event = packet.event;
            if (event.type === "done" || event.type === "error") terminal = event;
            else {
              partial = event.partial;
              stream.push(event);
            }
          } else if (packet.type === "finished") {
            void worker?.terminate().then(() => resolve(), reject);
          }
        });
        worker!.on("exit", () => resolve());
      });
      if (options.signal?.aborted) throw new AdapterError("canceled");
      if (failure) throw failure;
      if (!terminal) throw new AdapterError("incomplete");
      outgoing = terminal;
    } catch (error) {
      const fault = options.signal?.aborted ? new AdapterError("canceled") :
        error instanceof AdapterError ? error : new AdapterError("model_error");
      const message = errorMessage(model, fault, partial);
      outgoing = { type: "error", reason: message.stopReason as "error" | "aborted", error: message };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      if (abortTimer) clearTimeout(abortTimer);
      await worker?.terminate();
    }
    stream.push(outgoing!);
    stream.end();
  })();
  return stream;
}

async function runNativeWorker(): Promise<void> {
  const port = parentPort!;
  const data = workerData as {
    model: Model<Api>; context: Context; route: NativeRoute; options: SimpleStreamOptions;
  };
  const controller = new AbortController();
  let payloadId = 0;
  const pending = new Map<number, { resolve: (payload: unknown) => void; reject: () => void }>();
  port.on("message", (packet: { type: string; id: number; payload?: unknown }) => {
    if (packet.type === "abort") {
      controller.abort();
      for (const waiter of pending.values()) waiter.reject();
      pending.clear();
    } else {
      const waiter = pending.get(packet.id);
      if (packet.type === "payload_result") waiter?.resolve(packet.payload);
      else waiter?.reject();
      pending.delete(packet.id);
    }
  });
  try {
    let transportFault: AdapterError | undefined;
    const onTransport = (metadata: TransportMetadata) => port.postMessage({ type: "transport", metadata });
    const options = {
      ...data.options,
      signal: controller.signal,
      maxRetries: 0,
      onResponse: (response: ProviderResponse) => { onTransport(responseMetadata(response)); },
      onPayload: (payload: unknown) => new Promise<unknown>((resolve, reject) => {
        const id = ++payloadId;
        pending.set(id, { resolve, reject: () => reject(new AdapterError("canceled")) });
        port.postMessage({ type: "payload", id, payload });
      }),
    };
    const native = data.model.api === "openai-responses"
      ? responsesStream(data.model as Model<"openai-responses">, data.context, {
        ...options, apiKey: "workbench-sigv4-placeholder", reasoningEffort: "max",
        fetch: responsesFetch(data.route, {}, (fault) => {
          if (transportFault?.failoverAllowed !== false) transportFault = fault;
        }, onTransport),
      })
      : bedrockStream(data.model as Model<"bedrock-converse-stream">, data.context, {
        ...options,
        profile: data.route.profile, region: data.route.region,
        env: { AWS_PROFILE: data.route.profile, AWS_BEARER_TOKEN_BEDROCK: "", AWS_BEDROCK_SKIP_AUTH: "0" },
      });
    for await (const event of native) {
      if (event.type === "error" && data.model.api === "bedrock-converse-stream") {
        onTransport(bedrockFailureMetadata(event.error));
      }
      if (transportFault && (event.type === "done" || event.type === "error")) {
        const message = errorMessage(data.model, transportFault, event.type === "done" ? event.message : event.error);
        port.postMessage({ type: "event", event: { type: "error", reason: message.stopReason, error: message } });
      } else port.postMessage({ type: "event", event });
    }
  } catch (error) {
    port.postMessage({ type: "transport", metadata: failureMetadata(error) });
  } finally {
    port.postMessage({ type: "finished" });
  }
}

if (!isMainThread && workerData?.kind === "workbench-native") {
  void runNativeWorker().catch(() => { parentPort?.postMessage({ type: "finished" }); });
}

/** Each session gets a native provider instance; no global provider registration or settings. */
export function createNativeProvider(
  input: ModelRoute,
  onEvent: ProviderEventSink = () => {},
  dependencies: ProviderDependencies = {},
): { provider: Provider; model: Model<Api>; route: ModelRoute } {
  // Gateway dispatch precedes native normalization and every AWS inspection.
  const gateway = isGatewayRoute(input) ? createGatewayTransport(input, dependencies) : undefined;
  const route = gateway?.route ?? normalizeRoute(input);
  const model = resolveRouteModel(route);
  let requestNumber = 0;
  const dispatch = (selected: Model<Api>, context: Context, options: SimpleStreamOptions = {}) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const request = ++requestNumber;
      const identity = { request, provider: route.provider, model: route.model, effort: route.effort };
      let wire: Record<string, unknown> | undefined;
      let partial: AssistantMessage | undefined;
      let fault: AdapterError | undefined;
      let final: AssistantMessage | undefined;
      let transportFault: AdapterError | undefined;
      const openBlocks = new Set<number>();
      const toolArguments = new Map<number, string>();
      const transport: TransportMetadata = {};
      const onTransport = (metadata: TransportMetadata) => mergeTransport(transport, metadata);
      const emit = (type: string, data: unknown) => {
        // Optional metadata is absent on the wire, never an undefined JSON value.
        try { onEvent(type, JSON.parse(JSON.stringify(data))); }
        catch { throw new AdapterError("event_sink"); }
      };
      try {
        emit("provider_start", { ...identity, api: model.api, stopReason: "pending", usage: null, wireVerified: false });
        options.signal?.throwIfAborted();
        if (selected.id !== model.id || selected.provider !== model.provider || selected.api !== model.api) {
          throw new AdapterError("unsupported_route");
        }
        if (options.reasoning !== route.effort) throw new AdapterError("effort_mismatch");
        gateway?.validateOptions(selected, options);
        const projected = projectNativeContext(context, model);
        if (projected.foreignMessages) {
          emit("provider_context_projection", {
            ...identity, foreignMessages: projected.foreignMessages,
            omittedReasoningBlocks: projected.omittedReasoningBlocks,
            remappedToolCalls: projected.remappedToolCalls,
          });
        }
        context = projected.context;
        const onPayload: StreamOptions["onPayload"] = async (payload, selectedModel) => {
          try {
            const replacement = await options.onPayload?.(payload, selectedModel);
            const effective = replacement ?? payload;
            wire = gateway ? gateway.inspectPayload(effective) : inspectPayload(route as NativeRoute, effective);
            emit("provider_payload", { ...identity, ...wire, wireVerified: true });
            return effective;
          } catch (error) {
            transportFault = error instanceof AdapterError ? error : new AdapterError("model_error");
            throw transportFault;
          }
        };
        const shared: SimpleStreamOptions = {
          signal: options.signal,
          reasoning: route.effort,
          maxTokens: model.maxTokens,
          maxRetries: 0,
          timeoutMs: options.timeoutMs,
          sessionId: options.sessionId,
          cacheRetention: "short",
          onPayload,
          onResponse: gateway ? undefined : (response) => { onTransport(responseMetadata(response)); },
        };
        let native: AssistantMessageEventStream;
        if (gateway) {
          native = gateway.stream(context, shared, (fault) => {
            if (transportFault?.failoverAllowed !== false) transportFault = fault;
          }, onTransport);
        } else if (model.api === "openai-responses" && (dependencies.fetch || dependencies.credentials)) {
          native = responsesStream(model as Model<"openai-responses">, context, {
            ...shared,
            apiKey: "workbench-sigv4-placeholder",
            reasoningEffort: "max",
            fetch: responsesFetch(route as NativeRoute, dependencies, (fault) => {
              if (transportFault?.failoverAllowed !== false) transportFault = fault;
            }, onTransport),
          });
        } else if (dependencies.bedrockStream) {
          native = dependencies.bedrockStream(model as Model<"bedrock-converse-stream">, context, {
            ...shared, region: route.region, profile: route.profile,
          });
        } else {
          const profile = await inspectProfile((route as NativeRoute).profile);
          if (!profile.assumedRole || !profile.sourceConfigured) throw new AdapterError("authentication");
          native = streamNativeIsolated(model, context, shared, route as NativeRoute, onTransport);
        }
        for await (const incoming of native) {
          const event = gateway ? gateway.sanitize(incoming) : incoming;
          if (event.type === "done" || event.type === "error") {
            final = event.type === "done" ? event.message : event.error;
            if (model.api === "bedrock-converse-stream") onTransport(bedrockFailureMetadata(final));
          } else {
            partial = event.partial;
            if ("contentIndex" in event) {
              if (event.type.endsWith("_start")) openBlocks.add(event.contentIndex);
              if (event.type.endsWith("_end")) openBlocks.delete(event.contentIndex);
              if (event.type === "toolcall_start") toolArguments.set(event.contentIndex, "");
              if (event.type === "toolcall_delta") {
                toolArguments.set(event.contentIndex, (toolArguments.get(event.contentIndex) ?? "") + event.delta);
              }
              if (event.type === "toolcall_end") {
                const raw = toolArguments.get(event.contentIndex);
                // Responses may deliver complete arguments only in output_item.done;
                // its byte-preserving SSE validator checks that case.
                if (model.api === "bedrock-converse-stream") {
                  try { parseToolArguments(raw); }
                  catch { transportFault = new AdapterError("incomplete"); }
                }
              }
            }
            stream.push(event);
          }
        }
        if (!final) throw new AdapterError("incomplete");
        if (options.signal?.aborted) throw new AdapterError("canceled");
        if (transportFault) throw transportFault;
        fault = terminalError(final);
        if (fault) throw fault;
        if (openBlocks.size) throw new AdapterError("incomplete");
        if (!wire) throw new AdapterError("effort_mismatch");
        final.providerThinkingLevel = route.effort;
      } catch (error) {
        fault = options.signal?.aborted ? new AdapterError("canceled") :
          error instanceof AdapterError ? error : new AdapterError("model_error");
        final = errorMessage(model, fault, final ?? partial);
      }
      // Stock Responses currently loses usage on response.failed; retain reported usage.
      if (transport.usage) final!.usage = { ...final!.usage, ...transport.usage };
      try {
        emit("provider_end", {
          ...identity, ...wire, wireVerified: !!wire,
          stopReason: fault?.code === "length" ? "length" : final!.stopReason,
          rawStopReason: safeToken(final!.rawStopReason),
          usage: transport.usage ?? (final!.usage.totalTokens > 0 ? sanitizedUsage(final!.usage) : null),
          errorCode: fault?.code,
          retryable: fault?.retryable, failoverAllowed: fault?.failoverAllowed,
          transport: { api: model.api, ...transport },
        });
      } catch {
        final = errorMessage(model, new AdapterError("event_sink"), final);
        fault = new AdapterError("event_sink");
      }
      stream.push(fault
        ? { type: "error", reason: final!.stopReason as "error" | "aborted", error: final! }
        : { type: "done", reason: final!.stopReason as "stop" | "toolUse", message: final! });
      stream.end();
    })();
    return stream;
  };
  const provider = createProvider({
    id: route.provider,
    name: gateway ? "Native Gateway" : route.provider === "workbench-bedrock" ? "Native Bedrock Fable" : "Native Bedrock Responses",
    models: [model],
    auth: {
      apiKey: {
        name: gateway ? "Gateway credential reference" : "AWS assumed-role profile",
        // The route is configured; credential validity is checked only at inference time.
        check: async () => gateway
          ? await gateway.checkAuth()
          : { type: "api_key", source: "AWS profile (credentials unresolved)" },
        resolve: async () => ({ auth: {}, source: gateway ? "Gateway credential reference" : "AWS assumed-role profile" }),
      },
    },
    api: {
      stream: (selected, context, options) => dispatch(selected, context, {
        ...options, reasoning: (options as SimpleStreamOptions | undefined)?.reasoning ?? route.effort,
      }),
      streamSimple: dispatch,
    },
  });
  return { provider, model, route };
}
