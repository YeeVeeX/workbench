import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defaults, validateConfig } from "./config.js";
import type { ModelRoute, WorkbenchConfig } from "./contracts.js";
import { validateGatewayEndpoint } from "./gateway.js";

/** Import connection references from this recipient's existing setup, never key material. */
export function juniorPreset(root: string, backendPath = join(homedir(), ".config", "kilo", "game-backend.json")): WorkbenchConfig {
  const path = resolve(backendPath);
  let backend: { schema_version?: number; backend?: string; upstream?: string; kb_url?: string };
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw new Error();
    backend = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch { throw new Error("Junior setup was not found. Use the existing recipient game-backend.json; do not copy another person's credentials."); }
  if (backend.schema_version !== 1 || backend.backend !== "junior" || typeof backend.upstream !== "string" || typeof backend.kb_url !== "string")
    throw new Error("The existing backend must explicitly select junior with its upstream and KB URL.");
  const origin = validateGatewayEndpoint(backend.upstream, true);
  const kb = validateGatewayEndpoint(backend.kb_url, true);
  if (origin.pathname !== "/" || kb.hostname !== origin.hostname || kb.protocol !== origin.protocol || kb.pathname !== "/mcp")
    throw new Error("Junior URLs must use the same approved host and the native gateway origin.");
  const keyFile = join(path, "..", "junior-studio-gateway.key");
  try {
    const info = lstatSync(keyFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 32 || info.size > 8192 ||
      realpathSync(keyFile) !== resolve(keyFile)) throw new Error();
  } catch { throw new Error("The recipient's protected junior-studio-gateway.key is required beside the backend config. Its contents are never imported."); }
  const common = {
    effort: "max", baseUrl: new URL("/v1", origin).href, auth: { file: keyFile },
    contextWindow: 1000000, maxTokens: 128000, allowPrivateHttp: origin.protocol === "http:",
    gatewayPolicy: "studio-fable-astra-max-v1",
  } as const;
  const fable: ModelRoute = { ...common, provider: "workbench-gateway-messages", model: "fable-5.1-max", adaptiveThinking: true };
  const astra: ModelRoute = { ...common, provider: "workbench-gateway-responses", model: "gpt-6-astra-max" };
  return validateConfig({
    ...defaults(root), execution: "trusted-local", accessMode: "gateway-only", maxWorkers: 8,
    coordinator: fable, worker: astra, reviewer: { ...fable }, compactor: { ...astra },
    fallbacks: [{ ...astra }, { ...fable }],
    mcp: { knowledge: { url: kb.href, auth: { file: keyFile }, allowPrivateHttp: kb.protocol === "http:",
      readOnlyTools: ["kb_search", "kb_verify", "kb_status"] } },
  });
}
