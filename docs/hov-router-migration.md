# Moving to HoV Router

HoV Router is a House of Vibe project at [StartupBros/hov-router](https://github.com/StartupBros/hov-router). HoV Router and hovstack are independent sibling products; neither requires the other. Router continues tombii/better-ccflare and snipeship/ccflare under the existing MIT license. Git history, contributor acknowledgements, and license terms remain intact.

The public repository moved from `StartupBros-com/better-ccflare` on 2026-10-19 and has been `StartupBros/hov-router` since 2026-10-21. It is the same repository, ID `1278801682` (see [the repository move](#repository-move)). Use `StartupBros/hov-router` in clone, download, and support URLs. [Report Router issues here](https://github.com/StartupBros/hov-router/issues).

The current [Linux x86_64 binary](reference.md#install-the-linux-x86_64-release), release 5.0.1, displays HoV Router, as do 3.7.0, 3.7.1, 4.0.0, 5.0.0 and new source builds. The earlier 3.6.2 binary keeps its original product name, exact bytes, source SHA, tag, and signing identity, and prints that original name even through `hov-router`; a filesystem alias cannot relabel its embedded output. See [the historical 3.6.2 release](hov-router-releases.md#verify-the-historical-362-release). Router npm packages, container images, and other-platform binaries are not published.

## Install without replacing your current executable

Follow the [source quickstart](reference.md#install-from-source). It builds the current fork with `bun install --frozen-lockfile` and `bun run build`, then installs the unchanged `apps/cli/dist/better-ccflare` artifact under **both** executable names in a fresh directory:

- `hov-router` is the preferred command.
- `better-ccflare` remains a compatible command for the same server.
- Guides for 3.6.2 through 3.7.1 also installed `wstack-router`. An existing copy or link keeps working, because every name runs the same binary; new installs no longer create it.

Record the current executable location with `command -v` and the command name you use today before changing PATH. Keep that executable. The quickstart changes only the current shell's PATH unless you explicitly make it permanent; it does not replace a global package or repoint a service. Do not run multiple aliases as separate servers against the same database.

## What stays the same

| Surface | Existing contract |
| --- | --- |
| Linux/macOS config directory | `$XDG_CONFIG_HOME/better-ccflare`, or `~/.config/better-ccflare` when XDG is unset |
| Config filename | `better-ccflare.json` in that directory |
| Windows config directory | `better-ccflare` beneath `LOCALAPPDATA`, then `APPDATA`, then `~/AppData/Local` |
| Default SQLite database | `better-ccflare.db` in the platform config directory |
| Config override | `BETTER_CCFLARE_CONFIG_PATH`, with legacy `ccflare_CONFIG_PATH` fallback |
| Database override | `BETTER_CCFLARE_DB_PATH`; a PostgreSQL `DATABASE_URL` is refused (see [PostgreSQL support removed](#postgresql-support-removed)) |
| Other integration names | Existing `BETTER_CCFLARE_*`, `CCFLARE_*`, and other environment variables; `x-better-ccflare-*` headers |
| Default server port | `8080`; existing port overrides and deployment ports remain unchanged |
| Build/package names | `apps/cli/dist/better-ccflare`, the `better-ccflare` package identity, and internal `@better-ccflare/*` packages |

There is no new HoV configuration namespace and no config or credential migration. Do not rename storage directories, recovery files, environment variables, headers, or database files to match the product name. Existing deployments keep their paths, service names, and ports.

`hov-router --show-config` reads configuration without opening the account database or contacting a provider, and tags each value it took from the config file `[Config file]`. `--help` and `--version` alone do not prove that configuration was loaded. When a config file exists, `--show-config` leaves its contents unchanged; when none exists, it creates one holding only the default load-balancing strategy.

## PostgreSQL support removed

**What changed.** HoV Router now runs on SQLite only. Upstream added PostgreSQL support for multi-pod deployments. This fork removed it because no install of this fork uses it and it doubled every schema change.

**What happens now.** If `DATABASE_URL` starts with `postgres://` or `postgresql://`, the server and every command that opens the database stop at startup with a message. Before this change such a URL would have let the router start on an empty SQLite database. `--version`, `--help` and the other commands that never open the database still work. Any other `DATABASE_URL` value is ignored, as before; the SQLite file is chosen by `BETTER_CCFLARE_DB_PATH` or the default.

**Ways forward.**

1. Stay on v3.7.1, the last release that supports PostgreSQL ([verify and install it](hov-router-releases.md#verify-release-371)).
2. Unset `DATABASE_URL` and start fresh on SQLite, at `BETTER_CCFLARE_DB_PATH` or the default `~/.config/better-ccflare/better-ccflare.db`.

There is no PostgreSQL-to-SQLite migration tool, so option 2 starts with an empty database: accounts and history in PostgreSQL are not carried over.

**Environment variables no longer read:** `BETTER_CCFLARE_DB_POOL_MAX`, `BETTER_CCFLARE_DB_IDLE_TIMEOUT`, `BETTER_CCFLARE_DB_STATEMENT_TIMEOUT`, `BETTER_CCFLARE_DB_CLIENT_TIMEOUT`, `BETTER_CCFLARE_DB_PG_PREPARE`, `BETTER_CCFLARE_TEST_POSTGRES_URL`, and the `CCFLARE_REQUIRE_LIVE_PG_*` family. `BETTER_CCFLARE_DB_CLEANUP_BATCH_SIZE` and every SQLite setting still work.

## Auto-refresh removed

**What changed.** The per-account auto-refresh setting no longer does anything. Upstream used it to send a short scripted message to an account when its usage window reset, so the next window opened before anyone needed it. That is automated traffic sent on the account's behalf, which this fork does not send, and this fork's own install never had the setting on. Three behaviors stopped with it:

1. **Window-opening messages.** Nothing is sent on an account's behalf. A usage window opens when real traffic first uses it.
2. **Background OAuth token refresh.** Tokens are still refreshed when a request needs one: an expired or nearly expired token is refreshed before the request is sent, and a `401` on an Anthropic OAuth, Codex or xAI account triggers one refresh and retry. An account left idle until its refresh token lapses needs a re-login when it is next used (see [Re-authenticating an account](oauth-reauthentication.md)).
3. **Resuming paused accounts after a successful message.** An account paused after repeated failures (`failure_threshold`) now stays paused until you resume it from the dashboard or with `POST /api/accounts/<id>/resume`. An overage pause still clears on its own once its usage window resets, but only on Anthropic, Codex and Z.ai accounts with auto-fallback on.

**Who is affected.** Only accounts that had auto-refresh turned on. Release 4.0.0 logs one startup warning naming each of them and what they no longer get. Release 5.0.0 drops that warning, because the stored value has no effect. The Z.ai peak-hours pause, which ran on the same timer, is unchanged and now runs as its own job (see [Z.ai Peak-Hours Pause](providers.md#zai-peak-hours-pause)).

**The stored setting.** Nothing needs clearing. The database column is kept, with no migration, and nothing acts on it. Release 4.0.0 kept `POST /api/accounts/<id>/auto-refresh` answering and kept `autoRefreshEnabled` (always `false`) in account API responses, so existing scripts had one release to change. Release 5.0.0 removes both; see [Removed in 5.0.0](#removed-in-500). The dashboard toggle is gone. A request that still sends the `x-better-ccflare-auto-refresh` header is treated as an ordinary client request; the header is removed at ingress.

## Removed in 5.0.0

**Endpoints.** Each of these now answers `410 Gone` from the router itself, for every method, with a JSON body naming the endpoint, `removedIn: "5.0.0"` and the replacement, if any. A path the router does not recognize can be passed on to an upstream provider, so the router answers these itself rather than forwarding a stale call.

| Removed | Use instead |
|---|---|
| `GET` and `POST /api/config/model` | Nothing. The Default Agent Model setting never changed which model an agent used. Set a model per agent on the Agents tab or with `POST /api/agents/<id>/preference`. |
| `POST /api/accounts/<id>/auto-refresh` | Nothing. Auto-refresh was removed in 4.0.0 ([above](#auto-refresh-removed)). |
| `POST /api/accounts/<id>/model-fallbacks` | `POST /api/accounts/<id>/model-mappings` with an array per model family, first choice first: `{"modelMappings": {"sonnet": ["model-a", "model-b"]}}`. A mapping holds at most 16 models. |
| `GET /api/system/info` | Nothing. `GET /health` reports the running version and build SHA. |
| `GET /api/workspaces` | `GET /api/agents`, whose `workspaces` field lists the same workspaces. For a per-workspace agent count, count its `workspaceAgents` entries by `workspace`. |
| `POST /api/debug/cache-diagnosis` | Nothing. It ran only when `CCFLARE_CACHE_DIAG` was set. |

**Fields.** Account API responses no longer include `autoRefreshEnabled`. `GET /api/config` no longer includes `default_agent_model`. Until the next major release, `GET /api/insights/cache-parity` still reports the removed Codex levers, at fixed values: session keys, prefix sharding, settle window, pacing bypass, explicit breakpoints, turn state and WebSocket, with continuity fixed on. `GET /api/debug/cache-pacing` reports `codex_settle_ms` as `0`.

**Commands.** `--get-model` and `--set-model` are gone and now exit with status 1 as unknown arguments. `--show-config` still reads the configuration file without writing it.

**Settings now ignored.** These are ignored and left in place:

- a `default_agent_model` key in `better-ccflare.json` and the `DEFAULT_AGENT_MODEL` environment variable;
- `CCFLARE_CACHE_DIAG`;
- the Codex variables for features that are gone:
  - `CCFLARE_CODEX_WS_*`, removed with the WebSocket transport;
  - `CCFLARE_CODEX_TURN_STATE_*`, removed with the turn-state replay;
  - the cache-key and pacing experiment variables, starting with `CCFLARE_CODEX_CACHE_KEY_CONTINUITY_PERCENT`.

Release 5.0.0 logs one startup warning naming each Codex variable that is still set, without its value. Release 5.0.1 and later drop that warning and ignore the variables without logging anything. [Configuration](configuration.md) lists every name.

## Manual source updates

Branded builds do not offer an actionable upstream update. Do not install a registry package or a tombii release to update this fork: those are upstream distributions, not HoV Router.

1. Keep the prior installed directory and record its `--version` and `--git-sha` output. Back up configuration and database using your existing backup procedure before running a newer server; an identity change is not a promise that future schema changes can be downgraded.
2. In the clean source checkout created by the quickstart, inspect `git remote -v` and confirm `origin` points to `StartupBros/hov-router` (see [the repository move](#repository-move)). Confirm `git symbolic-ref HEAD` reports `refs/heads/main` before updating; use a separate fresh checkout if you are working on another branch. Fetch and fast-forward from the unambiguous remote reference (the repository also has a `main` tag):

   ```bash
   git fetch origin refs/heads/main
   git merge --ff-only origin/main
   bun install --frozen-lockfile
   bun run build
   ```

   If you have local changes or a diverged branch, stop and resolve them; do not reset or overwrite your work. These are manual maintainer commands, not an auto-updater.
3. Repeat the [source installation](reference.md#install-from-source) local installation block. It creates another fresh directory instead of overwriting the previous executable. Verify both commands' `--version` and `--git-sha` output before choosing that directory in PATH. Repointing or restarting an existing service is a separate deployment operation, not part of this installation guide.

## Roll back the command choice

1. Stop a newly started local server before returning to the prior executable. Do not start a second process against its database.
2. Remove the new install directory from the shell PATH configuration you added, or open a shell that still uses the previous PATH. You can also invoke the retained previous executable by its absolute path. Keep the new directory until you have verified the rollback; no deletion is needed.
3. Check `command -v better-ccflare`, then the selected executable's `--version` and `--git-sha`. This verifies command selection, not database downgrade safety. If you ran a version with schema changes, use that version's migration/backup guidance before restarting an older server.

## Maintainer: prepare local release artifacts

Preparation is not publication. From the repository root on **Linux x86_64**, install dependencies with `bun install --frozen-lockfile`, then run the helper with a new output directory:

```bash
bun run apps/cli/prepare-router-artifacts.ts /tmp/hov-router-prep-001
```

The destination must not already exist; choose a different path for each run. The helper builds the dashboard and reuses the selected-platform CLI builder. Its output directory contains exactly:

- `better-ccflare-linux-amd64` — the compatibility asset name remains unchanged.
- `SHA256SUMS` — the checksum for that executable.

The helper checks a copy under each supported command name with `--help` and `--version` in an isolated environment. These checks do not start a server, exercise provider inference, or prove configuration/database compatibility. Existing all-platform build support remains available; this preparation helper only covers Linux x86_64.

Verify the bytes from inside the output directory:

```bash
cd /tmp/hov-router-prep-001
sha256sum -c SHA256SUMS
```

Expect `better-ccflare-linux-amd64: OK`. A checksum detects a byte mismatch against the manifest; it does **not** authenticate the publisher. An untagged preparation build has no proven release SHA or distribution identity, even if its version output looks familiar. Do not use its `--git-sha` output as release proof. The updater remains non-actionable.

The CI counterpart is the separate [artifact preparation](../.github/workflows/prepare-router-artifacts.yml) job for pull requests and manual runs, with read-only repository permissions and no artifact uploads. It is not a publishing workflow: router releases come from `router-release.yml` and `router-release-artifacts.yml` ([release policy](hov-router-releases.md)). Upstream's npm, multi-architecture and SignPath publishers were deleted from this fork on 2026-11-03.

Do not invoke the release workflows for preparation, change versions manually, or push a tag to test this path. Actual publication requires separate approval and validation of release wiring, version/tag agreement, provenance, and intended destinations **before** creating a release tag. These locally prepared files are not a published downloadable release. For the current published artifact, use the [consumer installation](reference.md#install-the-linux-x86_64-release).

## Repository move

On 2026-10-19 the source repository was transferred from `StartupBros-com/better-ccflare` to the `StartupBros` organization. It remains a public fork of tombii/better-ccflare, and the transfer retains the fork relationship, Git history, and the MIT license. Contributor credits are unchanged. The post-transfer check confirmed the same repository ID, default-branch commit, branches/tags, issue and pull-request identities, and active workflows. The old repository URL redirects to the new home. At the time of the transfer check, there were no releases or assets before or immediately after the move; the move itself was not a binary release. Router 3.6.2 was published separately afterward.

After [PR #579](https://github.com/StartupBros/hov-router/pull/579) merged, the same repository was renamed from `StartupBros/wstack-router` on 2026-10-21 to its current name, `StartupBros/hov-router`, retaining ID `1278801682`. The [verified cutover record](https://github.com/StartupBros/hov-router/issues/578#issuecomment-6308306333) records the checks, including successful old repository-root, PR #579, release 3.6.2, and agent-setup document URL checks. This rename did not publish a new binary or change the historical release evidence.

Existing checkouts keep working under their current directory name; do not rename it. Inspect and update an existing checkout's remote to the current home:

```bash
git remote -v
git remote set-url origin https://github.com/StartupBros/hov-router.git
git remote -v
```

Old repository URLs redirect, but old issue redirects have a request-header-dependent exception. Anonymous checks of the old-name URL for [issue #578](https://github.com/StartupBros/hov-router/issues/578) with curl's default `Accept: */*` returned HTTP 404 with no redirect; the same request with `Accept: text/html` returned HTTP 301 to the canonical issue, which returned HTTP 200. Repeating the wildcard request still returned HTTP 404. The authenticated browser also opened the old URL successfully, but authentication is not required for the successful HTML request. GitHub's internal cause remains unknown; this is not a platform fix. Use canonical issue URLs rather than relying on old redirects. A fresh clone uses the [source guide's](reference.md#install-from-source) `git clone https://github.com/StartupBros/hov-router.git better-ccflare` form, keeping the local directory name compatible.

At transfer time, npm publication, GHCR images, signing, and release workflows still required separate approval and validation. The move did not validate any of them; subsequent Router release automation is documented in the [release guide](hov-router-releases.md). The existing publishing workflows listed above must not be invoked merely to move the repository. The transfer-time check also found that `.github/workflows/managed-routing-postgres.yml` used an exact repository match for its self-hosted runner, with the moved repository taking the hosted fallback; inspect current workflow configuration before making runner assumptions. The exact-origin allowlist in `apps/cli/build-provenance.ts` accepts the verified new origin forms while retaining the old ones. Its clean-tree, explicit-context, version, and exact-tag checks remain unchanged; untagged builds still have no proven release identity and branded builds have no actionable update channel.

GitHub redirects can be broken by reuse of the old repository path. [Detaching a fork](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/detaching-a-fork) is a separate irreversible decision and has not been made.

## Not included

No detaching of the fork or visibility change; registry/package, image or release publication; tag push; production deployment; provider inference; new installer; config migration; update adapter; or integration with other HoV tooling was part of the identity-change and repository-transfer handoff. Upstream Docker Compose recipes retain their existing behavior and images. A new product name does not change the provider usage rules.

## If installation fails

- **Repository not found:** use the current home, `https://github.com/StartupBros/hov-router`, and canonical issue links rather than old redirects. Check your network/Git configuration; hovstack is a separate product, not an alternate Router repository.
- **Missing build artifact:** run `bun run build` from the checkout root before copying. The build includes the dashboard and compiled CLI; do not invoke `prepublish`.
- **Command not found or old branding:** check PATH order and the printed installation directory with `command -v`; an older global command may still be selected.
- **Missing accounts/config:** check the existing HOME/XDG and config/database overrides. Do not create a replacement namespace or move credentials to fix a command-name change.
- **Port occupied:** leave the existing server alone and select a different local port, or perform a separate planned service handoff.
