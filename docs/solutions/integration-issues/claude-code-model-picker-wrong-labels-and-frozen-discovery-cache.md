---
title: The Claude Code /model picker named the wrong model and kept dead routes, from hand-written route labels and a client cache that discovery never refreshed
date: 2026-10-26
category: integration-issues
module: model-route-profiles
problem_type: integration_issue
component: proxy
symptoms:
  - The picker row whose id named Sol (pro-primary-sol) served GPT-6-Astra, and the row whose id named Astra (codex-pool-astra) served GPT-6.1-Sol, after OpenAI reordered its Codex catalog
  - "Labels such as Codex pool, Sonnet-tier, auto-updating never said which model a row would run"
  - Rows for paused accounts and for a profile its account could never satisfy stayed in the picker and failed closed when picked
  - ~/.claude/cache/gateway-models.json went 12 days without a rewrite, so the picker kept 2026-10-14 rows after the router changed
  - "A fresh Claude Code session logged `[gatewayDiscovery] skipped: no credential (ANTHROPIC_AUTH_TOKEN, apiKeyHelper, or API key)`"
root_cause: incorrect_assumption
resolution_type: code_fix
severity: medium
retire_when: "The client-cache half retires once Claude Code runs gateway discovery under a claude.ai login. Check: a fresh session's debug log no longer shows `[gatewayDiscovery] skipped: no credential`. The label half stays while route profiles exist."
related_components:
  - providers
tags:
  - route-profiles
  - model-picker
  - gateway-model-discovery
  - catalog-role
  - display-name
  - codex
  - claude-code-client
---

# The Claude Code /model picker named the wrong model and kept dead routes, from hand-written route labels and a client cache that discovery never refreshed

## Problem

The `/model` picker is filled from the router's `GET /v1/models`. Each route profile row showed the operator's hand-written `displayName`, which the router passed through unchanged. Codex catalog-role pools choose their model by position in OpenAI's catalog, so the served model changed under fixed labels and fixed, model-named ids. Rows also stayed listed for routes that could not run.

Separately, Claude Code caches the list on disk and refreshes it only when its gateway discovery runs. On a claude.ai subscription login, discovery skips silently, so the picker can show a list weeks old whatever the router serves.

These are two different bugs that look the same from the picker. Fixing the server half does not change what a client with a frozen cache shows.

## Symptoms

Pre-fix rows, from the cache backup taken before the rebuild (`gateway-models.json.bak-20261026-172418`, last written 2026-10-14 08:32 local):

| Picker id | Label shown | Served on 2026-10-26 |
|---|---|---|
| `claude-bccf-route-pro-primary-sol[1m]` | `Codex pool: Sonnet-tier, auto-updating (all Pro accounts, 1M)` | GPT-6-Astra |
| `claude-bccf-route-codex-pool-astra[1m]` | `Codex pool: Opus-tier, auto-updating (all Pro accounts, 1M)` | GPT-6.1-Sol |
| `claude-bccf-route-glm-5-3-flash` | `GLM-5.3-Flash (Mac Studio) · ai-gateway-chat` | the LiteLLM alias `chat`; the operator reported it serving DeepSeek-v1-flash |
| `claude-bccf-route-openrouter-fusion` | `Fusion · openrouter` | nothing: account paused, and the profile expects `fusion` while the account maps `openrouter/fusion` |
| `claude-bccf-route-ox-alpha` | `OX Alpha · openrouter` | nothing: account paused |

- The operator read the rows as "GPT Sonnet runs Astra, GPT Opus runs 6.1-Sol". The id named one model, the label named a tier, and the route served the other model.
- `~/.claude.json` had no `primaryApiKey` on 2026-10-26, so discovery was skipping on this machine. That placeholder was the workaround added on 2026-10-14 (session history).

## What Didn't Work

