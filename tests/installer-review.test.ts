import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const windows = process.platform === "win32";
const installer = fileURLToPath(new URL("../scripts/install-workbench.ps1", import.meta.url));
const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";

async function put(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

async function fixture() {
  const temporaryParent = await realpath(tmpdir());
  const root = await mkdtemp(join(temporaryParent, "workbench-installer-review-"));
  const home = join(root, "isolated-home"), bin = join(root, "isolated-bin");
  const source = join(root, "source"), runtime = join(root, "fixture-runtime");
  const packageText = JSON.stringify({ name: "workbench-agent-harness", version: "0.1.0", type: "module" });
  for (const directory of [source, runtime]) {
    await put(join(directory, "package.json"), packageText);
    await put(join(directory, "package-lock.json"), '{"name":"workbench-agent-harness","lockfileVersion":3}');
  }
  await put(join(source, "tsconfig.json"), '{"compilerOptions":{}}');
  await put(join(source, "src", "input.ts"), "export const sourceIdentity = 1;");
  await put(join(runtime, "node_modules", "review-fixture", "index.js"), "module.exports = 'offline';");
  await put(join(runtime, "dist", "config.js"), `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function defaults(root) { return { version: 1, stateDir: join(root, 'state') }; }
export function validateConfig(value) {
  if (value.version !== 1 || typeof value.stateDir !== 'string') throw new Error('Invalid fixture configuration');
  return value;
}
export function saveConfig(value, root) {
  validateConfig(value); mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify(value));
}
`);
  await put(join(runtime, "dist", "store.js"), `
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export class Store {
  constructor(root) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(join(root, 'workbench.sqlite'));
    this.db.exec('CREATE TABLE IF NOT EXISTS fixture(id INTEGER); PRAGMA user_version=1');
  }
  close() { this.db.close(); }
}
`);
  await put(join(runtime, "dist", "cli.js"), `
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaults, validateConfig, saveConfig } from './config.js';
const args = process.argv.slice(2);
const home = args[args.indexOf('--home') + 1];
if (args[0] === '--version') console.log('workbench 0.1.0');
else if (args[0] === '--help') console.log('workbench --home <directory> init status');
else if (args[0] === 'init') {
  const config = join(home, 'config.json');
  if (existsSync(config)) validateConfig(JSON.parse(readFileSync(config, 'utf8')));
  else saveConfig(defaults(home), home);
  console.log('Fixture initialized');
} else console.log('Offline fixture');
`);
  const run = async (body: string) => {
    const driver = join(root, "driver.ps1");
    await writeFile(driver, "\uFEFF$ErrorActionPreference = 'Stop'\n" + body, "utf8");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
    Object.assign(env, {
      USERPROFILE: join(root, "fake-user"), LOCALAPPDATA: join(root, "fake-local"),
      WORKBENCH_HOME: join(root, "unused-home"),
    });
    try {
      const output = await exec(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", driver],
        { windowsHide: true, env, maxBuffer: 4 * 1024 * 1024 });
      return { code: 0, ...output };
    } catch (error) {
      const output = error as { code?: number | string; stdout?: string; stderr?: string };
      if (typeof output.code !== "number") throw error;
      return { code: output.code, stdout: output.stdout || "", stderr: output.stderr || "" };
    }
  };
  return {
    root, home, bin, source, runtime, run,
    async close() {
      const target = await realpath(root);
      const difference = relative(temporaryParent, target);
      assert.equal(target, resolve(root));
      assert.ok(difference && difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference));
      await rm(target, { recursive: true, force: true });
    },
  };
}

test("I01: an unrecognized shim arriving after ownership inspection is preserved without ResetLaunchers",
  { skip: !windows }, async () => {
    const f = await fixture();
    const ownerShim = "@echo owner-managed command created during source inventory\r\n";
    try {
      // Preserve the real source inventory implementation; inject only a
      // concurrent filesystem edit at its first return, after ownership was
      // checked but before the transaction captures its 'before' files.
      const result = await f.run(`
. ${quote(installer)}
$script:reviewOriginalSource = (Get-Item Function:\\Get-WbSource).ScriptBlock
$script:reviewInjected = $false
function Get-WbSource([string]$Root, [switch]$Fixture) {
    $identity = & $script:reviewOriginalSource $Root -Fixture:$Fixture
    if (-not $script:reviewInjected) {
        $script:reviewInjected = $true
        [IO.File]::WriteAllText(${quote(join(f.bin, "workbench.cmd"))}, ${quote(ownerShim)})
    }
    return $identity
}
$null = Invoke-WbInstall -InstallRoot ${quote(f.home)} -BinRoot ${quote(f.bin)} -SourceRoot ${quote(f.source)} -FixtureRuntime ${quote(f.runtime)} -AllowDirtySource
`);
      const current = await readFile(join(f.bin, "workbench.cmd"), "utf8");
      assert.equal(current, ownerShim,
        `An unrecognized shim was replaced without -ResetLaunchers after the ownership check. Installer exit: ${result.code}. ${result.stderr}`);
      assert.notEqual(result.code, 0, "An ownership change must stop activation for review.");
    } finally { await f.close(); }
  });
