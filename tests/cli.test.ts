import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaults, loadConfig, saveConfig, validateConfig } from "../src/config.js";
import { projectInstructions } from "../src/capabilities.js";
import { RECOMMENDED_ROUTES } from "../src/providers.js";

const exec = promisify(execFile);

test("normal CLI help works without model credentials and documents recovery", async () => {
  const { stdout } = await exec(process.execPath, ["--import", "tsx", "src/cli.ts", "--help"], { cwd: process.cwd() });
  assert.match(stdout, /workbench recover/);
  assert.match(stdout, /workbench approve/);
  assert.match(stdout, /\/cancel, \/new <objective>, \/approvals, \/approve <id>, \/reject <id>/);
  assert.match(stdout, /Stock Pi/);
});

test("separate configuration persists max reasoning and does not need a Git project", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-config-"));
  try {
    const config = defaults(root);
    saveConfig(config, root);
    const read = loadConfig(root);
    assert.equal(read.coordinator.effort, "max");
    assert.equal(read.worker.effort, "max");
    assert.equal(read.reviewer.effort, "max");
    assert.deepEqual(read.compactor, read.worker);
    assert.equal(read.accessMode, "gateway-only");
    assert.equal(read.execution, "restricted");
    assert.equal(read.fallbacks.length, 0);
    assert.ok(read.fallbacks.every((route) => route.effort === "max"));
    assert.throws(() => validateConfig({ ...config, worker: { ...config.worker, effort: "low" } }), /route/);
    const { stdout } = await exec(process.execPath, ["--import", "tsx", "src/cli.ts", "status", "--home", root, "--json"]);
    assert.deepEqual(JSON.parse(stdout), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("nongit instructions stay scoped to the chosen work folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-instructions-"));
  try {
    const project = join(root, "project");
    await mkdir(project);
    await writeFile(join(root, "AGENTS.md"), "unrelated parent instructions");
    await writeFile(join(project, "AGENTS.md"), "current project instructions");
    const text = projectInstructions(project);
    assert.match(text, /current project instructions/);
    assert.doesNotMatch(text, /unrelated parent instructions/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
