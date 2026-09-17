import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, toNamespacedPath } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createExtensionRuntime,
  calculateContextTokens,
  estimateTokens,
  findCutPoint,
  generateSummaryWithUsage,
  ModelRuntime,
  sessionEntryToContextMessages,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore, type AssistantMessage, type Model, type Api } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { AgentAdapter, AgentReply, AgentRequest, ModelRoute, WorkbenchConfig } from "./contracts.js";
import { inspectGatewayAuth, isGatewayRoute, validateGatewayRoute } from "./gateway.js";
import {
  AdapterError,
  RECOMMENDED_ROUTES,
  createNativeProvider,
  inspectProfile,
  normalizeRoute,
  resolveRouteModel,
  sanitizedUsage,
  terminalError,
  type ProviderDependencies,
} from "./providers.js";

export { AdapterError } from "./providers.js";

/** No disk discovery, package loading, context-file discovery, or inline extensions. */
export class WorkbenchResourceLoader implements ResourceLoader {
  private readonly extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  private readonly systemPrompt: string;

  constructor(systemPrompt: string) { this.systemPrompt = systemPrompt; }
  getExtensions() { return this.extensions; }
  getSkills() { return { skills: [], diagnostics: [] }; }
  getPrompts() { return { prompts: [], diagnostics: [] }; }
  getThemes() { return { themes: [], diagnostics: [] }; }
  getAgentsFiles() { return { agentsFiles: [] }; }
  getSystemPrompt() { return this.systemPrompt; }
  getSystemPromptSource() { return undefined; }
  getAppendSystemPrompt() { return []; }
  getAppendSystemPromptSources() { return []; }
  extendResources() { throw new AdapterError("configuration"); }
  async reload() {}
}

function taskKey(request: AgentRequest): string {
  return createHash("sha256").update(JSON.stringify([request.run.id, request.task.id])).digest("hex");
}

interface AdapterFailureDiagnostics {
  phase: string;
  errorCategory: string;
  sqliteCode?: number;
  errorFingerprint?: string;
}

function diagnosedError(error: unknown, phase: string, code: ConstructorParameters<typeof AdapterError>[0]) {
  const original = error as { code?: unknown; name?: unknown; errcode?: unknown; message?: unknown } | undefined;
  const category = typeof original?.code === "string" ? original.code : original?.name;
  const diagnostics: AdapterFailureDiagnostics = {
    phase,
    errorCategory: typeof category === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(category) ? category : "UnknownError",
    ...(Number.isSafeInteger(original?.errcode) ? { sqliteCode: original!.errcode as number } : {}),
    ...(typeof original?.message === "string" ? { errorFingerprint: createHash("sha256").update(original.message).digest("hex") } : {}),
  };
  const fault = error instanceof AdapterError ? error : new AdapterError(code);
  return Object.assign(fault, {
    diagnostics: (fault as AdapterError & { diagnostics?: AdapterFailureDiagnostics }).diagnostics ?? diagnostics,
  });
}

async function acquireTaskLock(directory: string): Promise<() => Promise<void>> {
  let lock: DatabaseSync | undefined;
  try {
    // An OS-backed SQLite lock survives neither process exit nor descriptor close.
    // No time-based stale lease or racy deletion of another owner's lock file.
    lock = new DatabaseSync(toNamespacedPath(join(directory, ".adapter-lock.sqlite")));
    lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
    return async () => {
      try { lock!.exec("ROLLBACK"); }
      finally { lock!.close(); }
    };
  } catch (error) {
    lock?.close();
    const code = (error as { errcode?: number }).errcode;
    throw diagnosedError(error, "session_lock", code === 5 || code === 6 ? "session_conflict" : "persistence");
  }
}

