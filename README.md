# Workbench

Workbench is a terminal assistant built around the stock Pi SDK. It works in
folders with or without Git, coordinates workers with declared write ownership,
and keeps task state and evidence across interruptions. The supervisor accepts
results after the required checks and review; a model finishing its turn does
not mean the task passed.

This is an early release with limited local qualification. Installation,
gateway access, model capabilities and completed workflows need verification
for the particular build and machine you use.

On Windows with Git 2.55.0, keep the Git project root below 260 characters.
That Git release cannot reliably query an overlong root through a junction;
Workbench rejects the operation instead of accepting an incomplete snapshot.
This restriction concerns the project root, not every file path within it.

## Build from source

Clone this repository and install **Node.js 24 or newer** with npm. From the
repository root:

```powershell
npm ci --ignore-scripts
npm run check
npm run build
node dist/cli.js --help
```

`npm run check` runs typechecking and tests. `node scripts/check.mjs` is the
deterministic gate entrypoint. Neither command establishes live gateway access.
Dependency installation needs network access or an already populated cache;
`--ignore-scripts` does not make dependency code safe to execute.

Run the built CLI with `node dist/cli.js`. To register an optional Windows
command for this built checkout:

```powershell
powershell -File scripts/share-install.ps1
```

This script registers launchers without downloads or configuration changes.
It refuses an existing `.ps1` or `.cmd` for the selected name. Choose a different
`-CommandName`, such as `workbench-local`, to coexist with another installation.
Add `-AddToPath` explicitly if you want its command directory added to your
user PATH, then open a fresh terminal. The default launcher directory is
`%USERPROFILE%\.local\bin`.

Keep the checkout in its final location before registration:
moving it breaks the registered launchers. Registering a command does not
establish a working model route or completed task. Stock Pi and other assistants
keep their own configuration.

The separate transactional Windows installer,
`powershell -File scripts/install-workbench.ps1`, prepares and activates a
separate runtime from this Git checkout. It preserves previous generations
for rollback.

## Configure your own gateway

Workbench does not include gateway access or credentials. Before starting a
task, create and inspect its separate configuration:

```powershell
node dist/cli.js init
```

`config.json` lives in the Workbench home, by default
`%LOCALAPPDATA%\Workbench` on Windows for the source CLI. `WORKBENCH_HOME` or
`--home <folder>` selects another home; use the same home throughout.
After optional command registration, `workbench init` invokes the same CLI.
For source development, `npm start -- init` also uses this configuration logic.

Fresh public configuration uses `accessMode: "gateway-only"` and
`execution: "restricted"`, with placeholders for your gateway and model routes.
It has no AWS or profile defaults. Fill in those placeholders before inference;
the generated file does not establish a working connection. Explicitly chosen
application presets can use different execution settings, so inspect the
effective configuration.

Supply the following values from your own gateway installation:

| Setting | Value to supply |
| --- | --- |
| Gateway base URL (`baseUrl`) | `<YOUR_GATEWAY_BASE_URL>` |
| Provider and native protocol | `workbench-gateway-responses` or `workbench-gateway-messages`, qualified for your route |
| Coordinator model | `<ALLOWED_COORDINATOR_MODEL_ID>` |
| Worker model | `<ALLOWED_WORKER_MODEL_ID>` |
| Reviewer model | `<ALLOWED_REVIEWER_MODEL_ID>` |
| Summarization model (`compactor`) | `<ALLOWED_COMPACTOR_MODEL_ID>` |
| Authentication reference | `auth.env`: `<EXISTING_KEY_ENV_VAR>` **or** `auth.file`: `<EXISTING_KEY_FILE_PATH>` |
| Context/output limits | Verified integer values for `contextWindow` and `maxTokens` |
| Optional KB connector | `<YOUR_KB_CONNECTOR_COMMAND_OR_SUPPORTED_ENDPOINT>` |

The current [route contract](src/contracts.ts) declares this shape for one model
route. This is a template, not a complete `config.json`:

```json
{
  "provider": "workbench-gateway-responses",
  "model": "<ALLOWED_MODEL_ID>",
  "effort": "max",
  "baseUrl": "<YOUR_GATEWAY_BASE_URL>",
  "auth": { "env": "<EXISTING_KEY_ENV_VAR>" },
  "contextWindow": 200000,
  "maxTokens": 32000
}
```

For a supported key file, use `"auth": { "file": "<EXISTING_KEY_FILE_PATH>" }`
instead, using an absolute path to your existing protected key file. Replace
the placeholders and the example context/output numbers with your verified
gateway settings; those numbers are template defaults, not a capability claim.
Configure every role explicitly. The Messages adapter additionally requires
qualified adaptive thinking with `adaptiveThinking: true`. See the
[gateway adapter](src/gateway.ts) for validation; a contract field alone does
not establish working transport or authentication.

