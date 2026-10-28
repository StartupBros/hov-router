---
title: Authorization-Before-Ranking and Success-Conditioned Route Ownership
date: 2026-09-01
category: architecture-patterns
module: routing
problem_type: architecture_pattern
component: commit-bound routing
severity: high
applies_when:
  - Extending capability-profile descendant or trusted-helper routing
  - Adding pre-dispatch fallback, affinity, or route-home behavior
  - Changing provider-owned server-tool dispatch or failover
related_components:
  - session affinity
  - server-tool routing
  - request provenance
tags:
  - routing
  - route-profiles
  - session-affinity
  - server-tools
  - failover
  - authorization
---

# Authorization-Before-Ranking and Success-Conditioned Route Ownership

## Context

Route profiles establish **authorization**, not a standing preference that can be widened by whichever ranking mechanism runs next. A capability profile admits a root-capable pool from its expected provider and root logical-to-physical mapping; its descendants may use that pool without being pinned to the root physical model. The descendant ladder is requested model in the pool, root model in the pool, then the requested stock model through ordinary same-model routing; mapped providers are not eligible merely because they are available (`docs/configuration.md:456`).

This produces one combined invariant:

> **Compile the complete authorized candidate set before ranking it; commit a child home only after an accepted successful route.**

The two halves protect each other. If ranking runs before authorization, affinity, priority, probe recovery, or a cached owner can smuggle an ineligible account into the request. If ownership is written at selection or attempt time, an unusable candidate becomes a falsely sticky home. The candidate compiler expresses the three rungs as profile-requested, profile-root, and global-requested, applies the ordinary stock-model eligibility fence specifically to the global rung, deduplicates by account plus physical model, and only then passes eligible candidates to the strategy (`selectCapabilityDescendantAccounts`, `packages/proxy/src/handlers/account-selector.ts:2967-3177`).

Session history records why an exact account choice was not enough in earlier route-profile work: descendants could retain a logical model whose mapping did not satisfy the profile's physical or server-tool contract. It also records a routing-integrity correction where one late candidate mismatch incorrectly terminalized a request despite another authorized candidate. These are historical investigation findings rather than current-source claims; the current tree separately verifies candidate filtering and authorized-plan exhaustion. (session history)

This is intentionally not a general escape hatch. The selector rejects a public force route that conflicts with a capability profile (`packages/proxy/src/handlers/account-selector.ts:3491-3499`), and an unavailable force-routed account returns a typed error rather than normal-pool routing (`packages/proxy/src/handlers/account-selector.ts:3500-3540`). Ordinary stock-Claude traffic remains protected by the same-model integrity fence from PR #285, while the descendant behavior shipped in PR #286.

A child route home is narrower than a parent session binding: it is a process-local lane for one authenticated caller/session/child lineage. Affinity is keyed per lane by `deriveAffinityLaneKey`, which combines the session, protocol family, request path, model family, effective model, and canonical `anthropic-beta` signature. Profile lanes add the route profile under a separate key version, and descendants also add the bounded child-home key. A marker-only descendant with no child-home key gets no reusable key (`packages/proxy/src/handlers/account-selector.ts:1336-1376`). The shared vocabulary defines a child home as the first successful provider/account-class/physical-model lane for that child, preferred by later turns until a genuine availability failure; parents and siblings remain independent, and only `session-affinity` and sticky `session-drain-soonest` keep one (`CONCEPTS.md:139-147`).

Provider-owned hosted tools have the same boundary in a stricter form. The request-local ledger has a monotonic `undispatched → hosted_dispatched` claim that cannot be released by retry or failover (`packages/proxy/src/handlers/routing-attempt-ledger.ts:410-424`). Once a hosted dispatch may have occurred, proxy operations treat it as terminal rather than as an ordinary candidate miss (`HostedDispatchTerminalError`, `packages/proxy/src/handlers/proxy-operations.ts:337-347`; converted to a terminal response at `packages/proxy/src/handlers/proxy-operations.ts:8672-8681`). The native Codex Hosted WebSearch foundation and this dispatch boundary shipped in PR #129. That terminal check also covers a started exact-profile subscription WebSearch helper (`hasWebSearchHelperDispatched`), so the helper exception in guidance 3 sits behind the same at-most-once boundary.

## Guidance

1. **Authorize first.** Derive route class and hard boundaries from server-trusted state, then compile an immutable request-local candidate plan. A strategy may only reorder or temporarily suppress members of that plan; it must not add accounts, providers, models, or fallback rungs. The selector treats strategy output as ordering rather than authority and filters it back to the established eligible set: candidate ids for a descendant plan (`packages/proxy/src/handlers/account-selector.ts:3151-3158`), account ids for the ordinary pool (`packages/proxy/src/handlers/account-selector.ts:3268-3276`).

