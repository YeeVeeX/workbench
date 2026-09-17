import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { checkCandidate, createCandidate, type Candidate } from "../src/verification.js";
import { removeFixture } from "./fixtures.js";

const execute = promisify(execFile);
const native = (value: string): string => path.toNamespacedPath(value);

async function put(root: string, name: string, content: string | Buffer): Promise<void> {
  const target = path.join(root, ...name.split("/"));
  await fs.mkdir(native(path.dirname(target)), { recursive: true });
  await fs.writeFile(native(target), content);
}

async function git(root: string, ...args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  const result = await execute("git", ["-c", "core.longpaths=true", ...args], {
    cwd: native(root), env, encoding: "utf8", windowsHide: true,
  });
  return result.stdout;
}

async function fixture(t: TestContext, isGit = false, long = false): Promise<{ base: string; root: string; state: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-verification-test-"));
  const canonicalBase = await fs.realpath(base);
  t.after(async () => {
    assert.equal(await fs.realpath(base), canonicalBase);
    assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
    assert.ok(path.basename(base).startsWith("workbench-verification-test-"));
    await removeFixture(base, path.resolve(base));
  });
  const suffix = long
    ? Array.from({ length: 5 }, (_, index) => `${index} long directory 雪 ${"x".repeat(45)}`)
    : [];
  const root = path.join(base, "source ñ 雪", ...suffix);
  const state = path.join(base, "state with spaces", ...suffix);
  await fs.mkdir(native(root), { recursive: true });
  if (isGit) await git(root, "init", "--quiet");
  return { base, root, state };
}

const capture = (root: string, state: string, sourceScope?: string[]): Promise<Candidate> =>
  createCandidate(root, state, "run-1", "task-1", sourceScope === undefined ? undefined : { sourceScope });

async function manifest(candidate: Candidate): Promise<any> {
  return JSON.parse(await fs.readFile(native(candidate.manifestPath), "utf8"));
}

