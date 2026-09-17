import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const exec = promisify(execFile);
const windows = process.platform === "win32";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = join(repo, "scripts", "install-workbench.ps1");
const rollback = join(repo, "scripts", "rollback-workbench.ps1");
const ps = (text: string) => "'" + text.replaceAll("'", "''") + "'";
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

type Result = { code: number; stdout: string; stderr: string };
type Fixture = {
  root: string; home: string; bin: string; source: string; runtime: string;
  run: (body: string, options?: { env?: NodeJS.ProcessEnv; shell?: string }) => Promise<Result>;
  install: (options?: string, hook?: string, env?: NodeJS.ProcessEnv) => Promise<Result>;
  restore: (options: string, hook?: string) => Promise<Result>;
};

async function command(file: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<Result> {
  try {
    const { stdout, stderr } = await exec(file, args, {
      windowsHide: true, env: { ...process.env, ...env }, maxBuffer: 4 * 1024 * 1024,
      windowsVerbatimArguments: basename(file).toLowerCase() === "cmd.exe",
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const result = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    if (typeof result.code !== "number") throw error;
    return { code: result.code, stdout: result.stdout || "", stderr: result.stderr || "" };
  }
}

function passed(result: Result) {
  assert.equal(result.code, 0, result.stdout + result.stderr);
}

function failed(result: Result, pattern?: RegExp) {
  assert.notEqual(result.code, 0, result.stdout + result.stderr);
  if (pattern) assert.match(result.stdout + result.stderr, pattern);
}

async function json(path: string): Promise<any> {
  return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
}

async function put(path: string, data: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data, "utf8");
}

// Every child receives fake user defaults as an additional tripwire. The real
// .local/bin and Workbench home are never installation destinations in tests.
async function fixture(t: TestContext, label = "plain"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "workbench-installer-"));
  t.after(async () => {
    const full = resolve(root);
    const tempRoot = resolve(tmpdir()) + sep;
    assert.ok(full.startsWith(tempRoot) && basename(full).startsWith("workbench-installer-"));
    await rm(full, { recursive: true, force: true });
  });
  const home = join(root, label === "special" ? "home [ñ %WB_EXPAND_TRAP%] ! O'Brien & tools" : "home");
  const bin = join(root, "bin [commands]");
  const source = join(root, "source");
  const runtime = join(root, "fixture-runtime");
  const packageText = JSON.stringify({
    name: "workbench-agent-harness", version: "0.1.0", type: "module",
    dependencies: { "fixture-workbench-dep": "1.0.0" },
  }) + "\n";
  for (const folder of [source, runtime]) {
    await put(join(folder, "package.json"), packageText);
    await put(join(folder, "package-lock.json"), '{"lockfileVersion":3,"name":"workbench-agent-harness"}\n');
  }
  await put(join(source, "tsconfig.json"), '{"compilerOptions":{"outDir":"dist"}}\n');
  await put(join(source, "src", "build-input.ts"), "export const revision = 1;\n");
  await put(join(runtime, "node_modules", "fixture-workbench-dep", "package.json"),
    '{"name":"fixture-workbench-dep","version":"1.0.0","type":"module","exports":"./index.js"}\n');
  await put(join(runtime, "node_modules", "fixture-workbench-dep", "index.js"), "export const proof = 'dependency loaded';\n");
  await put(join(runtime, "dist", "config.js"), `
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export function defaults(root) { return { version: 1, stateDir: join(root, 'state'), label: 'initial' }; }
export function validateConfig(config) {
  if (!config || config.version !== 1 || typeof config.stateDir !== 'string') throw new Error('fixture config incompatible');
  return config;
}
export function saveConfig(config, home) {
  validateConfig(config); mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\\n');
}
`);
  await put(join(runtime, "dist", "cli.js"), `
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { defaults, saveConfig, validateConfig } from './config.js';
import { proof } from 'fixture-workbench-dep';
const args = process.argv.slice(2);
const homeIndex = args.indexOf('--home');
const home = resolve(homeIndex >= 0 ? args[homeIndex + 1] : process.env.WORKBENCH_HOME);
if (homeIndex >= 0) args.splice(homeIndex, 2);
if (args.includes('--version')) console.log('workbench 0.1.0');
else if (args.includes('--help')) console.log('workbench --home <folder> init status');
else if (args[0] === 'init') {
  if (process.env.WB_FIXTURE_INIT_FAIL === '1') { console.error('fixture initialization failed'); process.exit(23); }
  if (existsSync(join(home, 'config.json'))) validateConfig(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')));
  else saveConfig(defaults(home), home);
  console.log('Configuration ready: ' + home);
} else {
  console.log(JSON.stringify({ home, args, proof }));
  if (args.includes('fail-command')) process.exit(37);
}
`);
  await writeStore(runtime, 1);
  const childEnv = {
    USERPROFILE: join(root, "fake-user"), LOCALAPPDATA: join(root, "fake-local"),
    WORKBENCH_HOME: join(root, "wrong-default-home"), WB_EXPAND_TRAP: "wrong-expanded-path",
  };
  const run: Fixture["run"] = async (body, options = {}) => {
    const driver = join(root, `driver-${randomUUID()}.ps1`);
    // Windows PowerShell needs a BOM for fixture paths containing non-ASCII.
    await writeFile(driver, "\uFEFF$ErrorActionPreference = 'Stop'\n" + body, "utf8");
    return command(options.shell || powershell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", driver],
      { ...childEnv, ...options.env });
  };
  const install: Fixture["install"] = (options = "-AllowDirtySource", hook = "", env = {}) => run(`
. ${ps(installer)}
$null = Invoke-WbInstall -InstallRoot ${ps(home)} -BinRoot ${ps(bin)} -SourceRoot ${ps(source)} -FixtureRuntime ${ps(runtime)} ${options} ${hook ? "-TestHook { param($point, $context, $transaction)\n" + hook + "\n}" : ""}
`, { env });
  const restore: Fixture["restore"] = (options, hook = "") => run(`
. ${ps(rollback)}
$null = Invoke-WbRollback -InstallRoot ${ps(home)} -BinRoot ${ps(bin)} -Fixture ${options} ${hook ? "-TestHook { param($point, $context, $transaction)\n" + hook + "\n}" : ""}
`);
  return { root, home, bin, source, runtime, run, install, restore };
}

