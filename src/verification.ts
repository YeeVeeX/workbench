import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface Candidate {
  id: string;
  root: string;
  sourceRoot: string;
  manifestPath: string;
  digest: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  sourceScope?: string[];
}

type InputFile = Candidate["files"][number];
interface Scope {
  kind: "git" | "filesystem";
  selection: string;
  gitRoot: string | null;
  excludedAbsolutePaths: string[];
  excludedNames: string[];
  sensitivePaths: "reject-v1";
  links: "reject";
}
interface Manifest {
  version: 1;
  id: string;
  runId: string;
  taskId: string;
  root: string;
  sourceRoot: string;
  stateDir: string;
  sourceScope: string[];
  scope: Scope;
  files: InputFile[];
  digest: string;
}
interface Selection {
  scope: Scope;
  paths: string[];
}

const excludedNames = [".git", ".workbench", "node_modules", ".venv", "venv", "__pycache__"];
const credentialNames = new Set([
  ".aws", ".azure", ".ssh", ".gnupg", ".kube", ".credentials", "credentials",
  ".secrets", "secrets", ".netrc", "_netrc", ".npmrc", ".pypirc",
  ".git-credentials", ".s3cfg", ".boto", "auth.json", "kubeconfig",
]);

class ScopeError extends Error {
  constructor(message: string, readonly input?: string) {
    super(`Candidate scope error: ${message}`);
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compare);
}

function portable(value: string): string {
  return value.split(path.sep).join("/");
}

function plainPath(value: string): string {
  if (process.platform !== "win32") return value;
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  return value.replace(/^\\\\\?\\(?=[a-z]:\\)/i, "");
}

// Extended paths are used at the filesystem boundary, never handed to the broker.
function native(value: string): string {
  return path.parse(value).root === value ? value : path.toNamespacedPath(value);
}

function absolute(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new ScopeError("A nonempty filesystem path without NUL is required.");
  }
  const result = path.resolve(plainPath(value));
  if (process.platform === "win32") {
    const tail = result.slice(path.parse(result).root.length);
    for (const part of tail.split(path.sep)) validateComponent(part);
  }
  return result;
}

function validateComponent(value: string): void {
  if (!value || value === "." || value === ".." || /[<>:"/\\|?*\x00-\x1f]/.test(value)
    || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
    || /~\d(?:\.|$)/.test(value)) {
    throw new ScopeError(`Unsafe path component ${JSON.stringify(value)}. Use an ordinary directory name.`);
  }
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".."
    && !relative.startsWith(`..${path.sep}`));
}

function relativeFile(root: string, name: string): string {
  if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/")
    || name.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new ScopeError(`Unsupported selected path ${JSON.stringify(name)}. Use an ordinary relative file path.`, name);
  }
  if (process.platform === "win32") name.split("/").forEach(validateComponent);
  const result = path.resolve(root, ...name.split("/"));
  if (!within(root, result) || result === root) throw new ScopeError("A selected path escapes its source root.", name);
  return result;
}

function normalizeScope(value: string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ScopeError("sourceScope must be an array of concrete relative files or directories.");
  const names = value.map((entry) => {
    if (typeof entry !== "string") throw new ScopeError("sourceScope entries must be concrete relative paths.");
    const name = entry.replace(/\\/g, "/").replace(/\/$/, "");
    if (!name || name.startsWith("/") || /^[a-z]:/i.test(name) || /[\0*?]/.test(name)
      || name.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new ScopeError(`Invalid sourceScope entry ${JSON.stringify(entry)}. `
        + "Use concrete relative files or directories without traversal or wildcards; [] selects the whole project.");
    }
    if (process.platform === "win32") name.split("/").forEach(validateComponent);
    return name;
  });
  const unique = new Map(sorted(names).map((name) => [scopeKey(name), name]));
  const ordered = sorted(unique.values());
  return ordered.filter((name) => !ordered.some((parent) => parent !== name && scopeKey(name).startsWith(`${scopeKey(parent)}/`)));
}

function scopeKey(name: string): string {
  return process.platform === "win32" ? name.toLowerCase() : name;
}

function inScope(name: string, sourceScope: string[]): boolean {
  return sourceScope.length === 0 || sourceScope.some((entry) =>
    scopeKey(name) === scopeKey(entry) || scopeKey(name).startsWith(`${scopeKey(entry)}/`));
}