async function openTaskSession(request: AgentRequest, directory: string): Promise<SessionManager> {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl"));
  if (files.length > 1) throw new AdapterError("session_conflict");
  let manager: SessionManager;
  if (files.length === 0) {
    const path = join(directory, "session.jsonl");
    const handle = await open(path, "wx", 0o600);
    await handle.close();
    // Opening an empty file makes the stock SDK write its header immediately.
    // This preserves session identity even if auth/preflight fails before an assistant message.
    manager = SessionManager.open(path, directory, request.run.cwd);
  } else {
    manager = SessionManager.continueRecent(request.run.cwd, directory);
    if (resolve(manager.getSessionFile() ?? "") !== resolve(directory, files[0])) throw new AdapterError("session_conflict");
  }
  if (resolve(manager.getHeader()?.cwd ?? "") !== resolve(request.run.cwd)) throw new AdapterError("session_conflict");
  const binding = manager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "workbench-task");
  if (binding?.type === "custom") {
    const data = binding.data as { runId?: string; taskId?: string };
    if (data?.runId !== request.run.id || data.taskId !== request.task.id) throw new AdapterError("session_conflict");
  } else {
    if (manager.buildSessionContext().messages.length) throw new AdapterError("session_conflict");
    manager.appendCustomEntry("workbench-task", { runId: request.run.id, taskId: request.task.id });
  }
  const pending = new Set<string>();
  for (const message of manager.getBranch().flatMap(sessionEntryToContextMessages)) {
    if (message.role === "assistant" && message.stopReason === "toolUse") {
      for (const block of message.content) if (block.type === "toolCall") pending.add(block.id);
    } else if (message.role === "toolResult") pending.delete(message.toolCallId);
  }
  if (pending.size) throw new AdapterError("tool_state_unknown");
  return manager;
}

function customTools(request: AgentRequest): ToolDefinition[] {
  const names = new Set<string>();
  return request.tools.map((tool): ToolDefinition => {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(tool.name) || names.has(tool.name) ||
      !tool.parameters || tool.parameters.type !== "object") {
      throw new AdapterError("configuration");
    }
    names.add(tool.name);
    return {
      name: tool.name, label: tool.name, description: tool.description,
      parameters: structuredClone(tool.parameters) as TSchema,
      executionMode: "sequential",
      execute: async (_callId, args, signal) => {
        const combined = signal ? AbortSignal.any([signal, request.signal]) : request.signal;
        combined.throwIfAborted();
        const result = await tool.execute(args, combined);
        // Persist the completed result even if cancellation arrived during the tool's cleanup.
        const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
        return { content: [{ type: "text", text }], details: result ?? null };
      },
    };
  });
}

function requireRequest(request: AgentRequest): void {
  if (!request.run.id || !request.task.id || request.task.runId !== request.run.id ||
    !isAbsolute(request.run.cwd) || !isAbsolute(request.sessionDir) ||
    !request.systemPrompt.trim() || !request.prompt.trim()) throw new AdapterError("configuration");
}

export interface CheckpointReference {
  path: string;
  sha256: string;
  bytes: number;
  sessionId: string;
  entryCount: number;
  completedTools: number;
}

export interface AdapterCompaction {
  checkpoint: CheckpointReference;
  compactionEntryId: string;
  contextWindow: number;
  outputReserve: number;
  tokensBefore: number;
  estimatedTokensAfter: number;
  provider: string;
  model: string;
  effort: string;
  taskProvider: string;
  taskModel: string;
}