2. **Make rung order stronger than ranking.** Preserve semantic order between rungs; allow priority, load, probes, and affinity only to order candidates within a rung. The compiler emits rung specifications in semantic order before deduplication and capacity filtering (`packages/proxy/src/handlers/account-selector.ts:3052-3110`).

3. **Keep hard boundaries outside the ladder.** Exact-account, public force-routed, and bounded routes fail closed; do not compile their unavailable route into a global fallback. A same-session provider-owned WebSearch helper inherits the active capability profile and uses its exact proven server-tool route first; it may use the global proven capability lane only when that soft capability pool is unavailable before hosted dispatch (`docs/configuration.md:458`; helper lineage is classified in `docs/routing-architecture.md:98`). One narrow exception exists since #644. An exact, unbounded profile that explicitly opts in with `webSearchHelper` sends its fresh standalone WebSearch helpers to first-party Anthropic subscription accounts instead of failing closed. Those accounts are the listed ones, or any of them in pool mode. Each needs router-owned usage evidence under 180 seconds old, allowance left, and extra usage disabled. There is no paid or ordinary-inventory fallback and at most one send. A public `x-better-ccflare-account-id` header disables the exception. It does not widen the ladder. The opt-in is part of the profile's server-trusted authorization, and the helper branch admits accounts before the strategy ranks them, then filters the ranked list through the same admission again (`packages/proxy/src/handlers/account-selector.ts:3460-3490`). Details: [configuration](../../configuration.md#subscription-websearch-helper-opt-in) and [routing architecture](../../routing-architecture.md#exact-profile-subscription-websearch-helpers).

4. **Select provisionally; commit conditionally.** A candidate is not a home because it was ranked first, selected, acquired credentials, or started an attempt. Commit only at the accepted-candidate seam after terminal arbitration has chosen a successful response. `settleRoutedResponse` calls the home-commit callback only for successful accepted responses, so a failed terminal cannot own a descendant home (`packages/proxy/src/proxy.ts:3398-3457`).

5. **Use compare-and-set replacement semantics.** Retain a healthy child home first. Permit replacement only when the exact old home was observed unavailable, excluded, structurally removed, capacity/credential blocked, or circuit-open. `SessionAffinityStrategy` retains a valid descendant owner ahead of other candidates and sets a concrete re-pin reason otherwise (`packages/load-balancer/src/strategies/session-affinity.ts:992-1045`); its commit operation refuses a different owner unless the expected old candidate and replacement authorization match (`commitDescendantAffinityOwner`, `packages/load-balancer/src/strategies/session-affinity.ts:469-527`). The re-pin reason type declares six reasons, but `select()` assigns only four: `route_circuit_open`, `hard_exclusion`, `account_unavailable`, and `structural_removal` (`packages/load-balancer/src/strategies/session-affinity.ts:1030-1044`). `model_capacity` and `credential_failure` are declared but never assigned. `SessionAffinityStrategy` and sticky `session-drain-soonest` keep child homes. The default `session` strategy and `least-used` do not implement the optional `commitDescendantAffinityOwner` hook, and the request loop records a missing hook as `none` (`packages/types/src/context.ts:250-255`, `packages/proxy/src/proxy.ts:3458-3468`). `session-drain-soonest-strict` returns a null selection key unless a retain-owner directive is present, so `select()` skips the descendant block and the commit refuses (`packages/load-balancer/src/strategies/session-drain-soonest.ts:70-78`, `packages/load-balancer/src/strategies/session-affinity.ts:507-510`). Under those three strategies every child turn is ordered afresh within its rung plan. Strict's one exception is that directive: Anthropic degraded mode `enforce` publishes it only for a native Anthropic OAuth owner (`materializeDegradedOwnerDirective`, `packages/proxy/src/handlers/account-selector.ts:2108-2194`), and with it strict keeps the key, so `select()` runs the descendant block and the commit can install or retain a child home.