test("copies independent binary/UTF-8/empty regular files and binds the manifest to fixed roots", async (t) => {
  const { root, state } = await fixture(t);
  const bytes = Buffer.from([0, 255, 128, 10, 13, 0, 42]);
  await put(root, "nested space/雪 ñ.bin", bytes);
  await put(root, "empty.txt", "");
  await put(root, "readme.txt", "Hola 雪\n");
  const candidate = await capture(root, state);
  assert.deepEqual(candidate.files.map((file) => file.path), ["empty.txt", "nested space/雪 ñ.bin", "readme.txt"]);
  assert.equal(candidate.root, path.join(state, "runs", "run-1", "candidates", candidate.id, "root"));
  assert.equal(candidate.sourceRoot, root);
  assert.deepEqual(candidate.sourceScope, []);
  assert.deepEqual(await fs.readFile(native(path.join(candidate.root, "nested space/雪 ñ.bin"))), bytes);
  const identity = candidate.files.find((file) => file.path.endsWith(".bin"))!;
  assert.equal(identity.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(identity.bytes, bytes.length);
  const original = await fs.stat(native(path.join(root, "readme.txt")), { bigint: true });
  const copied = await fs.stat(native(path.join(candidate.root, "readme.txt")), { bigint: true });
  assert.notEqual(`${original.dev}:${original.ino}`, `${copied.dev}:${copied.ino}`, "copy must not be a hardlink");
  assert.equal(Number(copied.mode) & 0o222, 0);
  const saved = await manifest(candidate);
  assert.equal(saved.sourceRoot, root);
  assert.equal(saved.stateDir, state);
  assert.equal(saved.taskId, "task-1");
  assert.equal(saved.digest, candidate.digest);
  assert.deepEqual(saved.files, candidate.files);
  assert.deepEqual(saved.sourceScope, []);
  assert.equal(saved.scope.kind, "filesystem");
  assert.deepEqual(await checkCandidate(candidate), { ok: true, changed: [] });
});

test("full rewrites with the same byte count and restored mtime invalidate the original", async (t) => {
  const { root, state } = await fixture(t);
  await put(root, "input.txt", "aaaaaaaa");
  const candidate = await capture(root, state);
  const before = await fs.stat(path.join(root, "input.txt"));
  await put(root, "input.txt", "bbbbbbbb");
  await fs.utimes(path.join(root, "input.txt"), before.atime, before.mtime);
  assert.deepEqual(await checkCandidate(candidate), { ok: false, changed: ["source:input.txt"] });
  assert.equal(await fs.readFile(path.join(candidate.root, "input.txt"), "utf8"), "aaaaaaaa");
});

test("original additions and removals are detected, including generated supervisor names in scope", async (t) => {
  const { root, state } = await fixture(t);
  await put(root, "remove.txt", "old");
  await put(root, "stay.txt", "still");
  const candidate = await capture(root, state);
  await fs.unlink(path.join(root, "remove.txt"));
  await put(root, "added.ts", "new source");
  await put(root, ".kilo/sessions/heartbeat.json", "generated but selected");
  assert.deepEqual(await checkCandidate(candidate), {
    ok: false, changed: ["source:.kilo/sessions/heartbeat.json", "source:added.ts", "source:remove.txt"],
  });
});

test("every snapshot path is checked even if its new name would be excluded from source traversal", async (t) => {
  const { root, state } = await fixture(t);
  await put(root, "change.txt", "before");
  await put(root, "remove.txt", "before");
  const candidate = await capture(root, state);
  await fs.chmod(candidate.root, 0o700);
  await fs.chmod(path.join(candidate.root, "change.txt"), 0o600);
  await fs.chmod(path.join(candidate.root, "remove.txt"), 0o600);
  await put(candidate.root, "change.txt", "after!");
  await fs.unlink(path.join(candidate.root, "remove.txt"));
  await put(candidate.root, ".workbench/generated.txt", "injected");
  assert.deepEqual(await checkCandidate(candidate), {
    ok: false, changed: ["snapshot:.workbench/generated.txt", "snapshot:change.txt", "snapshot:remove.txt"],
  });
});

test("non-Git exclusions are explicit and do not hide similarly named ordinary directories", async (t) => {
  const { root, state } = await fixture(t);
  const excluded = [".workbench", "node_modules", ".venv", "venv", "__pycache__"];
  for (const directory of excluded) await put(root, `${directory}/ignored.txt`, "excluded");
  await put(root, "nested/.git/HEAD", "administrative");
  await put(root, "node_modules-source/keep.txt", "selected");
  const candidate = await capture(root, state);
  assert.deepEqual(candidate.files.map((file) => file.path), ["node_modules-source/keep.txt"]);
  assert.deepEqual((await manifest(candidate)).scope.excludedNames, [".git", ...excluded]);
  await put(root, "node_modules/new.txt", "excluded later");
  assert.equal((await checkCandidate(candidate)).ok, true);
});

test("Git preserves tracked generated names, includes nonignored untracked files, and excludes ignored untracked files", async (t) => {
  const { root, state } = await fixture(t, true);
  await put(root, ".gitignore", "dist/\nnode_modules/\n.venv/\n.workbench/\nignored.txt\n");
  const tracked = [
    ".workbench/owned.ts", ".venv/owned.py", "dist/owned.js", "node_modules/owned.js",
    ".kilo/sessions/tracked.json", "state/contract.txt", "fuente 雪/ñ.txt",
  ];
  for (const name of tracked) await put(root, name, `tracked ${name}`);
  await git(root, "add", "--force", "--", ".gitignore", ...tracked);
  await put(root, "dist/generated.js", "ignored");
  await put(root, "ignored.txt", "ignored");
  await put(root, "untracked source.ts", "selected");
  await put(root, ".kilo/sessions/untracked.json", "selected");
  const candidate = await capture(root, state);
  assert.deepEqual(candidate.files.map((file) => file.path).sort(), [
    ".gitignore", ...tracked, "untracked source.ts", ".kilo/sessions/untracked.json",
  ].sort());
  assert.equal((await manifest(candidate)).scope.kind, "git");
  assert.equal(candidate.files.some((file) => file.path.startsWith(".git/")), false);
  await put(root, "dist/more-generated.js", "still ignored");
  assert.equal((await checkCandidate(candidate)).ok, true);
  await put(root, "added source.ts", "now selected");
  assert.deepEqual((await checkCandidate(candidate)).changed, ["source:added source.ts"]);
});

test("Git discovery and listing scrub GIT_* inherited environment, including index and pathspec overrides", async (t) => {
  const { root, state, base } = await fixture(t, true);
  await put(root, "actual.txt", "selected");
  await git(root, "add", "--", "actual.txt");
  const other = path.join(base, "other repo");
  await fs.mkdir(other);
  await git(other, "init", "--quiet");
  await put(other, "wrong.txt", "not selected");
  await git(other, "add", "--", "wrong.txt");
  const injected: Record<string, string> = {
    GIT_DIR: path.join(other, ".git"), GIT_WORK_TREE: other,
    GIT_INDEX_FILE: path.join(other, ".git", "index"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.excludesFile", GIT_CONFIG_VALUE_0: "missing",
    GIT_LITERAL_PATHSPECS: "1", GIT_NOGLOB_PATHSPECS: "1",
    GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_PARAMETERS: "'invalid'",
  };
  const previous = new Map(Object.keys(injected).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, injected);
    const candidate = await capture(root, state, ["actual.txt"]);
    assert.deepEqual(candidate.files.map((file) => file.path), ["actual.txt"]);
    assert.equal((await checkCandidate(candidate)).ok, true);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

for (const isGit of [false, true]) {
  test(`${isGit ? "Git" : "non-Git"} stateDir inside source excludes only that output tree and avoids self-capture`, async (t) => {
    const { root } = await fixture(t, isGit);
    const state = path.join(root, "review output 雪");
    await put(root, "source.ts", "source");
    await put(root, "review output 雪/old-run/generated.txt", "state output");
    await put(root, "review output 雪-sibling/keep.txt", "source");
    if (isGit) await git(root, "add", "--", ".");
    const first = await capture(root, state);
    assert.deepEqual(first.files.map((file) => file.path), ["review output 雪-sibling/keep.txt", "source.ts"]);
    assert.ok((await manifest(first)).scope.excludedAbsolutePaths.includes(state));
    await put(state, "supervisor/progress.json", "new output");
    const second = await capture(root, state);
    assert.notEqual(first.id, second.id);
    assert.deepEqual(second.files, first.files);
    assert.equal(second.digest, first.digest, "unchanged review retries must have a stable input digest");
    assert.equal((await checkCandidate(first)).ok, true);
    assert.equal((await checkCandidate(second)).ok, true);
  });

  test(`${isGit ? "Git" : "non-Git"} scoped workers can capture and verify while a disjoint sibling writes`, async (t) => {
    const { root, state } = await fixture(t, isGit);
    await put(root, "worker/input.ts", "selected");
    await put(root, "sibling/input.ts", "unrelated");
    if (isGit) await git(root, "add", "--", ".");
    let stopping = false;
    let revisions = 0;
    const sibling = (async () => {
      while (!stopping) {
        await put(root, "sibling/input.ts", `revision ${revisions++}`);
        await delay(3);
      }
    })();
    let candidate: Candidate;
    try {
      candidate = await capture(root, state, ["worker/input.ts", "worker"]);
      assert.deepEqual(candidate.sourceScope, ["worker"]);
      assert.deepEqual(candidate.files.map((file) => file.path), ["worker/input.ts"]);
      assert.deepEqual((await manifest(candidate)).sourceScope, ["worker"]);
      assert.deepEqual(await checkCandidate(candidate), { ok: true, changed: [] });
    } finally {
      stopping = true;
      await sibling;
    }
    assert.ok(revisions > 1);
    await put(root, "sibling/added.ts", "unrelated addition");
    assert.equal((await checkCandidate(candidate)).ok, true);
    await put(root, "worker/input.ts", "changed selected source");
    assert.deepEqual((await checkCandidate(candidate)).changed, ["source:worker/input.ts"]);
    await put(root, "worker/input.ts", "selected");
    await put(root, "worker/added.ts", "selected addition");
    assert.deepEqual((await checkCandidate(candidate)).changed, ["source:worker/added.ts"]);
    await fs.chmod(candidate.root, 0o700);
    await put(candidate.root, "sibling/injected.ts", "snapshot additions always count");
    assert.ok((await checkCandidate(candidate)).changed.includes("snapshot:sibling/injected.ts"));
  });
}

test("an explicitly empty scope captures the whole project for integrated review", async (t) => {
  const { root, state } = await fixture(t);
  await put(root, "worker/input.ts", "worker");
  await put(root, "sibling/input.ts", "sibling");
  const candidate = await capture(root, state, []);
  assert.equal(candidate.files.length, 2);
  await put(root, "sibling/input.ts", "sibling changed");
  assert.deepEqual((await checkCandidate(candidate)).changed, ["source:sibling/input.ts"]);
});

test("scope and run paths reject traversal and missing assignments", async (t) => {
  const { root, state } = await fixture(t);
  await put(root, "safe.txt", "safe");
  for (const scope of ["../outside", "folder/../../outside", "/absolute", "C:\\outside", "src/*", ".", ""]) {
    await assert.rejects(capture(root, state, [scope]), /sourceScope|path component/i);
  }
  await assert.rejects(capture(root, state, ["missing"]), /does not exist/i);
  await assert.rejects(createCandidate(root, state, "../run", "task"), /path component/i);
  await assert.rejects(capture(root, root), /stateDir contains sourceRoot/);
});

test("concrete scope paths with brackets, spaces, and non-ASCII characters use literal Git pathspecs", async (t) => {
  const { root, state } = await fixture(t, true);
  await put(root, "[worker] 雪/file ñ.ts", "selected");
  await put(root, "w 雪/file ñ.ts", "outside");
  const candidate = await capture(root, state, ["[worker] 雪/"]);
  assert.deepEqual(candidate.files.map((file) => file.path), ["[worker] 雪/file ñ.ts"]);
  assert.equal((await checkCandidate(candidate)).ok, true);
});

test("Git subdirectory sources cannot capture their parent project", async (t) => {
  const { root, state } = await fixture(t, true);
  await put(root, "outside.txt", "outside");
  await put(root, "nested project/inside.txt", "inside");
  await git(root, "add", "--", ".");
  const candidate = await capture(path.join(root, "nested project"), state);
  assert.deepEqual(candidate.files.map((file) => file.path), ["inside.txt"]);
  assert.equal((await checkCandidate(candidate)).ok, true);
});

for (const ignoreCase of [false, true]) {
  test(`Git supports long source subdirectories and filenames with core.ignorecase=${ignoreCase}`, async (t) => {
    const { root, state } = await fixture(t, true);
    const directories = Array.from({ length: 5 }, (_, index) => `${index} long directory 雪 ${"x".repeat(45)}`);
    const name = [...directories, "nested space/源 ñ.txt"].join("/");
    await put(root, name, "long-path bytes 雪");
    await put(root, "outside.txt", "must not enter the candidate");
    if (process.platform !== "win32") {
      const differentlyCased = name.replace("0 long directory", "0 LONG directory");
      await put(root, differentlyCased, "a distinct case-sensitive source");
    }
    await git(root, "add", "--", ".");
    await git(root, "config", "core.ignorecase", String(ignoreCase));
    const longRoot = path.join(root, ...directories);
    const longState = path.join(state, ...directories);
    assert.ok(longRoot.length > 260);
    const candidate = await capture(longRoot, longState);
    assert.equal((await git(root, "config", "core.ignorecase")).trim(), String(ignoreCase));
    assert.deepEqual(candidate.files.map((file) => file.path), ["nested space/源 ñ.txt"]);
    assert.equal(await fs.readFile(native(path.join(candidate.root, "nested space/源 ñ.txt")), "utf8"), "long-path bytes 雪");
    assert.equal((await checkCandidate(candidate)).ok, true);
  });
}

test("non-Git capture supports long source and state roots", async (t) => {
  const { root, state } = await fixture(t, false, true);
  await put(root, "源 ñ.txt", "long-path source");
  const candidate = await capture(root, state);
  assert.equal(await fs.readFile(native(path.join(candidate.root, "源 ñ.txt")), "utf8"), "long-path source");
  assert.equal((await checkCandidate(candidate)).ok, true);
});

test("a long Git worktree root uses a temporary query bridge without changing original identities", async (t) => {
  const { root, state, base } = await fixture(t, true);
  await put(root, "src/源 ñ.txt", "long-root source");
  await git(root, "add", "--", ".");
  const longRoot = path.join(base, ...Array.from({ length: 5 }, (_, index) => `${index} long worktree ${"x".repeat(45)}`));
  for (const target of [root, longRoot]) {
    const relative = path.relative(path.resolve(base), path.resolve(target));
    assert.ok(relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`),
      "directory move must remain inside its resolved fixture");
  }
  await fs.mkdir(native(path.dirname(longRoot)), { recursive: true });
  await fs.rename(native(root), native(longRoot));
  assert.ok(longRoot.length > 260);
  const candidate = await capture(longRoot, state);
  assert.equal(candidate.sourceRoot, longRoot);
  const saved = await manifest(candidate);
  assert.equal(saved.scope.gitRoot, longRoot);
  assert.ok(saved.scope.excludedAbsolutePaths.includes(path.join(longRoot, ".git")));
  assert.equal(JSON.stringify(saved).includes("workbench-git-"), false);
  assert.deepEqual(candidate.files.map((file) => file.path), ["src/源 ñ.txt"]);
  assert.deepEqual(await checkCandidate(candidate), { ok: true, changed: [] });
  await put(longRoot, "src/源 ñ.txt", "changed");
  assert.deepEqual((await checkCandidate(candidate)).changed, ["source:src/源 ñ.txt"]);
  if (process.platform === "win32") {
    const previousPath = process.env.PATH;
    try {
      const system = process.env.SystemRoot || "C:\\Windows";
      process.env.PATH = [base, path.join(system, "System32"), path.join(system, "System32", "WindowsPowerShell", "v1.0")].join(";");
      await assert.rejects(capture(longRoot, path.join(base, "git-unavailable-state")), /spawn git ENOENT/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    assert.deepEqual((await checkCandidate(candidate)).changed, ["source:src/源 ñ.txt"]);
    const configPath = native(path.join(longRoot, ".git", "config"));
    const ordinaryConfig = await fs.readFile(configPath, "utf8");
    assert.match(ordinaryConfig, /bare\s*=\s*false/);
    try {
      await fs.writeFile(configPath, ordinaryConfig.replace(/bare\s*=\s*false/, "bare = true"));
      await assert.rejects(capture(longRoot, path.join(base, "bare-long-state")), /git failed|working.tree|work tree/i);
    } finally { await fs.writeFile(configPath, ordinaryConfig); }
    assert.deepEqual((await checkCandidate(candidate)).changed, ["source:src/源 ñ.txt"]);
  }
});

test("relocated Git administrative metadata is excluded even inside the source tree", async (t) => {
  const { root, state } = await fixture(t);
  const administration = path.join(root, "repo administration 雪");
  await git(root, "init", "--quiet", "--separate-git-dir", administration);
  await put(root, "source.txt", "selected");
  await put(administration, "auth.json", "private administrative fixture");
  await put(administration, "tracked-internal.txt", "internal");
  await git(root, "add", "--force", "--", "source.txt", "repo administration 雪/tracked-internal.txt");
  const candidate = await capture(root, state);
  assert.deepEqual(candidate.files.map((file) => file.path), ["source.txt"]);
  assert.ok((await manifest(candidate)).scope.excludedAbsolutePaths.includes(administration));
  await put(administration, "new-internal.txt", "new metadata");
  assert.equal((await checkCandidate(candidate)).ok, true);
});

test("Git worktree gitfiles and common administrative directories stay outside reviewer context", async (t) => {
  const { root, state, base } = await fixture(t, true);
  await put(root, "source.txt", "selected");
  await git(root, "add", "--", ".");
  await git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
  const worktree = path.join(base, "linked worktree 雪");
  await git(root, "worktree", "add", "--quiet", "--detach", worktree);
  const candidate = await capture(worktree, state);
  assert.deepEqual(candidate.files.map((file) => file.path), ["source.txt"]);
  const saved = await manifest(candidate);
  assert.ok(saved.scope.excludedAbsolutePaths.includes(path.join(worktree, ".git")));
  assert.ok(saved.scope.excludedAbsolutePaths.includes(path.join(root, ".git")));
  assert.equal((await checkCandidate(candidate)).ok, true);
});

test("Git metadata reached through an administrative junction is excluded at its actual location", async (t) => {
  const { root, state } = await fixture(t);
  const administration = path.join(root, "actual repository data");
  await git(root, "init", "--quiet", "--separate-git-dir", administration);
  await fs.unlink(path.join(root, ".git"));
  await fs.symlink(administration, path.join(root, ".git"), process.platform === "win32" ? "junction" : "dir");
  await put(root, "source.txt", "selected");
  await put(administration, "auth.json", "private metadata");
  await git(root, "add", "--", "source.txt");
  const candidate = await capture(root, state);
  assert.deepEqual(candidate.files.map((file) => file.path), ["source.txt"]);
  assert.ok((await manifest(candidate)).scope.excludedAbsolutePaths.includes(administration));
  assert.equal((await checkCandidate(candidate)).ok, true);
});

test("two candidates in the same run can be captured and verified concurrently with disjoint scopes", async (t) => {
  const { root, state } = await fixture(t, true);
  await put(root, "first/input.ts", "first");
  await put(root, "second/input.ts", "second");
  const [first, second] = await Promise.all([
    capture(root, state, ["first"]), capture(root, state, ["second"]),
  ]);
  assert.notEqual(first.id, second.id);
  await put(root, "second/input.ts", "second changed");
  const [firstCheck, secondCheck] = await Promise.all([checkCandidate(first), checkCandidate(second)]);
  assert.deepEqual(firstCheck, { ok: true, changed: [] });
  assert.deepEqual(secondCheck, { ok: false, changed: ["source:second/input.ts"] });
});

test("explicitly scoped excluded directories and empty-directory replacement are visible failures", async (t) => {
  const { root, state, base } = await fixture(t);
  await put(root, ".workbench/internal.txt", "excluded");
  await assert.rejects(capture(root, state, [".workbench"]), /excluded by the source selection rules/);
  await fs.mkdir(path.join(root, "empty"));
  const candidate = await capture(root, state, ["empty"]);
  assert.deepEqual(candidate.files, []);
  await fs.rmdir(path.join(root, "empty"));
  await fs.mkdir(path.join(base, "outside"));
  await fs.symlink(path.join(base, "outside"), path.join(root, "empty"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await checkCandidate(candidate)).ok, false);
});

test("stateDir cannot traverse a preexisting junction or symlink", async (t) => {
  const { root, base } = await fixture(t);
  await put(root, "source.txt", "source");
  const destination = path.join(base, "outside");
  await fs.mkdir(destination);
  const alias = path.join(base, "state link");
  await fs.symlink(destination, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(capture(root, path.join(alias, "state")), /Symlink|reparse/);
  assert.deepEqual(await fs.readdir(destination), []);
});

test("relative caller paths are fixed before later working-directory changes", async (t) => {
  const { root, state, base } = await fixture(t);
  await put(root, "source.txt", "source");
  const originalCwd = process.cwd();
  try {
    process.chdir(base);
    const candidate = await capture(path.relative(base, root), path.relative(base, state));
    process.chdir(originalCwd);
    assert.equal(candidate.sourceRoot, root);
    assert.deepEqual(await checkCandidate(candidate), { ok: true, changed: [] });
  } finally {
    process.chdir(originalCwd);
  }
});

for (const secret of [".env", ".env.local", "auth.json", ".aws/credentials", "keys/server.key", "service-account.json"]) {
  test(`selected sensitive input ${secret} fails before any reviewer copy is created`, async (t) => {
    const { root, state } = await fixture(t);
    await put(root, "a-safe.txt", "allowed");
    await put(root, secret, "private fixture");
    await assert.rejects(capture(root, state), /Sensitive input.*narrower sourceRoot/);
    await assert.rejects(fs.stat(state), { code: "ENOENT" });
  });
}

test("ignored untracked secrets stay outside Git selection; tracked secrets fail explicitly", async (t) => {
  const { root, state } = await fixture(t, true);
  await put(root, ".gitignore", ".env\nauth.json\n");
  await put(root, ".env", "fixture secret");
  await put(root, "auth.json", "fixture secret");
  await put(root, "safe.txt", "safe");
  const candidate = await capture(root, state);
  assert.deepEqual(candidate.files.map((file) => file.path), [".gitignore", "safe.txt"]);
  await git(root, "add", "--force", "--", ".env");
  await assert.rejects(capture(root, state), /Sensitive input.*Tracked inputs must also leave the index/);
  assert.deepEqual((await checkCandidate(candidate)).changed, ["source:.env"]);
});

test("scoped source excludes unrelated credentials instead of silently omitting selected credentials", async (t) => {
  const { root, state } = await fixture(t);
  await put(root, "worker/safe.txt", "safe");
  await put(root, ".env", "outside explicit scope");
  const candidate = await capture(root, state, ["worker"]);
  assert.deepEqual(candidate.files.map((file) => file.path), ["worker/safe.txt"]);
  await put(root, "worker/auth.json", "new selected secret");
  assert.deepEqual((await checkCandidate(candidate)).changed, ["source:worker/auth.json"]);
});

test("narrowing sourceRoot to a credential directory cannot bypass secret-path protection", async (t) => {
  const { root, state } = await fixture(t);
  for (const directory of [".aws", "credentials"]) {
    await put(root, `${directory}/config`, "private credential fixture");
    await assert.rejects(capture(path.join(root, directory), state), /sourceRoot is inside a sensitive credential path/);
  }
  await assert.rejects(fs.stat(state), { code: "ENOENT" });
});

for (const isGit of [false, true]) {
  test(`${isGit ? "Git" : "non-Git"} selected directory junction/symlink and linked source ancestors fail`, async (t) => {
    const { root, state, base } = await fixture(t, isGit);
    const outside = path.join(base, "outside");
    await put(outside, "file.txt", "outside data");
    await fs.symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(capture(root, state), /Symlink|reparse|Unsupported selected path/);
    await assert.rejects(capture(root, state, ["linked/file.txt"]), /Symlink|reparse/);
    await assert.rejects(capture(path.join(root, "linked"), state), /Symlink|reparse/);
  });
}

test("file symlinks cannot enter source or replace a snapshot file", async (t) => {
  const { root, state, base } = await fixture(t);
  await put(root, "input.txt", "input");
  await put(base, "outside.txt", "outside");
  const candidate = await capture(root, state);
  try {
    await fs.symlink(path.join(base, "outside.txt"), path.join(root, "link.txt"), "file");
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Windows file-symlink privilege unavailable; directory junction tests still run.");
      return;
    }
    throw error;
  }
  await assert.rejects(capture(root, state), /Symlink|reparse/);
  assert.deepEqual((await checkCandidate(candidate)).changed, ["source:link.txt"]);
  await fs.unlink(path.join(root, "link.txt"));
  await fs.chmod(candidate.root, 0o700);
  await fs.chmod(path.join(candidate.root, "input.txt"), 0o600);
  await fs.unlink(path.join(candidate.root, "input.txt"));
  await fs.symlink(path.join(root, "input.txt"), path.join(candidate.root, "input.txt"), "file");
  assert.deepEqual((await checkCandidate(candidate)).changed, ["snapshot:input.txt"]);
});

test("a snapshot replaced by a hardlink to unchanged source is rejected", async (t) => {
  const { root, state } = await fixture(t);
  await put(root, "input.txt", "unchanged bytes");
  const candidate = await capture(root, state);
  const copy = path.join(candidate.root, "input.txt");
  await fs.chmod(candidate.root, 0o700);
  await fs.chmod(copy, 0o600);
  await fs.unlink(copy);
  await fs.link(path.join(root, "input.txt"), copy);
  assert.deepEqual(await checkCandidate(candidate), { ok: false, changed: ["snapshot:input.txt"] });
});

test("manifest or returned identity tampering fails closed", async (t) => {
  const { root, state } = await fixture(t);
  await put(root, "file.txt", "original");
  const candidate = await capture(root, state);
  for (const altered of [
    { ...candidate, sourceRoot: state }, { ...candidate, root },
    { ...candidate, sourceScope: ["file.txt"] }, { ...candidate, digest: "0".repeat(64) },
    { ...candidate, files: [{ path: "../outside", sha256: "0".repeat(64), bytes: 0 }] },
  ]) assert.deepEqual(await checkCandidate(altered), { ok: false, changed: ["manifest"] });
  await fs.chmod(candidate.manifestPath, 0o600);
  const saved = await manifest(candidate);
  saved.scope.excludedNames.push("file.txt");
  await fs.writeFile(candidate.manifestPath, JSON.stringify(saved));
  assert.deepEqual(await checkCandidate(candidate), { ok: false, changed: ["manifest"] });
});

test("Git subprocess failure never falls back to a non-Git copy or corrupts earlier candidates", async (t) => {
  const { root, state } = await fixture(t, true);
  await put(root, "file.txt", "original");
  await git(root, "add", "--", ".");
  const candidate = await capture(root, state);
  const manifestBefore = await fs.readFile(candidate.manifestPath);
  const index = path.join(root, ".git", "index");
  const indexBefore = await fs.readFile(index);
  await fs.writeFile(index, "not a Git index");
  await assert.rejects(capture(root, state), /git failed/);
  assert.equal((await checkCandidate(candidate)).ok, false);
  assert.deepEqual(await fs.readFile(candidate.manifestPath), manifestBefore);
  assert.equal(await fs.readFile(path.join(candidate.root, "file.txt"), "utf8"), "original");
  await fs.writeFile(index, indexBefore);
  assert.equal((await checkCandidate(candidate)).ok, true);
});

test("malformed Git metadata fails explicitly", async (t) => {
  const { root, state } = await fixture(t);
  await put(root, ".git", "gitdir: absent-repository\n");
  await put(root, "safe.txt", "safe");
  await assert.rejects(capture(root, state), /git failed/);
});

test("source rewrite and addition during copy reject the attempt while preserving prior candidates", async (t) => {
  const { root, state } = await fixture(t);
  await put(root, "a.txt", "initial");
  const prior = await capture(root, state);
  const priorManifest = await fs.readFile(prior.manifestPath);
  await put(root, "z-large.bin", Buffer.alloc(16 * 1024 * 1024, 42));
  const pending = capture(root, state);
  const observed = pending.then(() => ({ success: true as const }), (error: unknown) => ({ success: false as const, error }));
  const candidates = path.join(state, "runs", "run-1", "candidates");
  let changed = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const entries = await fs.readdir(candidates);
    for (const entry of entries.filter((name) => name.startsWith(".pending-"))) {
      try {
        await fs.stat(path.join(candidates, entry, "root", "z-large.bin"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      await put(root, "a.txt", "rewrite");
      await put(root, "added-during-copy.txt", "new input");
      changed = true;
      break;
    }
    if (changed) break;
    await delay(2);
  }
  const result = await observed;
  assert.ok(changed, "test must mutate source while the real snapshot copy exists");
  assert.equal(result.success, false);
  if (!result.success) assert.match(String(result.error), /changed during capture|changed while reading/);
  assert.deepEqual(await fs.readFile(prior.manifestPath), priorManifest);
  assert.equal(await fs.readFile(path.join(prior.root, "a.txt"), "utf8"), "initial");
  const published = (await fs.readdir(candidates)).filter((name) => !name.startsWith(".pending-"));
  assert.deepEqual(published, [prior.id]);
});
