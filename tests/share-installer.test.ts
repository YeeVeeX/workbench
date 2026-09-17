import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Runs on Node 24 directly: node --test tests/share-installer.test.ts.
// No dependency installation, live Workbench install, or real user PATH writes.
const exec = promisify(execFile);
const windows = process.platform === "win32";
const installer = fileURLToPath(new URL("../scripts/share-install.ps1", import.meta.url));
const system = process.env.SystemRoot || "C:\\Windows";
const powershell = join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const shells = [powershell, "pwsh.exe"];
const commandName = "wb-share-fixture";
const ps = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Result = { code: number; stdout: string; stderr: string };

async function run(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<Result> {
  try {
    const result = await exec(executable, args, { env, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
      windowsVerbatimArguments: basename(executable).toLowerCase() === "cmd.exe" });
    return { code: 0, ...result };
  } catch (error) {
    const result = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    if (typeof result.code !== "number") throw error;
    return { code: result.code, stdout: result.stdout || "", stderr: result.stderr || "" };
  }
}
function passed(result: Result) { assert.equal(result.code, 0, result.stdout + result.stderr); }
function failed(result: Result, pattern?: RegExp) {
  assert.notEqual(result.code, 0, result.stdout + result.stderr);
  if (pattern) assert.match(result.stdout + result.stderr, pattern);
}
async function put(path: string, contents: string | Buffer) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function fixture(t: TestContext, special = false) {
  const temporaryParent = await realpath(tmpdir());
  const root = await mkdtemp(join(temporaryParent, "workbench-share-installer-"));
  t.after(async () => {
    const target = await realpath(root);
    const diff = relative(temporaryParent, target);
    assert.equal(target, resolve(root));
    assert.ok(diff && !isAbsolute(diff) && diff !== ".." && !diff.startsWith(`..${sep}`));
    assert.ok(basename(target).startsWith("workbench-share-installer-"));
    await rm(target, { recursive: true, force: true });
  });
  const suffix = special ? " [ñ é] O'Brien %WB_EXPAND_TRAP% !bang! & (tools) ^" : "";
  const source = join(root, "package" + suffix), bin = join(root, "bin" + suffix);
  const script = join(source, "scripts", "share-install.ps1");
  await put(script, await readFile(installer));
  await put(join(source, "dist", "cli.js"), `
console.log(JSON.stringify({ args: process.argv.slice(2), cli: process.argv[1],
  home: process.env.WORKBENCH_HOME || null, node: process.execPath }));
process.exitCode = Number(process.env.WB_FIXTURE_EXIT || 0);
`);
  const nodeDir = join(root, "node" + suffix);
  await mkdir(nodeDir);
  // Copy only for the special-path case; ordinary cases use real Node on PATH.
  if (special) await copyFile(process.execPath, join(nodeDir, "node.exe"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !["PATH", "PSMODULEPATH", "NODE_OPTIONS", "NODE_PATH", "WORKBENCH_HOME"].includes(key.toUpperCase())));
  Object.assign(env, {
    PATH: nodeDir + ";" + dirname(process.execPath) + ";" + (process.env.PATH || process.env.Path || ""),
    USERPROFILE: join(root, "fake-user"), LOCALAPPDATA: join(root, "fake-local"),
    WORKBENCH_HOME: join(root, "owner-home"), WB_EXPAND_TRAP: "WRONG", bang: "WRONG",
    WB_FIXTURE_ROOT: root, WB_FIXTURE_BIN: bin, WB_FIXTURE_EXIT: "0",
  });
  await put(join(root, "owner-home", "config.json"), "owner configuration sentinel");
  await put(join(root, "owner-home", "key.txt"), "local reference sentinel");
  let count = 0;
  const driver = async (body: string, shell = powershell) => {
    const path = join(root, `driver-${count++}.ps1`);
    await put(path, "\uFEFF$ErrorActionPreference = 'Stop'\n" +
      "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n" + body);
    return run(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path], env);
  };
  const install = (shell = powershell, extra = "", before = "") =>
    driver(`${before}\n& ${ps(script)} -BinRoot ${ps(bin)} -CommandName ${ps(commandName)} ${extra}`, shell);
  const noShims = async () => {
    for (const extension of [".ps1", ".cmd"]) assert.equal(existsSync(join(bin, commandName + extension)), false);
  };
  const manifest = async (runtime = true, names = ["scripts/share-install.ps1", "dist/cli.js"]) => {
    const files = await Promise.all(names.map(async (path) => {
      const bytes = await readFile(join(source, path));
      return { path, bytes: bytes.length, sha256: hash(bytes) };
    }));
    const path = join(source, runtime ? "RELEASE-MANIFEST.json" : "share-manifest.json");
    const value = { format: runtime ? "workbench.runtime/1" : "workbench.share-source/1", files };
    await put(path, JSON.stringify(value));
    return { path, value };
  };
  return { root, source, script, bin, nodeDir, env, driver, install, noShims, manifest };
}

