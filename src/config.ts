import { availableParallelism } from "node:os";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { WorkbenchConfig, ModelRoute } from "./contracts.js";
import { RECOMMENDED_ROUTES } from "./providers.js";
import { isGatewayRoute, validateGatewayRoute, validateGatewayEndpoint } from "./gateway.js";

export function homeDir(): string {
  return resolve(process.env.WORKBENCH_HOME || (process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Workbench")
    : join(homedir(), ".local", "share", "workbench")));
}

export function defaults(root = homeDir()): WorkbenchConfig {
  const gateway: ModelRoute = {
    provider: "workbench-gateway-responses", model: "configure-your-model", effort: "max",
    baseUrl: "https://gateway.example.invalid/v1", auth: { env: "WORKBENCH_GATEWAY_KEY" },
    contextWindow: 200000, maxTokens: 32000,
  };
  return {
    version: 1, stateDir: join(root, "state"),
    maxWorkers: Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2))),
    noProgressLimit: 3,
    execution: "restricted", accessMode: "gateway-only",
    coordinator: { ...gateway }, worker: { ...gateway }, reviewer: { ...gateway }, compactor: { ...gateway },
    fallbacks: [],
    capabilities: ["research", "documents", "data", "software", "operations"],
    mcp: {}, httpGrants: [],
  };
}

/** Explicit native opt-in. Local profile selection belongs to this user. */
export function nativeDefaults(root = homeDir()): WorkbenchConfig {
  return {
    ...defaults(root), accessMode: "native-allowed", execution: "trusted-local",
    coordinator: { ...RECOMMENDED_ROUTES.fable }, worker: { ...RECOMMENDED_ROUTES.astra },
    reviewer: { ...RECOMMENDED_ROUTES.fable }, compactor: { ...RECOMMENDED_ROUTES.astra },
    fallbacks: [{ ...RECOMMENDED_ROUTES.astra }, { ...RECOMMENDED_ROUTES.fable }],
  };
}

function route(value: unknown, name: string): asserts value is ModelRoute {
  const r = value as ModelRoute;
  if (!r || typeof r.provider !== "string" || typeof r.model !== "string" || !r.provider || !r.model
    || !["max", "xhigh"].includes(r.effort)) throw new Error(`Invalid ${name} route: choose an explicit model and max or xhigh effort.`);
  if (isGatewayRoute(r)) validateGatewayRoute(r);
}

export function validateConfig(input: unknown): WorkbenchConfig {
  const value = input as WorkbenchConfig;
  if (!value || value.version !== 1) throw new Error("Unsupported Workbench configuration version.");
  if (!Number.isInteger(value.maxWorkers) || value.maxWorkers < 1 || value.maxWorkers > 64) throw new Error("maxWorkers must be between 1 and 64.");
  if (!Number.isInteger(value.noProgressLimit) || value.noProgressLimit < 2) throw new Error("noProgressLimit must be at least 2.");
  if (!["trusted-local", "restricted"].includes(value.execution)) throw new Error("Unknown execution mode.");
  if (typeof value.stateDir !== "string" || !value.stateDir) throw new Error("stateDir is required.");
  if (value.accessMode !== undefined && !["gateway-only", "native-allowed"].includes(value.accessMode))
    throw new Error("Unknown provider access mode.");
  for (const name of ["coordinator", "worker", "reviewer"] as const) route(value[name], name);
  if (value.compactor !== undefined) route(value.compactor, "compactor");
  if (!Array.isArray(value.fallbacks)) throw new Error("fallbacks must be an explicit array.");
  value.fallbacks.forEach((r) => route(r, "fallback"));
  const compactor = value.compactor ?? (isGatewayRoute(value.worker) ? { ...value.worker } : { ...RECOMMENDED_ROUTES.astra });
  if (value.accessMode === "gateway-only" && [value.coordinator, value.worker, value.reviewer, compactor, ...value.fallbacks]
    .some((r) => !isGatewayRoute(r))) throw new Error("Gateway-only configuration cannot use native providers, including helpers and fallbacks.");
  const capabilities = new Set(["research", "documents", "data", "software", "operations"]);
  if (!Array.isArray(value.capabilities) || value.capabilities.some((x) => !capabilities.has(x))) throw new Error("Unknown capability pack.");
  if (!value.mcp || typeof value.mcp !== "object" || Array.isArray(value.mcp)) throw new Error("mcp must be an object.");
  for (const [name, server] of Object.entries(value.mcp)) {
    if (!server || !Array.isArray(server.readOnlyTools)
      || server.readOnlyTools.some((x) => typeof x !== "string")) throw new Error(`Invalid MCP server: ${name}`);
    if (server.url !== undefined) {
      if (server.command !== undefined || server.args !== undefined || server.env !== undefined)
        throw new Error(`HTTP MCP server cannot include a local command: ${name}`);
      validateGatewayEndpoint(server.url, server.allowPrivateHttp);
      if (server.auth !== undefined) {
        const keys = Object.keys(server.auth);
        if (keys.length !== 1 || !["env", "file"].includes(keys[0]) || typeof Object.values(server.auth)[0] !== "string" || !Object.values(server.auth)[0])
          throw new Error(`MCP auth requires one local environment or file reference: ${name}`);
      }
    } else if (typeof server.command !== "string" || !server.command || !Array.isArray(server.args)
      || server.args.some((x) => typeof x !== "string")) throw new Error(`Invalid MCP server: ${name}`);
  }
  if (value.httpGrants !== undefined) {
    if (!Array.isArray(value.httpGrants)) throw new Error("httpGrants must be an explicit array.");
    for (const grant of value.httpGrants) {
      if (!grant || !Array.isArray(grant.methods) || !grant.methods.length
        || grant.methods.some((method) => !["POST", "PUT", "PATCH", "DELETE"].includes(method))
        || typeof grant.urlPrefix !== "string") throw new Error("HTTP grants require explicit mutation methods and a URL prefix.");
      const prefix = new URL(grant.urlPrefix);
      if (!["http:", "https:"].includes(prefix.protocol) || prefix.username || prefix.password || prefix.search || prefix.hash)
        throw new Error("HTTP grant prefixes cannot contain credentials, a query or a fragment.");
    }
  }
  return { ...value, compactor, stateDir: resolve(value.stateDir) };
}

export function loadConfig(root = homeDir()): WorkbenchConfig {
  const path = join(root, "config.json");
  return existsSync(path) ? validateConfig(JSON.parse(readFileSync(path, "utf8"))) : defaults(root);
}

export function saveConfig(config: WorkbenchConfig, root = homeDir()): string {
  validateConfig(config);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  return path;
}