6. **Treat irreversible dispatch as a separate ownership boundary.** Revalidate the exact hosted-tool proof immediately before transport, assert the physical budget, then synchronously claim hosted dispatch. Two shared helpers do the revalidation and the claim: `assertAttemptPlanCapabilityIsCurrent` (`packages/proxy/src/handlers/proxy-operations.ts:3581-3600`) and `claimCurrentHostedDispatch` (`packages/proxy/src/handlers/proxy-operations.ts:3739-3750`). The WebSocket hook asserts the budget and claims in `onBeforeFrameWrite` (`packages/proxy/src/handlers/proxy-operations.ts:4634-4641`, `packages/proxy/src/handlers/proxy-operations.ts:4683-4689`). The HTTP hook claims in the pre-fetch callback (`packages/proxy/src/handlers/proxy-operations.ts:4642-4650`, `packages/proxy/src/handlers/proxy-operations.ts:4710-4711`). No later candidate, guard replay, model fallback, or account failover may repeat that inbound hosted operation.

A TypeScript-shaped implementation keeps the authority boundary visible:

```ts
type AuthorizedCandidate = {
  id: string;
  accountId: string;
  logicalModel: string;
  physicalModel: string;
  rung: "profile_requested_model" | "profile_root_model" | "global_requested_model";
};

function compileAuthorizedPlan(input: RouteInput): AuthorizedCandidate[] {
  assertHardBoundary(input); // exact/force/bounded: permit one route or fail

  const profilePool = accounts.filter((account) =>
    provesRootCapability(account, input.profile),
  );
  const globalStockPool = accounts.filter((account) =>
    servesOrdinaryStockModel(account, input.requestedModel),
  );

  return dedupeAccountPhysical([
    ...profilePool.map((account) =>
      candidate(account, input.requestedModel, "profile_requested_model"),
    ),
    ...profilePool.map((account) =>
      candidate(account, input.profile.rootModel, "profile_root_model"),
    ),
    ...globalStockPool.map((account) =>
      candidate(account, input.requestedModel, "global_requested_model"),
    ),
  ]);
}

async function routeDescendant(input: RouteInput) {
  const authorized = compileAuthorizedPlan(input);
  const ordered = rankWithinRung(preferHealthyHome(authorized, input.childLane));

  for (const candidate of ordered) {
    const result = await attempt(candidate);
    if (!result.accepted) continue;

    commitHomeIfExpected(input.childLane, candidate, result.replacementEvidence);
    return result.response;
  }
  return typedAuthorizedExhaustion(authorized);
}
```

The pseudocode models existing behavior: candidate metadata includes the rung and effective logical model (`packages/proxy/src/handlers/account-selector.ts:3091-3106`), and route provenance constrains allowed rungs, home actions, and re-pin reasons (`packages/types/src/request.ts:45-80`).

## Why This Matters

Authorization and ownership are security and correctness properties, not optimizations.

- **No eligibility laundering.** A high-priority account, recovered account, affinity owner, or probe target cannot become eligible because it ranks well. The global descendant rung applies ordinary stock-model eligibility before implicit fallback policy (`packages/proxy/src/handlers/account-selector.ts:3036-3051`).
- **No false stickiness.** A credential failure, pre-dispatch rejection, or losing provisional response must not strand future turns. The request loop invokes `commitDescendantAffinityOwner` only through `commitDescendantRouteHome` (`packages/proxy/src/proxy.ts:3458-3468`). Each routed-response branch passes that function to `settleRoutedResponse` as its winner callback (for example `packages/proxy/src/proxy.ts:3724-3726`).
- **Continuity without snapback for child homes.** A healthy child home stays preferred despite priority changes or recovery of a preferred rung. The descendant branch of `select()` returns before the quota-pressure hooks that move ordinary owners. Re-pinning is driven by concrete route evidence, and the allowed reasons are structurally bounded (`packages/load-balancer/src/strategies/session-affinity.ts:1000-1045`, `packages/types/src/request.ts:60-68`). This holds only under the strategies that keep child homes (guidance 5). Ordinary parent-session affinity is weaker. A healthy owner can be remapped by a same-tier pressure-band outclass, or when a displaced owner recovers to its home tier (`packages/load-balancer/src/strategies/session-affinity.ts:1515-1554`). The opt-in `session-drain-soonest` strategy delays that remap for a warm Anthropic owner. The hold ends once the owner has been idle for `ANTHROPIC_WARM_CACHE_MS` or the hold has lasted `ANTHROPIC_PRESSURE_HOLD_CAP_MS` (`packages/load-balancer/src/strategies/session-drain-soonest.ts:25-27`, `packages/load-balancer/src/strategies/session-drain-soonest.ts:93-109`). The default strategy is `session` (`packages/core/src/strategy.ts:12`).
- **At-most-once hosted work.** Server-owned operations can be non-idempotent or produce provider-owned state. The ledger's synchronous first-claim-wins transition prevents replay through a sibling lane after the dispatch boundary (`packages/proxy/src/handlers/routing-attempt-ledger.ts:415-424`).
- **Truthful diagnostics.** Response metadata exposes only coarse fallback and routed-model facts (`packages/proxy/src/response-handler.ts:266-310`). Durable request provenance preserves bounded operator details with preserve-first updates, and its route columns freeze once a routing attempt summary is recorded (`packages/database/src/repositories/request.repository.ts:351-355`, `packages/database/src/repositories/request.repository.ts:343-350`). SQLite and PostgreSQL define matching route-provenance columns in both the create and upgrade paths (`packages/database/src/migrations.ts:513-520`, `packages/database/src/migrations.ts:2633-2646`, `packages/database/src/migrations-pg.ts:791-798`, `packages/database/src/migrations-pg.ts:1902-1915`).