async function writeStore(runtime: string, schema: number) {
  await put(join(runtime, "dist", "store.js"), `
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export class Store {
  constructor(root) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(join(root, 'workbench.sqlite'));
    this.db.exec('CREATE TABLE IF NOT EXISTS fixture (id INTEGER); PRAGMA user_version = ${schema}');
  }
  close() { this.db.close(); }
}
`);
}

async function bump(f: Fixture, revision = 2) {
  await put(join(f.source, "src", "build-input.ts"), `export const revision = ${revision};\n`);
  await put(join(f.runtime, "dist", "revision.js"), `export const revision = ${revision};\n`);
}

async function active(f: Fixture) {
  return json(join(f.home, "active.json"));
}

async function snapshot(f: Fixture) {
  const entries: Record<string, string | null> = {};
  for (const [root, names] of [
    [f.home, ["config.json", "active.json"]],
    [f.bin, ["workbench", "workbench.cmd", "workbench.ps1"]],
  ] as const) {
    for (const name of names) {
      const path = join(root, name);
      entries[name] = existsSync(path) ? (await readFile(path)).toString("base64") : null;
    }
  }
  return entries;
}

async function journals(f: Fixture) {
  const root = join(f.home, "installation-backups");
  if (!existsSync(root)) return [];
  const result: { root: string; journal: any }[] = [];
  for (const name of await readdir(root)) {
    const directory = join(root, name);
    const path = join(directory, "transaction.json");
    if (existsSync(path)) result.push({ root: directory, journal: await json(path) });
  }
  return result;
}

// Intercept the real snapshot factory, after preliminary ownership inspection.
// The file edits happen on disk in the child PowerShell process; snapshotting,
// ownership validation and activation remain the actual installer functions.
function interceptTransaction(before: string, after = "") {
  return `
$script:originalTransactionFactory = (Get-Item Function:\\New-WbTransaction).ScriptBlock
function New-WbTransaction($Context, [string]$Id, [string]$Action, [string]$Generation) {
  ${before}
  $captured = & $script:originalTransactionFactory $Context $Id $Action $Generation
  ${after}
  return $captured
}
`;
}

test("installer scripts parse in Windows PowerShell and PowerShell 7; dot-sourcing has no install effects", { skip: !windows }, async (t) => {
  const f = await fixture(t);
  for (const shell of [powershell, "pwsh.exe"]) {
    passed(await f.run(`
foreach ($script in @(${ps(installer)}, ${ps(rollback)})) {
  $tokens = $null; $errors = $null
  $null = [Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw ($errors | Out-String) }
}
. ${ps(rollback)}
Write-Output 'definitions only'
`, { shell }));
  }
  assert.equal(existsSync(f.home), false);
  assert.equal(existsSync(f.bin), false);
  assert.equal(existsSync(join(f.root, "fake-local")), false);
});