- **Naming the role instead of the model.** The 2026-09-26 catalog-role conversion relabelled both pools "Sonnet-tier, auto-updating" and "Opus-tier, auto-updating" (`route-profile-expected-physical-model-checked-before-provider-defaults.md`). That label stayed technically true but told the user nothing about which model they would get, and the model-named ids kept pointing at the model the route no longer served.
- **Rebuilding the cache by hand.** A machine-local script, `ccflare-refresh-picker-cache` (`~/.local/bin`, not in this repo), rewrites the cache from `GET /v1/models`. It went stale again as soon as routes changed, because nothing runs it (session history).
- **Looking for a picker filter in Claude Code.** On 2026-10-14 a missing row was first chased through the 2.1.299 picker code. Nothing there hid it; discovery had never run (session history).
- **`apiKeyHelper` to satisfy the discovery gate.** Any helper makes Claude Code treat the session as a non-subscriber. That turns off claude.ai connectors and the plan-usage panel, and sends the helper's output as the bearer instead of the OAuth token. It was declined (session history).
- **A placeholder `primaryApiKey` in `~/.claude.json`.** It passes the gate without changing inference: inference keeps the OAuth bearer, and the custom-header `x-api-key` replaces the placeholder on the wire. It worked from 2026-10-14, but it was gone by 2026-10-26 for an unknown reason (`/logout` clears it). It also costs a startup warning ("Both claude.ai and /login managed key set"), and `/install-github-app` would upload it as a repository secret.

## Solution

PR #617 (merged at 447f7dc7, deployed backend-only 2026-10-26) derives each row's label and visibility from what the route serves, on every discovery request.

- **`packages/proxy/src/model-route-discovery.ts`** builds the rows. `buildModelRouteDiscoveryModels` (line 117) labels each row `<served model>[ (1M)] · <where>`. `<where>` is the exact account's name, or `<provider> pool` for a capability pool. A pool whose accounts disagree lists each distinct model. The label is cut at 120 characters.
  - `servedModel` (line 82): a catalog-role row reads each account's own catalog target. Other rows use `expectedPhysicalModel`, else the previewed physical model (below).
  - `servedModelLabel` (line 97): the Codex catalog's display name for Codex rows, the Claude display name for Claude ids, the raw id otherwise.
  - `admits` (line 63) hides a paused account, and any account that `getRouteProfileConstraintViolation` (`packages/proxy/src/handlers/account-selector.ts:211`) rejects. The one exception is `catalog_role_unavailable`: a cold catalog after a restart is admitted, and the row shows the operator `displayName` until the catalog loads. A pool with no admitted account is left out.
  - `listModelRouteDiscoveryModels` (line 160) does one local account read. If it fails, discovery serves the static operator rows and hides nothing.
- **`previewAccountPhysicalModel`** (`packages/providers/src/request-capabilities.ts:196`) previews the physical model for a non-catalog-role row: the account mapping, else the provider default, or the logical model itself for a native Anthropic pass-through account.
- **`packages/proxy/src/proxy.ts:943`**: the `/v1/models` handler calls `listModelRouteDiscoveryModels` in place of the static list.

Rows served after the deploy:

```text
claude-bccf-route-pro-primary-sol[1m]   GPT-6-Astra (1M) · codex pool
claude-bccf-route-grok-primary          grok-4.7 · grok
claude-bccf-route-codex-pool-astra[1m]  GPT-6.1-Sol (1M) · codex pool
claude-bccf-route-glm-5-3-flash         chat · ai-gateway-chat
```

