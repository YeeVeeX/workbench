# Third-party notices

The Workbench MIT license applies to Workbench contributors' original
work. Dependencies, bundled runtimes and other third-party material retain
their own copyright notices and license terms. This document does not replace
those texts or grant rights to material whose license is unresolved.

## npm dependencies

`package.json` declares direct dependencies; `package-lock.json` records their
resolved versions and transitive dependency graph. The following snapshot was
checked against the lockfile and installed package metadata. “Declared license”
reports package metadata, not an independent legal audit or a substitute for
the actual license text.

| Direct runtime dependency | Resolved version | Declared license |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` | 0.85.1 | MIT |
| `@earendil-works/pi-ai` | 0.85.1 | MIT |
| `@aws-sdk/credential-providers` | 3.1134.0 | Apache-2.0 |
| `@smithy/signature-v4` | 5.7.3 | Apache-2.0 |
| `@smithy/protocol-http` | 5.6.2 | Apache-2.0 |
| `@aws-crypto/sha256-js` | 5.2.0 | Apache-2.0 |
| `@modelcontextprotocol/sdk` | 1.30.0 | MIT |
| `typebox` | 1.3.7 | MIT |

| Direct development dependency | Resolved version | Declared license |
| --- | --- | --- |
| `@types/node` | 24.13.5 | MIT |
| `tsx` | 4.23.13 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |

Refresh this table when the lockfile changes. It is not a complete inventory of
the transitive packages or native components in a ZIP. Cloud SDK packages in
the dependency tree do not mean a gateway user needs cloud credentials.

For each distribution, inventory the packages actually included, with exact
versions and provenance. Read their `package.json` metadata together with their
`LICENSE`, `LICENCE`, `COPYING`, `NOTICE` and other applicable attribution files.
Preserve the required original texts and copyright notices, including those
for transitive dependencies and bundled components.

## Pi 0.85.1 repository license

The missing Pi package-root license text has been resolved from the exact
upstream release. Published npm metadata for all six packages below identifies
[`earendil-works/pi`](https://github.com/earendil-works/pi), version 0.85.1 and
`gitHead` `d981de1229ef899957bbe968bc8dcda02a21f477`. The repository's `v0.85.1`
tag resolves to that same commit.

| Package | Repository directory | Declared license |
| --- | --- | --- |
| `@earendil-works/pi-ai` | `packages/ai` | MIT |
| `@earendil-works/pi-coding-agent` | `packages/coding-agent` | MIT |
| `@earendil-works/pi-agent-core` | `packages/agent` | MIT |
| `@earendil-works/pi-tui` | `packages/tui` | MIT |
| `@earendil-works/pi-telemetry` | `packages/telemetry` | MIT |
| `@earendil-works/chord` | `packages/chord` | MIT |

The complete source tree at that revision contains the repository-root MIT
license and no separate license/notice files under those package directories.
Each exact-revision package manifest declares MIT. The unchanged license text
states **Copyright (c) 2025 Mario Zechner**.

Redistribute the [exact upstream license](https://raw.githubusercontent.com/earendil-works/pi/d981de1229ef899957bbe968bc8dcda02a21f477/LICENSE)
with these packages. This repository includes the saved copy at
`third-party/pi-0.85.1/LICENSE` and its verification record at
`third-party/provenance.json`. Preserve both with the package.
The 1,069-byte license has SHA-256:

```text
0457f5bcec3b3b211605dfb5d1a49042fd638f3686a410fe099c24a25af13c48
```

Provenance records the immutable source URL, npm metadata, matching release
tag/commit, source manifests and checks of eight installed package copies.
Five nested lockfile entries initially lacked integrity fields; they now pin
the verified npm archive hashes. Verification matched 1,413 package-owned files
against those archives with zero mismatches. No requested Pi license
text remains unresolved. Other third-party notices still apply.

For other packages, resolve missing or conflicting information against an
authoritative source for the exact version. A package list or lockfile alone
does not establish that a runtime bundle contains all required notices.

## Runtime bundles

A source distribution and a bundle containing Node.js, npm, native modules or
other executables have different inventories. If a package includes those
components, retain their own license and third-party notices and record their
versions, platform and origin. Include development dependencies in the
inventory if the archive ships them.

This repository distributes source and does not bundle a Node executable.
If redistributing Node, preserve its entire official `LICENSE`, including its
third-party notices, and all original license texts shipped with production
npm dependencies. Verify the actual distribution and its supported platforms;
the source repository's checks do not establish new-PC or offline operation.

## Design references

Workbench's upstream Swarm Forge review did not find a repository license
grant in the inspected sources. Workbench uses independently implemented design
ideas; do not copy upstream Swarm Forge code, prompts or documentation into a
release without a valid permission grant.

ECC was reviewed for design inspiration. No ECC implementation or prompt text
was imported into Workbench. This acknowledgment does not imply that ECC is
bundled, installed, required at runtime or endorses Workbench.

Any later copied or adapted third-party material needs an explicit provenance
record and its applicable notices. Preserve dependency licenses regardless of
whether a dependency was inspired by, or associated with, either project.
