import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";

// Test teardown only: candidates stay read-only until their fixture is removed.
// Check the fixture boundary before every removal and never follow links.
export async function removeFixture(target: string, boundary: string): Promise<void> {
  const absolute = path.resolve(target);
  const relative = path.relative(boundary, absolute);
  assert.ok(relative === "" || (!path.isAbsolute(relative) && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)), "cleanup must stay inside its fixture");
  const native = path.toNamespacedPath(absolute);
  const stat = await fs.lstat(native);
  if (stat.isSymbolicLink()) {
    await fs.unlink(native);
  } else if (stat.isDirectory()) {
    await fs.chmod(native, 0o700);
    for (const name of await fs.readdir(native)) await removeFixture(path.join(absolute, name), boundary);
    await fs.rmdir(native);
  } else {
    await fs.chmod(native, 0o600);
    await fs.unlink(native);
  }
}
