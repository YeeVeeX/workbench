import { existsSync, readFileSync, lstatSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";

export interface ProjectCheck {
  name: string;
  executable: string;
  args: string[];
  writes: string[];
  timeoutSeconds: number;
  inputs: Array<{ path: string; sha256: string }>;
}

/** Explicit project check contract, pinned before any agent can edit the project. */
export function projectChecks(cwd: string): ProjectCheck[] {
  const file = join(cwd, "workbench.checks.json");
  if (!existsSync(file)) return [];
  const value = JSON.parse(readFileSync(file, "utf8")) as { checks?: ProjectCheck[] };
  if (!Array.isArray(value.checks)) throw new Error("workbench.checks.json requires a checks array.");
  const names = new Set<string>();
  return value.checks.map((check) => {
    if (!check || !check.name || !check.executable || !Array.isArray(check.args)
      || check.args.some((arg) => typeof arg !== "string") || !Array.isArray(check.writes)
      || check.writes.some((path) => typeof path !== "string") || names.has(check.name))
      throw new Error("Invalid or duplicate registered project check.");
    const timeoutSeconds = check.timeoutSeconds ?? 600;
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error("A project check requires a positive process timeout.");
    names.add(check.name);
    const inputs: ProjectCheck["inputs"] = [];
    for (const input of ["workbench.checks.json", ...check.args]) {
      const path = resolve(cwd, input), local = relative(cwd, path);
      if (local.startsWith("..") || isAbsolute(local) || !existsSync(path) || !lstatSync(path).isFile()) continue;
      inputs.push({ path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
    }
    return { name: check.name, executable: check.executable, args: check.args, writes: check.writes, timeoutSeconds, inputs };
  });
}