function intersectsScope(name: string, sourceScope: string[]): boolean {
  return inScope(name, sourceScope) || sourceScope.some((entry) => scopeKey(entry).startsWith(`${scopeKey(name)}/`));
}

function assertNotSensitive(name: string): void {
  for (const part of name.split("/")) {
    const lower = part.toLowerCase();
    if (credentialNames.has(lower) || /^\.env(?:\.|$)/.test(lower)
      || /^(?:auth|credentials?|secrets?|tokens?)\.(?:json|ya?ml|toml|ini|txt|conf|xml)$/.test(lower)
      || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(lower)
      || /(?:^|[-_.])(?:private[-_]?key|service[-_]?account|client[-_]?secret)(?:[-_.]|$)/.test(lower)
      || /\.(?:pem|key|p12|pfx|jks|keystore)$/.test(lower)) {
      throw new ScopeError(
        `Sensitive input ${JSON.stringify(name)} cannot enter reviewer context. `
        + "Choose a narrower sourceRoot or move credentials outside the selected source; "
        + "for an untracked Git input, add an ignore rule. Tracked inputs must also leave the index.",
        name,
      );
    }
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
}

async function command(
  executable: string, args: string[], cwd: string, input?: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: native(cwd), env: cleanEnvironment(), windowsHide: true, shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let processError: Error | undefined;
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const failed = (error: Error): void => { processError ??= error; };
    child.on("error", failed);
    child.stdin.on("error", failed);
    child.stdout.on("error", failed);
    child.stderr.on("error", failed);
    child.on("close", (code, signal) => {
      if (processError) {
        reject(processError);
      } else if (code !== 0) {
        reject(new ScopeError(
          `${executable} failed (${signal ?? code ?? "no exit status"}). `
          + Buffer.concat(stderr).toString("utf8").trim(),
        ));
      } else {
        resolve(Buffer.concat(stdout));
      }
    });
    child.stdin.end(input);
  });
}

function utf8(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new ScopeError("A filename or subprocess result is not valid UTF-8. Rename the input or repair the subprocess before retrying.");
  }
}

async function git(root: string, args: string[]): Promise<Buffer> {
  // Match scopeKey/within even when a repository inherits another platform's setting.
  const argv = ["-c", "core.longpaths=true", "-c", "core.quotepath=false",
    "-c", `core.ignorecase=${process.platform === "win32"}`, ...args];
  // Windows/libuv and Git versions report several different failures for an
  // overlong cwd, including ENOENT and misidentifying a valid work tree as bare.
  // Use the checked short bridge before launching instead of guessing from errors.
  if (process.platform === "win32" && root.length >= 260)
    return gitThroughJunction(root, argv, args[0] === "rev-parse");
  return command("git", argv, root);
}