test("isolated install inventories sources, dist and dependencies; all launchers use custom home and preserve exit codes", { skip: !windows }, async (t) => {
  const f = await fixture(t, "special");
  passed(await f.install());
  const pointer = await active(f);
  const manifest = await json(join(pointer.runtime, "installed.json"));
  const receipt = await json(join(f.home, "installation-backups", pointer.generation, "prepared.json"));
  assert.equal(pointer.installRoot, f.home);
  assert.equal(pointer.binRoot, f.bin);
  assert.equal(manifest.validationMode, "offline-fixture");
  assert.equal(manifest.source.dirty, true);
  assert.equal(manifest.source.commit, null);
  assert.equal(receipt.manifestSha256, hash(await readFile(join(pointer.runtime, "installed.json"))));
  assert.equal(manifest.source.files.find((file: any) => file.path === "src/build-input.ts").sha256,
    hash(await readFile(join(f.source, "src", "build-input.ts"))));
  for (const entry of manifest.files) {
    const bytes = await readFile(join(pointer.runtime, entry.path));
    assert.equal(entry.sha256, hash(bytes), entry.path);
    assert.equal(entry.bytes, bytes.length, entry.path);
  }
  assert.ok(manifest.files.some((file: any) => file.path === "node_modules/fixture-workbench-dep/index.js"));
  assert.ok(manifest.files.some((file: any) => file.path === "dist/cli.js"));
  assert.equal((await json(join(f.home, "config.json"))).stateDir, join(f.home, "state"));
  assert.equal(existsSync(join(f.home, "state")), false, "installation must not initialize the live database");

  for (const shell of [powershell, "pwsh.exe"]) {
    const result = await command(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", join(f.bin, "workbench.ps1"), "status", "two words"], { WB_EXPAND_TRAP: "wrong-expanded-path" });
    passed(result);
    assert.deepEqual(JSON.parse(result.stdout), { home: f.home, args: ["status", "two words"], proof: "dependency loaded" });
  }
  const cmd = process.env.ComSpec || "cmd.exe";
  const batch = await command(cmd, ["/d", "/s", "/c", `""${join(f.bin, "workbench.cmd")}" status "two words""`],
    { WB_EXPAND_TRAP: "wrong-expanded-path" });
  passed(batch);
  assert.deepEqual(JSON.parse(batch.stdout.trim()), { home: f.home, args: ["status", "two words"], proof: "dependency loaded" });
  const bad = await command(cmd, ["/d", "/s", "/c", `""${join(f.bin, "workbench.cmd")}" fail-command"`]);
  assert.equal(bad.code, 37, bad.stdout + bad.stderr);
  const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
  if (existsSync(bash)) {
    const sh = await command(bash, ["--noprofile", "--norc", join(f.bin, "workbench").replaceAll("\\", "/"), "status", "two words"]);
    passed(sh);
    const output = JSON.parse(sh.stdout);
    assert.equal(output.home.toLowerCase(), f.home.toLowerCase());
    assert.deepEqual(output.args, ["status", "two words"]);
  }
  assert.equal(existsSync(join(f.root, "fake-local")), false);
  // PowerShell can create its own cache under USERPROFILE. Only installation
  // destinations are relevant to this assertion.
  assert.equal(existsSync(join(f.root, "fake-user", ".local", "bin", "workbench.ps1")), false);
});

test("PrepareOnly leaves activation absent, and verified prepared activation plus reinstall reuse the generation", { skip: !windows }, async (t) => {
  const f = await fixture(t);
  passed(await f.install("-AllowDirtySource -PrepareOnly"));
  assert.deepEqual(await snapshot(f), {
    "config.json": null, "active.json": null, workbench: null, "workbench.cmd": null, "workbench.ps1": null,
  });
  assert.equal(existsSync(f.bin), false);
  const generation = (await readdir(join(f.home, "runtime")))[0];
  passed(await f.install(`-ActivateGeneration ${ps(generation)}`));
  const before = await snapshot(f);
  passed(await f.install());
  assert.deepEqual(await snapshot(f), before);
  assert.deepEqual(await readdir(join(f.home, "runtime")), [generation]);
  passed(await f.install("-AllowDirtySource -PrepareOnly",
    "if ($point -eq 'before-source-readback') { throw 'Reused preparation must not rebuild.' }"));
  assert.deepEqual(await snapshot(f), before);
  assert.deepEqual(await readdir(join(f.home, "runtime")), [generation]);
  const reused = (await journals(f)).find(({ journal }) => journal.action === "activate" && journal.state === "prepared");
  assert.ok(reused);
  assert.equal((await json(join(reused.root, "preparation-checks", "compatibility.json"))).databaseSchema, 1);
  assert.equal(existsSync(join(reused.root, "checks", "gate.log")), false);
});

test("dirty source requires explicit opt-in; fixture receipts cannot be activated through the production CLI", { skip: !windows }, async (t) => {
  const f = await fixture(t);
  failed(await f.install(""), /AllowDirtySource/);
  assert.equal(existsSync(join(f.home, "active.json")), false);
  passed(await f.install("-AllowDirtySource -PrepareOnly"));
  const generation = (await readdir(join(f.home, "runtime")))[0];
  const result = await f.run(`& ${ps(installer)} -InstallRoot ${ps(f.home)} -BinRoot ${ps(f.bin)} -ActivateGeneration ${ps(generation)}`);
  failed(result, /offline fixture is not eligible/);
  assert.equal(existsSync(join(f.home, "active.json")), false);
});

test("every activation boundary restores the absence of prior files after failure", { skip: !windows }, async (t) => {
  for (const name of ["config.json", "workbench.ps1", "workbench.cmd", "workbench", "active.json"]) {
    await t.test(name, async (child) => {
      const f = await fixture(child);
      const before = await snapshot(f);
      failed(await f.install("-AllowDirtySource", `if ($point -eq ${ps("after-" + name)}) { throw 'fixture activation failure' }`),
        /previous configuration, pointer and launchers were restored/);
      assert.deepEqual(await snapshot(f), before);
      const failedJournal = (await journals(f)).find(({ journal }) => journal.state === "restored");
      assert.ok(failedJournal);
      assert.ok(failedJournal.journal.files.every((file: any) => file.before.exists === false));
      assert.equal((await readdir(join(f.home, "runtime"))).length, 1, "failed generation is retained");
    });
  }
});

test("failed upgrade restores exact prior bytes and missing shims, retaining both runtime generations", { skip: !windows }, async (t) => {
  const f = await fixture(t);
  passed(await f.install());
  const old = await active(f);
  const oldManifest = await readFile(join(old.runtime, "installed.json"));
  await rm(join(f.bin, "workbench.cmd"));
  const before = await snapshot(f);
  await bump(f);
  failed(await f.install("-AllowDirtySource", "if ($point -eq 'after-active.json') { throw 'fixture upgrade failure' }"), /were restored/);
  assert.deepEqual(await snapshot(f), before);
  assert.deepEqual(await readFile(join(old.runtime, "installed.json")), oldManifest);
  assert.equal((await readdir(join(f.home, "runtime"))).length, 2);
  passed(await f.install());
  assert.notEqual((await active(f)).generation, old.generation);
  assert.ok(existsSync(join(f.bin, "workbench.cmd")));
});

test("initialization failure and source drift cannot activate; failed command output remains available", { skip: !windows }, async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f);
  failed(await f.install("-AllowDirtySource", "", { WB_FIXTURE_INIT_FAIL: "1" }), /Check failed \(exit 23\)/);
  assert.deepEqual(await snapshot(f), before);
  const failedInit = (await journals(f)).find(({ journal }) => journal.state === "failed");
  assert.ok(failedInit);
  assert.match(await readFile(join(failedInit.root, "checks", "runtime", "init.log"), "utf8"), /fixture initialization failed/);
  failed(await f.install("-AllowDirtySource",
    `if ($point -eq 'before-source-readback') { [IO.File]::WriteAllText(${ps(join(f.source, "src", "build-input.ts"))}, 'changed while preparing') }`),
  /Source changed during preparation/);
  assert.deepEqual(await snapshot(f), before);
});