Operational observation belongs in the implementation closeout record, not in this invariant. Automated boundary tests remain the proof of the authorization, ownership, and at-most-once properties.

## When to Apply

Apply this invariant when changing any of these areas:

- Capability-profile descendant models, root-model substitution, or global fallback rungs.
- `SessionAffinityStrategy`, route circuits, candidate metadata, or strategy ordering.
- Trusted helpers or provider-owned tools, especially when a helper model is not an operator-selected model.
- Attempt-plan construction, credential/pretransport flow, HTTP dispatch, WebSocket writes, retries, guard recovery, or response arbitration.
- Route-selection provenance or its database migrations; update both SQLite and PostgreSQL schemas and upgrade paths.

Do **not** apply it by silently broadening existing route classes. Ordinary stock-Claude roots remain subject to the same-model fence, and exact-account, force-routed, and bounded profiles remain fail-closed. The only carve-out is the explicit exact-profile `webSearchHelper` opt-in in guidance 3, which a public force header disables.

## Examples

### Authorized fallback, then ranking

```ts
const plan = compileAuthorizedPlan({
  profile: solCapabilityProfile,
  requestedModel: "claude-sonnet-5",
  childLane,
});

// Correct: reorder only candidates already proven by their rung.
const ranked = rankWithinEachRung(plan, { affinity, priority, probeState });

// Incorrect: grants eligibility because an unrelated route is available.
const unsafe = [...ranked, ...allAvailableAccounts];
```

Test with a higher-priority mapped provider: it must remain absent from an ordinary stock root and the global requested-model rung unless it independently satisfies ordinary eligibility.

### Selection is not ownership

```ts
const candidate = strategy.select(authorized)[0];
// Do not: homes.set(childLane, candidate);

const attempt = await transport(candidate);
if (attempt.acceptedWinner) {
  homes.compareAndSet({
    lane: childLane,
    expected: currentUnavailableHomeOrNull,
    next: candidate,
  });
}
```

Test rejected-before-dispatch, credential failure, pre-acceptance upstream failure, accepted success, concurrent first successes, priority change, recovered preferred rung, every enumerated re-pin reason, sibling isolation, and restart/TTL expiry.

### Hosted tool: authorize before dispatch; never replay after dispatch

```ts
const candidate = nextAuthorizedProvenHostedCandidate();
assertExactCapabilityProof(candidate);
ledger.assertPhysicalAttemptAvailable({ accountId: candidate.accountId });
if (!ledger.claimHostedDispatch()) return terminalAlreadyDispatched();

return sendHostedRequest(candidate); // irreversible boundary
// Never select another hosted candidate for this inbound request after this point.
```

Test one-and-only-one transport across HTTP, WebSocket, in-process retries, failover, cancellation before and after claim, guard recovery, and ambiguous writes.

### Observable outcome without leaking topology

```ts
persistOperatorProvenance({
  profileId,
  requestedModel,
  routedProvider,
  routedModel,
  fallbackRung: winner.rung,
  homeAction: "repinned",
  repinReason: "route_circuit_open",
  candidateId: winner.id,
});

return addClientHeaders(response, {
  fallbackRung: winner.rung,
  routedModel,
});
```

Response-facing metadata excludes account and candidate identifiers, while authenticated operator history retains the bounded route facts needed to reconstruct the decision.

## Related

- [Account Routing Architecture](../../routing-architecture.md)
- [Configuration](../../configuration.md#claude-code-model-route-profiles)
- [Commit-Bound Capability Profile Descendant Routing Plan](../../plans/2026-08-30-1854-fix-route-profile-descendant-routing-plan.md)
- [Codex Native Hosted Web Search Plan](../../plans/2026-07-29-001-fix-provider-server-tool-capability-architecture-plan.md)
- [Rate-Limit Scope and Duration](../rate-limit-scope-and-duration.md)
