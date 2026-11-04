---
title: Drop PostgreSQL Support - Plan
type: refactor
date: 2026-11-03
deepened: 2026-11-03
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Drop PostgreSQL Support - Plan

## Goal Capsule

- **Objective:** Contributors write and test each HoV Router schema change once, for SQLite. Production keeps running on its existing database with no data change. An install still configured for PostgreSQL stops at startup with a message saying what changed, instead of quietly starting on a different, empty database.
- **Means:** delete the PostgreSQL backend in one PR and put a startup refusal where its selector was (KTD1, KTD2).
- **Authority:** the Product Contract's R-IDs win on behavior and the KTDs win on mechanism. AGENTS.md's protected names, generated-file ban and Anthropic testing restriction bind every unit. Where the code at implementation time disagrees with a line number here, the code wins; line numbers are as of `origin/main` 337c80cd.
- **Execution profile:** one PR with five units, U1 to U5, executed in order. It waits on PR #713 merging (merge only, no deploy); if #713 is closed unmerged instead, follow the fallback under Dependencies and continue without stopping. Codex implements; the delegating session reviews the diff and owns the PR.
- **Who finishes:** the PR-owning session runs the Verification Contract, opens the PR, runs the one pro-gate round this diff requires (it touches `.github/` and the migration files), and merges once CI is green. The first deploy after the merge is a separate full restart that needs an explicit operator go (see Deploy and rollback).
- **Stop conditions:** stop and report instead of continuing when any of these holds.
  - The running production binary's environment contains a `DATABASE_URL` that starts with `postgres://` or `postgresql://`.
  - A unit appears to need a SQLite schema or data change, meaning any edit to `packages/database/src/migrations.ts` beyond comments.
  - A protected name from AGENTS.md would change.
  - Evidence appears that someone outside the maintainers runs PostgreSQL, such as an issue or a support report.

---

## Product Contract

### Summary

HoV Router drops its PostgreSQL backend, and SQLite becomes the only database. A `DATABASE_URL` that selects PostgreSQL today makes the server and every CLI command that opens the database exit at startup with a message pointing to the migration guide; commands that never open it, such as `--version` and `--help`, keep working. The PostgreSQL schema file, the PostgreSQL branches in the runtime, the CI database service, the PostgreSQL-only tests and the dual-migration rule all go. SQLite behavior, its schema, the required CI checks and every protected name stay as they are.

### Problem Frame