test("unknown and edited launchers are protected; explicit reset preserves their bytes in backups", { skip: !windows }, async (t) => {
  const f = await fixture(t);
  await put(join(f.bin, "workbench.cmd"), "@echo another tool\r\n");
  const before = await snapshot(f);
  failed(await f.install(), /Unrecognized or edited launcher/);
  assert.deepEqual(await snapshot(f), before);
  passed(await f.install("-AllowDirtySource -ResetLaunchers"));
  const first = (await journals(f)).find(({ journal }) => journal.state === "committed");
  assert.ok(first);
  assert.equal(await readFile(join(first.root, "before", "workbench.cmd"), "utf8"), "@echo another tool\r\n");
  await put(join(f.bin, "workbench.ps1"), "# Workbench managed launcher\nWrite-Output 'owner edit'\n");
  const edited = await snapshot(f);
  failed(await f.install(), /Unrecognized or edited launcher/);
  assert.deepEqual(await snapshot(f), edited);
});

test("a hard interruption is recoverable without npm, and recovery itself is idempotent", { skip: !windows }, async (t) => {
  const f = await fixture(t);
  passed(await f.install());
  const before = await snapshot(f);
  await bump(f);
  const crash = await f.install("-AllowDirtySource", "if ($point -eq 'after-workbench.cmd') { [Environment]::Exit(91) }");
  assert.equal(crash.code, 91);
  assert.notDeepEqual(await snapshot(f), before);
  failed(await f.install("-AllowDirtySource -PrepareOnly"), /activation is incomplete/);
  // Exercise the public recovery script too: it needs neither the fixture
  // seam nor permission to accept a fixture runtime.
  passed(await f.run(`& ${ps(rollback)} -InstallRoot ${ps(f.home)} -BinRoot ${ps(f.bin)} -Recover`));
  assert.deepEqual(await snapshot(f), before);
  passed(await f.restore("-Recover"));
  assert.deepEqual(await snapshot(f), before);
  assert.ok((await journals(f)).some(({ journal }) => journal.state === "restored"));
});

test("recovery refuses unknown external edits and corrupt backup snapshots before changing any file", { skip: !windows }, async (t) => {
  for (const corruptBackup of [false, true]) {
    await t.test(corruptBackup ? "backup hash" : "external edit", async (child) => {
      const f = await fixture(child);
      passed(await f.install());
      await bump(f);
      assert.equal((await f.install("-AllowDirtySource", "if ($point -eq 'after-workbench.cmd') { [Environment]::Exit(91) }")).code, 91);
      const pending = (await journals(f)).find(({ journal }) => journal.state === "activating");
      assert.ok(pending);
      await put(corruptBackup ? join(pending.root, "before", "workbench.cmd") : join(f.bin, "workbench.cmd"), "external bytes");
      const before = await snapshot(f);
      failed(await f.restore("-Recover"), corruptBackup ? /snapshot hash mismatch/ : /external change/);
      assert.deepEqual(await snapshot(f), before);
    });
  }
});

test("saved rollback verifies all runtime files and manifest before changing activation", { skip: !windows }, async (t) => {
  const f = await fixture(t);
  passed(await f.install());
  const old = await active(f);
  await bump(f);
  passed(await f.install());
  const before = await snapshot(f);
  for (const relative of ["node_modules/fixture-workbench-dep/index.js", "saved-config.json", "installed.json"]) {
    await t.test(relative, async () => {
      const file = join(old.runtime, relative);
      const bytes = await readFile(file);
      await writeFile(file, Buffer.concat([bytes, Buffer.from("\nchanged")]));
      failed(await f.restore(`-Generation ${ps(old.generation)}`), /hash mismatch/);
      assert.deepEqual(await snapshot(f), before);
      await writeFile(file, bytes);
    });
  }
  await put(join(old.runtime, "dist", "unexpected.js"), "unexpected code");
  failed(await f.restore(`-Generation ${ps(old.generation)}`), /inventory\/hash mismatch/);
  assert.deepEqual(await snapshot(f), before);
  failed(await f.restore("-Generation '..\\outside'"), /Invalid saved generation/);
  assert.deepEqual(await snapshot(f), before);
});

test("rollback restores the target's saved configuration and launchers, while preserving current state and backups", { skip: !windows }, async (t) => {
  const f = await fixture(t);
  passed(await f.install());
  const first = await active(f);
  const firstSnapshot = await snapshot(f);
  const config = await json(join(f.home, "config.json"));
  config.label = "later owner settings";
  await put(join(f.home, "config.json"), JSON.stringify(config) + "\n");
  await bump(f);
  passed(await f.install());
  const second = await active(f);
  const secondSnapshot = await snapshot(f);
  await put(join(f.home, "state", "retained-evidence.txt"), "evidence must survive rollback\n");
  passed(await f.restore(`-Generation ${ps(first.generation)}`));
  const restored = await snapshot(f);
  assert.equal((await active(f)).generation, first.generation);
  for (const name of ["config.json", "workbench", "workbench.cmd", "workbench.ps1"]) assert.equal(restored[name], firstSnapshot[name]);
  assert.equal(await readFile(join(f.home, "state", "retained-evidence.txt"), "utf8"), "evidence must survive rollback\n");
  assert.ok(existsSync(join(second.runtime, "installed.json")));
  const saved = (await journals(f)).find(({ journal }) => journal.action === "rollback" && journal.state === "committed");
  assert.ok(saved);
  assert.equal((await readFile(join(saved.root, "before", "config.json"))).toString("base64"), secondSnapshot["config.json"]);
});