async function gitThroughJunction(root: string, args: string[], pathResult: boolean): Promise<Buffer> {
  const temporaryParent = await canonicalDirectory(tmpdir());
  if (within(root, temporaryParent) || path.join(temporaryParent, "workbench-git-XXXXXX", "root").length >= 260) {
    throw new ScopeError("Git cannot start in this long working-tree root. "
      + "Use a shorter TEMP directory outside the working tree, or a shorter Git working-tree root.");
  }
  const temporary = plainPath(await fs.mkdtemp(native(path.join(temporaryParent, "workbench-git-"))));
  const directoryIdentity = await fs.lstat(native(temporary), { bigint: true });
  const alias = path.join(temporary, "root");
  let linkIdentity: BigIntStats | undefined;
  try {
    await fs.symlink(root, native(alias), "junction");
    linkIdentity = await fs.lstat(native(alias), { bigint: true });
    let queryArgs = args;
    const marker = path.join(alias, ".git");
    const markerStat = await fs.lstat(native(marker)).catch((error) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (markerStat?.isDirectory() && !markerStat.isSymbolicLink()) {
      const configArgs = ["-c", "core.longpaths=true", "--git-dir", marker, "config"];
      const bare = utf8(await command("git", [...configArgs, "--type=bool", "--default=false", "--get", "core.bare"], alias)).trim();
      const configuredWorktree = utf8(await command("git", [...configArgs, "--default=", "--get", "core.worktree"], alias)).trim();
      if (bare === "false" && !configuredWorktree) {
        // Git for Windows may discover the long physical directory behind the
        // junction and lose its work-tree association. Pin both short aliases
        // only for an ordinary non-bare repository with its default work tree.
        // Relative arguments keep Git from canonicalizing the junction back
        // to an overlong physical path before its long-path setting applies.
        queryArgs = ["--git-dir", ".git", "--work-tree", ".", ...args];
      }
    }
    const result = await command("git", queryArgs, alias);
    if (!pathResult) return result;
    const text = utf8(result);
    if (!text.endsWith("\n")) throw new ScopeError("Git returned an incomplete repository path.");
    const reported = absolute(path.resolve(alias, text.slice(0, -1)));
    // Resolve discovery paths before removing the temporary alias.
    const original = within(alias, reported) ? path.resolve(root, path.relative(alias, reported)) : reported;
    return Buffer.from(`${original}\n`, "utf8");
  } finally {
    const current = await fs.lstat(native(temporary), { bigint: true });
    if (path.dirname(temporary) !== temporaryParent || !current.isDirectory() || current.isSymbolicLink()
      || current.dev !== directoryIdentity.dev || current.ino !== directoryIdentity.ino) {
      throw new ScopeError("Temporary Git directory changed; retained it for inspection.");
    }
    if (linkIdentity) {
      const link = await fs.lstat(native(alias), { bigint: true });
      if (!link.isSymbolicLink() || link.dev !== linkIdentity.dev || link.ino !== linkIdentity.ino) {
        throw new ScopeError("Temporary Git junction changed; retained it for inspection.");
      }
      // Unlink the verified junction itself. Never recursively delete its target.
      await fs.unlink(native(alias));
    }
    await fs.rmdir(native(temporary));
  }
}

// Node exposes junctions/symlinks through lstat, but not all Windows reparse tags.
// Pass filenames over UTF-8 stdin, never interpolate them into PowerShell code.
async function assertNoReparse(paths: Iterable<string>): Promise<void> {
  if (process.platform !== "win32") return;
  const names = sorted(paths);
  if (names.length === 0) return;
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false, $true)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class WorkbenchFileAttributes {
  [DllImport("kernel32.dll", EntryPoint = "GetFileAttributesW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern uint Read(string path);
}
'@
  $paths = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
  $reparse = @()
  for ($i = 0; $i -lt $paths.Count; $i++) {
    $attributes = [WorkbenchFileAttributes]::Read($paths[$i])
    if ($attributes -eq [uint32]::MaxValue) {
      throw (New-Object ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error()))
    }
    if (($attributes -band 1024) -ne 0) { $reparse += $i }
  }
  [Console]::Out.Write((ConvertTo-Json -InputObject @($reparse) -Compress))
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`;
  const output = await command("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    path.parse(names[0]).root, JSON.stringify(names.map(native)));
  const indices: unknown = JSON.parse(utf8(output));
  if (!Array.isArray(indices) || indices.some((i) => !Number.isInteger(i) || i < 0 || i >= names.length)) {
    throw new ScopeError("Windows reparse-point inspection returned an invalid result.");
  }
  if (indices.length) {
    throw new ScopeError(`Symlink/reparse input ${JSON.stringify(names[indices[0]])} is unsupported. `
      + "Select a directory of independent regular files.");
  }
}

async function ancestors(target: string, allowMissing = false): Promise<string[]> {
  const found: string[] = [];
  let cursor = path.parse(target).root;
  const parts = target.slice(cursor.length).split(path.sep).filter(Boolean);
  for (const part of ["", ...parts]) {
    if (part) cursor = path.join(cursor, part);
    let stat: BigIntStats;
    try {
      stat = await fs.lstat(native(cursor), { bigint: true });
    } catch (error) {
      if (allowMissing && isMissing(error)) return found;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new ScopeError(`Symlink/reparse traversal at ${JSON.stringify(cursor)} is unsupported.`);
    if (!stat.isDirectory()) throw new ScopeError(`Expected a regular directory at ${JSON.stringify(cursor)}.`);
    found.push(cursor);
  }
  return found;
}

async function canonicalDirectory(value: string, allowMissing = false): Promise<string> {
  const target = absolute(value);
  const found = await ancestors(target, allowMissing);
  await assertNoReparse(found);
  const last = found[found.length - 1];
  const canonical = plainPath(await fs.realpath(native(last)));
  return path.resolve(canonical, path.relative(last, target));
}

async function ensureDirectory(target: string): Promise<void> {
  const found = await ancestors(target, true);
  await assertNoReparse(found);
  let cursor = found[found.length - 1];
  for (const part of path.relative(cursor, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      await fs.mkdir(native(cursor), { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await ancestors(cursor);
      await assertNoReparse([cursor]);
    }
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(native(target));
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function gitMarker(sourceRoot: string): Promise<string | undefined> {
  let cursor = sourceRoot;
  for (;;) {
    const marker = path.join(cursor, ".git");
    if (await exists(marker)) return marker;
    // A bare repository is administrative data, not a non-Git source tree.
    if (await exists(path.join(cursor, "HEAD")) && await exists(path.join(cursor, "objects"))
      && await exists(path.join(cursor, "refs"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

async function discoverScope(sourceRoot: string, stateDir: string): Promise<Scope> {
  const marker = await gitMarker(sourceRoot);
  const base = {
    sensitivePaths: "reject-v1" as const, links: "reject" as const,
  };
  if (!marker) {
    return {
      ...base, kind: "filesystem", gitRoot: null, selection: "recursive regular files",
      excludedAbsolutePaths: [stateDir], excludedNames: [...excludedNames],
    };
  }
  const probeRoot = path.basename(marker).toLowerCase() === ".git" ? path.dirname(marker) : marker;
  async function gitPath(option: string): Promise<string> {
    const result = utf8(await git(probeRoot, ["rev-parse", option]));
    if (!result.endsWith("\n")) throw new ScopeError("Git returned an incomplete repository path.");
    return plainPath(await fs.realpath(native(absolute(path.resolve(probeRoot, result.slice(0, -1))))));
  }
  const results = await Promise.allSettled([
    gitPath("--show-toplevel"), gitPath("--absolute-git-dir"), gitPath("--git-common-dir"),
  ]);
  // A failed discovery must not leave another Git process holding the source cwd.
  const values = results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
  const [gitRoot, gitDir, commonDir] = values;
  const markerTarget = plainPath(await fs.realpath(native(marker)));
  const metadata = sorted([marker, markerTarget, gitDir, commonDir]);
  if (!within(gitRoot, sourceRoot) || metadata.some((directory) => within(directory, sourceRoot))) {
    throw new ScopeError("Select a Git working-tree directory, outside Git administrative metadata.");
  }
  return {
    ...base, kind: "git", gitRoot,
    selection: "git ls-files --cached --others --exclude-standard --full-name -z -- .",
    excludedAbsolutePaths: sorted([stateDir, ...metadata]), excludedNames: [],
  };
}

function excluded(scope: Scope, target: string): boolean {
  return scope.excludedAbsolutePaths.some((directory) => within(directory, target));
}

async function inspectFile(root: string, name: string, inspected?: Set<string>): Promise<BigIntStats> {
  const target = relativeFile(root, name);
  const rootStat = await fs.lstat(native(root));
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new ScopeError(`Source root is no longer an independent directory: ${JSON.stringify(root)}.`, name);
  }
  let cursor = root;
  const parts = name.split("/");
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]);
    let stat: BigIntStats;
    try {
      stat = await fs.lstat(native(cursor), { bigint: true });
    } catch (error) {
      throw new ScopeError(`Cannot read selected input ${JSON.stringify(name)}. `
        + "Restore it or remove it from the Git index, then retry. "
        + ((error as NodeJS.ErrnoException).code ?? "Filesystem error"), name);
    }
    if (stat.isSymbolicLink()) throw new ScopeError(`Symlink/reparse input ${JSON.stringify(name)} is unsupported. `
      + "Replace it with a regular file or choose a narrower sourceRoot.", name);
    inspected?.add(cursor);
    if (index < parts.length - 1) {
      if (!stat.isDirectory()) throw new ScopeError(`Input ancestor is not a directory: ${JSON.stringify(name)}.`, name);
    } else {
      if (!stat.isFile()) throw new ScopeError(`Selected input ${JSON.stringify(name)} is not a regular file. `
        + "Select its regular files explicitly; Git submodule directories need their own candidate.", name);
      return stat;
    }
  }
  throw new ScopeError(`Invalid input path ${JSON.stringify(target)}.`, name);
}

async function walk(root: string, scope?: Scope, sourceScope: string[] = []): Promise<string[]> {
  const inspected = new Set(await ancestors(root));
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    // Buffer entries plus fatal decoding prevent invalid UTF-8 names aliasing one another.
    const entries = await fs.readdir(native(directory), { encoding: "buffer" });
    for (const entry of entries.sort(Buffer.compare)) {
      const name = utf8(entry);
      const target = path.join(directory, name);
      if (scope && (scope.excludedNames.includes(name.toLowerCase()) || excluded(scope, target))) continue;
      const relative = portable(path.relative(root, target));
      if (!intersectsScope(relative, sourceScope)) continue;
      relativeFile(root, relative);
      const stat = await fs.lstat(native(target));
      if (stat.isSymbolicLink()) throw new ScopeError(`Symlink/reparse input ${JSON.stringify(relative)} is unsupported. `
        + "Replace it with regular files or choose a narrower sourceRoot.", relative);
      inspected.add(target);
      if (stat.isDirectory()) {
        await visit(target);
      } else if (stat.isFile()) {
        if (!inScope(relative, sourceScope)) continue;
        assertNotSensitive(relative);
        files.push(relative);
      } else {
        throw new ScopeError(`Selected input ${JSON.stringify(relative)} is not a regular file.`, relative);
      }
    }
  }
  await visit(root);
  await assertNoReparse(inspected);
  return files.sort(compare);
}

async function selectSource(sourceRoot: string, stateDir: string, sourceScope: string[]): Promise<Selection> {
  try {
    assertNotSensitive(portable(sourceRoot));
  } catch {
    throw new ScopeError("sourceRoot is inside a sensitive credential path. "
      + "Choose a source directory outside credential storage before requesting review.");
  }
  const inspected = new Set(await ancestors(sourceRoot));
  const scope = await discoverScope(sourceRoot, stateDir);
  for (const entry of sourceScope) {
    const target = relativeFile(sourceRoot, entry);
    if (excluded(scope, target) || (scope.kind === "filesystem"
      && entry.split("/").some((part) => scope.excludedNames.includes(part.toLowerCase())))) {
      throw new ScopeError(`Declared sourceScope path ${JSON.stringify(entry)} is excluded by the source selection rules. `
        + "Choose source paths outside Git metadata, Workbench state, and excluded directories.", entry);
    }
    try {
      for (const directory of await ancestors(path.dirname(target))) inspected.add(directory);
      const stat = await fs.lstat(native(target));
      if (stat.isSymbolicLink()) throw new ScopeError(`Symlink/reparse sourceScope path ${JSON.stringify(entry)} is unsupported.`, entry);
      if (!stat.isDirectory() && !stat.isFile()) throw new ScopeError(`sourceScope path ${JSON.stringify(entry)} is not a regular file or directory.`, entry);
      inspected.add(target);
    } catch (error) {
      if (error instanceof ScopeError) throw error;
      throw new ScopeError(`Declared sourceScope path ${JSON.stringify(entry)} does not exist or cannot be read. `
        + "Use an existing directory to include future files, or correct the assignment scope.", entry);
    }
  }
  if (sourceScope.length) await assertNoReparse(inspected);
  if (scope.kind === "filesystem") return { scope, paths: await walk(sourceRoot, scope, sourceScope) };
  const gitRoot = scope.gitRoot!;
  const exclusions = scope.excludedAbsolutePaths.filter((entry) => within(gitRoot, entry))
    .map((entry) => `:(top,exclude,literal)${portable(path.relative(gitRoot, entry))}`);
  const literal = process.platform === "win32" ? ":(top,literal,icase)" : ":(top,literal)";
  const prefix = portable(path.relative(gitRoot, sourceRoot));
  const includes = sourceScope.length
    ? sourceScope.map((entry) => `${literal}${portable(path.relative(gitRoot, relativeFile(sourceRoot, entry)))}`)
    : prefix ? [`${literal}${prefix}`] : ["."];
  // Git 2.55 on Ubuntu 24.04 can prune tracked long paths out of the index
  // before matching a case-sensitive pathspec. An additional root-level
  // include prevents that common-prefix optimization. Git metadata is always
  // excluded below, so this preserves the exact literal source selection.
  if (process.platform !== "win32") includes.push(":(top,literal).git");
  const output = utf8(await git(gitRoot, [
    "ls-files", "--cached", "--others", "--exclude-standard", "--full-name", "-z", "--", ...includes, ...exclusions,
  ]));
  if (output && !output.endsWith("\0")) throw new ScopeError("Git returned an incomplete file list.");
  const files = new Set<string>();
  for (const name of output ? output.slice(0, -1).split("\0") : []) {
    const target = relativeFile(gitRoot, name);
    if (!within(sourceRoot, target)) throw new ScopeError("Git selected an input outside sourceRoot.", name);
    if (excluded(scope, target)) continue;
    const relative = portable(path.relative(sourceRoot, target));
    if (!inScope(relative, sourceScope)) throw new ScopeError("Git selected an input outside sourceScope.", relative);
    assertNotSensitive(relative);
    await inspectFile(sourceRoot, relative, inspected);
    files.add(relative);
  }
  await assertNoReparse(inspected);
  return { scope, paths: sorted(files) };
}

function sameStat(a: BigIntStats, b: BigIntStats): boolean {
  return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode && a.nlink === b.nlink;
}

async function hashFile(root: string, name: string, destination?: string, independent = false): Promise<InputFile> {
  const before = await inspectFile(root, name);
  if (independent && before.nlink !== 1n) {
    throw new ScopeError(`Snapshot input ${JSON.stringify(name)} is no longer an independent regular file.`, name);
  }
  const input = await fs.open(native(relativeFile(root, name)),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let output: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    if (!sameStat(before, await input.stat({ bigint: true }))) {
      throw new ScopeError(`Input changed before reading: ${JSON.stringify(name)}. Retry after writers stop.`, name);
    }
    if (destination) output = await fs.open(native(destination), "wx", 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(128 * 1024);
    let bytes = 0;
    for (;;) {
      const read = await input.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      const chunk = buffer.subarray(0, read.bytesRead);
      hash.update(chunk);
      bytes += read.bytesRead;
      if (!Number.isSafeInteger(bytes)) throw new ScopeError(`Input is too large to identify exactly: ${JSON.stringify(name)}.`, name);
      if (output) {
        let offset = 0;
        while (offset < chunk.length) {
          const written = await output.write(chunk, offset, chunk.length - offset);
          if (written.bytesWritten === 0) throw new Error("Snapshot write made no progress.");
          offset += written.bytesWritten;
        }
      }
    }
    if (!sameStat(before, await input.stat({ bigint: true }))
      || !sameStat(before, await inspectFile(root, name)) || BigInt(bytes) !== before.size) {
      throw new ScopeError(`Input changed while reading: ${JSON.stringify(name)}. Retry after writers stop.`, name);
    }
    if (output) await output.sync();
    return { path: name, sha256: hash.digest("hex"), bytes };
  } finally {
    try {
      await output?.close();
    } finally {
      await input.close();
    }
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compare).map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function manifestDigest(manifest: Omit<Manifest, "digest"> | Manifest): string {
  // Retry identities must remain comparable. These location fields are pinned
  // separately against Candidate; the digest binds the assignment and its inputs.
  const { digest: _digest, id: _id, root: _root, ...identity } = manifest as Manifest;
  return createHash("sha256").update(canonical(identity), "utf8").digest("hex");
}

async function compareFiles(root: string, paths: string[], files: InputFile[], prefix: string): Promise<string[]> {
  const changed = new Set<string>();
  const expected = new Map(files.map((file) => [file.path, file]));
  const actual = new Set(paths);
  for (const name of expected.keys()) if (!actual.has(name)) changed.add(`${prefix}:${name}`);
  for (const name of paths) {
    const file = expected.get(name);
    if (!file) {
      changed.add(`${prefix}:${name}`);
      continue;
    }
    try {
      const current = await hashFile(root, name, undefined, prefix === "snapshot");
      if (file.sha256 !== current.sha256 || file.bytes !== current.bytes) changed.add(`${prefix}:${name}`);
    } catch {
      changed.add(`${prefix}:${name}`);
    }
  }
  return sorted(changed);
}

async function makeReadOnly(root: string): Promise<void> {
  for (const entry of await fs.readdir(native(root), { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    const stat = await fs.lstat(native(target));
    if (stat.isSymbolicLink()) throw new ScopeError("Snapshot acquired a symlink before publication.");
    if (stat.isDirectory()) await makeReadOnly(target);
    else if (stat.isFile()) await fs.chmod(native(target), 0o444);
    else throw new ScopeError("Snapshot acquired a non-regular file before publication.");
  }
  await fs.chmod(native(root), 0o555);
}

/**
 * Capture independently copied bytes. Only a completely checked staging directory
 * is published. Failed .pending-* attempts remain inspectable and are never reused.
 */
export async function createCandidate(
  sourceRoot: string, stateDir: string, runId: string, taskId: string,
  options?: { sourceScope?: string[] },
): Promise<Candidate> {
  validateComponent(runId);
  if (typeof taskId !== "string" || !taskId || taskId.includes("\0")) throw new ScopeError("A nonempty taskId is required.");
  sourceRoot = await canonicalDirectory(sourceRoot);
  stateDir = await canonicalDirectory(stateDir, true);
  if (within(stateDir, sourceRoot)) {
    throw new ScopeError("stateDir contains sourceRoot. Choose a separate state directory or a subdirectory of sourceRoot.");
  }
  const sourceScope = normalizeScope(options?.sourceScope);
  const initial = await selectSource(sourceRoot, stateDir, sourceScope);
  const id = `candidate-${randomUUID()}`;
  const candidates = path.join(stateDir, "runs", runId, "candidates");
  await ensureDirectory(candidates);
  const staging = path.join(candidates, `.pending-${id}`);
  const directory = path.join(candidates, id);
  const stagingRoot = path.join(staging, "root");
  const root = path.join(directory, "root");
  const manifestPath = path.join(directory, "manifest.json");
  await fs.mkdir(native(staging), { mode: 0o700 });
  await fs.mkdir(native(stagingRoot), { mode: 0o700 });
  const files: InputFile[] = [];
  for (const name of initial.paths) {
    const target = relativeFile(stagingRoot, name);
    await fs.mkdir(native(path.dirname(target)), { recursive: true, mode: 0o700 });
    files.push(await hashFile(sourceRoot, name, target));
  }
  const snapshotChanges = await compareFiles(stagingRoot, await walk(stagingRoot), files, "snapshot");
  const final = await selectSource(sourceRoot, stateDir, sourceScope);
  const sourceChanges = await compareFiles(sourceRoot, final.paths, files, "source");
  if (canonical(initial.scope) !== canonical(final.scope) || snapshotChanges.length || sourceChanges.length) {
    throw new ScopeError(`Inputs changed during capture (${[...sourceChanges, ...snapshotChanges].join(", ") || "selection rules"}). `
      + "Retry after writers stop.");
  }
  const identity: Omit<Manifest, "digest"> = {
    version: 1, id, runId, taskId, root, sourceRoot, stateDir, sourceScope, scope: initial.scope, files,
  };
  const digest = manifestDigest(identity);
  await fs.writeFile(native(path.join(staging, "manifest.json")),
    JSON.stringify({ ...identity, digest }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await makeReadOnly(staging);
  if (path.dirname(path.resolve(staging)) !== candidates || path.dirname(path.resolve(directory)) !== candidates) {
    throw new ScopeError("Candidate publication paths escaped the verified candidates directory.");
  }
  await assertNoReparse(await ancestors(staging));
  if (await exists(directory)) throw new ScopeError("The candidate publication directory already exists; retained the staging attempt.");
  await fs.rename(native(staging), native(directory));
  return { id, root, sourceRoot, manifestPath, digest, sourceScope, files: files.map((file) => ({ ...file })) };
}

function validateManifest(value: unknown, candidate: Candidate): asserts value is Manifest {
  const manifest = value as Manifest;
  if (!manifest || manifest.version !== 1 || manifest.id !== candidate.id
    || manifest.sourceRoot !== candidate.sourceRoot || manifest.root !== candidate.root
    || manifest.digest !== candidate.digest || !/^[a-f0-9]{64}$/.test(candidate.digest)
    || !Array.isArray(manifest.files) || !manifest.scope
    || !["git", "filesystem"].includes(manifest.scope.kind)
    || typeof manifest.stateDir !== "string" || typeof manifest.runId !== "string"
    || typeof manifest.taskId !== "string" || !manifest.taskId) throw new Error("Invalid manifest identity.");
  validateComponent(manifest.runId);
  validateComponent(manifest.id);
  if (absolute(manifest.sourceRoot) !== manifest.sourceRoot || absolute(manifest.stateDir) !== manifest.stateDir
    || within(manifest.stateDir, manifest.sourceRoot)) throw new Error("Invalid manifest roots.");
  const directory = path.join(manifest.stateDir, "runs", manifest.runId, "candidates", manifest.id);
  if (manifest.root !== path.join(directory, "root") || candidate.manifestPath !== path.join(directory, "manifest.json")) {
    throw new Error("Invalid manifest location.");
  }
  for (const file of manifest.files) {
    relativeFile(manifest.root, file.path);
    assertNotSensitive(file.path);
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new Error("Invalid file identity.");
    }
  }
  const names = manifest.files.map((file) => file.path);
  if (canonical(names) !== canonical(sorted(names)) || manifestDigest(manifest) !== candidate.digest
    || canonical(manifest.files) !== canonical(candidate.files)
    || !Array.isArray(manifest.sourceScope)
    || canonical(normalizeScope(manifest.sourceScope)) !== canonical(manifest.sourceScope)
    || canonical(manifest.sourceScope) !== canonical(candidate.sourceScope ?? [])
    || names.some((name) => !inScope(name, manifest.sourceScope))) throw new Error("Manifest digest mismatch.");
}

/** Revalidate both trees against the supervisor's pinned Candidate identity. */
export async function checkCandidate(candidate: Candidate): Promise<{ ok: boolean; changed: string[] }> {
  let manifest: Manifest;
  try {
    const directory = path.dirname(absolute(candidate.manifestPath));
    const inspected = new Set(await ancestors(directory));
    await inspectFile(directory, path.basename(candidate.manifestPath), inspected);
    await assertNoReparse(inspected);
    const parsed: unknown = JSON.parse(await fs.readFile(native(candidate.manifestPath), "utf8"));
    validateManifest(parsed, candidate);
    manifest = parsed;
  } catch {
    return { ok: false, changed: ["manifest"] };
  }
  const changed = new Set<string>();
  function failure(prefix: string, error: unknown): void {
    changed.add(`${prefix}:${error instanceof ScopeError && error.input ? error.input : "[scope]"}`);
  }
  try {
    const selection = await selectSource(manifest.sourceRoot, manifest.stateDir, manifest.sourceScope);
    if (canonical(selection.scope) !== canonical(manifest.scope)) changed.add("source:[scope]");
    for (const name of await compareFiles(manifest.sourceRoot, selection.paths, manifest.files, "source")) changed.add(name);
    // Catch membership changes that occur while hashing, including newly added inputs.
    const after = await selectSource(manifest.sourceRoot, manifest.stateDir, manifest.sourceScope);
    if (canonical(selection.scope) !== canonical(after.scope)) changed.add("source:[scope]");
    const beforeNames = new Set(selection.paths);
    const afterNames = new Set(after.paths);
    for (const name of selection.paths) if (!afterNames.has(name)) changed.add(`source:${name}`);
    for (const name of after.paths) if (!beforeNames.has(name)) changed.add(`source:${name}`);
  } catch (error) {
    failure("source", error);
  }
  try {
    const names = await walk(manifest.root);
    for (const name of await compareFiles(manifest.root, names, manifest.files, "snapshot")) changed.add(name);
    const after = await walk(manifest.root);
    const beforeNames = new Set(names);
    const afterNames = new Set(after);
    for (const name of names) if (!afterNames.has(name)) changed.add(`snapshot:${name}`);
    for (const name of after) if (!beforeNames.has(name)) changed.add(`snapshot:${name}`);
  } catch (error) {
    failure("snapshot", error);
  }
  return { ok: changed.size === 0, changed: sorted(changed) };
}
