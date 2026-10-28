# Repository Agent Instructions

Instructions for any agent working on **HoV Router** (`hov-router`): a load balancer and gateway that routes Claude Code and other clients across multiple provider accounts, with a dashboard for usage, cost and errors. It is a House of Vibe project at [StartupBros/hov-router](https://github.com/StartupBros/hov-router), a product fork of [tombii/better-ccflare](https://github.com/tombii/better-ccflare) (MIT). `CLAUDE.md` only imports this file, so edit this one.

## ⚠️ CRITICAL: Testing Restrictions

**Anthropic-backed accounts, including the `claude` account, must only be used through a real interactive Claude Code CLI session, except for the managed gateway-routed headless Claude Code CLI sessions covered by the operator-approved exception below.** Interactive sessions remain permitted. The operator-approved exception (2026-10-07) also permits managed gateway-routed headless Claude Code sessions, including bounded tiny tool-free CLI acceptance checks. This exception does not authorize paid overages or a switch to Codex CLI.

**Raw scripted Anthropic inference remains prohibited** — directly and through the proxy: no curl, test harness, or diagnostic-script probes, whether or not you would call them "testing". Real Anthropic accounts can get banned for automated/scripted usage. For scripted API requests, use a non-Anthropic account (ollama, litellm, omniroute, etc.) and force-route with `x-better-ccflare-account-id`.

## ⚠️ CRITICAL: Names that must NOT be renamed

The product is HoV Router, but these operational names predate it and existing installs depend on them. A "consistency" rename breaks configuration, credentials, clients or deployments. Change them only in a separately approved migration.

- **Commands:** `hov-router` is preferred; `better-ccflare` must keep working (`COMMAND_NAMES` in `packages/core/src/product-identity.ts`). New installs no longer create `wstack-router`, but existing `wstack-router` links run the same binary and the upgrade block in `docs/reference.md` keeps them current.
- **Storage:** config directory `~/.config/better-ccflare` (or `$XDG_CONFIG_HOME/better-ccflare`; Windows `better-ccflare` under `LOCALAPPDATA`/`APPDATA`), `better-ccflare.json`, `better-ccflare.db`.
- **Environment variables:** `BETTER_CCFLARE_*`, `CCFLARE_*`, and the legacy `ccflare_*` fallbacks. **Headers:** `x-better-ccflare-*`.
- **Packages and artifacts:** npm package name `better-ccflare`, internal `@better-ccflare/*` workspaces, `apps/cli/dist/better-ccflare`, release asset `better-ccflare-linux-amd64`.
- **Ports and services:** default `8080`; production guard `:8788` → binary `:8789`; `ccflare-stack.service`.
- **Release identity:** the `v1:startupbros-wstack-router-*` provenance tokens embedded in published v3.6.2 through v3.7.1 (later builds embed `v1:startupbros-hov-router-*`; the verifier and runtime catalogue recognize both), and published v3.6.2 bytes and signer identity (historical; never rewrite).
- **Upstream recognition and credit:** `tombii` distribution contexts in build provenance and the version checker exist to classify upstream builds; LICENSE, `docs/acknowledgements.md`, `UPSTREAM.md` and historical citations stay.

Display text uses the constants instead of hard-coded names: `PRODUCT_NAME` / `COMMAND_NAME` from `@better-ccflare/core/product-identity`. Import that subpath directly, not the core barrel, which the dashboard cannot load. Reference: [docs/hov-router-migration.md](docs/hov-router-migration.md#what-stays-the-same).

## ⚠️ CRITICAL: Generated files

**NEVER TOUCH these auto-generated files** — must be excluded from all reads, edits, searches, and commits:
- `packages/database/src/inline-vacuum-worker.ts`
- `packages/database/src/inline-integrity-check-worker.ts`
- `packages/database/src/inline-incremental-vacuum-worker.ts`
- `packages/database/src/inline-reader-worker.ts`
- `packages/proxy/src/inline-worker.ts` (orphaned — see below)

All four `packages/database` files are gitignored build output of `bun run build:cli`.
If one is accidentally modified, do not stage or commit it; re-run that build to
restore it. A fresh worktree will not have them at all, and `bun test` crashes on
import until you build once.

`packages/proxy/src/inline-worker.ts` is different: its source worker was retired
(`3ad4b5bce8`, `417520840d`), nothing regenerates it, and its `EMBEDDED_WORKER_CODE`
export has no importers left. Still do not touch or commit it, but there is no build
that will bring it back — deleting it is a deliberate cleanup decision, not a recovery.

**`apps/cli/README.md`** is a short pointer to the root README. Upstream's npm `prepublishOnly` script overwrites it with the root README at publish time, and this fork publishes no npm package. Keep product documentation in `./README.md` and `docs/`.

## Git

This repo has both a `main` branch and a `main` tag:
- **Push/fetch:** use `refs/heads/main` (`git push origin refs/heads/main:refs/heads/main`, `git fetch origin refs/heads/main`).
- **Checkout:** use `git switch main`. `git checkout refs/heads/main` detaches HEAD, and the deploy gate then refuses with "checkout has detached HEAD".
- **Comparisons:** use `origin/main` (`git merge-base`, `git log X..origin/main`) to avoid the ambiguous-refspec warning.

Branch from a freshly fetched `origin/main`; never change `main` directly. Before changing anything, run `git status` and note pre-existing changes so you can tell them apart from yours. Stage files by name (`git add <files>`), never `git add .`, which picks up generated workers.

## Deployment source (production)
Production is a root systemd service, `ccflare-stack.service` (guard on `:8788` in front of the binary on `:8789`). Deploys build from `main` ONLY, via `scripts/deploy-ccflare.sh` — it refuses to build or ship any commit that is not an ancestor of `origin/main`. The binary embeds its git SHA at build time, verifiable at runtime via the health endpoint's `git_sha` field (no need to trust the binary filename). The systemd pin lives at `/etc/systemd/system/ccflare-stack.service.d/50-pinned-build.conf`. Never let a long-lived feature branch become the de-facto trunk again — merge to `main` and deploy from there. Merging never deploys; the script is the only deploy path.

## Releases and versions

**NEVER bump the version by hand, and never publish to npm.** Router releases are draft-only GitHub releases produced by release-please (`.github/workflows/router-release.yml`, `scripts/router-release.ts`); publishing a draft is a separate operator decision. Upstream's npm, multi-architecture and signing publishers (`release.yml`, `release-dispatch.yml`, `signpath-*.yml`) are fenced off for this repository and must stay that way. No container image is published; Docker builds from source ([docs/docker.md](docs/docker.md)). Full policy: [docs/hov-router-releases.md](docs/hov-router-releases.md).

Commit prefixes drive the version and changelog (`release-please-config.json`, plus the alias map in `scripts/router-release.ts`):
- `feat:` → minor, under Features (`feature:`/`add:`/`new:` are accepted aliases)
- `fix:` → patch, under Bug Fixes (`bug:`/`resolve:` aliases)
- `security:` → Security; `refactor:` → Improvements (`improve:`/`enhance:`/`update:` aliases); `perf:` → Performance Improvements
- `docs:`, `chore:`, `test:`, `style:` alone produce no release
- `!` or `BREAKING CHANGE` → major

`CLAUDE_CLI_VERSION` in `packages/core/src/version.ts` tracks the Claude Code CLI version used in user-agent headers. It is not the product version.

## PR Review Against Current Main (MANDATORY)

Before reviewing or merging any PR, always find the merge base and identify what main has added since the PR branched:

```bash
git fetch origin pull/<PR_NUMBER>/head:<branch-name>
git fetch origin refs/heads/main
MERGE_BASE=$(git merge-base <branch-name> origin/main)
git log $MERGE_BASE..origin/main --oneline          # commits on main the PR doesn't have
git diff $MERGE_BASE..origin/main --name-only        # files main changed since PR branched
```

Cross-check the PR's changed files against main's post-branch files. If they overlap, inspect those specific hunks to confirm the PR doesn't regress recent fixes. A PR based on an old main can silently overwrite hotfixes, security patches, or behaviour changes that landed after it branched.

## Merging PRs from External Contributors
When merging a PR from an external contributor (someone other than the repository owner), **create a merge commit** instead of squashing or rebasing, so the contributor's commits and authorship stay in history. Do **not** use `gh pr merge` for these, since it may squash or rebase:

```bash
git fetch origin pull/<PR_NUMBER>/head:<branch-name>
git merge --no-ff <branch-name>
```

A `--no-ff` merge commit's subject carries the PR title (e.g. `fix(proxy): ... (PR #N)`), **not** GitHub-UI's `Merge pull request #N from user/branch` format. Tooling that scans merge commits for contributor credit must handle both shapes.

Order, pushing only once at the end:
1. `git merge --no-ff <branch-name>`
2. Fix any still-unresolved review findings in a follow-up commit.
3. Thank the contributor for their specific contribution in [docs/acknowledgements.md](docs/acknowledgements.md), committed as `chore: acknowledge <name> for PR #<N>` (excluded from release notes). Commit real fixes separately with their own prefix.
4. Push merge, fixes and acknowledgement together.

The owner's own PRs merge normally (squash).

## Upstream syncs

This is a product fork with intentional hard divergence, not a mirror. Adopt upstream releases deliberately, protecting the fork contracts listed in [UPSTREAM.md](UPSTREAM.md). Never merge or cherry-pick upstream on ahead/behind counts alone. Upstream-only issue reports belong at tombii/better-ccflare.

## Issue Management
- Never close issues automatically, and use `Refs #N` rather than closing keywords in commits and PR bodies.
- Wait for the issue reporter to confirm that fixes work for them before closing.

## Issue Staleness Check (MANDATORY before implementing)
Before implementing any GitHub issue, always run:
```bash
git log origin/main --since='<issue-open-date>' --oneline --no-merges -- <relevant-paths>
```
Check if recent commits already partially or fully address the issue. Rate limiting, health, and proxy code change frequently. Ask the user "does this issue still apply given recent changes?" before proceeding. Especially check: has the reported symptom been fixed? Does the proposal conflict with new architecture?

## Database
- Default: `~/.config/better-ccflare/better-ccflare.db`
- Custom: Set `BETTER_CCFLARE_DB_PATH=/path/to/dev.db` in env or .env
- Query: `sqlite3 ~/.config/better-ccflare/better-ccflare.db "SELECT name, provider, custom_endpoint FROM accounts;"`

## ⚠️ CRITICAL: Database Migrations — Port to PostgreSQL

**Every migration added to `packages/database/src/migrations.ts` MUST also be ported to `packages/database/src/migrations-pg.ts`.**

When adding a new column or table to SQLite:
1. Add it to `ensureSchema()` in `migrations.ts` (SQLite CREATE TABLE)
2. Add it to `runMigrations()` in `migrations.ts` (SQLite ALTER TABLE for existing DBs)
3. Add it to `ensureSchemaPg()` in `migrations-pg.ts` (PG CREATE TABLE for new installs)
4. Add an entry to the `columnsToAdd` array in `runMigrationsPg()` in `migrations-pg.ts` (PG ALTER TABLE for existing DBs)
5. If there's a backfill/data migration in SQLite, add the equivalent `adapter.unsafe(UPDATE ...)` call in `runMigrationsPg()` as well.

New tables also need to be created in `ensureSchemaPg()` AND in `runMigrationsPg()` (using `CREATE TABLE IF NOT EXISTS` so upgrades work).

## Test-Driven Development
When creating new functionality: write tests first, then implement, then run tests. This ensures the implementation matches the specs/request before and after coding.

## After Code Changes
Always run: `bun run lint && bun run typecheck && bun run format`

**`typecheck` does not cover test files.** The root `tsconfig.json` excludes
`**/__tests__` and `**/*.test.ts`, so stale call sites in tests compile green and fail
only when that suite actually runs. After changing a shared repository/facade signature,
grep its call sites yourself (`grep -a`, not plain `grep` — see the doc) and run the
affected suites, including any gated behind `DATABASE_URL`. Details:
[docs/solutions/workflow-issues/typecheck-does-not-cover-test-call-sites.md](docs/solutions/workflow-issues/typecheck-does-not-cover-test-call-sites.md)

Run affected suites one file at a time (`bun test <file>`). A full `bun test` batch shows cross-file mock-isolation failures that do not occur in isolation.

`docs/solutions/` is the searchable store for documented bugs, practices, and workflow patterns, organized by category and YAML frontmatter (`module`, `tags`, `problem_type`); `CONCEPTS.md` defines shared domain vocabulary. Both are relevant when implementing or debugging in documented areas.

## Commands

### Server
- First run: `bun install --frozen-lockfile && bun run build` (builds dashboard/CLI)
- Start: `bun start` (port 8080) or `bun start --serve --port 8081` (testing)
- Startup: Takes ~15 seconds, wait before testing with curl
- Production: guard on `:8788` forwards to the binary on `:8789`. Test local changes on port 8081.

### Account Management
- Add: `bun run cli --add-account <name> --mode <mode> --priority <number>`
- Accepted modes: the `validModes` array in `apps/cli/src/main.ts` is authoritative. Read it rather than trusting any list in docs — including `--help`, whose printed list is currently missing modes that `validModes` accepts.
- List: `bun run cli --list`
- Remove: `bun run cli --remove <name>`
- Reauth: `bun run cli --reauthenticate <name>` (preserves metadata, auto-notifies servers)
- Priority: `bun run cli --set-priority <name> <priority>` (lower = higher priority, 0 = first)
- Provider behavior: OAuth (5hr windows, session-based), API keys (pay-as-you-go, no sessions)

### Maintenance
- `bun run cli --reset-stats|--clear-history|--stats|--analyze`

### API Endpoints
- `POST /api/accounts/:id/reload|pause|resume`

### Testing OpenRouter
Use a **currently free** model, and look one up rather than trusting a slug written
here — OpenRouter rotates which models carry the `:free` tier, so any pinned slug
rots. (`z-ai/glm-4.5-air:free` was named here until 2026-08-16, when it started
returning HTTP 404 `This model is unavailable for free. The paid version is
available now`. A pinned paid slug silently spends real money instead.)

Pick one:
```bash
curl -s https://openrouter.ai/api/v1/models | \
  python3 -c "import json,sys; print('\n'.join(m['id'] for m in json.load(sys.stdin)['data'] if m['id'].endswith(':free')))"
```

Then send it, force-routing to the openrouter account so the request cannot land
on an Anthropic-backed one (see the testing restriction at the top of this file):
```bash
curl -X POST http://localhost:8081/v1/messages \
  -H "Content-Type: application/json" -H "Authorization: Bearer test" \
  -H "x-better-ccflare-account-id: $(sqlite3 ~/.config/better-ccflare/better-ccflare.db "SELECT id FROM accounts WHERE provider='openrouter' LIMIT 1;")" \
  -d '{"model":"<free-slug>","messages":[{"role":"user","content":"test"}],"max_tokens":10}'
```

Add `"stream":true` to exercise the SSE translation path; a healthy stream ends
with a `message_stop` event.

## Qwen Provider
- When working on the Qwen provider or streaming transform, **always mirror the qwen-code implementation** using a locally available checkout of `QwenLM/qwen-code`. In the final response, state the checkout path and revision compared; if the comparison was not performed, explicitly say so and explain why.
- Qwen/DashScope sends incremental tool call argument chunks (not cumulative like standard OpenAI). The streaming transform buffers all chunks and emits complete JSON at stream end, matching `StreamingToolCallParser` in qwen-code.

## Honest Work and Anti-Ceremony (binding for agents and humans alike)

The purpose of agent work here is working, deployable capability. Process
serves that outcome and never becomes the product.

- A process artifact (certificate, ledger, dashboard, matrix, meta-report,
  speculative check) may be created only if it names a concrete consumer,
  the named feature it gates, the observed defect class justifying it, and
  its deletion condition. Otherwise it does not get created. Boundary test:
  if running code branches on it, it is product; if only humans and status
  reports read it, it is process and the creation-gate rule above applies;
  code written just to flip this answer counts as the pathology, not as a
  consumer. Sole exception: a minimal
  integrity/recovery control (crash-recovery state, provenance snapshot) is
  legitimate when it prevents a named evidence-loss or corruption mode and
  is necessary and minimal.
- Real code + real tests in the same unit of work. Forbidden: faked tests,
  fixtures/mocks presented as live proof, weakened assertions, golden
  regeneration to force green, hard-coded success paths, placeholder macros
  in commits, editing the spec instead of implementing it, narrowing scope
  while claiming full success.
- No self-certification: work is closed by an independent verifier citing
  evidence at an exact revision. Solo sessions re-verify by re-execution and
  state what was not independently verified.
- A typed refusal beats a fabricated result and is less valuable than the
  real capability; refusal-only work stays open and says so.
- Truthful null results ("checked X, found no material increment") are
  successful outcomes. Unsupported claims are worse than silence.
- Metrics predeclare denominator and countermetric; agreement between
  agents may raise confidence but is never independent evidence; never
  silence stderr in evidence-bearing commands.
- Name these pathologies when they occur (gate self-weakening, proof-class
  inflation, golden regeneration, tolerance widening, suppression-pragma
  laundering, refusal farming, follow-up laundering); the names are the
  deterrent. The full catalog with countermeasures lives in the
  just-say-no-to-process-porn-and-ceremony skill; ask the operator for it
  if you cannot resolve that reference.