test("rollback refuses a newer database schema or a changed state directory, without modifying the database", { skip: !windows }, async (t) => {
  const f = await fixture(t);
  passed(await f.install());
  const first = await active(f);
  await bump(f);
  await writeStore(f.runtime, 2);
  passed(await f.install()); // no live DB exists yet; the isolated probe is schema 2
  const dbPath = join(f.home, "state", "workbench.sqlite");
  await mkdir(dirname(dbPath), { recursive: true });
  passed(await command(process.execPath, ["--input-type=module", "-e", `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[1]);
db.exec('CREATE TABLE retained (id INTEGER); INSERT INTO retained VALUES (42); PRAGMA user_version = 2');
db.close();`, dbPath]));
  const dbBytes = await readFile(dbPath);
  const before = await snapshot(f);
  failed(await f.restore(`-Generation ${ps(first.generation)}`), /Check failed/);
  assert.deepEqual(await snapshot(f), before);
  assert.deepEqual(await readFile(dbPath), dbBytes);
  const failedSchema = (await journals(f)).find(({ journal }) => journal.action === "rollback" && journal.state === "failed");
  assert.ok(failedSchema);
  assert.match(await readFile(join(failedSchema.root, "rollback-checks", "compatibility.log"), "utf8"), /Database schema is incompatible/);
  const config = await json(join(f.home, "config.json"));
  config.stateDir = join(f.home, "other-state");
  await put(join(f.home, "config.json"), JSON.stringify(config));
  const changed = await snapshot(f);
  failed(await f.restore(`-Generation ${ps(first.generation)}`));
  assert.deepEqual(await snapshot(f), changed);
  assert.deepEqual(await readFile(dbPath), dbBytes);
});

test("installer locks cover both home and shared bin; invalid roots and junction ancestors are rejected", { skip: !windows }, async (t) => {
  const f = await fixture(t);
  for (const root of [f.home, f.bin]) {
    await mkdir(root, { recursive: true });
    const result = await f.run(`
. ${ps(installer)}
$guard = [IO.File]::Open(${ps(join(root, ".workbench-install.lock"))}, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try { $null = Invoke-WbInstall -InstallRoot ${ps(f.home)} -BinRoot ${ps(f.bin)} -SourceRoot ${ps(f.source)} -FixtureRuntime ${ps(f.runtime)} -AllowDirtySource }
finally { $guard.Dispose() }
`);
    failed(result, /lock cannot be opened/);
  }
  for (const root of ["relative-home", "C:relative", "C:\\", f.bin, join(f.source, "nested-home")]) {
    failed(await f.run(`
. ${ps(installer)}
$null = Invoke-WbInstall -InstallRoot ${ps(root)} -BinRoot ${ps(f.bin)} -SourceRoot ${ps(f.source)} -FixtureRuntime ${ps(f.runtime)} -AllowDirtySource
`), /absolute local|volume root|nonoverlapping|source checkout/);
  }
  const outside = join(f.root, "outside");
  const link = join(f.root, "linked-parent");
  await mkdir(outside);
  await symlink(outside, link, "junction");
  failed(await f.run(`
. ${ps(installer)}
$null = Invoke-WbInstall -InstallRoot ${ps(join(link, "home"))} -BinRoot ${ps(f.bin)} -SourceRoot ${ps(f.source)} -FixtureRuntime ${ps(f.runtime)} -AllowDirtySource
`), /links or junctions/);
  assert.deepEqual(await readdir(outside), []);
  assert.equal(existsSync(join(f.home, "active.json")), false);
});

test("an active runtime file can remain open across upgrade; preparation never replaces that generation", { skip: !windows }, async (t) => {
  const f = await fixture(t);
  passed(await f.install());
  const original = await active(f);
  const cli = join(original.runtime, "dist", "cli.js");
  const before = await readFile(cli);
  await bump(f);
  passed(await f.run(`
. ${ps(installer)}
$guard = [IO.File]::Open(${ps(cli)}, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try { $null = Invoke-WbInstall -InstallRoot ${ps(f.home)} -BinRoot ${ps(f.bin)} -SourceRoot ${ps(f.source)} -FixtureRuntime ${ps(f.runtime)} -AllowDirtySource }
finally { $guard.Dispose() }
`));
  assert.notEqual((await active(f)).generation, original.generation);
  assert.deepEqual(await readFile(cli), before);
});

test("an actual sharing violation rolls back earlier launcher writes", { skip: !windows }, async (t) => {
  const f = await fixture(t);
  passed(await f.install());
  const before = await snapshot(f);
  await bump(f);
  failed(await f.run(`
. ${ps(installer)}
$guard = [IO.File]::Open(${ps(join(f.bin, "workbench.cmd"))}, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try { $null = Invoke-WbInstall -InstallRoot ${ps(f.home)} -BinRoot ${ps(f.bin)} -SourceRoot ${ps(f.source)} -FixtureRuntime ${ps(f.runtime)} -AllowDirtySource }
finally { $guard.Dispose() }
`), /previous configuration, pointer and launchers were restored/);
  assert.deepEqual(await snapshot(f), before);
});

