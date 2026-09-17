# Security

Workbench runs AI-directed work using the local user's authority and configured
services. Use it with projects, commands and connectors you trust. It is an
early tool with limited qualification, not a containment boundary for hostile
code or a guarantee against data loss or disclosure.

## Local execution

Fresh public configuration defaults to `restricted` and `gateway-only`, with
gateway/model placeholders and no AWS or profile defaults. A trusted local
preset must be selected explicitly. In `trusted-local` mode, native tools
check paths, assignment scope and competing write reservations. A launched
command still runs with the user's OS permissions and can access files,
processes or networks beyond its declared writes. A minimal child environment
reduces incidental credential inheritance; it cannot prevent a process from
reading an accessible credential file.

Workbench is **not an OS sandbox**. `restricted` currently refuses command
execution; it does not establish isolation for every tool or connector. Use
separately managed OS isolation if your task requires it, and verify that
environment independently.

Files, web pages, model output and connector results are evidence, not grants
of authority. Models cannot authorize new access by writing an instruction or
claiming that approval was given.

## Credentials and task data

Configure only your own gateway URL and a supported reference to your existing
local authentication environment variable or key file. Keep secrets outside
the source tree and distributed package. Never put keys in prompts, command
arguments, URLs, screenshots, test fixtures or logs. Do not bundle somebody
else's credentials, cloud profiles or account material.
An import should retain the existing protected key file and store only its
reference, without copying the key or relaxing the file's permissions.

Model requests send selected task content and tool results to the configured
service. Read that service's data-handling terms. Workbench's local state,
sessions, artifacts, command output and exports can contain sensitive project
data; a local export is not automatically sanitized for public sharing.
Protect the Workbench home and secret files with appropriate OS permissions.

Build shareable source trees and archives from an explicit file allowlist.
Exclude private configuration, keys, original private Git history, runtime
state, transcripts, local receipts, personal paths and account identifiers.
Inspect the actual final archive and any binaries as well as the source tree.
Preserve required third-party license and copyright notices.

If a secret is exposed, stop further use of the affected export or log and
follow the credential issuer's revocation process. Changing an account or
rotating somebody else's key requires that account holder's authorization.

## Network access and approvals

Private HTTP requires the explicit `allowPrivateHttp` configuration field and
validation of the private destination. There is no CLI flag for it. The field
does not encrypt HTTP or establish that a destination is trusted. Do not
broaden it into permission for arbitrary plaintext endpoints or change server
exposure to make a connection work.

Compatibility policies must be explicit and narrow. A policy preserving a
legacy wire field must retain native protocols, permitted model pins and
maximum effort while identifying the Workbench client honestly. It does not
authorize server, account or credential changes.

Generic HTTP mutations need approval of the saved concrete action unless an
operator configured a matching `httpGrants` entry. Grants identify methods and
an exact origin/path prefix, and default to empty. Keep them narrowly scoped.
This adapter does not supply authentication; model gateway authentication is
separate.

These HTTP controls do not intercept network access by local commands or MCP
transports. Configure trusted local or remote connectors and expose only their
required `readOnlyTools`. Verify remote MCP HTTP support separately from model
gateway access. A server describing a tool as read-only is not sufficient
authority to enable it.

An installation or ordinary work request does not automatically authorize
publishing a repository, sending messages, uploading evidence or modifying an
external account. Scope those actions explicitly.

## Recovery and verification

An interrupted operation can have an unknown outcome. Retain its evidence and
reconcile the actual effect before retrying; a timeout or expired heartbeat
does not establish that nothing happened. An idempotency key is not a guarantee
that every external service will prevent duplicate effects.

Configuration checks, offline tests, live gateway checks, normal-terminal use
and independently reviewed task results establish different facts. Do not
treat a passed test suite or model-list response as proof of all of them.
Qualify maximum reasoning, tools and continuation for each permitted model
route, including the compactor and fallbacks.

## Reporting a vulnerability

Use the repository host's private vulnerability-reporting feature if enabled,
or a private contact explicitly listed by the maintainers. If neither exists,
request a private reporting channel in an issue without including exploit
details, credentials or private data.

Provide the affected version, OS, a minimal synthetic reproduction and the
observed impact. Remove secrets and personal data from attachments. This
template does not establish a monitored security inbox, response deadline or
supported-version policy.