async function saveCompactionAttempt(directory: string, payload: unknown) {
  const content = JSON.stringify(payload) + "\n";
  const sha256 = createHash("sha256").update(content).digest("hex");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${sha256}.json`);
  try { await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" ||
      createHash("sha256").update(await readFile(path)).digest("hex") !== sha256) throw new AdapterError("persistence");
  }
  return { path, sha256, bytes: Buffer.byteLength(content) };
}

/** Context capacity, never a task/token spending limit. Fresh native usage wins over estimates. */
export function contextBudget(manager: SessionManager, model: Model<Api>, systemPrompt: string, tools: AgentRequest["tools"]) {
  const messages = manager.buildSessionContext().messages;
  const estimatedMessages = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  const staticTokens = Math.ceil(Buffer.byteLength(systemPrompt + JSON.stringify(tools.map(({ name, description, parameters }) =>
    ({ name, description, parameters }))), "utf8") / 4);
  const branch = manager.getBranch();
  const lastCompaction = branch.findLastIndex((entry) => entry.type === "compaction");
  let tokens = estimatedMessages;
  let basis = "message-estimate";
  for (let index = branch.length - 1; index > lastCompaction; index--) {
    const entry = branch[index];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message;
    if (message.provider !== model.provider || message.model !== model.id || message.api !== model.api ||
      !["stop", "toolUse"].includes(message.stopReason) || !(message.usage.totalTokens > 0)) continue;
    const at = messages.indexOf(message);
    if (at < 0) continue;
    tokens = calculateContextTokens(message.usage) + messages.slice(at + 1).reduce((sum, trailing) => sum + estimateTokens(trailing), 0);
    basis = "provider-usage-plus-trailing-estimate";
    break;
  }
  const outputReserve = model.maxTokens;
  const inputCapacity = model.contextWindow - outputReserve;
  return {
    contextWindow: model.contextWindow, outputReserve, inputCapacity, staticTokens,
    tokens: tokens + staticTokens, estimatedMessages, basis,
    needsCompaction: tokens + staticTokens >= inputCapacity,
  };
}

async function saveCheckpoint(
  request: AgentRequest, manager: SessionManager, emit: AgentRequest["onEvent"], assertActive: () => void,
): Promise<CheckpointReference> {
  emit("checkpoint_start", { sessionId: manager.getSessionId() });
  assertActive();
  try {
    const entries = manager.getEntries();
    const content = JSON.stringify({
      version: 1, runId: request.run.id, taskId: request.task.id, sessionId: manager.getSessionId(),
      sourceSessionFile: manager.getSessionFile(),
      systemPrompt: request.systemPrompt, prompt: request.prompt,
      entries: [manager.getHeader(), ...entries],
    }) + "\n";
    const sha256 = createHash("sha256").update(content).digest("hex");
    const directory = join(manager.getSessionDir(), "checkpoints");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${sha256}.json`);
    try { await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" ||
        createHash("sha256").update(await readFile(path)).digest("hex") !== sha256) throw error;
    }
    assertActive();
    const reference: CheckpointReference = {
      path, sha256, bytes: Buffer.byteLength(content), sessionId: manager.getSessionId(), entryCount: entries.length,
      completedTools: entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && !entry.message.isError).length,
    };
    manager.appendCustomEntry("workbench-checkpoint", reference);
    emit("checkpoint_end", reference);
    assertActive();
    return reference;
  } catch (error) {
    const fault = error instanceof AdapterError ? error : new AdapterError("persistence");
    emit("checkpoint_failed", { sessionId: manager.getSessionId(), errorCode: fault.code });
    throw fault;
  }
}

/**
 * Stock Pi session owner. Model attempts and tools settle before this method returns;
 * selection of another route, retries, effect reconciliation and verdict acceptance are supervisor work.
 */
export class PiAdapter implements AgentAdapter {
  private readonly config: WorkbenchConfig;
  private readonly dependencies: ProviderDependencies;

  constructor(config: WorkbenchConfig, dependencies: ProviderDependencies = {}) {
    this.config = config;
    this.dependencies = dependencies;
  }

  private compactorRoute(taskRoute?: ModelRoute): ModelRoute {
    if (this.config.compactor) return this.config.compactor;
    const routes = [taskRoute, this.config.worker, this.config.coordinator, this.config.reviewer].filter(
      (route): route is ModelRoute => !!route,
    );
    if (this.config.accessMode === "gateway-only" || isGatewayRoute(taskRoute) || routes.every(isGatewayRoute)) {
      // Preselect a configured Max route; never invent an AWS helper for a gateway client.
      return routes.find((route) => isGatewayRoute(route) && route.effort === "max") ?? routes[0];
    }
    return RECOMMENDED_ROUTES.astra;
  }