test("an owner edit during preparation or activation is preserved", { skip: !windows }, async (t) => {
  const f = await fixture(t);
  passed(await f.install());
  await bump(f);
  const before = await snapshot(f);
  failed(await f.install("-AllowDirtySource",
    `if ($point -eq 'before-activation') { [IO.File]::WriteAllText(${ps(join(f.home, "config.json"))}, 'owner changed configuration') }`),
  /files changed during preparation/);
  const editedConfig = await snapshot(f);
  for (const name of ["active.json", "workbench.ps1", "workbench.cmd", "workbench"]) assert.equal(editedConfig[name], before[name]);
  assert.equal(await readFile(join(f.home, "config.json"), "utf8"), "owner changed configuration");
  await writeFile(join(f.home, "config.json"), Buffer.from(before["config.json"]!, "base64"));
  failed(await f.install("-AllowDirtySource",
    `if ($point -eq 'after-config.json') { [IO.File]::WriteAllText(${ps(join(f.bin, "workbench.ps1"))}, 'owner changed launcher') }`),
  /Recovery is incomplete/);
  assert.equal(await readFile(join(f.bin, "workbench.ps1"), "utf8"), "owner changed launcher");
  assert.ok((await journals(f)).some(({ journal }) => journal.state === "recovery-required"));
});

test("PowerShell 7 executes install and rollback transactions with the same saved generation", { skip: !windows }, async (t) => {
  const f = await fixture(t);
  passed(await f.run(`
. ${ps(installer)}
$null = Invoke-WbInstall -InstallRoot ${ps(f.home)} -BinRoot ${ps(f.bin)} -SourceRoot ${ps(f.source)} -FixtureRuntime ${ps(f.runtime)} -AllowDirtySource
`, { shell: "pwsh.exe" }));
  const first = await active(f);
  await bump(f);
  passed(await f.install());
  passed(await f.run(`
. ${ps(rollback)}
$null = Invoke-WbRollback -InstallRoot ${ps(f.home)} -BinRoot ${ps(f.bin)} -Generation ${ps(first.generation)} -Fixture
`, { shell: "pwsh.exe" }));
  assert.equal((await active(f)).generation, first.generation);
});

test("source identity includes dirty tracked and untracked source bytes even when the Git commit is unchanged", { skip: !windows }, async (t) => {
  const f = await fixture(t);
  passed(await command("git.exe", ["-C", f.source, "init", "--quiet"]));
  passed(await command("git.exe", ["-C", f.source, "add", "."]));
  passed(await command("git.exe", ["-C", f.source, "-c", "user.name=Workbench fixture",
    "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Fixture source"]));
  const inventory = async (name: string) => {
    const target = join(f.root, name);
    passed(await f.run(`
. ${ps(installer)}
$identity = Get-WbSource ${ps(f.source)}
$identity | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath ${ps(target)} -Encoding UTF8
`));
    return json(target);
  };
  const clean = await inventory("clean-source.json");
  assert.equal(clean.dirty, false);
  await put(join(f.source, ".git", "info", "exclude"), "src/ignored.js\n");
  await put(join(f.source, "src", "ignored.js"), "export const ignoredInput = true;\n");
  const ignored = await inventory("ignored-source.json");
  assert.equal(ignored.dirty, true, "ignored compiler inputs still require dirty-source opt-in");
  assert.ok(ignored.files.some((file: any) => file.path === "src/ignored.js"));
  await put(join(f.source, "src", "build-input.ts"), "export const changed = true;\n");
  await put(join(f.source, "src", "untracked.ts"), "export const newSource = true;\n");
  const dirty = await inventory("dirty-source.json");
  assert.equal(dirty.commit, clean.commit);
  assert.equal(dirty.dirty, true);
  assert.notEqual(dirty.sha256, clean.sha256);
  assert.equal(dirty.files.find((file: any) => file.path === "src/untracked.ts").sha256,
    hash(await readFile(join(f.source, "src", "untracked.ts"))));
});