Upstream (tombii/better-ccflare) added PostgreSQL on 2026-03-03 for multi-pod Kubernetes deployments. This fork runs one process on SQLite in production and has no known PostgreSQL user: an issue search on 2026-11-03 found only maintainer issues mentioning it (#233, #464). The cost falls on every schema change. `packages/database/src/migrations-pg.ts` is 2,941 lines, 34 PostgreSQL migration commits landed in 90 days, and AGENTS.md requires a five-step port for each SQLite migration. CI also runs a `postgres:16` service and three PostgreSQL-only steps on every PR. Idea 3 of the 2026-11-03 upstream-teardown ideation audited the downsides and found the constraints this plan handles.

### Requirements

**Database selection and refusal**

- R1. With `DATABASE_URL` unset or empty, the server and every CLI command use SQLite exactly as today, including `BETTER_CCFLARE_DB_PATH` and the default `better-ccflare.db` location.
- R2. A `DATABASE_URL` starting with `postgres://` or `postgresql://` (case-sensitive, the exact set that selects PostgreSQL today) makes the server and every command that opens the database exit non-zero before any database file is opened. Commands that never open the database (`--version`, `--help`, `--show-config`, `--convert-family-policy-aliases`, `--get-model` and `--set-model`) keep working, since they cannot fall back to SQLite. It prints a message saying PostgreSQL support was removed, how to proceed and where the migration guide section is, and it never prints the URL, which can carry a password.
- R3. Any other `DATABASE_URL` value is ignored, as it is today, with no new warning.

**Data and rollback**

- R4. The existing production SQLite database opens unchanged: no SQLite schema change, no data migration, and the multi-instance guard keeps writing `'sqlite'` to its NOT NULL `db_dialect` column, so the previous binary still opens the database after a rollback.

**Removal**

- R5. The PostgreSQL schema file, the PostgreSQL branches in the adapter, retry logic, repositories, multi-instance guard, server and CLI commands, and the PostgreSQL-only tests and scripts are deleted, and no `isSQLite` dialect flag remains in runtime code.
- R6. The PostgreSQL-only environment variables stop being read: `BETTER_CCFLARE_DB_POOL_MAX`, `BETTER_CCFLARE_DB_IDLE_TIMEOUT`, `BETTER_CCFLARE_DB_STATEMENT_TIMEOUT`, `BETTER_CCFLARE_DB_CLIENT_TIMEOUT`, `BETTER_CCFLARE_DB_PG_PREPARE`, `BETTER_CCFLARE_TEST_POSTGRES_URL` and the `CCFLARE_REQUIRE_LIVE_PG_*` family. `BETTER_CCFLARE_DB_CLEANUP_BATCH_SIZE` and every SQLite setting keep working.

**CI, deploy and release tooling**

- R7. The required checks `managed-routing-foundation` and `prepare` keep their names and still pass. `.github/workflows/managed-routing-postgres.yml` keeps its path, its display name "Managed Routing Foundation Gate" and its job id; only the postgres service, the PostgreSQL steps and the PostgreSQL exclusion go.
- R8. The deploy script's schema-change detection keeps working with only the SQLite migration file, and the first deploy after this change counts as a schema change.

**Contributor rules and docs**

- R9. AGENTS.md no longer requires porting migrations to PostgreSQL, and UPSTREAM.md's protected contracts no longer promise SQLite/PostgreSQL migration parity. Both changes land in the same merge as the deletion.
- R10. User docs describe SQLite as the only backend. A break notice in `docs/hov-router-migration.md` tells anyone on `DATABASE_URL` how to stay on the last release with PostgreSQL support or start fresh on SQLite, and lists the variables R6 removes.
- R11. Every protected name in AGENTS.md stays unchanged.

### Acceptance Examples

- AE1. Covers R2.
  - **Given** `DATABASE_URL=postgresql://user:s3cret@db.example/x`, set in the environment or in a `.env` file the CLI loads (`.env` in the working directory, `../../.env`, or beside the entrypoint, per `apps/cli/src/startup-env.ts`),
  - **When** the operator runs `better-ccflare --serve` or any other command that opens the database, such as `--list`,
  - **Then** the process exits non-zero within seconds, stderr carries the refusal, no `better-ccflare.db`, `-wal` or `-shm` file exists afterwards, no connection to the host is attempted, and `s3cret` appears nowhere in the output.
- AE2. Covers R1, R3.
  - **Given** `DATABASE_URL` is empty, or `mysql://x`, or `POSTGRES://x`, or `sqlite:///tmp/x.db`,
  - **When** the server starts,
  - **Then** it uses SQLite at `BETTER_CCFLARE_DB_PATH` or the default path, exactly as v3.7.1 does. A `sqlite://` URL does not choose the file; `docs/database.md` claims it does today, and R10 corrects that.
- AE3. Covers R4.
  - **Given** the production database written by v3.7.1,
  - **When** the new build starts on it, and later the operator rolls back to the previous pinned binary,
  - **Then** both builds open it without a migration error, and the guard row's `db_dialect` reads `sqlite` throughout.
- AE4. Covers R8.
  - **Given** a deploy of a commit that includes this change,
  - **When** `scripts/deploy-ccflare.sh` computes `SCHEMA_DIGEST`,
  - **Then** it hashes only `packages/database/src/migrations.ts`, the digest differs from the running build's, `backend_handoff_eligible` returns false, and the deploy does a full restart rather than aborting.

### Key Decisions

- **SQLite becomes the only database.** (session-settled: user-approved — chosen over keeping PostgreSQL as a supported backend: production and every known install run SQLite, and the dual-migration rule taxes every schema change.) Governs R1, R5, R6, R9, R10.
- **A PostgreSQL URL is refused, not ignored.** Ignoring it would start the router on a different, empty SQLite database while the operator believes it is on PostgreSQL. Governs R2.
- **No PostgreSQL-to-SQLite migration tool.** No user of the PostgreSQL backend is known, and the break notice offers staying on the last release that supports it. Governs R10.
- **The change ships as a breaking release.** The PR title carries `feat!:` and the body a `BREAKING CHANGE:` footer, so release-please proposes a major version. Governs R10.

### Scope Boundaries

Not built, though considered:

- A warning for `DATABASE_URL` values other than the two PostgreSQL schemes.
- A PostgreSQL-to-SQLite data migrator.
- Renaming `managed-routing-postgres.yml`, its display name or its job id; release tooling pins all three (KTD7).
- A distinct exit code for the refusal (KTD3).
- Fixing the SQLite arm of `BunSqlAdapter.transaction()`, which does not run `fn` inside a transaction (`packages/database/src/adapters/bun-sql-adapter.ts:601-615`). This predates the change; the PR body flags it and this PR leaves it alone.

Left unchanged on purpose:

- The `BunSqlAdapter` class name, `DatabaseOperations.initializeAsync`, `DatabaseFactory.getInstanceAsync`, and the `db_dialect` column (KTD5, KTD8).
- Release and install tests that scrub `DATABASE_URL` from child environments (`apps/cli/__tests__/prepare-router-artifacts.test.ts:259`, `prepare-router-release.test.ts:144,741,765`, `source-install.test.ts:95`), and the advice at `docs/agent-setup.md:37` to exclude an ambient `DATABASE_URL`. An ambient PostgreSQL URL now triggers the refusal, so these stay useful.
- History: `docs/acknowledgements.md`, `docs/plans/`, `docs/reports/`, `docs/ideation/`, and the bodies of `docs/solutions/` learnings.
- The generated inline worker files AGENTS.md bans.

### Dependencies

- **PR #713 merges first; it does not need to deploy.** It edits `AGENTS.md`, `UPSTREAM.md` and `docs/hov-router-migration.md`, all of which U5 also edits, and it deletes `scripts/rehearse-upstream-sync-migrations.ts`, which has a postgres mode. Fallback if #713 is closed unmerged: U2 also strips the postgres dialect from that script and its test (`scripts/__tests__/rehearse-upstream-sync-migrations.test.ts`), and U5 edits the pre-#713 wording.
- **Open issues this makes moot:** item 1 of #233 (verify the live-PostgreSQL gate) and the PostgreSQL acceptance items in #464 (move foundation validation to an ARC pool). The PR body cites them with `Refs`, and the PR owner comments on each after the merge; neither is closed.
- **Release PR #600** (`chore(main): release 3.8.0`). If it publishes before this merges, 3.8.0 becomes the last release with PostgreSQL support; otherwise that release is v3.7.1. U5's break notice names whichever is true at implementation time.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **One PR, five units, in dependency order.** U1 adds the refusal test-first in place of the PostgreSQL selector. U2 deletes the schema file and everything that stops compiling or passing without it. U3 removes `isSQLite` readers outside `packages/database`. U4 collapses the database package and deletes the flag. U5 rewrites the rules and docs. The deletion needs a full restart in any case, and AGENTS.md's rule change must land with it, so a second PR would add a review and merge cycle without avoiding the restart. Governs R2, R5, R9.
- KTD2. **The refusal is one predicate, `assertNotPostgresUrl()`, called at two points.** Every database open goes through the `DatabaseOperations` constructor: `DatabaseFactory` (`packages/database/src/factory.ts:85`, used by server startup at `apps/server/src/server.ts:1593-1594` and by the CLI at `apps/cli/src/main.ts:1361,1587`), `packages/proxy/src/usage-collector.ts:2573`, and `packages/cli-commands/src/commands/rebuild-windows.ts:87`. But `DatabaseFactory.getInstance()` first runs `migrateFromCcflare()` (`factory.ts:55`), which copies a legacy `ccflare.db` (and its `-wal` and `-shm`) to `better-ccflare.db` before the constructor runs, so a constructor-only guard would leave files behind and break R2. The guard therefore runs first in `getInstance()`, before `migrateFromCcflare()`, and again at the top of the constructor for the two direct constructions. `getInstanceAsync` calls `getInstance`, so it needs no third call. A named error class carries the message, which uses `PRODUCT_NAME` from `@better-ccflare/core/product-identity` when the database package can import it without a cycle. The predicate is the old selector's own test at `packages/database/src/database-operations.ts:542-547`, applied to the raw value. If a U1 test still finds a database file created before either call, the guard moves to the earliest shared point that precedes that open; the test decides.
- KTD3. **Exit code stays 1, and the runner and systemd unit are unchanged.** Under `ccflare-stack.service`, the runner retries a child that exits 1 three times in five minutes, then exits 75 (`scripts/run-ccflare-stack.sh:40-41,67,1070-1078`). systemd restarts it at most five times per 300 s (`StartLimitBurst=5`), then leaves the unit failed with the refusal in the journal. A distinct exit code would need runner, unit and deploy-validation changes (`scripts/deploy-ccflare-lib.sh:1185`) for a case production does not have.
- KTD4. **`--serve` must exit on the refusal, not hang.** `startServerWithConfig` calls `startServer` without awaiting it (`apps/cli/src/main.ts:321`), and nothing in the repo registers an `unhandledRejection` handler. The U1 spawned test decides: if the process stays alive after the rejection, add a catch at that call site that prints the error and exits 1, in the style of the EADDRINUSE fail-fast at `apps/server/src/server.ts:2768-2784`. Other CLI commands already reach `main().catch` (`apps/cli/src/main.ts:2041-2045`), which prints `Error:` and exits 1.
- KTD5. **The dialect column and the async init surface stay.** `db_dialect TEXT NOT NULL` (`packages/database/src/migrations.ts:1095`) keeps receiving the literal `'sqlite'` from `packages/database/src/multi-instance-guard.ts`. `initializeAsync` (`database-operations.ts:715-731`) stays because it runs `runStartupGuard` and `startHeartbeatLoop` for SQLite; only its PostgreSQL lines (:716-719) go. Governs R4.
- KTD6. **The deploy digest drops `migrations-pg.ts`, and a test checks that every listed path exists.** The list is inline at `scripts/deploy-ccflare.sh:472-475`. A missing listed file makes the inline `node` call throw, and `set -Eeuo pipefail` (:58) then aborts the deploy after the build and pin backup but before any restart. CI never runs the deploy, so a test in `scripts/__tests__/deploy-ccflare.test.ts` that reads the script source (as its existing contract tests do at :398) is the only automated proof of this edit. The changed digest input makes the first deploy a full restart, which is the safe direction. Governs R8.
- KTD7. **CI keeps the workflow file, display name and job id.** The ruleset requires `managed-routing-foundation`. Release tooling pins the file and display name at `scripts/router-release.ts:427,432,438-442` and `scripts/router-release-assets.ts:31-32`, and tests pin them at `scripts/__tests__/router-release.test.ts:451,466`, `scripts/__tests__/router-release-workflow.test.ts:67,405` and `tests/bun-toolchain-pin.test.ts:10`. The file name keeps saying "postgres", which is cosmetic. `DATABASE_URL` is set only at step level in that workflow (L71, L81), so the remaining steps and the full-suite loop already run without it. Governs R7.
- KTD8. **`BunSqlAdapter` keeps its name and its SQLite behavior, and its constructor takes only a `Database`.** Delete the PostgreSQL overload and branch (:279, :285-288), the `sql` field, `convertPlaceholders` (:31-112), `PG_CLIENT_QUERY_TIMEOUT_MS` (:114-132), `getSQL`, `pgSql`, `withPgTimeout` and `withPgIntegerSizeRetry` (:303-369), the PostgreSQL tails of the query methods, `transaction`, `unsafe` and `close` (:413-672), and `readerFor`'s early return (:175). Keep `getCleanupBatchSize`, `withBusyRetry`, `viaWriter`, `readerFor` and `getSQLiteDb`. When an arm collapses, keep the SQLite arm's SQL text verbatim.
- KTD9. **Unique-violation detectors drop SQLSTATE `23505` and keep their SQLite checks.** The sites are `packages/http-api/src/handlers/account-public-value.ts:25,31-32`, `packages/http-api/src/handlers/accounts.ts:940,956` and `packages/oauth-flow/src/index.ts:44,48`. Each must still recognize `SQLITE_CONSTRAINT_UNIQUE` after the edit.
- KTD10. **The breaking marker rides in the PR title and body.** The repository squashes with the PR title as subject and the PR body as message (`squash_merge_commit_title: PR_TITLE`, `squash_merge_commit_message: PR_BODY`). So `feat!:` in the title drives the major bump (`docs/hov-router-releases.md:212-214`), and a `BREAKING CHANGE:` footer in the body reaches the changelog. Nobody bumps the version by hand.

### High-Level Technical Design

How `DATABASE_URL` is handled after the change, on every entry path:

```mermaid
flowchart TB
  ENV["DATABASE_URL from the process env, or from the first non-empty .env the CLI loads"] --> CTOR["assertNotPostgresUrl: first in DatabaseFactory.getInstance, before the legacy ccflare.db copy; and atop the DatabaseOperations constructor, for usage-collector and rebuild-windows"]
  CTOR --> Q{"Starts with postgres:// or postgresql:// ?"}
  Q -->|"no: unset, empty, any other value"| SQLITE["Open SQLite at BETTER_CCFLARE_DB_PATH or the default better-ccflare.db"]
  Q -->|"yes"| REFUSE["Throw the refusal before any file is opened; the URL is never printed"]
  REFUSE --> ENTRY{"Entry path"}
  ENTRY -->|"CLI command"| CATCH["main().catch prints the message, exit 1"]
  ENTRY -->|"--serve"| SERVE["startServer rejection ends the process with exit 1 (KTD4)"]
  CATCH --> SEEN["Operator reads the message"]
  SERVE --> UNIT{"Running under ccflare-stack.service?"}
  UNIT -->|"no"| SEEN
  UNIT -->|"yes"| RUNNER["Runner retries 3 times in 5 minutes, then exits 75"]
  RUNNER --> SYSTEMD["systemd restarts at most 5 times per 300 s, then leaves the unit failed"]
  SYSTEMD --> JOURNAL["Refusal is in the journal"]
```

Unit order, the PR and the deploy:

```mermaid
flowchart TB
  P713["PR #713 merged"] --> BRANCH["Branch from freshly fetched origin/main"]
  BRANCH --> U1["U1 refusal, test-first"]
  U1 --> U2["U2 delete schema file, PG tests, CI steps, digest entry"]
  U2 --> U3["U3 remove isSQLite readers outside packages/database"]
  U3 --> U4["U4 collapse packages/database, delete isSQLite"]
  U4 --> U5["U5 AGENTS.md, UPSTREAM.md, docs, break notice"]
  U5 --> PR["One PR: feat! title, BREAKING CHANGE footer"]
  PR --> GATE["Required checks green, one pro-gate round"]
  GATE --> MERGE["Squash merge; merging never deploys"]
  MERGE --> RP["release-please updates its draft release PR to a major version"]
  MERGE --> GO{"Operator go for a full restart?"}
  GO -->|"not yet"| HOLD["Production stays on the previous build"]
  GO -->|"yes"| DEPLOY["scripts/deploy-ccflare.sh: digest changed, full restart"]
  DEPLOY --> CHECK["/health git_sha matches, WAL advancing, requests succeeding"]
```

### Assumptions

- **Production runs SQLite with no PostgreSQL configuration.** Verified 2026-11-03 at about 21:31-21:45 EST:
  - `systemctl show ccflare-stack.service` lists no `DATABASE_URL` in `Environment=`.
  - The only running router process, pid 4179860, executing `better-ccflare-v3.7.1-337c80cd-…`, has no `DATABASE_URL` or `BETTER_CCFLARE_DB_*` variable in `/proc/4179860/environ`. That environment includes anything the two root-only `EnvironmentFile`s supply.
  - `better-ccflare.db-wal` was written the same second it was checked.
  - Residual: production could change before the deploy, so the deploy preflight repeats the environ check.
- **No one outside the maintainers runs PostgreSQL.** This is unmeasured: customer installs report nothing back, and the issue search found only maintainer issues. Residual: a silent PostgreSQL user breaks on upgrade. The refusal message and break notice are the mitigation, and they make the break loud instead of silent.
- **The bump is to 4.0.0.** This is inferred from release-please's major rule plus the 3.x line; release-please computes the actual number.
- **Bun's behavior on the unawaited rejection is unknown.** KTD4 leaves it to the U1 test.
- **Line numbers are as of 337c80cd.** #713 and later merges shift some of them; the implementer re-locates each by its anchor text.

### Alternatives Considered

- **Keep PostgreSQL but freeze it, with no new PostgreSQL migrations.** Rejected: a frozen schema diverges from SQLite on the next migration, so any install still on PostgreSQL breaks at a random later release instead of at a declared one.
- **Ignore a PostgreSQL URL and start on SQLite.** Rejected: the operator would see an empty router and could run two stores side by side without knowing it (Key Decisions).
- **Ship the refusal first as its own PR and backend-only deploy.** Rejected: the deletion PR still changes the schema digest and needs a full restart, so the split adds a review and merge cycle and saves no restart (KTD1).
- **Refuse in the CLI entrypoint only.** Rejected: `usage-collector` and `rebuild-windows` construct `DatabaseOperations` directly, so an entrypoint check would leave paths that open SQLite anyway (KTD2).

### Risks

| Risk | Mitigation |
|---|---|
| An unknown PostgreSQL user upgrades and the router refuses to start | R2's message plus R10's notice name both ways out: stay on the last release with PostgreSQL support, or unset `DATABASE_URL` and start fresh |
| A host with a PostgreSQL URL loops restarts under systemd | Bounded by the runner's retry cap and `StartLimitBurst` (KTD3); production verified clean, and the deploy preflight rechecks |
| The deploy aborts on a missing digest path | KTD6's test fails in CI before merge |
| Test call sites go stale, because the root typecheck excludes tests | Search call sites with `grep -a` and run every touched suite one file at a time (Verification Contract; `docs/solutions/workflow-issues/typecheck-does-not-cover-test-call-sites.md`) |
| A full `bun test` batch shows mock-isolation failures that are not real | Run suites singly, as CI's loop does |
| Collapsing an arm changes the SQL production runs | Keep the SQLite arm's text verbatim (KTD8); the stats, usage-history and cache-health suites cover the collapsed sites |
| Text conflicts with #713 | Wait for #713 to merge, then branch from fresh `origin/main` |

### Deploy and rollback

- **Gate:** the first deploy after the merge is a full-stack restart (R8, AE4) and needs an explicit operator go every time. Merging never deploys.
- **Preflight:** recheck the running binary's `/proc/<pid>/environ` for `DATABASE_URL`, then run `scripts/deploy-ccflare.sh --check` from a clean main clone.
- **After the restart:** `/health` reports the new `git_sha`, `better-ccflare.db-wal` keeps advancing, and recent requests succeed.
- **Rollback:** restore the previous binary pin. The database needs no step because the schema did not change (R4, AE3).

---

## Implementation Units

### U1. Refuse a PostgreSQL DATABASE_URL at startup, test-first

- **Goal:** a PostgreSQL URL stops every entry path that opens the database with the R2 message before any database file is touched; every other value behaves as today.
- **Requirements:** R1, R2, R3, R6 (the pool variables stop being read here).
- **Dependencies:** PR #713 merged; branch from freshly fetched `origin/main`.
- **Files:**
  - New: a small refusal module in `packages/database/src/` holding the named error class and `assertNotPostgresUrl()`, exported through `packages/database/src/index.ts` only if a caller outside the package needs them.
  - `packages/database/src/factory.ts`: call `assertNotPostgresUrl()` first in `getInstance()`, before `migrateFromCcflare()` (:55).
  - `packages/database/src/database-operations.ts`: replace the PostgreSQL arm of the selector (:542-603) with the guard; the SQLite arm becomes the only path.
  - `apps/cli/src/main.ts`: only if KTD4's test requires the catch at :321.
  - Tests: `packages/database/src/__tests__/db-constructor-file-mode.test.ts` keeps its `DATABASE_URL` scrub (:37-48), with the constructor tests added beside it; a new spawned-CLI test under `apps/cli/__tests__/`, following the spawn style of `apps/cli/__tests__/cli.test.ts`.
- **Approach:** write the tests first and watch them fail, then add the guard (KTD2). The spawned test sets a temporary `HOME` and `XDG_CONFIG_HOME`, an unused port (not 8080, 8081, 8788 or 8789), `DATABASE_URL=postgresql://user:s3cret@synthetic.invalid/never-connect`, and a timeout of about 20 s. It runs after `bun run build:cli`, because a fresh worktree lacks the generated workers. No account exists in the temporary home, so nothing reaches any provider.
- **Test scenarios:**
  - The constructor throws the named error for `postgres://…` and `postgresql://…`, and the temporary directory holds no database file afterwards.
  - The constructor opens SQLite as before for unset, empty, `mysql://x`, `POSTGRES://x` and `sqlite:///tmp/x.db`.
  - `DatabaseFactory.getInstance()` with the PostgreSQL URL and a legacy `ccflare.db` seeded at the path the legacy-config helper resolves under the temporary home throws the named error, and no `better-ccflare.db*` file exists afterwards.
  - `--serve` with the PostgreSQL URL exits non-zero before the timeout; stderr contains the refusal; neither stdout nor stderr contains `s3cret`; no `better-ccflare.db*` file exists (AE1).
  - `--list` with the same environment exits non-zero with the refusal.
  - `--version` with the same environment exits 0 and prints the version, because it never opens the database (R2).
  - A `.env` in the spawned process's working directory supplying the URL produces the same refusal.
- **Verification:** each new and touched test file passes on its own with `bun test <file>`.

### U2. Delete the PostgreSQL schema and everything that depends on it

- **Goal:** `migrations-pg.ts` and every test, script, CI step and deploy input built on it are gone, and the deploy digest still works.
- **Requirements:** R5, R6, R7, R8.
- **Dependencies:** U1.
- **Files:** delete and edit per Appendix A.1. The main edits are:
  - `packages/database/src/database-operations.ts`: the `ensureSchemaPg`/`runMigrationsPg` import at :69 and the PostgreSQL lines of `initializeAsync` (:716-719), per KTD5.
  - `scripts/deploy-ccflare.sh:472-475`, plus the KTD6 test in `scripts/__tests__/deploy-ccflare.test.ts`.
  - `.github/workflows/managed-routing-postgres.yml`.
  - `scripts/__tests__/upstream-review-workflow-security.test.ts:83-98`.
  - Comments that cite the file: `packages/database/src/migrations.ts:659` and `packages/database/src/multi-instance-guard.ts:36`.
- **Approach:**
  - **Workflow:** delete the `services:` block (L17-30), the three PostgreSQL steps (L67-92), and the full-suite exclusion with its comment (L103-108, L112). Keep everything else, including the focused SQLite step and the full-suite loop (KTD7).
  - **Shape test:** rename it to describe the foundation gate and Bun pin, and drop its `postgres:16` image and `DATABASE_URL` expectations; keep the runs-on test (:67-81).
  - **Mixed tests:** where a test file mixes SQLite and PostgreSQL cases, delete only the PostgreSQL blocks. Where a text-reader asserts SQLite/PostgreSQL parity, keep any assertion that still holds for SQLite alone, for example the `ROUTING_ATTEMPT_REASON_SQL` import check in `packages/database/src/routing-attempt-migrations.test.ts:445-460`.
- **Test scenarios:**
  - The new deploy test extracts the digest path list from `scripts/deploy-ccflare.sh` and asserts every listed path exists in the repository. It fails against the old list once `migrations-pg.ts` is deleted.
  - The reworked shape test passes against the edited workflow.
  - Every edited test file from Appendix A.1 passes alone.
- **Verification:**
  - `grep -a -rn` finds no `migrations-pg`, `ensureSchemaPg`, `runMigrationsPg`, `BETTER_CCFLARE_TEST_POSTGRES_URL` or `CCFLARE_REQUIRE_LIVE_PG` outside history docs.
  - The release-tooling tests named in KTD7 still pass.

### U3. Remove PostgreSQL branches outside the database package

- **Goal:** no code outside `packages/database` reads `isSQLite` or carries a PostgreSQL arm, so U4 can delete the flag.
- **Requirements:** R5.
- **Dependencies:** U2.
- **Files:** per Appendix A.2:
  - `apps/server/src/server.ts:1619`.
  - `packages/cli-commands/src/commands/database-repair.ts` and `rebuild-windows.ts`.
  - `packages/http-api/src/services/alerts.ts:2517-2519`.
  - The three KTD9 detector sites.
  - `packages/proxy/src/integrity-scheduler.ts`.
  - PostgreSQL comments in `packages/proxy/src/auto-refresh-scheduler.ts`, `packages/proxy/src/usage-collector.ts`, `packages/proxy/src/session-account-observer.ts`, `packages/types/src/account.ts:621` and `packages/types/src/request.ts:882`.
  - The tests listed in A.2.
- **Approach:** collapse each branch to its SQLite arm unchanged. Where `alerts.ts` already uses `INSERT OR IGNORE` on the SQLite arm, keep that text. Keep the `DATABASE_URL=""` lines in the four http-api tests and the proxy environment scrubs, because R1 treats empty as unset and an ambient PostgreSQL URL would now trigger the refusal. Update only the comments there that say they prevent PostgreSQL selection.
- **Test scenarios:**
  - Each KTD9 detector still classifies a real `SQLITE_CONSTRAINT_UNIQUE` error as a duplicate.
  - `database-repair` and `rebuild-windows` behave as before on SQLite. Delete the PostgreSQL-only case at `rebuild-windows.test.ts:364`.
  - `integrity-scheduler.test.ts:412` keeps its SQLite meaning under a name without "PostgreSQL".
- **Verification:**
  - `grep -a -rn -w isSQLite apps packages` lists only files inside `packages/database`.
  - Every touched test file passes alone.

### U4. Collapse the database package to SQLite and delete the dialect flag

- **Goal:** the adapter, retry logic, repositories, guard and `DatabaseOperations` have one SQLite path, and `isSQLite` no longer exists.
- **Requirements:** R4, R5, R6 (the adapter's client-timeout variable stops being read here).
- **Dependencies:** U3.
- **Files:** per Appendix A.3:
  - `packages/database/src/adapters/bun-sql-adapter.ts` (KTD8).
  - `packages/database/src/retry.ts`: `RETRYABLE_PG_ERRORS` at :16-28 and its use at :47-49.
  - `packages/database/src/multi-instance-guard.ts`: PostgreSQL arms at :174-196, :217-220 and :260-264; `dialect` at :150 becomes the literal `'sqlite'` (KTD5).
  - `packages/database/src/repositories/account.repository.ts`: the advisory-lock arm at :704-717 and its constant at :12-14.
  - `usage-history.repository.ts:283,290`, `cache-health.repository.ts:16` (drop the `sqlite` parameter from `cacheHealthBucketQuery`), and `stats.repository.ts:117,133`.
  - `packages/database/src/database-operations.ts`: the imports at :51 and :122 as they become unused, the public `isSQLite` at :444, the PostgreSQL `SELECT 1` blocks at :822-826 and :846-850, and the dialect check at :2144.
  - The tests in A.3.
- **Approach:** delete each PostgreSQL arm and keep the SQLite arm's code and SQL verbatim (KTD8). Tests that build a fake adapter with `isSQLite: false` lose those cases. `usage-history.repository.test.ts:617-661` becomes assertions on the SQLite SQL rather than a dialect comparison.
- **Test scenarios:**
  - The multi-instance guard still writes and reads `db_dialect = 'sqlite'` (AE3).
  - The account repository's SQLite locking path still serializes as before.
  - The stats lifetime aggregation, usage-history, cache-health, cleanup-config and off-thread-reader suites pass with only SQLite cases.
- **Verification:**
  - `grep -a -rn -w isSQLite apps packages` returns nothing.
  - `grep -a -rn` for `23505`, `pg_advisory`, `PG_CLIENT_QUERY_TIMEOUT_MS`, `convertPlaceholders` and `RETRYABLE_PG_ERRORS` returns nothing outside history docs.
  - Every touched test file passes alone.

### U5. Rewrite the rules and docs, and publish the break notice

- **Goal:** contributor rules and user docs describe a SQLite-only router, and a PostgreSQL user finds a clear way forward.
- **Requirements:** R9, R10, R11.
- **Dependencies:** U4.
- **Files:**
  - `AGENTS.md`: drop the "Port to PostgreSQL" section (:123-135 before #713) and the PostgreSQL line in the testing guidance (:146).
  - `UPSTREAM.md`: the "SQLite/PostgreSQL migration … parity" protected contract, located by its wording in #713's rewritten file.
  - `docs/hov-router-migration.md`: the "Database override" row (:28 before #713), plus a new "PostgreSQL support removed" section that the refusal message points to.
  - `docs/database.md`, including the false `sqlite://` claim at :16 and the PostgreSQL variables at :366-377.
  - `docs/configuration.md:140,918,1011-1060`, `docs/deployment.md:35,660-800,1101-1102`, `docs/architecture.md:1387-1408`, `docs/reference.md:46,57,408`, `docs/combos.md:328`, `docs/systemd.md:313`, and `docs/routing-architecture.md:190`.
  - A one-line superseded note on `docs/solutions/workflow-issues/typecheck-does-not-cover-test-call-sites.md`, and on any other learning whose instructions still require PostgreSQL steps.
- **Approach:**
  - **Break notice:** say what changed and why, and name the last release with PostgreSQL support after checking `gh release list` and #600's state.
  - **Ways forward:** pin that release, or unset `DATABASE_URL` and start fresh on SQLite. Say that no migration tool exists.
  - **Removed variables:** list R6's variables.
  - **Refusal message:** the heading text must match what U1's message cites.
- **Test scenarios:** none new. U1's refusal test asserts the message's pointer text, so a heading change shows up there.
- **Verification:**
  - `grep -a -rn -i postgres AGENTS.md UPSTREAM.md docs --exclude-dir=plans --exclude-dir=reports --exclude-dir=ideation --exclude-dir=solutions` returns only the break notice, the migration-guide row and `docs/acknowledgements.md`.
  - `docs/solutions` is excluded because learning bodies are history and stay unchanged (Scope Boundaries); instead, each learning there whose instructions still require PostgreSQL steps carries the one-line superseded note.
  - `bun run format` leaves the docs clean.

---

## Verification Contract

| Check | Command | When |
|---|---|---|
| Fresh-worktree setup | `bun install --frozen-lockfile && bun run build:cli` | Before the first test run |
| Touched suites | `bun test <file>`, one file at a time, for every added, edited or renamed test file | After each unit |
| Spawned refusal test | `bun test apps/cli/__tests__/<new refusal test>` | U1 onward |
| Deploy digest test | `bun test scripts/__tests__/deploy-ccflare.test.ts` | U2 onward |
| Release tooling pins | `bun test scripts/__tests__/router-release.test.ts`, `scripts/__tests__/router-release-workflow.test.ts`, `tests/bun-toolchain-pin.test.ts`, `scripts/__tests__/upstream-review-workflow-security.test.ts` (add `--timeout 60000` locally if the host is loaded) | U2 and before the PR |
| Lint, types, format | `bun run lint && bun run typecheck && bun run format` | After each unit and before the PR |
| Residue search | `grep -a -rn` for `migrations-pg`, `ensureSchemaPg`, `runMigrationsPg`, `isSQLite`, `PG_CLIENT_QUERY_TIMEOUT_MS`, `convertPlaceholders`, `RETRYABLE_PG_ERRORS`, `pg_advisory`, `23505`, `BETTER_CCFLARE_DB_POOL`, `BETTER_CCFLARE_DB_IDLE_TIMEOUT`, `BETTER_CCFLARE_DB_STATEMENT_TIMEOUT`, `BETTER_CCFLARE_DB_CLIENT_TIMEOUT`, `BETTER_CCFLARE_DB_PG_PREPARE`, `BETTER_CCFLARE_TEST_POSTGRES_URL`, `CCFLARE_REQUIRE_LIVE_PG` across `apps packages scripts tests .github` | Before the PR |
| CI | Both required checks green at the PR head; the `managed-routing-foundation` log shows no postgres service and the full-suite loop over every test file | On the PR |

- **Anthropic restriction:** no unit sends inference to any provider. The spawned test uses a temporary home with no accounts, and nothing in this plan calls the proxy with an Anthropic-backed account.
- **Generated files:** the AGENTS.md generated workers are never edited, searched into or staged; stage files by name.

---

## Definition of Done

**Global**

- Every R-ID holds, and AE1 to AE4 are each demonstrated by a passing test, or by the deploy checks for AE3 and AE4's runtime half.
- Every Verification Contract row passes, with output observed and not assumed.
- The PR title starts with `feat!:`, and the body carries a `BREAKING CHANGE:` footer, `Refs #233` and `Refs #464`, and the pre-existing `transaction()` note from Scope Boundaries.
- The one pro-gate round has no open P0 or P1.
- The PR is squash-merged with green required checks, and no issue is closed.
- No dead-end or experimental code remains in the diff, including abandoned helper files and commented-out PostgreSQL arms.
- The deploy has not run without an operator go.

**Per unit**

| Unit | Done when |
|---|---|
| U1 | The refusal tests fail before the guard and pass after it; `--serve` exits non-zero within the timeout; no database file is created; the URL's password never appears |
| U2 | `migrations-pg.ts` and the A.1 files are gone; the deploy digest test passes; the workflow has no postgres service or PostgreSQL step; the release-tooling tests pass |
| U3 | No `isSQLite` reader remains outside `packages/database`; the KTD9 detectors still catch SQLite unique violations |
| U4 | `isSQLite` is gone; the adapter constructor takes only a `Database`; the guard writes `'sqlite'`; every A.3 suite passes alone |
| U5 | AGENTS.md and UPSTREAM.md carry no PostgreSQL obligation; the break notice names the actual last release with PostgreSQL support and lists R6's variables; the refusal message's pointer matches the heading |

---

## Appendix

### A.1 U2 inventory: schema, PostgreSQL-only tests, scripts, CI

Delete:

- `packages/database/src/migrations-pg.ts`
- `packages/database/src/migrations-pg.test.ts`
- `packages/database/src/migrations-pg-add-column.test.ts`
- `packages/database/src/__tests__/managed-routing-postgres.integration.test.ts`
- `packages/database/src/__tests__/quality-route-postgres.integration.test.ts`
- `packages/database/src/adapters/__tests__/bun-sql-adapter-convert-placeholders.test.ts`
- `packages/database/src/adapters/__tests__/bun-sql-adapter-pg-integer-retry.test.ts`
- `packages/http-api/src/__tests__/pg-live-queries.test.ts`
- `scripts/apply-migrations.ts`, which is PostgreSQL-only and referenced nowhere else

Edit: tests that import `./migrations-pg`. Remove the import and the PostgreSQL blocks; keep the SQLite cases.

- `packages/database/src/__tests__/`: `device-setup-job-migrations`, `managed-routing-migrations`, `multi-instance-guard` (including the text-reader at :567-593 and the live block at :596-670), `native-quota-policy` (including the PostgreSQL policy-columns case at :73), `route-provenance-columns`, `server-tool-replay-issuance-migrations`
- `packages/database/src/repositories/__tests__/`:
  - `cache-flight-recorder` (:14)
  - `request-affinity-history` (:10; the `DATABASE_URL` live block at :38-62)
  - `request-attempt-summary` (:20)
  - `routing-attempt.repository` (:6; the `BETTER_CCFLARE_TEST_POSTGRES_URL` parity block from :407)
  - `server-tool-replay-issuance.repository` (:7)
  - `usage-windows.repository` (dynamic imports at :547, :578, :653 and :745, plus its live block)

Edit: tests that read `migrations-pg.ts` as text.

- `packages/database/src/migrations.test.ts:2020-2057`
- `packages/database/src/routing-attempt-migrations.test.ts:416-484` (keep the SQLite-only import assertion at :445-460)
- `packages/database/src/unified-ratelimit-migrations.test.ts:27-34`

CI and deploy:

- `.github/workflows/managed-routing-postgres.yml` (L17-30, L67-92, L103-108, L112)
- `scripts/__tests__/upstream-review-workflow-security.test.ts:83-98`
- `scripts/deploy-ccflare.sh:472-475`
- `scripts/__tests__/deploy-ccflare.test.ts` (new case)

### A.2 U3 inventory: outside `packages/database`

Runtime:

- `apps/server/src/server.ts:1619`
- `packages/cli-commands/src/commands/database-repair.ts:29-30,54-57,125,167-170`
- `packages/cli-commands/src/commands/rebuild-windows.ts:74,79-81`
- `packages/http-api/src/services/alerts.ts:2517-2519` and nearby comments
- `packages/http-api/src/handlers/account-public-value.ts:25,31-32`
- `packages/http-api/src/handlers/accounts.ts:940,956`
- `packages/oauth-flow/src/index.ts:44,48`
- `packages/proxy/src/integrity-scheduler.ts:24-26,280`

Comments only:

- `packages/proxy/src/auto-refresh-scheduler.ts`
- `packages/proxy/src/usage-collector.ts`
- `packages/proxy/src/session-account-observer.ts`
- `packages/types/src/account.ts:621` and `packages/types/src/request.ts:882`

Tests:

- `packages/cli-commands/src/commands/__tests__/rebuild-windows.test.ts:364` (delete that case)
- `packages/http-api/src/services/__tests__/auth-failure-alert.test.ts:198,282`
- `packages/proxy/src/__tests__/auto-refresh-proactive-requires-reauth.test.ts:243`
- `packages/proxy/src/__tests__/integrity-scheduler.test.ts:412` (rename)
- `packages/proxy/src/__tests__/quality-route-service.test.ts:501-502`
- `DATABASE_URL=""` lines, kept with comments only (R1): `packages/http-api/src/__tests__/router-public-subscription-value.test.ts:12`, `handlers/__tests__/public-subscription-value.test.ts:19`, `handlers/__tests__/public-value-roster.test.ts:19`, `services/__tests__/usage-window-read.test.ts:15`
- proxy scrubs, kept with comments only: `packages/proxy/src/__tests__/usage-collector-cache-health.test.ts:26-34`, `usage-collector-unified-ratelimit-headers.test.ts:27-34`

### A.3 U4 inventory: `packages/database` runtime and its tests

Runtime: the files named in U4's Files list.

Tests, all under `packages/database/src/`:

- `adapters/__tests__/bun-sql-adapter-batch.test.ts:71-108`
- `adapters/__tests__/bun-sql-adapter-returning.test.ts:5-10,52-96`
- `__tests__/cleanup-config.test.ts:8,62-71`
- `__tests__/off-thread-reader.test.ts:6,662-682`
- `__tests__/stats-lifetime-account-aggregation.test.ts:11,159-184`
- `repositories/__tests__/usage-history.repository.test.ts:617-661`
- `repositories/__tests__/cache-health.repository.test.ts:250` (the `cacheHealthBucketQuery` call)

Checked and out of scope: `__tests__/factory-retirement.test.ts` and `__tests__/factory-runtime-config.test.ts` have no PostgreSQL references.