  async run(request: AgentRequest): Promise<AgentReply> {
    return await this.execute(request, false) as AgentReply;
  }

  /** Explicit operation on the existing task session; does not append/run request.prompt. */
  async compact(request: AgentRequest): Promise<AdapterCompaction> {
    return await this.execute(request, true) as AdapterCompaction;
  }

  private async execute(request: AgentRequest, compactOnly: boolean): Promise<AgentReply | AdapterCompaction> {
    let session: AgentSession | undefined;
    let manager: SessionManager | undefined;
    let unsubscribe: (() => void) | undefined;
    let release: (() => Promise<void>) | undefined;
    let aborting: Promise<void> | undefined;
    let eventFailure = false;
    let lastMessage: AssistantMessage | undefined;
    let compactionFailure: AdapterError | undefined;
    let purpose: "inference" | "compaction" = "inference";
    let phase = "request_validation";
    const emit = (type: string, data: unknown) => {
      try {
        const metadata = type.startsWith("provider_") ? { ...data as object, purpose } : data;
        request.onEvent(type, JSON.parse(JSON.stringify(metadata)));
      }
      catch {
        eventFailure = true;
        if (session) aborting ??= session.abort();
      }
    };
    const onAbort = () => {
      if (session) aborting ??= session.abort();
    };
    const assertActive = () => {
      if (eventFailure) throw new AdapterError("event_sink");
      if (request.signal.aborted) throw new AdapterError("canceled");
    };
    try {
      requireRequest(request);
      if (request.signal.aborted) throw new AdapterError("canceled");
      if (!isAbsolute(this.config.stateDir)) throw new AdapterError("configuration");
      if (this.config.accessMode === "gateway-only" && !isGatewayRoute(request.route)) {
        throw new AdapterError("unsupported_route");
      }
      phase = "tool_configuration";
      const tools = customTools(request);
      phase = "provider_configuration";
      const native = createNativeProvider(request.route, emit, this.dependencies);
      phase = "compactor_configuration";
      const helperRoute = this.compactorRoute(request.route);
      if (this.config.accessMode === "gateway-only" && !isGatewayRoute(helperRoute)) throw new AdapterError("unsupported_route");
      const compactor = createNativeProvider(helperRoute, emit, this.dependencies);
      if (compactor.route.effort !== "max") throw new AdapterError("effort_mismatch");
      const agentDir = join(resolve(this.config.stateDir), "agent");
      phase = "agent_directory";
      await mkdir(agentDir, { recursive: true });
      const directory = join(resolve(request.sessionDir), taskKey(request));
      phase = "session_directory";
      await mkdir(directory, { recursive: true });
      phase = "session_lock";
      release = await acquireTaskLock(await realpath(directory));
      phase = "session_open";
      manager = await openTaskSession(request, directory);
      phase = "session_metadata";
      const previousModel = manager.buildSessionContext().model;
      manager.appendCustomEntry("workbench-instructions", {
        systemPrompt: request.systemPrompt, prompt: request.prompt, operation: compactOnly ? "compact" : "run",
      });
      if (previousModel && (previousModel.provider !== native.model.provider || previousModel.modelId !== native.model.id)) {
        const checkpoint = await saveCheckpoint(request, manager, emit, assertActive);
        manager.appendModelChange(native.model.provider, native.model.id);
        emit("adapter_route_change", {
          from: previousModel, to: { provider: native.model.provider, modelId: native.model.id, effort: native.route.effort },
          checkpoint,
        });
        assertActive();
      }
      manager.appendCustomEntry("workbench-attempt", {
        attempt: request.task.attempt, provider: native.route.provider, model: native.route.model, effort: native.route.effort,
      });
      // In-memory settings have no global or selected-project read/write path.
      // agentDir still scopes all SDK-owned paths to stateDir/agent.
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
        enableSkillCommands: false, enableAnalytics: false, enableInstallTelemetry: false,
        defaultTools: [], packages: [], extensions: [], skills: [], prompts: [], themes: [],
        transport: "sse",
      });
      phase = "model_runtime";
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsStore: new InMemoryModelsStore(),
        modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
        signal: request.signal,
      });
      if (isGatewayRoute(native.route)) {
        // registerNativeProvider triggers an offline availability refresh of ALL
        // builtins in stock Pi, including AWS auth. Restrict this instance's
        // public refresh API before registration; never mutate global providers.
        const refresh = runtime.refresh.bind(runtime);
        runtime.refresh = (options = {}) => refresh({
          ...options, allowNetwork: false, providers: [native.provider.id],
        });
      }
      runtime.registerNativeProvider(native.provider);
      phase = "create_session";
      const created = await createAgentSession({
        cwd: request.run.cwd, agentDir, modelRuntime: runtime,
        model: native.model, thinkingLevel: native.route.effort,
        settingsManager, sessionManager: manager,
        resourceLoader: new WorkbenchResourceLoader(request.systemPrompt),
        noTools: "builtin", tools: tools.map((tool) => tool.name), customTools: tools,
      });
      session = created.session;
      if (isGatewayRoute(native.route)) {
        // Stock SDK installs extension payload/response hooks even with no
        // extensions. Gateway routes expose neither request overrides nor raw headers.
        session.agent.onPayload = undefined;
        session.agent.onResponse = undefined;
      }
      phase = "session_validation";
      if (created.modelFallbackMessage || session.model?.id !== native.model.id ||
        session.model.provider !== native.model.provider || session.thinkingLevel !== native.route.effort) {
        throw new AdapterError("effort_mismatch");
      }
      if (session.agent.state.tools.length !== tools.length ||
        session.agent.state.tools.some((tool) => !tools.some((custom) => custom.name === tool.name))) {
        throw new AdapterError("configuration");
      }
      // No tool runs in parallel with another tool within a task; the supervisor owns task parallelism.
      session.agent.toolExecution = "sequential";
      const activeSession = session;
      const activeManager = manager;
      const performCompaction = async (reason: "manual" | "threshold"): Promise<AdapterCompaction> => {
        const budget = contextBudget(activeManager, native.model, activeSession.systemPrompt, request.tools);
        let checkpoint: CheckpointReference | undefined;
        let summaryReceipt: { path: string; sha256: string; bytes: number } | undefined;
        const metadata = {
          reason, ...budget,
          provider: compactor.model.provider, model: compactor.model.id, effort: compactor.route.effort,
          taskProvider: native.model.provider, taskModel: native.model.id,
          helper: { ...compactor.route, selection: "preselected_compactor" },
        };
        emit("compaction_start", metadata);
        purpose = "compaction";
        try {
          assertActive();
          checkpoint = await saveCheckpoint(request, activeManager, emit, assertActive);
          const entries = activeManager.buildContextEntries();
          // Preserve a native recent suffix bounded by the route's output reserve.
          const keep = Math.min(budget.outputReserve, Math.floor(budget.inputCapacity / 2));
          let cut = findCutPoint(entries, 0, entries.length, keep).firstKeptEntryIndex;
          if (cut === 0) {
            // Stock findCutPoint(keep=0) can return the first message when the
            // transcript ends in tool results. Keep their assistant call and
            // all following results together instead of splitting that pair.
            for (let index = entries.length - 1; index > 0; index--) {
              if (sessionEntryToContextMessages(entries[index]).some((message) => message.role === "user" || message.role === "assistant")) {
                cut = index;
                break;
              }
            }
          }
          // Portable state consists of instructions, visible answers, and tool
          // evidence. Vendor reasoning remains exact in the source checkpoint;
          // do not render it as dialogue for another model or summary helper.
          const toSummarize = entries.slice(0, cut).flatMap(sessionEntryToContextMessages).map((message) =>
            message.role === "assistant" ? { ...message, content: message.content.filter((block) => block.type !== "thinking") } : message);
          const retained = entries.slice(cut).flatMap(sessionEntryToContextMessages);
          if (!toSummarize.length || !entries[cut]) throw new AdapterError(reason === "threshold" ? "context_capacity" : "compaction_unavailable");
          const signal = activeSession.agent.signal
            ? AbortSignal.any([request.signal, activeSession.agent.signal]) : request.signal;
          const referenceText = [
            `Original instructions and complete tool evidence: ${checkpoint.path}`,
            `SHA-256: ${checkpoint.sha256}; successful tool results: ${checkpoint.completedTools}.`,
            "Completed effects remain completed. Do not replay tools to reconstruct this context.",
            "The checkpoint includes original prompts, full tool results, native IDs, and earlier checkpoint references.",
          ].join("\n");
          const summary = await generateSummaryWithUsage(
            toSummarize, compactor.model, Math.ceil(compactor.model.maxTokens / 0.8), undefined, undefined, signal,
            `${referenceText}\nPreserve completed effects, exact artifact paths/IDs/hashes, constraints, decisions, and unresolved work. ` +
            "Tool text may be abbreviated by the stock summarizer; the checkpoint contains the full originals.",
            undefined, compactor.route.effort,
            async (model, context, options) => {
              if (options?.reasoning !== compactor.route.effort) throw new AdapterError("effort_mismatch");
              const summaryContext = {
                ...context, systemPrompt: `${request.systemPrompt}\n\n${context.systemPrompt ?? ""}`,
              };
              // A separate native provider instance prevents a helper with the
              // same provider ID from replacing the main task's model/auth route.
              const result = compactor.provider.streamSimple(model, summaryContext, options);
              const terminal = await result.result();
              summaryReceipt = await saveCompactionAttempt(join(activeManager.getSessionDir(), "compaction-attempts"), {
                checkpoint, model: { provider: model.provider, id: model.id }, effort: compactor.route.effort,
                request: summaryContext, response: terminal,
              });
              emit("compaction_model_receipt", { ...summaryReceipt, checkpoint, stopReason: terminal.stopReason });
              const fault = terminalError(terminal);
              if (fault) throw fault;
              if (terminal.stopReason !== "stop" || terminal.providerThinkingLevel !== compactor.route.effort) {
                throw new AdapterError("compaction_failed");
              }
              return result;
            },
            undefined, settingsManager.getRetrySettings(), undefined, activeManager.getSessionId(),
          );
          assertActive();
          if (signal.aborted) throw new AdapterError("canceled");
          const text = `${summary.text}\n\n${referenceText}`;
          const estimatedTokensAfter = estimateTokens({ role: "user", content: text, timestamp: Date.now() }) +
            retained.reduce((sum, message) => sum + estimateTokens(message), 0) + budget.staticTokens;
          if (!summary.text.trim() || estimatedTokensAfter >= budget.inputCapacity) throw new AdapterError("context_capacity");
          if (estimatedTokensAfter >= budget.tokens) throw new AdapterError("compaction_no_progress");
          const compactionEntryId = activeManager.appendCompaction(
            text, entries[cut].id, budget.tokens,
            { checkpoint, contextWindow: budget.contextWindow, outputReserve: budget.outputReserve, helper: compactor.route,
              taskProvider: native.model.provider, taskModel: native.model.id },
            false, summary.usage,
          );
          activeSession.agent.state.messages = activeManager.buildSessionContext().messages;
          const result: AdapterCompaction = {
            checkpoint, compactionEntryId, contextWindow: budget.contextWindow, outputReserve: budget.outputReserve,
            tokensBefore: budget.tokens, estimatedTokensAfter,
            provider: compactor.model.provider, model: compactor.model.id, effort: compactor.route.effort,
            taskProvider: native.model.provider, taskModel: native.model.id,
          };
          emit("compaction_end", { ...result, reason, summaryReceipt, usage: sanitizedUsage(summary.usage) });
          assertActive();
          return result;
        } catch (error) {
          const fault = eventFailure ? new AdapterError("event_sink") : request.signal.aborted ? new AdapterError("canceled") :
            error instanceof AdapterError ? error : new AdapterError("compaction_failed");
          compactionFailure = fault;
          activeManager.appendCustomEntry("workbench-compaction-failed", { checkpoint, summaryReceipt, errorCode: fault.code, reason });
          emit("compaction_failed", { ...metadata, checkpoint, summaryReceipt, errorCode: fault.code,
            retryable: fault.retryable, failoverAllowed: fault.failoverAllowed });
          throw fault;
        } finally { purpose = "inference"; }
      };
      // Public per-request context hook runs after user/tool messages are persisted.
      // The preselected helper is independent and cannot recursively compact itself.
      activeSession.agent.transformContext = async () => {
        assertActive();
        if (contextBudget(activeManager, native.model, activeSession.systemPrompt, request.tools).needsCompaction) {
          await performCompaction("threshold");
        }
        // The SDK file is authoritative even when the low-level loop still holds its pre-compaction array.
        return activeManager.buildSessionContext().messages;
      };
      unsubscribe = session.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "assistant") lastMessage = event.message;
        if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
          emit(event.type, {
            toolName: tools.some((tool) => tool.name === event.toolName) ? event.toolName : "unknown",
            toolCallId: createHash("sha256").update(event.toolCallId).digest("hex"),
            ...(event.type === "tool_execution_end" ? { isError: event.isError } : {}),
          });
        }
      });
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) throw new AdapterError("canceled");
      emit("adapter_session", {
        sessionId: session.sessionId, taskSessionKey: taskKey(request),
        provider: native.route.provider, model: native.route.model, effort: native.route.effort,
      });
      if (eventFailure) throw new AdapterError("event_sink");
      phase = compactOnly ? "compaction" : "session_run";
      if (compactOnly) return await performCompaction("manual");
      await session.prompt(request.prompt, { expandPromptTemplates: false });
      if (aborting) await aborting;
      if (eventFailure) throw new AdapterError("event_sink");
      if (request.signal.aborted) throw new AdapterError("canceled");
      if (compactionFailure) throw compactionFailure;
      if (!lastMessage) throw new AdapterError("incomplete");
      const fault = terminalError(lastMessage);
      if (fault) throw fault;
      if (lastMessage.stopReason !== "stop") throw new AdapterError("incomplete");
      if (lastMessage.providerThinkingLevel !== native.route.effort) throw new AdapterError("effort_mismatch");
      const text = lastMessage.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      manager.appendCustomEntry("workbench-attempt-end", { attempt: request.task.attempt, stopReason: "stop" });
      return {
        text, stopReason: lastMessage.stopReason,
        usage: sanitizedUsage(lastMessage.usage),
        provider: lastMessage.provider, model: lastMessage.model,
      };
    } catch (error) {
      const fallback = ["agent_directory", "session_directory", "session_lock", "session_open", "session_metadata"].includes(phase)
        ? "persistence" : phase === "session_run" ? "model_error" : "session_setup";
      const selected = eventFailure ? new AdapterError("event_sink") :
        request.signal.aborted ? new AdapterError("canceled") :
          compactionFailure ?? error;
      const fault = diagnosedError(selected, phase, fallback);
      emit("adapter_failed", { errorCode: fault.code, retryable: fault.retryable, failoverAllowed: fault.failoverAllowed, ...fault.diagnostics });
      if (manager) {
        try { manager.appendCustomEntry("workbench-attempt-end", { attempt: request.task.attempt, errorCode: fault.code }); }
        catch { throw new AdapterError("persistence"); }
      }
      throw fault;
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      if (session && !session.isIdle) await session.abort();
      if (aborting) await aborting;
      unsubscribe?.();
      session?.dispose();
      await release?.();
    }
  }

  async doctor(): Promise<{ ok: boolean; checks: Record<string, unknown> }> {
    const compactorRoute = this.compactorRoute();
    const routes = [
      { role: "coordinator", route: this.config.coordinator }, { role: "worker", route: this.config.worker },
      { role: "reviewer", route: this.config.reviewer }, { role: "compactor", route: compactorRoute },
      ...this.config.fallbacks.map((route, index) => ({ role: `fallback_${index}`, route })),
    ];
    const routeChecks: Record<string, unknown>[] = [];
    let routesOk = true;
    for (const { role, route } of routes) {
      try {
        if (this.config.accessMode === "gateway-only" && !isGatewayRoute(route)) throw new AdapterError("unsupported_route");
        if (isGatewayRoute(route)) {
          const normalized = validateGatewayRoute(route);
          if (role === "compactor" && normalized.effort !== "max") throw new AdapterError("effort_mismatch");
          const model = resolveRouteModel(normalized);
          const auth = await inspectGatewayAuth(normalized);
          routesOk &&= auth.configured;
          routeChecks.push({
            ok: auth.configured, role, provider: normalized.provider, model: normalized.model, effort: normalized.effort,
            api: model.api, maxTokens: model.maxTokens, contextWindow: model.contextWindow,
            auth, liveQualified: false,
          });
          continue;
        }
        const normalized = normalizeRoute(route);
        if (role === "compactor" && normalized.effort !== "max") throw new AdapterError("effort_mismatch");
        const model = resolveRouteModel(normalized);
        const auth = await inspectProfile(normalized.profile);
        const ok = auth.configured && auth.assumedRole && auth.sourceConfigured;
        routesOk &&= ok;
        routeChecks.push({
          ok, role, provider: normalized.provider, model: normalized.model, effort: normalized.effort,
          api: model.api, region: normalized.region, profile: normalized.profile,
          maxTokens: model.maxTokens, auth, liveQualified: false,
        });
      } catch (error) {
        routesOk = false;
        routeChecks.push({ ok: false, role, errorCode: error instanceof AdapterError ? error.code : "configuration" });
      }
    }
    let sdkVersion: string | undefined;
    try {
      const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
      sdkVersion = JSON.parse(await readFile(join(dirname(entry), "..", "package.json"), "utf8")).version;
    } catch { /* An unresolved package is a failed runtime check. */ }
    const runtimeOk = sdkVersion === "0.85.1" && Number(process.versions.node.split(".")[0]) >= 24 &&
      typeof globalThis.fetch === "function" && typeof AbortSignal.any === "function";
    let stateOk = isAbsolute(this.config.stateDir);
    if (stateOk) {
      let existing = resolve(this.config.stateDir);
      while (true) {
        try { stateOk = (await stat(existing)).isDirectory(); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(existing) === existing) { stateOk = false; break; }
          existing = dirname(existing);
        }
      }
    }
    return {
      ok: runtimeOk && routesOk && stateOk,
      checks: {
        runtime: { ok: runtimeOk, node: process.versions.node, sdk: sdkVersion },
        state: { ok: stateOk, settings: "isolated in memory; SDK agentDir is stateDir/agent", taskSessions: "persistent" },
        resources: { discovery: false, extensions: false, skills: false, tools: "request.tools only", sourceInstructions: "parent systemPrompt" },
        retries: { pi: 0, responses: 0, bedrock: "worker-local AWS_MAX_ATTEMPTS=1" },
        compaction: {
          automatic: "before each model request", outputReserve: "full task model.maxTokens", originals: "immutable checkpoints",
          helper: routeChecks.find((check) => check.role === "compactor"), helperSelection: "preselected_compactor", helperEffort: "max",
        },
        routes: routeChecks, inferencePerformed: false, credentialsResolved: false,
      },
    };
  }
}