test("the packaging path runs the gate, fresh build and real offline npm ci with only production dependencies", { skip: !windows }, async (t) => {
  const f = await fixture(t, "special");
  const npmLocation = await f.run(`
. ${ps(installer)}
$shim = Get-WbApplication 'npm.cmd'
Write-Output (Join-Path ([IO.Path]::GetDirectoryName($shim)) 'node_modules\\npm\\bin\\npm-cli.js')
`);
  passed(npmLocation);
  const npmCli = npmLocation.stdout.trim();
  const env = {
    npm_config_offline: "true", npm_config_cache: join(f.root, "npm-cache"),
    npm_config_update_notifier: "false",
  };
  const dependency = join(f.runtime, "node_modules", "fixture-workbench-dep");
  await put(join(dependency, "package.json"), JSON.stringify({
    name: "fixture-workbench-dep", version: "1.0.0", type: "module", exports: "./index.js",
    scripts: { install: "node -e \"process.exit(29)\"" },
  }));
  const packed = await command(process.execPath,
    [npmCli, "pack", dependency, "--json", "--ignore-scripts", "--pack-destination", f.root], env);
  passed(packed);
  const archive = pathToFileURL(join(f.root, JSON.parse(packed.stdout)[0].filename)).href;
  await put(join(f.source, "package.json"), JSON.stringify({
    name: "workbench-agent-harness", version: "0.1.0", type: "module",
    scripts: { build: "tsc", preinstall: "node -e \"process.exit(28)\"" },
    dependencies: { "fixture-workbench-dep": archive },
    devDependencies: { "fixture-dev-only": archive },
  }) + "\n");
  for (const file of ["cli.js", "config.js", "store.js"]) {
    await put(join(f.source, "src", file), await readFile(join(f.runtime, "dist", file), "utf8"));
  }
  await put(join(f.source, "scripts", "check.mjs"), `
import { existsSync } from 'node:fs';
if (!existsSync('src/cli.js')) process.exit(31);
console.log('tiny fixture source gate passed');
`);
  // A tiny offline compiler fixture copies ready JS. The actual Workbench
  // TypeScript build is reserved for the parent's integrated installation.
  await put(join(f.source, "node_modules", "typescript", "bin", "tsc"), `
const { mkdirSync, readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const index = process.argv.indexOf('--outDir');
if (index < 0) process.exit(32);
const destination = process.argv[index + 1];
mkdirSync(destination, { recursive: true });
for (const file of readdirSync('src')) writeFileSync(join(destination, file), readFileSync(join('src', file)));
`);
  await put(join(f.source, "node_modules", ".bin", "tsc.cmd"),
    '@echo off\r\nnode "%~dp0..\\typescript\\bin\\tsc" %*\r\nexit /b %errorlevel%\r\n');
  await put(join(f.source, ".gitignore"), "node_modules/\ndist/\n");
  passed(await command(process.execPath, [npmCli, "install", "--package-lock-only", "--ignore-scripts",
    "--no-audit", "--no-fund", "--prefix", f.source], env));
  passed(await command("git.exe", ["-C", f.source, "init", "--quiet"]));
  passed(await command("git.exe", ["-C", f.source, "add", "."]));
  passed(await command("git.exe", ["-C", f.source, "-c", "user.name=Workbench fixture",
    "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Offline packaging fixture"]));
  // No FixtureRuntime bypass here: this exercises the real packaging branch,
  // using a local tarball and tiny copied JS source, not Workbench's full deps.
  const preparation = await f.run(`
. ${ps(installer)}
$null = Invoke-WbInstall -InstallRoot ${ps(f.home)} -BinRoot ${ps(f.bin)} -SourceRoot ${ps(f.source)} -PrepareOnly
`, { env });
  if (preparation.code !== 0) {
    t.diagnostic("CLI fixture locations: " + (await readdir(f.root, { recursive: true }))
      .filter((path) => basename(path) === "cli.js").join("\n"));
    for (const entry of await journals(f)) {
      for (const relative of ["checks/build.log", "checks/build.log.json", "checks/npm-ci.log", "checks/runtime/version.log"]) {
        const path = join(entry.root, relative);
        if (existsSync(path)) t.diagnostic(relative + "\n" + await readFile(path, "utf8"));
      }
    }
  }
  passed(preparation);
  const generation = (await readdir(join(f.home, "runtime")))[0];
  const runtime = join(f.home, "runtime", generation);
  const manifest = await json(join(runtime, "installed.json"));
  assert.equal(manifest.validationMode, "production");
  assert.equal(manifest.source.dirty, false);
  assert.match(manifest.source.commit, /^[a-f0-9]{40}$/);
  assert.ok(existsSync(join(runtime, "node_modules", "fixture-workbench-dep", "index.js")));
  assert.equal(existsSync(join(runtime, "node_modules", "fixture-dev-only")), false);
  assert.ok(manifest.checks.some((check: any) => check.arguments.includes("scripts/check.mjs") && check.exitCode === 0));
  assert.ok(manifest.checks.some((check: any) => check.arguments.includes("--omit=dev") && check.exitCode === 0));
  assert.equal(existsSync(join(f.source, "dist")), false);
  assert.equal(existsSync(join(f.home, "active.json")), false);
  assert.equal(existsSync(f.bin), false);
});

test("a moved Node installation prepares a fresh generation instead of trapping reinstall behind a stale receipt", { skip: !windows }, async (t) => {
  const f = await fixture(t);
  const tools = join(f.root, "old-node");
  const oldNode = join(tools, "node.exe");
  await mkdir(tools);
  await copyFile(process.execPath, oldNode);
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") || "Path";
  passed(await f.install("-AllowDirtySource", "", { [pathKey]: tools + ";" + process.env[pathKey] }));
  const old = await active(f);
  assert.equal((await json(join(old.runtime, "installed.json"))).node.path, oldNode);
  await rm(oldNode);
  passed(await f.install());
  const current = await active(f);
  assert.notEqual(current.generation, old.generation);
  assert.equal((await json(join(current.runtime, "installed.json"))).node.path, process.execPath);
  assert.ok(existsSync(join(old.runtime, "installed.json")));
});

test("snapshot ownership preserves an owner edit or new launcher between inspection and capture", { skip: !windows }, async (t) => {
  for (const action of ["install", "activate", "rollback"] as const) {
    for (const change of ["edit", "new"] as const) {
      await t.test(`${action}: ${change}`, async (child) => {
        const f = await fixture(child);
        passed(await f.install());
        const prior = await active(f);
        if (change === "new") await rm(join(f.bin, "workbench.cmd"));
        const before = await snapshot(f);
        const generations = await readdir(join(f.home, "runtime"));
        if (action === "install") await bump(f);
        const ownerBytes = `@echo owner ${change} between inspection and capture\r\n`;
        const entrypoint = action === "rollback" ? rollback : installer;
        const invoke = action === "rollback"
          ? `Invoke-WbRollback -InstallRoot ${ps(f.home)} -BinRoot ${ps(f.bin)} -Generation ${ps(prior.generation)} -Fixture`
          : `Invoke-WbInstall -InstallRoot ${ps(f.home)} -BinRoot ${ps(f.bin)} -SourceRoot ${ps(f.source)} -FixtureRuntime ${ps(f.runtime)} ` +
            (action === "activate" ? `-ActivateGeneration ${ps(prior.generation)}` : "-AllowDirtySource");
        const result = await f.run(`
. ${ps(entrypoint)}
${interceptTransaction(`[IO.File]::WriteAllText(${ps(join(f.bin, "workbench.cmd"))}, ${ps(ownerBytes)})`)}
$null = ${invoke}
`);
        failed(result, /Unrecognized or edited launcher/);
        assert.deepEqual(await snapshot(f), { ...before, "workbench.cmd": Buffer.from(ownerBytes).toString("base64") });
        assert.deepEqual(await readdir(join(f.home, "runtime")), generations, "reject the snapshot before preparing another runtime");
        const rejected = (await journals(f)).find(({ journal }) => journal.state === "failed");
        assert.ok(rejected);
        assert.equal(await readFile(join(rejected.root, "before", "workbench.cmd"), "utf8"), ownerBytes);
        assert.equal(rejected.journal.files.find((file: any) => file.name === "workbench.cmd").before.sha256, hash(ownerBytes));
      });
    }
  }
});