for (const shell of shells) {
  test(`portable registration and launch preserve special paths (${basename(shell)})`, { skip: !windows }, async (t) => {
    const f = await fixture(t, true);
    passed(await f.install(shell));
    const shim = join(f.bin, commandName + ".ps1");
    assert.deepEqual((await readFile(shim)).subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
    const args = ["--help", "two words", "O'Brien", "[literal]", "a&b", "(group)", "%WB_EXPAND_TRAP%", "!bang!", "caret^"];
    const direct = await f.driver(`& ${ps(shim)} ${args.map(ps).join(" ")}`, shell);
    passed(direct);
    const record = JSON.parse(direct.stdout.trim());
    assert.deepEqual(record.args, args);
    assert.equal(record.cli, join(f.source, "dist", "cli.js"));
    assert.equal(record.node, join(f.nodeDir, "node.exe"));
    assert.equal(record.home, f.env.WORKBENCH_HOME);
    // Discover the shim through PATH, including under inherited /v:on.
    // A literal ! in cmd command source is expanded by the caller itself.
    f.env.PATH = f.bin + ";" + f.env.PATH;
    const cmd = await run(join(system, "System32", "cmd.exe"),
      ["/d", "/v:on", "/s", "/c", `${commandName}.cmd --help "two words"`], f.env);
    passed(cmd);
    assert.deepEqual(JSON.parse(cmd.stdout.trim()).args, ["--help", "two words"]);
    assert.equal(JSON.parse(cmd.stdout.trim()).cli, record.cli);
    f.env.WB_FIXTURE_EXIT = "23";
    assert.equal((await f.driver(`& ${ps(shim)}\nexit $LASTEXITCODE`, shell)).code, 23);
    assert.equal((await run(join(system, "System32", "cmd.exe"),
      ["/d", "/v:off", "/s", "/c", commandName + ".cmd"], f.env)).code, 23);
    assert.equal(await readFile(join(f.root, "owner-home/config.json"), "utf8"), "owner configuration sentinel");
    assert.equal(await readFile(join(f.root, "owner-home/key.txt"), "utf8"), "local reference sentinel");
    assert.equal(existsSync(join(f.root, "fake-user/.local/bin")), false);
    assert.equal(existsSync(join(f.root, "fake-local/Workbench")), false);
    assert.equal(existsSync(join(f.root, "fake-local/WorkbenchJunior")), false);
  });

  test(`verified source and runtime manifests (${basename(shell)})`, { skip: !windows }, async (t) => {
    for (const runtime of [false, true]) {
      await t.test(runtime ? "runtime" : "source", async (t) => {
        const f = await fixture(t);
        await put(join(f.source, "notes/niño.txt"), "Unicode inventory entry");
        await f.manifest(runtime, ["scripts/share-install.ps1", "dist/cli.js", "notes/niño.txt"]);
        passed(await f.install(shell));
      });
    }
  });

  test(`Junior launcher home defaults only in its child process (${basename(shell)})`, { skip: !windows }, async (t) => {
    const f = await fixture(t);
    await put(join(f.source, "JUNIOR-PACKAGE.json"), '{"format":"workbench.junior/1"}');
    await f.manifest(true, ["scripts/share-install.ps1", "dist/cli.js", "JUNIOR-PACKAGE.json"]);
    passed(await f.install(shell));
    const result = await f.driver(`Remove-Item Env:\\WORKBENCH_HOME\n& ${ps(join(f.bin, commandName + ".ps1"))}`, shell);
    passed(result);
    assert.equal(JSON.parse(result.stdout.trim()).home, join(f.env.LOCALAPPDATA!, "WorkbenchJunior"));
    assert.equal(existsSync(join(f.root, "fake-local/WorkbenchJunior")), false);
  });
}

test("existing shims, executables and session/PATH commands are preserved", { skip: !windows }, async (t) => {
  for (const extension of ["", ".ps1", ".cmd", ".bat", ".exe", ".com"]) {
    await t.test(extension || "extensionless", async (t) => {
      const f = await fixture(t);
      const path = join(f.bin, commandName + extension);
      await put(path, "owner sentinel");
      failed(await f.install(), /Command already exists/);
      assert.equal(await readFile(path, "utf8"), "owner sentinel");
      assert.deepEqual(await readdir(f.bin), [commandName + extension]);
    });
  }
  await t.test("PATH", async (t) => {
    const f = await fixture(t);
    await put(join(f.nodeDir, commandName + ".cmd"), "@echo owner");
    failed(await f.install(), /already exists on PATH/);
    await f.noShims();
  });
  await t.test("session", async (t) => {
    const f = await fixture(t);
    failed(await f.install(powershell, "", `function ${commandName} { 'owner' }`), /already exists on PATH or in this session/);
    await f.noShims();
  });
  await t.test("custom PATHEXT", async (t) => {
    const f = await fixture(t);
    f.env.PATHEXT = ".EXE;.CMD;.CUSTOM";
    await put(join(f.bin, commandName + ".CUSTOM"), "owner sentinel");
    failed(await f.install(), /Command already exists/);
    await f.noShims();
    assert.equal(await readFile(join(f.bin, commandName + ".CUSTOM"), "utf8"), "owner sentinel");
  });
});

test("package, command, scripts, dist and manifest parents cannot traverse junctions", { skip: !windows }, async (t) => {
  for (const location of ["package", "bin", "scripts", "dist", "manifest-parent", "node"]) {
    await t.test(location, async (t) => {
      const f = await fixture(t);
      const outside = join(f.root, "other");
      await mkdir(outside);
      if (location === "package") {
        const alias = join(f.root, "package-link");
        await symlink(f.source, alias, "junction");
        failed(await f.driver(`& ${ps(join(alias, "scripts/share-install.ps1"))} -BinRoot ${ps(f.bin)} -CommandName ${commandName}`), /links or junctions/);
      } else if (location === "scripts" || location === "dist") {
        const name = location === "scripts" ? "share-install.ps1" : "cli.js";
        await copyFile(join(f.source, location, name), join(outside, name));
        // Both resolved recursive-delete targets are checked under the fixture.
        const target = resolve(f.source, location);
        assert.ok(target.startsWith(resolve(f.root) + sep));
        await rm(target, { recursive: true });
        await symlink(outside, target, "junction");
        failed(await f.install(), /links or junctions/);
      } else if (location === "bin") {
        await symlink(outside, f.bin, "junction");
        failed(await f.install(), /links or junctions/);
      } else if (location === "node") {
        await copyFile(process.execPath, join(outside, "node.exe"));
        await symlink(outside, join(f.source, "node"), "junction");
        failed(await f.install(), /links or junctions/);
      } else {
        await put(join(outside, "input.txt"), "fixture");
        await symlink(outside, join(f.source, "linked"), "junction");
        await f.manifest(true, ["scripts/share-install.ps1", "dist/cli.js", "linked/input.txt"]);
        failed(await f.install(), /links or junctions/);
      }
      await f.noShims();
      assert.equal(existsSync(join(outside, commandName + ".ps1")), false);
    });
  }
});

test("invalid or incomplete manifests fail before registration", { skip: !windows }, async (t) => {
  for (const problem of ["hash", "size", "empty", "duplicate", "traversal", "absolute", "stream", "omitted-cli", "omitted-installer", "source-hash", "unlisted"]) {
    await t.test(problem, async (t) => {
      const f = await fixture(t);
      const m = await f.manifest(problem !== "source-hash");
      if (problem === "hash" || problem === "source-hash") m.value.files[0].sha256 = "0".repeat(64);
      if (problem === "size") m.value.files[0].bytes++;
      if (problem === "empty") m.value.files = [];
      if (problem === "duplicate") m.value.files.push({ ...m.value.files[0], path: m.value.files[0].path.toUpperCase() });
      if (problem === "traversal") m.value.files[0].path = "../outside.txt";
      if (problem === "absolute") m.value.files[0].path = f.script;
      if (problem === "stream") m.value.files[0].path = "dist/cli.js:stream";
      if (problem === "omitted-cli") m.value.files = m.value.files.filter((v) => v.path !== "dist/cli.js");
      if (problem === "omitted-installer") m.value.files = m.value.files.filter((v) => v.path !== "scripts/share-install.ps1");
      if (problem === "unlisted") await put(join(f.source, "dist/unlisted.js"), "fixture");
      await put(m.path, JSON.stringify(m.value));
      failed(await f.install(), /manifest|integrity|unlisted/i);
      await f.noShims();
    });
  }
});

test("manifest verification precedes execution of the bundled Node", { skip: !windows }, async (t) => {
  const f = await fixture(t);
  // Invalid executable must never be attempted: the integrity error should win.
  await put(join(f.source, "node/node.exe"), "not an executable");
  const m = await f.manifest(true, ["scripts/share-install.ps1", "dist/cli.js", "node/node.exe"]);
  m.value.files[2].sha256 = "0".repeat(64);
  await put(m.path, JSON.stringify(m.value));
  failed(await f.install(), /integrity check failed/);
  await f.noShims();
});

test("failed second launcher creation removes our first and preserves a racing command", { skip: !windows }, async (t) => {
  for (const shell of shells) {
    await t.test(basename(shell), async (t) => {
      const f = await fixture(t);
      const lines = (await readFile(f.script, "utf8")).split("\n");
      const line = lines.findIndex((text) => text.includes("$wbStream = [IO.File]::Open($wbLauncher.Path")) + 1;
      assert.ok(line > 0);
      const before = `
$global:wbFixtureCreates = 0
$null = Set-PSBreakpoint -Script ${ps(f.script)} -Line ${line} -Action {
  $global:wbFixtureCreates++
  if ($global:wbFixtureCreates -eq 2) {
    [IO.File]::WriteAllText(${ps(join(f.bin, commandName + ".cmd"))}, 'racing owner')
  }
}`;
      failed(await f.install(shell, "", before), /already exists|exist/i);
      assert.equal(existsSync(join(f.bin, commandName + ".ps1")), false);
      assert.equal(await readFile(join(f.bin, commandName + ".cmd"), "utf8"), "racing owner");
    });
  }
});

test("partial write cleanup and rollback preserve later owner edits", { skip: !windows }, async (t) => {
  await t.test("short write then failure", async (t) => {
    const f = await fixture(t);
    const original = await readFile(f.script, "utf8");
    const write = "try { $wbStream.Write($wbLauncher.Bytes, 0, $wbLauncher.Bytes.Length) }";
    assert.equal(original.split(write).length - 1, 1);
    await put(f.script, original.replace(write,
      "try { $wbStream.Write($wbLauncher.Bytes, 0, 7); throw 'fixture short write' }"));
    failed(await f.install(), /fixture short write/);
    await f.noShims();
  });
  await t.test("owner changes first launcher before second fails", async (t) => {
    const f = await fixture(t);
    const line = (await readFile(f.script, "utf8")).split("\n")
      .findIndex((text) => text.includes("$wbStream = [IO.File]::Open($wbLauncher.Path")) + 1;
    assert.ok(line > 0);
    const before = `
$global:wbFixtureCreates = 0
$null = Set-PSBreakpoint -Script ${ps(f.script)} -Line ${line} -Action {
  $global:wbFixtureCreates++
  if ($global:wbFixtureCreates -eq 2) {
    [IO.File]::WriteAllText(${ps(join(f.bin, commandName + ".ps1"))}, 'owner replacement')
    [IO.File]::WriteAllText(${ps(join(f.bin, commandName + ".cmd"))}, 'racing owner')
  }
}`;
    failed(await f.install(powershell, "", before), /already exists|exist/i);
    assert.equal(await readFile(join(f.bin, commandName + ".ps1"), "utf8"), "owner replacement");
    assert.equal(await readFile(join(f.bin, commandName + ".cmd"), "utf8"), "racing owner");
  });
});

test("runtime identity requires a release manifest and accepts verified bundled Node", { skip: !windows }, async (t) => {
  for (const marker of ["JUNIOR-PACKAGE.json", "node/node.exe"]) {
    await t.test("missing manifest: " + marker, async (t) => {
      const f = await fixture(t);
      await put(join(f.source, marker), "fixture");
      failed(await f.install(), /manifest is missing/);
      await f.noShims();
    });
  }
  await t.test("bundled Node", async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.source, "node"));
    await copyFile(process.execPath, join(f.source, "node/node.exe"));
    await f.manifest(true, ["scripts/share-install.ps1", "dist/cli.js", "node/node.exe"]);
    passed(await f.install());
    const output = await f.driver(`& ${ps(join(f.bin, commandName + ".ps1"))}`);
    passed(output);
    assert.equal(JSON.parse(output.stdout.trim()).node, join(f.source, "node/node.exe"));
  });
});

