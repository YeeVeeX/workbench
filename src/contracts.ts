/** Shared contracts. Workers return candidates; the supervisor owns acceptance. */
export type TaskState = "queued" | "running" | "waiting" | "verifying" | "accepted" | "blocked" | "failed" | "canceled";
export type RunState = "running" | "paused" | "verifying" | "accepted" | "blocked" | "failed" | "canceled";
export type OperationState = "prepared" | "running" | "succeeded" | "failed" | "unknown";
export type AgentRole = "coordinator" | "worker" | "reviewer";
export type CapabilityName = "research" | "documents" | "data" | "software" | "operations";

export interface RunRecord {
  id: string;
  objective: string;
  cwd: string;
  state: RunState;
  createdAt: string;
  updatedAt: string;
  result?: string;
  ownerPid?: number;
  ownerToken?: string;
}
export interface TaskRecord {
  id: string;
  runId: string;
  parentId?: string;
  objective: string;
  role: AgentRole;
  state: TaskState;
  dependsOn: string[];
  writePaths: string[];
  acceptance: string[];
  result?: string;
  evidence: string[];
  attempt: number;
  createdAt: string;
  updatedAt: string;
}
export interface OperationRecord {
  id: string;
  runId: string;
  taskId: string;
  kind: string;
  inputHash: string;
  state: OperationState;
  input: unknown;
  result?: unknown;
  pid?: number;
  createdAt: string;
  updatedAt: string;
}
export interface ArtifactRecord {
  id: string;
  runId: string;
  taskId: string;
  path: string;
  sha256: string;
  bytes: number;
  mediaType: string;
  createdAt: string;
}
export interface EventRecord {
  seq: number;
  runId: string;
  taskId?: string;
  type: string;
  data: unknown;
  at: string;
}
export interface ApprovalRecord {
  id: string;
  runId: string;
  taskId: string;
  actionHash: string;
  action: unknown;
  state: "pending" | "approved" | "rejected" | "consumed";
  createdAt: string;
}
export interface ModelRoute {
  provider: string;
  model: string;
  effort: "max" | "xhigh";
  region?: string;
  profile?: string;
  baseUrl?: string;
  auth?: { env?: string; file?: string };
  contextWindow?: number;
  maxTokens?: number;
  allowPrivateHttp?: boolean;
  adaptiveThinking?: boolean;
  deploymentId?: string;
  gatewayPolicy?: "studio-fable-astra-max-v1";
}
export type ConnectorConfig = {
  command?: string; args?: string[]; env?: Record<string, string>;
  url?: string; auth?: { env?: string; file?: string }; allowPrivateHttp?: boolean;
  readOnlyTools: string[];
};
export interface WorkbenchConfig {
  version: 1;
  stateDir: string;
  maxWorkers: number;
  noProgressLimit: number;
  execution: "trusted-local" | "restricted";
  coordinator: ModelRoute;
  worker: ModelRoute;
  reviewer: ModelRoute;
  compactor?: ModelRoute;
  fallbacks: ModelRoute[];
  capabilities: CapabilityName[];
  mcp: Record<string, ConnectorConfig>;
  httpGrants?: Array<{ methods: string[]; urlPrefix: string }>;
  accessMode?: "gateway-only" | "native-allowed";
}
export interface TaskInput {
  objective: string;
  parentId?: string;
  role?: AgentRole;
  dependsOn?: string[];
  writePaths?: string[];
  acceptance?: string[];
}
export interface AgentRequest {
  run: RunRecord;
  task: TaskRecord;
  prompt: string;
  systemPrompt: string;
  tools: AgentTool[];
  route: ModelRoute;
  signal: AbortSignal;
  sessionDir: string;
  onEvent: (type: string, data: unknown) => void;
}
export interface AgentReply {
  text: string;
  stopReason: string;
  usage?: Record<string, unknown>;
  model: string;
  provider: string;
}
export interface AgentAdapter {
  run(request: AgentRequest): Promise<AgentReply>;
  doctor(): Promise<{ ok: boolean; checks: Record<string, unknown> }>;
}
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: any, signal?: AbortSignal) => Promise<unknown>;
}
export interface BrokerContext {
  run: RunRecord;
  task: TaskRecord;
  signal: AbortSignal;
}
export interface TaskSubmission {
  summary: string;
  evidence: string[];
}
export interface ReviewVerdict {
  verdict: "pass" | "fail";
  findings: string[];
  evidence: string[];
}
