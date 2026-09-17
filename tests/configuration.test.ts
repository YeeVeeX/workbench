import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { nativeDefaults as defaults, loadConfig, saveConfig, validateConfig } from "../src/config.js";
import { RECOMMENDED_ROUTES } from "../src/providers.js";
import { MemoryBook } from "../src/memory.js";
import { projectChecks } from "../src/checks.js";

async function temporary() {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, "workbench-configuration-"));
  return { root, async close() {
    const target = await realpath(root), rel = relative(parent, target);
    assert.ok(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
    assert.equal(target, resolve(root));
    await rm(target, { recursive: true, force: true });
  } };
}

for (const effort of ["max", "xhigh"] as const) {
  test(`manual Fable ${effort} worker config without compactor keeps the dedicated Astra Max default`, async () => {
    const fixture = await temporary();
    try {
      const { compactor: _omitted, ...config } = defaults(fixture.root);
      config.worker = { ...RECOMMENDED_ROUTES.fable, effort, profile: "worker-only", region: "us-west-2" };
      const json = JSON.stringify(config, null, 2) + "\n";
      const path = join(fixture.root, "config.json");
      await writeFile(path, json);

      const loaded = loadConfig(fixture.root);
      assert.deepEqual(loaded.worker, config.worker);
      assert.deepEqual(loaded.compactor, RECOMMENDED_ROUTES.astra);
      assert.deepEqual(validateConfig(config).compactor, loaded.compactor);
      assert.deepEqual(defaults(fixture.root).compactor, loaded.compactor);
      assert.notStrictEqual(loaded.compactor, RECOMMENDED_ROUTES.astra);
      assert.equal("compactor" in config, false);
      assert.equal(await readFile(path, "utf8"), json);

      saveConfig(loaded, fixture.root);
      assert.deepEqual(loadConfig(fixture.root).compactor, RECOMMENDED_ROUTES.astra);
    } finally { await fixture.close(); }
  });
}

test("loading preserves an explicit helper including effort for the adapter's strict Max check", async () => {
  const fixture = await temporary();
  try {
    for (const effort of ["max", "xhigh"] as const) {
      const config = defaults(fixture.root);
      config.compactor = { ...RECOMMENDED_ROUTES.fable, effort, profile: "helper-only", region: "us-west-2" };
      saveConfig(config, fixture.root);
      assert.deepEqual(loadConfig(fixture.root).compactor, config.compactor);
    }
    for (const compactor of [null, {}, { ...RECOMMENDED_ROUTES.astra, effort: "high" }]) {
      assert.throws(() => validateConfig({ ...defaults(fixture.root), compactor }), /Invalid compactor route/);
    }
  } finally { await fixture.close(); }
});

test("project check registration retains exact local input identities", async () => {
  const fixture = await temporary();
  try {
    const original = "process.exit(0);\n";
    await writeFile(join(fixture.root, "check.cjs"), original);
    await writeFile(join(fixture.root, "workbench.checks.json"), JSON.stringify({ checks: [{
      name: "contract", executable: process.execPath, args: ["check.cjs"], writes: [], timeoutSeconds: 20,
    }] }));
    const [check] = projectChecks(fixture.root);
    const pinned = check.inputs.find((input) => input.path.endsWith("check.cjs"));
    assert.ok(pinned);
    await writeFile(join(fixture.root, "check.cjs"), "process.exit(1);\n");
    const current = createHash("sha256").update(await readFile(pinned.path)).digest("hex");
    assert.notEqual(current, pinned.sha256);
    assert.equal(pinned.sha256, createHash("sha256").update(original).digest("hex"));
  } finally { await fixture.close(); }
});

test("owner grants remain explicit and malformed scopes are refused", () => {
  const config = defaults();
  assert.deepEqual(config.httpGrants, []);
  assert.doesNotThrow(() => validateConfig({ ...config, httpGrants: [{ methods: ["POST"], urlPrefix: "https://example.com/records" }] }));
  for (const grant of [
    { methods: ["*"], urlPrefix: "https://example.com/" },
    { methods: ["POST"], urlPrefix: "https://user:password@example.com/" },
    { methods: ["POST"], urlPrefix: "https://example.com/?all=true" },
  ]) assert.throws(() => validateConfig({ ...config, httpGrants: [grant] }));
});

test("notebooks isolate projects and retain owner-supplied provenance", async () => {
  const fixture = await temporary();
  try {
    const a = join(fixture.root, "a"), b = join(fixture.root, "b");
    await mkdir(a); await mkdir(b);
    const book = new MemoryBook(join(fixture.root, "state"));
    const entry = book.add(MemoryBook.project(a), "Preserve CSV schema.", "Owner decision 2026-09-17");
    assert.deepEqual(book.list(MemoryBook.project(b)), []);
    assert.equal(book.list(MemoryBook.project(a), "csv")[0].source, entry.source);
    book.remove(MemoryBook.project(a), entry.id);
    assert.deepEqual(book.list(MemoryBook.project(a)), []);
  } finally { await fixture.close(); }
});

test("unreadable or incomplete notebook content is an error, never an empty search", async () => {
  const fixture = await temporary();
  try {
    const book = new MemoryBook(fixture.root);
    book.add("owner", "Use Max reasoning.", "Owner");
    const file = join(fixture.root, "memory", createHash("sha256").update("owner").digest("hex") + ".json");
    await writeFile(file, '{"incomplete":');
    assert.throws(() => book.list("owner"));
  } finally { await fixture.close(); }
});