// Replace only the User PATH API boundary in the disposable copy. The tested
// registration, comparison, serialization and rollback code remains intact.
async function fakeUserPath(f: Awaited<ReturnType<typeof fixture>>, initial: string | null, failWrite = false, changeOnRead = false) {
  const original = await readFile(f.script, "utf8");
  const registry = "[Microsoft.Win32.Registry]::CurrentUser";
  assert.equal(original.split(registry).length - 1, 2);
  await put(f.script, original.replaceAll(registry, "$global:wbFixtureRegistry"));
  return `
$global:wbFixturePath = ${initial === null ? "$null" : ps(initial)}
$global:wbFixtureReads = 0
$global:wbFixtureRegistry = New-Object PSObject
$global:wbFixtureRegistry | Add-Member ScriptMethod OpenSubKey { param($Name)
  if ($Name -ne 'Environment') { throw 'unexpected registry key' }
  return $this
}
$global:wbFixtureRegistry | Add-Member ScriptMethod CreateSubKey { param($Name)
  if ($Name -ne 'Environment') { throw 'unexpected registry key' }
  return $this
}
$global:wbFixtureRegistry | Add-Member ScriptMethod Dispose {}
$global:wbFixtureRegistry | Add-Member ScriptMethod GetValue { param($Name, $Default, $Options)
  if ($Name -ne 'Path' -or $Options -ne [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) { throw 'unsafe PATH read' }
  $global:wbFixtureReads++
  if (${changeOnRead ? "$true" : "$false"} -and $global:wbFixtureReads -eq 2) { return 'concurrent PATH' }
  return $global:wbFixturePath
}
$global:wbFixtureRegistry | Add-Member ScriptMethod GetValueKind { param($Name)
  return [Microsoft.Win32.RegistryValueKind]::ExpandString
}
$global:wbFixtureRegistry | Add-Member ScriptMethod SetValue { param($Name, $Value, $Kind)
  if ($Name -ne 'Path' -or $Kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) { throw 'unsafe PATH write' }
  if (${failWrite ? "$true" : "$false"}) { throw 'fixture PATH write denied' }
  [IO.File]::WriteAllText(${ps(join(f.root, "path-write.txt"))}, $Value)
}`;
}