Keep the top-level `accessMode: "gateway-only"` policy and verify that the build
rejects native cloud routes under it. Configure the compactor and every fallback
as explicitly as the main roles.

Keep the key in its existing local store. Configure a supported environment
variable or file reference, never a key value in a prompt, command argument,
repository, ZIP or log. A gateway route should not require the gateway
operator's cloud credentials or account access.

Private HTTP requires `allowPrivateHttp: true` on the relevant route or remote
MCP connector, together with a validated private destination. This is a
configuration field; there is no CLI flag for it. Keep it false for HTTPS.
Use it only for the existing authorized private connection; the field does
not provide encryption or authorize exposing a service. Cloud SDK dependencies
do not require gateway users to configure AWS credentials. Native cloud access
is a separate explicit opt-in and is never enabled by public initialization.

Qualify the exact model, native protocol, tool calls, continuation and reasoning
settings together. Set context and output limits from verified gateway
capabilities, not from an alias or another deployment's defaults. An advertised
model alias or a successful model-list request does not establish those
capabilities. Native Messages and Responses are not interchangeable with
Chat Completions.

Routes require explicit maximum reasoning settings (`max` or `xhigh`, as
supported and qualified by that adapter/model). The current compactor requires
`max`. Do not silently lower effort or substitute another model. Configure
fallbacks explicitly and qualify each route; provider refusals must not trigger
retry or failover. The generated defaults are not qualification for your gateway.

`maxWorkers` controls capacity; `--parallel <count>` overrides it for an
invocation. Set capacity within your gateway's allowed concurrency and models.
A preset's worker count is configuration, not a measured gateway capacity or
a promise of faster execution.

Optional KB access uses a configured read-only MCP connector. Remote KB access
requires this build's MCP HTTP transport and the permitted tool list. Verify
the connector implementation and remote behavior before claiming KB support;
its presence in a configuration file is not proof.

## Verify and use

After configuring the gateway and any connectors, use the built source CLI
from an ordinary terminal:

```powershell
node dist/cli.js --help
node dist/cli.js doctor
node dist/cli.js status
```

Doctor checks runtime/configuration and inventories configured MCP tools. It
can launch local connectors or contact configured remote services; it does not
perform model inference or prove a completed workflow. An empty connector list
does not prove KB access.

Then use a disposable folder with synthetic input for a gateway workflow test:

```powershell
node dist/cli.js run "Read the sample documents and write a short comparison."
node dist/cli.js status
```

Model requests use your configured service and may consume its quota. Inspect
any live-check script before running it; run only checks written for your
selected adapter. Record offline tests, live protocol checks, installed command
behavior and independently reviewed task acceptance as separate results.
Missing or interrupted evidence remains unverified.

The examples below use `workbench` after optional command registration; the
same arguments work with `node dist/cli.js`. Workbench uses a simple text prompt.
Starting `workbench` opens an empty conversation: type a goal after `>` and
press Enter to start a task. `/resume` and `/cancel` act on that
conversation's current run. After restarting the CLI, use `workbench status`
to find the saved run ID, then `workbench resume <run-id>`.

Interactive commands include
`/status`, `/pause`, `/resume`, `/cancel` and
`/new <objective>`. From another terminal, use `workbench steer <run-id> "change"`
or `workbench resume <run-id>`. Unknown command effects need reconciliation
before retrying. `workbench export <run-id> <folder>` writes a local evidence
export, which may contain task data and needs inspection before sharing.

Projects can register checks in `workbench.checks.json`. Workbench runs them
before acceptance and binds their evidence to the candidate. Running command
checks requires explicitly selecting trusted local execution; restricted mode
refuses those commands. Preserve stronger project checks and instructions.

## Execution and access

Fresh public configuration defaults to `restricted`, which currently refuses
command execution until an isolation adapter is available. Explicit
`trusted-local` mode runs owner-trusted local commands with the current user's
OS permissions. **Workbench is not an OS sandbox.** Native path checks, write
grants and resource reservations limit broker operations; they do not contain
arbitrary subprocesses. Restricted mode is not proof of OS isolation.

HTTP mutation grants (`httpGrants`) default to empty. The generic HTTP tool
requires a saved action approval or a matching configured method/origin/path
grant, and does not supply credentials. These controls do not prevent a trusted
command from using network access. Gateway authentication is a separate
adapter concern. MCP tools are limited to the configured `readOnlyTools` list;
trust and inspect the connector itself.

Preparing a task or package does not authorize sending messages, publishing
code, uploading artifacts or changing an external account. Make any such
authorization explicit and scoped. See [SECURITY.md](SECURITY.md) for the trust
boundary and handling of secrets and task data.

Workbench is licensed under [MIT](LICENSE), copyright Workbench contributors.
Dependencies retain their own terms; see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
