# Workbench

Workbench is a general-purpose supervisor around the stock Pi SDK. Its runtime,
configuration and state are separate from stock Pi and other assistants.
This public tree must be usable without a maintainer's private checkout,
machine configuration, credentials or services.

## Commands

Requires Node.js 24 or newer.

- Dependencies: `npm ci --ignore-scripts`
- Typecheck and tests: `npm run check`
- Build: `npm run build`
- Built source CLI: `node dist/cli.js`
- Development CLI: `npm start -- --help`
- Deterministic gate: `node scripts/check.mjs`
- Optional Windows command: `powershell -File scripts/share-install.ps1`
- Transactional Windows installer: `powershell -File scripts/install-workbench.ps1`

This checkout needs Node.js 24+, npm dependencies and a build. `share-install.ps1`
registers launchers to the final built location, without downloads or
configuration changes. It refuses an existing `.ps1` or `.cmd`; use
`-CommandName workbench-local` to coexist and `-AddToPath` only when explicitly
selected. Moving the checkout breaks registered launchers.
The transactional installer requires a clean Git checkout.

This repository distributes source. If building a separate binary distribution,
verify its manifest, entrypoint, platform behavior and dependency notices.
Inspect live-check scripts and their target routes before using them; real
model calls and connector access are separate from the ordinary test gate.
Keep failed evidence. Do not require a maintainer's private Swarm Forge path
to build or check this public tree.

## Implementation invariants

- `src/contracts.ts` is shared. Coordinate contract changes across callers,
  validation, providers and tests.
- Fresh public configuration is `gateway-only` and `restricted`, with
  gateway/model placeholders and no AWS or profile defaults. Trusted local
  presets must be explicit; never silently import a maintainer's routes.
- The supervisor owns acceptance. Distinguish model, tool, task and run terminal
  states; a finished model response is not an accepted result.
- Use the maximum reasoning supported and qualified for the selected route.
  Model IDs and gateway permissions are explicit configuration, including
  coordinator, worker, reviewer, compactor and fallbacks. No silent downgrade
  or unqualified fallback; refusals do not trigger failover.
- Qualify the actual native protocol, tool use and continuation. Do not infer
  capability from a familiar API label, model alias or listing endpoint.
- Give parallel writers disjoint ownership and preserve unrelated changes.
  Treat native grants and reservations as broker controls, not an OS sandbox.
- `trusted-local` commands have the current user's OS authority. `restricted`
  currently refuses command execution; never label it verified containment.
- Reconcile unknown effects before retrying. Do not replay commands because a
  process died or a heartbeat expired.
- Retain complete evidence and bind checks/review to the candidate. An absent,
  failed, malformed or interrupted review is not a passing verdict.
- Preserve stronger project gates. Run affected tests during repair and the
  complete deterministic gate before release.
- Preserve existing stock Pi, Kilo/Game Studio and other assistants. Configure
  Workbench independently.
- Preserve authentication by reference to the existing protected file or
  environment variable. Imports must not copy keys or relax file permissions.
- Private HTTP uses the `allowPrivateHttp` config field, not a CLI flag.
  The Junior import sets it explicitly from each validated URL: true for
  private HTTP, false for HTTPS. Remote read-only KB access needs a qualified
  MCP HTTP transport and tool allowlist; model access alone does not prove it.
- Keep compatibility policies narrow and client identity honest. The explicit
  `gatewayPolicy: "studio-fable-astra-max-v1"` policy preserves the legacy
  `game-director` wire header marker for Fable while retaining native endpoints,
  model pins and Max effort. Identify Workbench as the actual client and do not
  change server policy to enable this compatibility.

## Public distribution

Use placeholders for gateway URLs, allowed model IDs and local authentication
references. Never commit or package keys, cloud credentials, private profiles,
private service addresses, user-specific paths, sessions, local qualification
receipts or private repository history. An authentication reference is a
variable name or supported file location, not the secret value.
For gateway-only distributions, configure `accessMode: "gateway-only"` and
verify that it rejects native cloud routes for every role and fallback.

Prepare public trees and ZIPs from an explicit allowlist and inspect their
actual contents. Include binaries or dependencies only with recorded packaging
tests for their OS and architecture and their required notices. Do not claim
offline or new-PC support without the corresponding installation proof.

The MIT license covers Workbench contributors' original work.
Dependencies retain their own licenses. Check
`package-lock.json`, installed package metadata and the license/notice texts
for the exact distributed versions; missing text or metadata needs resolution.
Do not infer a package's license from another package's name or publisher.

Upstream Swarm Forge was reviewed without finding a repository license grant.
Use design ideas only; do not copy its source, prompts or documentation.
ECC informed design choices; no ECC implementation or prompt text was imported.
Any later third-party import needs its own provenance and license review.

Preparing changes does not authorize external publication, messages, account
changes or credential access. Keep external actions within explicit user
authorization and scoped grants.

## Documentation and acceptance

Write for the person installing this tree without private context. State
prerequisites, working commands, expected behavior and practical limits.
Separate defaults from capabilities actually qualified on a user's gateway.
Review factual accuracy and language quality separately.

Report offline checks, live model/protocol proof, normal-terminal installation
and independent acceptance separately. Read `README.md` and `SECURITY.md` for
the user-facing contract; implementation details are in `src/` and `tests/`.
Do not present a downloaded runtime, registered launcher or passed source build
as an installed and verified workflow.
