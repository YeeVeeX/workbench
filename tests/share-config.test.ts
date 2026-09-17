import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaults, validateConfig } from "../src/config.js";
import { juniorPreset } from "../src/presets.js";
import { RECOMMENDED_ROUTES } from "../src/providers.js";
import { Connectors } from "../src/mcp.js";
import { Store } from "../src/store.js";

const exec = promisify(execFile);
async function fixture() {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, "workbench-share-config-"));
  const backend = join(root, "game-backend.json");
  const key = join(root, "junior-studio-gateway.key");
  const secret = "synthetic-recipient-key-no-owner-account-access";
  await writeFile(backend, JSON.stringify({ schema_version: 1, backend: "junior",
    upstream: "http://fixture.tail000000.ts.net", kb_url: "http://fixture.tail000000.ts.net:8004/mcp" }));
  await writeFile(key, secret, { mode: 0o600 });
  return { root, backend, key, secret, async close() {
    const target = await realpath(root), rel = relative(parent, target);
    assert.ok(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
    assert.equal(target, resolve(root));
    await rm(target, { recursive: true, force: true });
  } };
}

test("public defaults contain only unconfigured gateway references and no native fallback", () => {
  const config = validateConfig(defaults());
  assert.equal(config.accessMode, "gateway-only");
  assert.equal(config.execution, "restricted");
  assert.deepEqual(config.fallbacks, []);
  assert.equal(config.worker.baseUrl, "https://gateway.example.invalid/v1");
  assert.equal(config.worker.profile, undefined);
  const { compactor, ...without } = config;
  assert.deepEqual(validateConfig(without).compactor, config.worker);
  for (const field of ["coordinator", "worker", "reviewer", "compactor"] as const)
    assert.throws(() => validateConfig({ ...config, [field]: RECOMMENDED_ROUTES.astra }), /Gateway-only/);
  assert.throws(() => validateConfig({ ...config, fallbacks: [RECOMMENDED_ROUTES.astra] }), /Gateway-only/);
});

test("Junior imports recipient references and Max routes without importing any key contents", async () => {
  const f = await fixture();
  try {
    const config = juniorPreset(join(f.root, "home"), f.backend);
    assert.equal(config.execution, "trusted-local");
    assert.equal(config.accessMode, "gateway-only");
    assert.equal(config.maxWorkers, 8);
    assert.equal(config.coordinator.model, "fable-5.1-max");
    assert.equal(config.worker.model, "gpt-6-astra-max");
    assert.equal(config.compactor!.model, "gpt-6-astra-max");
    assert.deepEqual(config.coordinator.auth, { file: f.key });
    assert.deepEqual(config.mcp.knowledge.auth, { file: f.key });
    assert.doesNotMatch(JSON.stringify(config), new RegExp(f.secret));
    for (const r of [config.coordinator, config.worker, config.reviewer, config.compactor!, ...config.fallbacks]) {
      assert.equal(r.effort, "max");
      assert.equal(r.maxTokens, 128000);
      assert.equal(r.profile, undefined);
    }
    await writeFile(f.key, "too short");
    assert.throws(() => juniorPreset(f.root, f.backend), /protected/);
  } finally { await f.close(); }
});

test("Junior rejects local backend, public plaintext and a KB on another host", async () => {
  const f = await fixture();
  try {
    for (const backend of [
      { schema_version: 1, backend: "local" },
      { schema_version: 1, backend: "junior", upstream: "http://example.com", kb_url: "http://example.com:8004/mcp" },
      { schema_version: 1, backend: "junior", upstream: "https://gateway.example.com", kb_url: "https://different.example.com/mcp" },
      { schema_version: 1, backend: "junior", upstream: "https://user:secret@gateway.example.com", kb_url: "https://gateway.example.com/mcp" },
    ]) {
      await writeFile(f.backend, JSON.stringify(backend));
      assert.throws(() => juniorPreset(f.root, f.backend));
    }
  } finally { await f.close(); }
});

test("real CLI Junior init is additive and refuses to overwrite an existing config", async () => {
  const f = await fixture();
  try {
    const home = join(f.root, "new-home");
    const args = ["--import", "tsx", "src/cli.ts", "init", "--preset", "junior", "--backend-config", f.backend, "--home", home];
    const { stdout } = await exec(process.execPath, args);
    assert.match(stdout, /Configuration created/);
    assert.ok(!stdout.includes(f.secret));
    const before = await readFile(join(home, "config.json"), "utf8");
    assert.ok(!before.includes(f.secret));
    await assert.rejects(exec(process.execPath, args), /Configuration already exists/);
    assert.equal(await readFile(join(home, "config.json"), "utf8"), before);
    assert.equal(await readFile(f.key, "utf8"), f.secret);
  } finally { await f.close(); }
});

test("HTTP MCP uses recipient bearer auth and exposes only explicitly allowed tools", async () => {
  const f = await fixture();
  const requests: { authorization?: string; method: string }[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = "";
    for await (const part of req) body += part;
    const data = JSON.parse(body);
    requests.push({ authorization: req.headers.authorization, method: data.method });
    if (data.id === undefined) { res.writeHead(202).end(); return; }
    const result = data.method === "initialize" ? {
      protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" },
    } : { tools: ["kb_search", "write_everything"].map((name) => ({ name, inputSchema: { type: "object" } })) };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: data.id, result }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const config = defaults(f.root);
  config.mcp = { fixture: { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    allowPrivateHttp: true, auth: { file: f.key }, readOnlyTools: ["kb_search"] } };
  const store = new Store(config.stateDir), connectors = new Connectors(validateConfig(config), store);
  try {
    assert.deepEqual(await connectors.inventory(), [{ server: "fixture", tools: ["kb_search"], unavailable: [] }]);
    assert.ok(requests.length >= 2);
    assert.ok(requests.every((req) => req.authorization === `Bearer ${f.secret}`));
  } finally {
    await connectors.close(); store.close();
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    await f.close();
  }
});

test("HTTP MCP discovery never exposes a remote JSON-RPC error containing its bearer key", async () => {
  const f = await fixture();
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = ""; for await (const part of req) body += part;
    const data = JSON.parse(body);
    if (data.id === undefined) { res.writeHead(202).end(); return; }
    const envelope = data.method === "initialize" ? { result: {
      protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" },
    } } : { error: { code: -32000, message: `private remote diagnostic ${f.secret}` } };
    res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: data.id, ...envelope }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const config = defaults(f.root);
  config.mcp = { fixture: { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    allowPrivateHttp: true, auth: { file: f.key }, readOnlyTools: ["kb_search"] } };
  const store = new Store(config.stateDir), connectors = new Connectors(validateConfig(config), store);
  try {
    const safeError = (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "The configured HTTP connector could not list tools.");
      assert.ok(!String(error).includes(f.secret));
      return true;
    };
    await assert.rejects(connectors.inventory(), safeError);
    // Discovery fails before the context is consulted; no model receives a tool.
    await assert.rejects(connectors.tools({} as never), safeError);
  } finally {
    await connectors.close(); store.close();
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    await f.close();
  }
});
