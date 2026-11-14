---
title: Unpriced route-alias tokens meant proxied Codex usage was counted twice
date: 2026-11-14
category: integration-issues
module: external-codex-usage
problem_type: integration_issue
component: background_job
symptoms:
  - The public subscription value feed marked ChatGPT Pro windows as partially priced, shown as "At least $X" with "Partial pricing"
  - "Closed Codex windows held unpriced tokens under a route-profile model (`claude-bccf-route-…`) that only the router serves"
  - Every stored alias event matched a proxied request on the same account with identical token counts
root_cause: incorrect_assumption
resolution_type: code_fix
severity: medium
related_components:
  - usage-window-ledger
  - public-subscription-value
tags: [external-codex, usage-window-value, unpriced-tokens, route-profiles, double-count, public-subscription-value, model-provider]
---

# Unpriced route-alias tokens meant proxied Codex usage was counted twice

## Problem

The public subscription value feed (`GET /api/public/subscription-value`) reported several closed ChatGPT Pro windows with partial pricing. The House of Vibe value page shows such a window as "At least $X" with "Partial pricing: some captured usage is unpriced." The unpriced tokens were not usage the ledger had failed to price. They were the router's own proxied Codex requests, ingested a second time by the external Codex scanner.

## Symptoms

- A window is reported as `"partial"` whenever its `unpricedTokens` is above zero (`packages/http-api/src/handlers/public-subscription-value.ts:68-80`).
- The unpriced tokens sat under the route-profile model `claude-bccf-route-codex-pool-astra`. Only the router serves that name, so Codex can only have used it through the router.
- On 2026-11-13, 7 of 72 published windows showed partial pricing. Five were ChatGPT Pro windows whose unpriced tokens equalled their stored alias tokens exactly. The other two were Claude Max windows with Haiku 5.5 tokens, which have a separate cause (#520).

## What Didn't Work

- **Treating it as a missing price.** The first diagnosis was that the alias needed a price: map its catalog-role profile to the physical model it served, or give it a provisional price. The valuation step already maps an alias to a physical model, but only for a profile with a fixed `expectedPhysicalModel`. It leaves a catalog-role alias unmapped because current config cannot reconstruct which model each account's catalog served at the time (`packages/http-api/src/services/usage-window-valuation.ts:13-31`). Pricing these tokens would have counted the same usage twice, an estimated $59–778 too high across the affected windows (estimated on 2026-11-10), and removed the only visible sign of the double count.
- **Filtering by alias name alone.** A rollout that ran through the router can name a plain model instead of an alias. Those tokens price normally, so a name filter leaves that double count in place with no caveat at all. On 2026-11-14, 2,361 stored external `gpt-5.5` events from June came from such rollouts. They were never matched to an account, so no window counted them.

## Solution

PR #804 (Refs #782) makes the scanner skip usage the router already counted:

- The parser records `session_meta.model_provider` from each rollout's first line (`packages/http-api/src/services/external-codex-parser.ts:161`).
- The scanner counts no event from a rollout whose provider is set and is not `openai`. It also counts no event under a route-profile model, whatever the provider (`packages/http-api/src/services/external-codex-scanner.ts:298-310`). Older rollouts that name no provider still count.
- A rollout counted before that now reads as proxied gets an empty replacement, which removes its stored rows the next time its file is scanned.
- Tests: `packages/http-api/src/services/external-codex-scanner.test.ts:603` and `:649`, and `packages/http-api/src/services/__tests__/external-codex-parser.test.ts:306`. The behavior is documented under External Codex Usage in `docs/configuration.md`.

The provider field was the right test. On 2026-11-10, all 535 retained alias events matched a proxied request on the same account with identical token counts. All 1,741 stored alias events came from rollouts whose provider was not `openai`, and none came from rollouts whose provider was. Between the fix's deploy on 2026-11-13 and 2026-11-14, the scanner ingested 154 rollout events, all from rollouts whose provider was `openai` and none under a route alias.

## Why This Works

Codex writes the provider it used into each rollout's `session_meta`. A Codex home pointed at the router through its own provider block records that provider's name, not `openai`. So the provider says who saw the request first: anything other than OpenAI means the router logged it as a proxied request with its real token counts, and the scanner's copy is a duplicate. The route-alias check covers the one kind of name that never comes from direct OpenAI use, whatever the provider field says.

## What the fix does not heal

- Stored rows stay until their rollout file changes. The scanner skips unchanged files, and a finished rollout is rarely written again. On 2026-11-14, 1,790 rows under `claude-bccf-route-codex-pool-astra` and 2 under a second route alias were still stored.
- When stored rows are removed, the scanner hands the affected account and timestamps to `reaggregateClosedWindows` (`apps/server/src/server.ts:1725`; `packages/database/src/repositories/external-usage.repository.ts:530-544`). That rebuilds a closed window from the requests table only while request retention still covers the window's start and still holds every proxied request the window counted (`packages/http-api/src/services/usage-window-ledger.ts:146-225`). Otherwise it logs `Skipping retention-unsafe external usage rebuild`, clears the window's pending-rebuild marker so later scans do not retry it, and leaves the window unchanged, with no alert.
- Without a repair, the affected windows drop out of the public feed one by one, because it shows only each account's last eight closed weekly windows (`packages/http-api/src/handlers/public-subscription-value.ts:236`). The last one drops out around mid-January 2027. A one-off repair, deleting the stored alias rows and then rebuilding the windows retention still covers, changes production data and needs the operator's go.

## Prevention

- Before pricing an unpriced model, find out where its tokens came from. If they are in `external_usage_events`, match those events against `requests` for the same account and time, looking for identical token counts. A match means the usage was ingested twice: fix the ingestion, not the price.
- Never give a route alias (`claude-bccf-route-…`) a price or a provisional price era. Only the router serves those names, so external usage under one is always a copy.
- The same double count can happen silently under a plain model name, which prices normally and raises no caveat. Codex pointed at the router with `openai_base_url` or `OPENAI_BASE_URL` can still record `openai` as its provider. Give the router its own `[model_providers.<name>]` block, or leave that Codex home out of `external_codex_homes`. The token-count match above is how to detect this case.

## Related Issues

- #782 (this bug) and PR #804 (the fix).
- #541 (PR #543): the external Codex scanner and the retention-bounded closed-window rebuild.
- #532: the public subscription value feed.
- #520: Claude Max windows left partial for a different reason.
- `docs/solutions/integration-issues/new-claude-model-drift-alert-means-bundled-catalog-lag.md`: a different source of unpriced tokens, a model the bundled price table did not know yet.