test("ownership uses the captured launcher even when the live file is restored before validation", { skip: !windows }, async (t) => {
  const f = await fixture(t);
  passed(await f.install());
  await bump(f);
  const before = await snapshot(f);
  const generations = await readdir(join(f.home, "runtime"));
  const launcher = join(f.bin, "workbench.cmd");
  const ownerBytes = "@echo unrecognized bytes captured in the transaction\r\n";
  const result = await f.run(`
. ${ps(installer)}
${interceptTransaction(
    `$script:originalLauncherBytes = [IO.File]::ReadAllBytes(${ps(launcher)})
     [IO.File]::WriteAllText(${ps(launcher)}, ${ps(ownerBytes)})`,
    `[IO.File]::WriteAllBytes(${ps(launcher)}, $script:originalLauncherBytes)`)}
$null = Invoke-WbInstall -InstallRoot ${ps(f.home)} -BinRoot ${ps(f.bin)} -SourceRoot ${ps(f.source)} -FixtureRuntime ${ps(f.runtime)} -AllowDirtySource
`);
  failed(result, /Unrecognized or edited launcher/);
  assert.deepEqual(await snapshot(f), before);
  assert.deepEqual(await readdir(join(f.home, "runtime")), generations);
  const rejected = (await journals(f)).find(({ journal }) => journal.state === "failed");
  assert.ok(rejected);
  assert.equal(await readFile(join(rejected.root, "before", "workbench.cmd"), "utf8"), ownerBytes);
});

test("snapshot ownership validates an active pointer changed after preliminary inspection", { skip: !windows }, async (t) => {
  for (const action of ["install", "rollback"] as const) {
    await t.test(action, async (child) => {
      const f = await fixture(child);
      passed(await f.install());
      const prior = await active(f);
      const before = await snapshot(f);
      const ownerBytes = JSON.stringify({ ...prior, runtime: join(f.root, "owner-runtime") }) + "\n";
      const entrypoint = action === "rollback" ? rollback : installer;
      const invoke = action === "rollback"
        ? `Invoke-WbRollback -InstallRoot ${ps(f.home)} -BinRoot ${ps(f.bin)} -Generation ${ps(prior.generation)} -Fixture`
        : `Invoke-WbInstall -InstallRoot ${ps(f.home)} -BinRoot ${ps(f.bin)} -SourceRoot ${ps(f.source)} -FixtureRuntime ${ps(f.runtime)} -AllowDirtySource`;
      const result = await f.run(`
. ${ps(entrypoint)}
${interceptTransaction(`[IO.File]::WriteAllText(${ps(join(f.home, "active.json"))}, ${ps(ownerBytes)})`)}
$null = ${invoke}
`);
      failed(result, /not owned by this installation/);
      assert.deepEqual(await snapshot(f), { ...before, "active.json": Buffer.from(ownerBytes).toString("base64") });
    });
  }
});

test("explicit ResetLaunchers authorizes the captured new shim and retains its exact backup", { skip: !windows }, async (t) => {
  const f = await fixture(t);
  const ownerBytes = "@echo newly created owner shim, explicitly reset\r\n";
  passed(await f.run(`
. ${ps(installer)}
${interceptTransaction(`[IO.File]::WriteAllText(${ps(join(f.bin, "workbench.cmd"))}, ${ps(ownerBytes)})`)}
$null = Invoke-WbInstall -InstallRoot ${ps(f.home)} -BinRoot ${ps(f.bin)} -SourceRoot ${ps(f.source)} -FixtureRuntime ${ps(f.runtime)} -AllowDirtySource -ResetLaunchers
`));
  const committed = (await journals(f)).find(({ journal }) => journal.state === "committed");
  assert.ok(committed);
  assert.equal(await readFile(join(committed.root, "before", "workbench.cmd"), "utf8"), ownerBytes);
  assert.notEqual(await readFile(join(f.bin, "workbench.cmd"), "utf8"), ownerBytes);
});

test("reused PrepareOnly checks current configuration and database compatibility", { skip: !windows }, async (t) => {
  for (const changed of ["configuration", "database"] as const) {
    await t.test(changed, async (child) => {
      const f = await fixture(child);
      passed(await f.install());
      const generations = await readdir(join(f.home, "runtime"));
      let database: string | undefined;
      let databaseBytes: Buffer | undefined;
      if (changed === "configuration") {
        const config = await json(join(f.home, "config.json"));
        await put(join(f.home, "config.json"), JSON.stringify({ ...config, version: 99 }));
      } else {
        database = join(f.home, "state", "workbench.sqlite");
        await mkdir(dirname(database), { recursive: true });
        passed(await command(process.execPath, ["--input-type=module", "-e", `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[1]);
db.exec('CREATE TABLE retained (id INTEGER); PRAGMA user_version = 99');
db.close();`, database]));
        databaseBytes = await readFile(database);
      }
      const before = await snapshot(f);
      failed(await f.install("-AllowDirtySource -PrepareOnly"), /Check failed/);
      assert.deepEqual(await snapshot(f), before);
      assert.deepEqual(await readdir(join(f.home, "runtime")), generations);
      if (database) assert.deepEqual(await readFile(database), databaseBytes);
    });
  }
});
