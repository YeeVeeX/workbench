import { spawnSync } from "node:child_process";
// Plain argv entrypoint also works under Git hooks and Swarm Forge.
for (const args of [
  ["node_modules/typescript/bin/tsc", "--noEmit"],
  ["--import", "tsx", "--test", "tests/*.test.ts"],
]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const child = spawnSync(process.execPath, args, { stdio: "inherit", env });
  if (child.error) { console.error(child.error.message); process.exit(2); }
  if (child.status !== 0) process.exit(2);
}
