#!/usr/bin/env node
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, existsSync, readFileSync, lstatSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadConfig, saveConfig, homeDir } from "./config.js";
import { packs } from "./capabilities.js";
import { Store } from "./store.js";
import { ToolBroker } from "./broker.js";
import { PiAdapter } from "./adapter.js";
import { Supervisor } from "./supervisor.js";
import type { RunRecord } from "./contracts.js";
import { MemoryBook } from "./memory.js";
import { safePath } from "./paths.js";
import { Connectors } from "./mcp.js";
import { juniorPreset } from "./presets.js";

const help = `Workbench — complete useful work with evidence.

  workbench                         Interactive conversation
  workbench run "objective"          Work autonomously in the current folder
  workbench resume <run-id>          Resume preserved work
  workbench status [run-id]          Inspect tasks and recent progress
  workbench pause <run-id>           Pause the supervisor and clean up owned work
  workbench cancel <run-id>          Cancel a run, preserving its evidence
  workbench steer <run-id> "change"  Add a correction to active or paused work
  workbench approvals <run-id>       Inspect concrete actions awaiting approval
  workbench approve <approval-id>    Approve the exact saved action
  workbench reject <approval-id>     Reject a saved action
  workbench recover <run-id>         Release a dead supervisor; retain unknown effects
  workbench reconcile <op-id> <succeeded|failed> "evidence"
                                    Record an owner's confirmed operation outcome
  workbench export <run-id> [folder] Export the run's ledger and evidence references
  workbench doctor                  Check configuration, runtime and model availability
  workbench init                    Write the separate Workbench configuration
  workbench init --preset junior    Import this computer's Junior gateway references
  workbench capabilities            List available capability packs
  workbench memory list [scope]     Inspect explicit owner/project/area notes
  workbench memory add <scope> "text" "source"
  workbench memory forget <scope> <entry-id>

Options: --project <folder>, --home <folder>, --json, --parallel <count>, --backend-config <file>
Memory scope: owner, project (current folder), or area:<name>.
Interactive: /status, /pause, /resume, /cancel, /new <objective>, /approvals, /approve <id>, /reject <id>, /quit.
Ordinary input steers active work.
Stock Pi and other assistants keep their own configuration.`;

function parse(argv: string[]) {
  const args: string[] = [];
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (["--project", "--home", "--parallel", "--preset", "--backend-config"].includes(argv[i])) {
      const name = argv[i].slice(2);
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`Missing value for --${name}.`);
      opts[name] = argv[++i];
    } else if (argv[i] === "--json") opts.json = true;
    else if (argv[i] === "--help" || argv[i] === "-h") opts.help = true;
    else if (argv[i] === "--version") opts.version = true;
    else args.push(argv[i]);
  }
  return { args, opts };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw new Error("Process identity is uncertain; ownership is retained.");
  }
}

function publicRun(run: RunRecord): Omit<RunRecord, "ownerToken"> {
  const { ownerToken: _ownerToken, ...visible } = run;
  return visible;
}

function preview(value: unknown, length = 180): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > length ? text.slice(0, length - 1) + "…" : text;
}