The fusion and ox-alpha rows are gone. The ids are unchanged, because a renamed id breaks saved picker choices until alias support exists (#618). The local cache was rebuilt by hand once with `ccflare-refresh-picker-cache` (9 rows to 7).

## Why This Works

**Server half: catalog-role pools follow a position, not a model.** `deriveFamilyDefaults` (`packages/proxy/src/codex-model-catalog.ts:752-764`) maps fable and opus to the first entry of the account's normalized catalog, sonnet to the second and haiku to the third. The catalog is sorted by OpenAI's own priority. When OpenAI moved gpt-6-astra ahead of gpt-6.1-sol, the opus pool and the sonnet pool swapped models with no configuration change, exactly as designed. Only the text around them, the ids and the hand-written labels, still described the old order. A label computed from the same catalog lookup the selector uses cannot drift from it.

**Server half: hiding uses the selector's own rule.** `admits` calls the same `getRouteProfileConstraintViolation` the selector runs before admitting an account. A row is therefore listed only when the selector could pick at least one of its accounts. A new admission rule in the selector hides rows with no change to discovery.

**Client half: discovery needs an API-key-style credential.** Read from the installed binary (observed in 2.1.296 and 2.1.299 on 2026-10-14, confirmed present in 2.1.310 on 2026-10-26), Claude Code's startup discovery does this:

1. It checks for `ANTHROPIC_AUTH_TOKEN`, an `apiKeyHelper`, or an API key. With none, it logs `[gatewayDiscovery] skipped: no credential (ANTHROPIC_AUTH_TOKEN, apiKeyHelper, or API key)` and stops.
2. Otherwise it calls `GET <ANTHROPIC_BASE_URL>/v1/models?limit=1000`, keeps ids matching `/(claude|anthropic)/i`, and writes `~/.claude/cache/gateway-models.json`.
3. The picker reads rows only from that file.

A claude.ai login is none of the three. The router key in `ANTHROPIC_CUSTOM_HEADERS` is applied after the check, so it never satisfies it. Discovery runs once per process, so even a working setup shows new rows only from the next fresh `claude` process. In 2.1.310 the rewrite is skipped when the fresh list equals the cached one. That comparison reads as a deep compare over whole row objects, so a label-only change should rewrite the cache; this has not been observed yet.

## Prevention

- **When the picker looks wrong, split server from client first.** Compare `GET /v1/models` (sent with the router key) with the rows and `fetchedAt` in `~/.claude/cache/gateway-models.json`. If the router is right and the cache is old, the problem is client discovery, not routing.
- **Prove discovery with a fresh process that sends no prompt.** Start `claude --debug-file <path>`, exit without a prompt, and grep the file for `[gatewayDiscovery]`. `cached N models` means it ran. `skipped: no credential` means the gate blocked it. This spends no Anthropic inference, which the repository's testing restriction requires.
- **Fallbacks when discovery cannot run.** `/model claude-bccf-route-<id>` typed directly is accepted under a non-first-party base URL even when the picker has no row (read from 2.1.299, and used on 2026-10-14). On the operator machine, `ccflare-refresh-picker-cache` rebuilds the cache and keeps a timestamped backup. Start a new `claude` after either.
- **Don't name a model in a route-profile id or label that follows a catalog role.** The router now writes the model into the label, so the operator `displayName` is only a cold-start fallback. A model-named id can't be fixed by renaming until #618 adds aliases.
- **Don't add admission logic to discovery.** Hide rows through `getRouteProfileConstraintViolation`, so the picker and the selector cannot disagree.
- **An alias lane shows its alias.** An account mapped to a LiteLLM group such as `chat` shows `chat`, because the router can't see what the alias resolves to. Map the account to the concrete model id to show the model.

## Related Issues

- PR #617: the fix.
- #618 (open): alias old ids, and decide between catalog-slot and model-line pools.
- #398 (open): R17 asked for labels that describe current routing; R18, the unexplained GPT-5.6 row, has a lead (a stale cached label) but no provenance.
- PR #420: generated, kind-only descriptions for discovery rows.
- #387 (open): alert when a catalog role's target changes across a restart, the same silent reorder seen from the alerting side.
- #325 (open): cold Codex catalogs after a restart, which is why a cold row keeps the operator label.
- `docs/solutions/integration-issues/route-profile-expected-physical-model-checked-before-provider-defaults.md`: the catalog-role conversion and its role-named labels.
- `docs/solutions/integration-issues/new-claude-model-drift-alert-means-bundled-catalog-lag.md`: a different picker list, the bundled Claude catalog, which lags for its own reasons.
- `docs/configuration.md`, "Claude Code `/model` setup": the label format and hiding rules.