for (const shell of shells) {
  test(`AddToPath handles null, duplicates, unsafe paths and failure (${basename(shell)})`, { skip: !windows }, async (t) => {
    for (const state of ["null", "empty", "append", "raw", "duplicate", "denied", "changed", "percent", "semicolon"]) {
      await t.test(state, async (t) => {
        const f = await fixture(t, state === "percent");
        const initial = state === "null" ? null : state === "empty" ? "" :
          state === "raw" ? "%USERPROFILE%\\tools" :
          state === "duplicate" ? `C:\\other;"${f.bin.toUpperCase()}\\\\";` : "C:\\other;";
        const before = await fakeUserPath(f, initial, state === "denied", state === "changed");
        let result: Result;
        if (state === "semicolon") {
          const unsafe = join(f.root, "semi;colon");
          result = await f.driver(`${before}\n& ${ps(f.script)} -BinRoot ${ps(unsafe)} -CommandName ${commandName} -AddToPath`, shell);
          assert.equal(existsSync(unsafe), false);
        } else result = await f.install(shell, "-AddToPath", before);
        const written = join(f.root, "path-write.txt");
        if (["denied", "changed", "percent", "semicolon"].includes(state)) {
          failed(result, /PATH/);
          assert.equal(existsSync(written), false);
          await f.noShims();
        } else {
          passed(result);
          if (state === "duplicate") assert.equal(existsSync(written), false);
          else assert.equal(await readFile(written, "utf8"), (initial || "") + (state === "raw" ? ";" : "") + f.bin);
        }
      });
    }
  });
}

test("ambiguous destinations, device names and absent builds fail without registration", { skip: !windows }, async (t) => {
  for (const bin of ["C:relative", "\\relative", "C:\\", "relative"]) {
    const f = await fixture(t);
    failed(await f.driver(`& ${ps(f.script)} -BinRoot ${ps(bin)} -CommandName ${commandName}`), /directory/);
    await f.noShims();
  }
  const f = await fixture(t);
  failed(await f.driver(`& ${ps(f.script)} -BinRoot ${ps(f.bin)} -CommandName CON`), /device name/);
  await rm(join(f.source, "dist/cli.js"));
  failed(await f.install(), /Build this source package first/);
  await f.noShims();
});