function formatStatus(value: any): string {
  if (Array.isArray(value)) return value.length
    ? value.map((run) => `${run.id}  ${run.state}\n  ${preview(run.objective)}`).join("\n")
    : "No saved runs.";
  return [
    `${value.run.id}  ${value.run.state}`,
    value.run.objective,
    ...value.tasks.map((task: any) => `${task.id}  ${task.role}  ${task.state}\n  ${preview(task.objective)}`),
    `Unresolved operations: ${value.operations.length}. Pending approvals: ${value.approvals.length}.`,
    "Use --json for complete status and recent events.",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { args, opts } = parse(argv);
  if (opts.help) { console.log(help); return 0; }
  if (opts.version) { console.log("workbench 0.2.0"); return 0; }
  if (opts.home) process.env.WORKBENCH_HOME = resolve(String(opts.home));
  const root = homeDir();
  const config = loadConfig(root);
  if (opts.parallel) {
    const count = Number(opts.parallel);
    if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error("Choose 1–64 worker slots.");
    config.maxWorkers = count;
  }
  const cwd = resolve(String(opts.project || process.cwd()));
  const print = (value: unknown) => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  const command = args.shift();
  if (command === "init") {
    if (opts.preset !== undefined && opts.preset !== "junior") throw new Error("Unknown preset. Choose junior or edit the default gateway template.");
    if (opts["backend-config"] && opts.preset !== "junior") throw new Error("--backend-config requires --preset junior.");
    if (existsSync(join(root, "config.json"))) {
      if (opts.preset) throw new Error("Configuration already exists. Choose a new --home directory to initialize a separate preset.");
      print(`Configuration already exists: ${join(root, "config.json")}`);
    } else {
      const selected = opts.preset === "junior" ? juniorPreset(root, opts["backend-config"] ? resolve(String(opts["backend-config"])) : undefined) : config;
      print(`Configuration created: ${saveConfig(selected, root)}`);
      if (!opts.preset) print("Set your gateway URL, model, context limits and local key reference before running work. No inference has been requested.");
    }
    return 0;
  }
  if (command === "capabilities") { print(packs); return 0; }
  const store = new Store(config.stateDir);
  const broker = new ToolBroker(store, config);
  const adapter = new PiAdapter(config);
  const supervisor = new Supervisor(store, broker, adapter, config, (type, data: any) => {
    if (opts.json) print({ event: type, ...data });
    else if (["task.delegated", "task.accepted", "task.blocked", "task.interrupted", "inference.failed", "review.completed"].includes(type))
      console.log(`[${type}] ${preview(data.objective || data.reason || data.result || data.verdict || "")}`);
  });
  const requireArg = (index: number, label: string) => {
    if (!args[index]) throw new Error(`${label} is required. Run workbench --help.`);
    return args[index];
  };
  const status = (id?: string) => id ? {
    run: publicRun(store.getRun(id)), tasks: store.tasks(id), operations: store.operations(id).filter((op) => ["running", "unknown"].includes(op.state)),
    approvals: store.approvals(id).filter((a) => a.state === "pending"), recent: store.events(id).slice(-12),
  } : store.listRuns().slice(-20).reverse().map(publicRun);
  try {
    switch (command) {
      case "doctor": {
        const result = await adapter.doctor();
        const connectors = new Connectors(config, store);
        let connectorChecks: unknown;
        let connectorsOk = true;
        try {
          const inventory = await connectors.inventory();
          connectorChecks = inventory;
          connectorsOk = inventory.every((server) => server.unavailable.length === 0);
        } catch (error) {
          connectorsOk = false;
          connectorChecks = { error: error instanceof Error ? error.message : String(error) };
        } finally { await connectors.close(); }
        print({ ...result, ok: result.ok && connectorsOk, connectors: connectorChecks,
          version: "0.2.0", node: process.version, root, stateDir: config.stateDir,
          execution: config.execution, maxWorkers: config.maxWorkers, sqlite: true,
          inference: "not run", stockPiModified: false });
        return result.ok && connectorsOk ? 0 : 2;
      }
      case "run": {
        const run = supervisor.create(requireArg(0, "Objective") + (args.length > 1 ? " " + args.slice(1).join(" ") : ""), cwd);
        print(opts.json ? { runId: run.id } : `Run ${run.id}`);
        const abort = new AbortController();
        const interrupt = () => abort.abort(new Error("Owner interrupted work."));
        process.once("SIGINT", interrupt);
        try {
          const result = await supervisor.execute(run.id, abort.signal);
          print(opts.json ? result : `${result.state}: ${result.result || "No result submitted."}`);
          return result.state === "accepted" ? 0 : 2;
        } finally { process.off("SIGINT", interrupt); }
      }
      case "resume": {
        const result = await supervisor.execute(requireArg(0, "Run ID"));
        print(opts.json ? result : `${result.state}: ${result.result || ""}`);
        return result.state === "accepted" ? 0 : 2;
      }
      case "status": {
        const value = status(args[0]);
        print(opts.json ? value : formatStatus(value));
        return 0;
      }
      case "memory": {
        const book = new MemoryBook(config.stateDir);
        const action = args[0] || "list";
        const scope = !args[1] || args[1] === "project" ? MemoryBook.project(cwd) : args[1];
        if (action === "list") print(book.list(scope));
        else if (action === "add") print(book.add(scope, requireArg(2, "Memory text"), requireArg(3, "Source")));
        else if (action === "forget") { book.remove(scope, requireArg(2, "Entry ID")); print("Entry removed."); }
        else throw new Error("Use memory list, add or forget.");
        return 0;
      }
      case "pause":
      case "cancel": {
        const id = requireArg(0, "Run ID");
        if (store.getRun(id).state === "accepted") throw new Error("An accepted run is immutable; start a new run.");
        store.updateRun(id, { state: command === "pause" ? "paused" : "canceled" });
        store.addEvent(id, `owner.${command}`, {});
        print(`${command} requested; inspect status for cleanup and unresolved effects.`);
        return 0;
      }
      case "steer": {
        const id = requireArg(0, "Run ID"), instruction = args.slice(1).join(" ");
        if (!instruction) throw new Error("Steering text is required.");
        if (["accepted", "canceled"].includes(store.getRun(id).state)) throw new Error("Start a new run for a completed objective.");
        store.addEvent(id, "user.steering", { instruction });
        print("Correction saved; it will be incorporated before acceptance.");
        return 0;
      }
      case "approvals": print(store.approvals(requireArg(0, "Run ID"))); return 0;
      case "approve":
      case "reject": print(store.decideApproval(requireArg(0, "Approval ID"), command === "approve")); return 0;
      case "recover": {
        const id = requireArg(0, "Run ID"), run = store.getRun(id);
        if (run.ownerPid && alive(run.ownerPid)) throw new Error("The recorded supervisor PID is still alive. Pause it first; no ownership was changed.");
        for (const op of store.operations(id).filter((o) => o.state === "running")) {
          store.updateOperation(op.id, { state: "unknown", result: { recovery: "Supervisor exited without a confirmed outcome.", processObservedAlive: op.pid ? alive(op.pid) : null } });
        }
        if (run.ownerToken) store.releaseRun(id, run.ownerToken);
        if (!["accepted", "canceled"].includes(run.state)) store.updateRun(id, { state: "paused" });
        store.addEvent(id, "owner.recovered", { unresolved: store.operations(id).filter((o) => o.state === "unknown").map((o) => o.id) });
        print(status(id));
        return 0;
      }
      case "reconcile": {
        const op = store.getOperation(requireArg(0, "Operation ID")), outcome = requireArg(1, "Outcome");
        const evidence = args.slice(2).join(" ");
        if (op.state !== "unknown" || !["succeeded", "failed"].includes(outcome) || !evidence) throw new Error("Reconciliation requires an unknown operation, succeeded/failed, and the owner's confirmation evidence.");
        store.updateOperation(op.id, { state: outcome as "succeeded" | "failed", result: { ownerConfirmation: evidence } });
        store.addEvent(op.runId, "owner.reconciled", { operation: op.id, outcome, evidence }, op.taskId);
        print("Outcome recorded. Resume the run when all unresolved effects have been reconciled.");
        return 0;
      }
      case "export": {
        const id = requireArg(0, "Run ID"), destination = resolve(args[1] || join(cwd, `workbench-export-${id}`));
        mkdirSync(destination, { recursive: true, mode: 0o700 });
        const data = { run: publicRun(store.getRun(id)), tasks: store.tasks(id), operations: store.operations(id), events: store.events(id),
          artifacts: store.artifacts(id), approvals: store.approvals(id) };
        const path = join(destination, "run.json");
        if (existsSync(path)) throw new Error("Export destination already contains run.json; choose another folder.");
        const artifactDirectory = join(destination, "artifacts");
        mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
        const exported: Array<{ id: string; file: string; sha256: string }> = [];
        for (const artifact of data.artifacts) {
          if (!lstatSync(artifact.path).isFile() || lstatSync(artifact.path).isSymbolicLink()) throw new Error("Artifact is not an independent regular file.");
          const bytes = readFileSync(artifact.path);
          const hash = createHash("sha256").update(bytes).digest("hex");
          if (hash !== artifact.sha256 || bytes.length !== artifact.bytes) throw new Error("Artifact changed after its receipt; export is incomplete.");
          const file = `${artifact.id}.bin`;
          writeFileSync(safePath(destination, join("artifacts", file), { write: true }), bytes, { flag: "wx", mode: 0o600 });
          exported.push({ id: artifact.id, file: `artifacts/${file}`, sha256: hash });
        }
        writeFileSync(path, JSON.stringify({ ...data, exported }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        print(`Ledger and ${exported.length} verified artifacts exported: ${path}`);
        return 0;
      }
      case undefined: return await interactive(supervisor, store, cwd, print);
      default: throw new Error(`Unknown command: ${command}. Run workbench --help.`);
    }
  } finally {
    await supervisor.close();
    await broker.close();
    store.close();
  }
}

export async function interactive(
  supervisor: Pick<Supervisor, "create" | "execute">, store: Store, cwd: string, print: (value: unknown) => void,
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin, output: NodeJS.WritableStream = process.stdout,
): Promise<number> {
  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY) });
  let active: Promise<void> | undefined;
  let current: RunRecord | undefined;
  let resumeAfterApproval = false;
  let closing = false;
  rl.once("close", () => { closing = true; resumeAfterApproval = false; });
  print("Workbench. Describe the result you want. /status /pause /resume /cancel /approvals /approve <id> /quit");
  rl.setPrompt("> "); rl.prompt();
  const launch = (id: string) => {
    active = supervisor.execute(id).then(() => {
      // Owner commands can supersede the returned snapshot during cleanup.
      current = store.getRun(id);
      print(`${current.state}: ${current.result || "No result submitted."}`);
    }).catch((error) => print(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        active = undefined;
        const resume = resumeAfterApproval;
        resumeAfterApproval = false;
        const run = store.getRun(id);
        if (resume && !closing && ["blocked", "paused"].includes(run.state)) launch(id);
        else if (!closing) rl.prompt();
      });
  };
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) { rl.prompt(); continue; }
    const run = current && store.getRun(current.id);
    if (line === "/quit") {
      closing = true;
      resumeAfterApproval = false;
      if (active && run && !["accepted", "canceled"].includes(run.state)) store.updateRun(run.id, { state: "paused" });
      break;
    }
    if (line === "/status") {
      print(current ? formatStatus({ run: publicRun(store.getRun(current.id)), tasks: store.tasks(current.id),
        operations: store.operations(current.id).filter((operation) => ["running", "unknown"].includes(operation.state)),
        approvals: store.approvals(current.id).filter((approval) => approval.state === "pending") }) : "No run yet.");
    } else if (line.startsWith("/new ")) {
      resumeAfterApproval = false;
      if (active && run) {
        if (!["accepted", "canceled"].includes(run.state)) store.updateRun(run.id, { state: "paused" });
        await active;
      }
      current = supervisor.create(line.slice(5).trim(), cwd);
      print(`Run ${current.id}`);
      launch(current.id);
    } else if (line === "/approvals") {
      print(current ? store.approvals(current.id) : "No run yet.");
    } else if (line.startsWith("/approve ") || line.startsWith("/reject ")) {
      const approved = line.startsWith("/approve ");
      const id = line.slice(approved ? 9 : 8).trim();
      try {
        const approval = store.getApproval(id);
        if (!run || approval.runId !== run.id) throw new Error("Choose an approval from the current run.");
        if (["accepted", "canceled"].includes(run.state)) throw new Error(`Run is ${run.state}. Start a new run.`);
        print(store.decideApproval(id, approved));
        if (approved && active) resumeAfterApproval = true;
        else if (approved && ["blocked", "paused"].includes(run.state)) launch(run.id);
      } catch (error) { print(error instanceof Error ? error.message : String(error)); }
    } else if (line === "/pause" || line === "/cancel") {
      resumeAfterApproval = false;
      if (!run) print("No active work.");
      else if (["accepted", "canceled"].includes(run.state)) print(`Run is ${run.state}. Start a new run.`);
      else {
        store.updateRun(run.id, { state: line === "/pause" ? "paused" : "canceled" });
        print(line === "/pause" ? "Pause requested." : "Cancel requested; evidence retained.");
      }
    } else if (line === "/resume") {
      if (!run) print("No run to resume.");
      else if (["accepted", "canceled"].includes(run.state)) print(`Run is ${run.state}. Start a new run.`);
      else if (active) print("Work is already active.");
      else launch(run.id);
    } else if (line.startsWith("/")) {
      print("Use /status, /pause, /resume, /cancel, /new <objective>, /approvals, /approve <id>, /reject <id>, or /quit. Recovery commands are available from a second terminal.");
    } else if (active && run && !["accepted", "canceled"].includes(run.state)) {
      store.addEvent(run.id, "user.steering", { instruction: line });
      print("Correction saved.");
    } else if (run && ["blocked", "paused"].includes(run.state)) {
      store.addEvent(run.id, "user.steering", { instruction: line });
      launch(run.id);
    } else {
      resumeAfterApproval = false;
      await active;
      current = supervisor.create(line, cwd);
      print(`Run ${current.id}`);
      launch(current.id);
    }
    rl.prompt();
  }
  closing = true;
  resumeAfterApproval = false;
  if (active && current && ["running", "verifying"].includes(store.getRun(current.id).state)) store.updateRun(current.id, { state: "paused" });
  await active;
  rl.close();
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
