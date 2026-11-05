# Upstream relationship

- **Upstream:** https://github.com/tombii/better-ccflare
- **Fork type:** Product fork with intentional hard divergence
- **Sync cadence:** Targeted cherry-picks only. Wholesale release merges ended on 2026-11-03; see [Porting an upstream fix](#porting-an-upstream-fix). To port fixes from the wider fork network rather than from a release, follow [the fork-network survey method](docs/solutions/workflow-issues/survey-the-fork-network-then-check-each-port-applies-here.md)
- **Last wholesale merge:** upstream v3.5.78, [PR #339](https://github.com/StartupBros-com/better-ccflare/pull/339) (2026-09-10), with its [resolution inventory](docs/plans/2026-09-09-issue-338-v3.5.78-resolution-inventory.json) and [generated ledger](docs/plans/2026-09-09-issue-338-v3.5.78-resolution-ledger.md)

This repository is not a mirror. It substantially rewrites routing, provider,
persistence, provenance, and operator behavior for StartupBros. Default-branch
ahead/behind counts do not determine whether the fork is redundant or whether an
upstream update is safe.

## Why wholesale merges ended

A wholesale merge takes every upstream change since the last one as a single
two-parent merge and resolves every conflict by hand. The v3.5.78 merge needed a
dedicated 2,124-line ledger verifier. By 2026-11-03 upstream was 428 commits and
more than 300 files ahead (v3.6.2), against a fork that has rewritten routing,
providers and persistence. Porting the fixes that matter one at a time costs less
than resolving that merge, and deleting an inherited surface no longer turns every
later merge into a modify/delete conflict.

## Porting an upstream fix

When upstream ships a release, skim its changes for proxy, provider-protocol,
authentication, persistence and security fixes. For each candidate, run the four
checks in the [fork-network survey method](docs/solutions/workflow-issues/survey-the-fork-network-then-check-each-port-applies-here.md#5-before-porting-a-confirmed-fix-check-that-it-applies-here):
call path, production config, client behaviour, and kind of harm. Port only what
passes, as an ordinary PR with a test, crediting the upstream author.

A port must preserve, at minimum, these protected fork contracts:

- routing precedence, exact-account/model fail-closed behavior, model-route profiles,
  capability pools, session affinity, and strict-drain semantics;
- response provenance, terminal recovery order, stream ownership, cancellation, and
  exactly-once usage collection;
- fork providers and defaults, canonical provider identities, model mappings, and
  compatible-endpoint validation;
- Config-authoritative controls and default-off behavior for new routing features;
- SQLite migration, repository, retention, and active-window behavior;
- fork build/update provenance, runtime Git-SHA identity, deployment source gates,
  observability, and operator controls.

Deployment stays a separate operator-authorized action. `scripts/deploy-ccflare.sh`
ships only the freshly fetched `origin/main` tip, from any checkout. A merge, package
version, or ported fix does not prove the installed binary or running service identity.

Ordinary dashboard, npm, binary, or Docker update paths may resolve mutable
upstream-controlled artifacts. They must not replace this fork unless provenance
proves the intended producer and artifact mode. The StartupBros managed-source
build is deliberately non-actionable through the ordinary updater.

## Removed upstream surfaces

Do not port upstream changes to these. Each line says what replaced it, or what
would justify bringing it back.

- **npm, multi-architecture and SignPath publishers** (`release.yml`,
  `release-dispatch.yml`, `signpath-release.yml`, `signpath-test.yml`,
  `.signpath/`), the npm `prepublishOnly`/`postpublish` hooks, and the macOS,
  Windows and arm64 build aliases: removed 2026-11-03. Router releases come from
  `router-release.yml`; `build:multi` with `CCFLARE_ONLY_PLATFORMS` still builds
  any platform. `scripts/__tests__/router-release-workflow.test.ts` fails if a
  publisher workflow reappears.
- **PostgreSQL support** (`migrations-pg.ts`, the PostgreSQL adapter and repository
  arms, the `DATABASE_URL` backend switch): removed 2026-11-03; v3.7.1 is the last
  release that has it. Upstream PostgreSQL fixes are not ported. A PostgreSQL
  `DATABASE_URL` is refused at startup, see
  [PostgreSQL support removed](docs/hov-router-migration.md#postgresql-support-removed).
- **Docker image publishing workflow:** removed earlier; the
  [Docker guide](docs/docker.md) builds from source.
- **Wholesale-merge tooling** (`scripts/verify-upstream-sync-ledger.ts`,
  `scripts/rehearse-upstream-sync-migrations.ts` and their tests): removed
  2026-11-03; last present at commit `337c80cd`. Restore them from there only if a
  deliberate decision resumes wholesale merges.

## Why this file exists

An org-wide audit on 2026-07-24 found that comparing only the default branch made
several forks look like zero-delta mirrors when they actually carried unmerged
StartupBros fixes on side branches. Any future fork-pruning pass must enumerate and
author-check all branches and audit behavior, not just default-branch divergence.
This file sets how upstream fixes come in without promising automatic upstream
tracking or weakening intentional product-fork ownership.
