import { lstatSync } from "node:fs";
import path from "node:path";

const protectedNames = new Set([
  ".git", ".workbench", "state", "credentials", ".credentials", "secrets", ".secrets",
  ".aws", ".azure", ".ssh", ".gnupg", ".kube", ".netrc", "_netrc", ".npmrc", ".pypirc",
  ".git-credentials", "auth.json", "credentials.json", "credentials.yaml", "credentials.yml",
]);

function normalized(input: string): string {
  const result = path.resolve(input);
  return process.platform === "win32" ? result.toLowerCase() : result;
}

/** Whether either path contains the other, including equality; not a string-prefix test. */
export function overlaps(a: string, b: string): boolean {
  const left = normalized(a);
  const right = normalized(b);
  const contains = (parent: string, child: string): boolean => {
    const relative = path.relative(parent, child);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".."
      && !relative.startsWith(`..${path.sep}`));
  };
  return contains(left, right) || contains(right, left);
}

function checkSpelling(input: string): void {
  if (input.includes("\0")) throw new Error("Paths cannot contain NUL.");
  // Device namespaces, alternate data streams, and Win32 name aliases bypass ordinary checks.
  if (process.platform === "win32") {
    if (/^[\\/]{2}[?.][\\/]/.test(input)) throw new Error("Windows device paths are not allowed.");
    const withoutDrive = input.replace(/^[a-z]:[\\/]/i, "");
    for (const part of withoutDrive.split(/[\\/]/)) {
      if (part === "." || part === ".." || part === "") continue;
      if (/[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
        || /~\d(?:\.|$)/.test(part)) {
        throw new Error("Windows device, stream, short, and aliased path names are not allowed.");
      }
    }
  }
}

function isProtected(part: string): boolean {
  const name = part.toLowerCase();
  return protectedNames.has(name) || /^\.env(?:\.|$)/.test(name)
    || /^(?:secrets|credentials)\.(?:json|ya?ml|toml|ini|txt|conf)$/.test(name)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(name)
    || /\.(?:pem|key|p12|pfx|keystore)$/.test(name);
}

/**
 * Resolve a project path without following any existing symlink/junction, including
 * root ancestors. Missing tails are permitted for writes. This is a native-tool
 * policy check, not an OS sandbox or protection against a hostile concurrent OS user.
 */
export function safePath(root: string, input: string, options: { write?: boolean } = {}): string {
  if (typeof root !== "string" || root.length === 0
    || typeof input !== "string" || input.length === 0) {
    throw new Error("A nonempty root and path are required.");
  }
  checkSpelling(root);
  checkSpelling(input);
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, input);
  const relative = path.relative(normalized(absoluteRoot), normalized(target));
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Path is outside the project root.");
  }
  if (options.write && relative.split(path.sep).some(isProtected)) {
    throw new Error("Writes to repository metadata, Workbench state, or credential paths are denied.");
  }

  let cursor = path.parse(target).root;
  const parts = target.slice(cursor.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new Error("Symlink or junction traversal is denied.");
      if (index < parts.length - 1 && !stat.isDirectory()) {
        throw new Error("A path ancestor is not a directory.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return target;
}
