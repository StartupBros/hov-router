---
title: A banked-reset gate built on an inferred vendor field blocked a redemption that works
date: 2026-11-10
category: integration-issues
module: codex-provider
problem_type: integration_issue
component: api_layer
symptoms:
  - "The accounts page showed held Codex banked resets as Not usable now and kept Use reset disabled, while ChatGPT's website offered the same resets"
  - "All three Pro accounts read available_count 2 and applicable_available_count 0, including one at 100% of its weekly limit"
root_cause: incorrect_assumption
resolution_type: code_fix
severity: medium
related_components:
  - frontend
tags:
  - codex
  - banked-resets
  - reset-credits
  - reference-client
  - codex-cli
  - chatgpt-backend
---

# A banked-reset gate built on an inferred vendor field blocked a redemption that works

## Problem

The banked-resets plan offered the dashboard's Use reset only when OpenAI's `rate_limit_reset_credits.applicable_available_count` was above zero (R8 and KTD7 in `docs/plans/2026-11-02-1712-feat-banked-resets-plan.md`, shipped in #707). The plan inferred what the field means from three accounts in one capture. The gate stopped the operator from redeeming resets that OpenAI's own clients redeem.

## Symptoms

- On 2026-11-10 the accounts page showed every held reset as "Not usable now" and kept Use reset disabled. ChatGPT's website showed the same resets as usable.
- The usage poll reported `available_count` 2 and `applicable_available_count` 0 on all three Pro accounts: pro-primary-wmgm, pro-secondary-bros and pro-tertiary-will. pro-tertiary-will was at 100% of its weekly limit.

## What Didn't Work

- **Reading the vendor client for mechanics only.** On 2026-11-02 the planning session extracted the installed Codex TUI's usage code and read its `reset_eligible` block (session history). The plan then copied the TUI's request-id minting and consume call (KTD8, KTD10). It took the gate from the API field's name instead of from the TUI's condition. KTD7 says so: "The meaning is inferred from the three accounts in the 2026-11-02 capture."
- **Explaining the 0.** A theory that the router's own 100% capacity stop made OpenAI report 0 was offered as fact, then retracted. Nothing observed supports it. What the field means is still unknown, and no fix depends on knowing it.

## Solution

Gate the way OpenAI's Codex CLI does. In openai/codex at `e0370f0b` (main, fetched 2026-11-10), the TUI's usage menu in `codex-rs/tui/src/chatwidget/usage.rs` enables Redeem reset when the user is signed in with ChatGPT and holds a reset. It never reads an applicable count, and its backend types do not declare one:

```rust
let reset_eligible = self.has_chatgpt_account;
let (reset_action_enabled, reset_description) =
    match (reset_eligible, self.available_rate_limit_reset_credits) {
        (true, Some(available_count)) if available_count > 0 => {
            (true, format!("{available_count} available"))
        }
        (true, None) => (true, "Check availability".to_string()),
        (true, Some(_)) | (false, _) => (false, "None available".to_string()),
    };
```

- #773 changed the server gate in `packages/http-api/src/services/codex-reset-redemption.ts`. A fresh count with at least one held reset is enough to send. A stale count still answers 409 `counts_stale`, and none held answers 409 `none_held`.
- #775 removed the applicability wording from the account row, fleet summary and confirmation dialog. The API still returns `applicableCount` and `appliesNow` as OpenAI reports them.

The operator's first redemption, on pro-tertiary-will on 2026-11-10 at an applicable count of 0, returned HTTP 200 with code `reset`. Held resets went from 2 to 1 and weekly use from 100% to 0%. The applicable count read 0 afterwards too.

## Why This Works

OpenAI decides what a consume resets, and its own client asks only whether the user is signed in with ChatGPT and holds a reset. A router gate stricter than the vendor's client can only refuse actions the vendor allows. The router stays stricter in one deliberate way: it refuses a stale count, where the TUI offers "Check availability", because Use reset is one confirmed click on an irreversible spend.

## Prevention

- Before gating a user action on a vendor response field, find the vendor's own client and copy its gate condition, citing file, line and revision in the plan's decision. For OpenAI's `wham` endpoints that client is the Codex CLI; for Qwen, `AGENTS.md` already requires mirroring qwen-code. If the client never reads the field, do not gate on it.
- A field whose meaning a plan records as inferred may be displayed, but must not disable an action until a real action confirms the meaning.
- When a plan copies a client's request shape, also copy when that client offers the action.
- These tests hold the current gate: "sends when OpenAI counts none of the held resets as applying, as the Codex CLI does (#772)" in `packages/http-api/src/services/__tests__/codex-reset-redemption.test.ts`, and the tests whose titles begin "is enabled on any fresh held count, whatever OpenAI's applicable count says" in `packages/dashboard-web/src/components/accounts/BankedResetsStatus.test.tsx` and `reset-redemption-flow.test.ts`.

## Related Issues

- #772 (the incident) and #691 (the banked-resets work-spec); PRs #707, #773 and #775.
- [validate-against-live-payloads.md](../validate-against-live-payloads.md): a live payload shows a field's shape. This doc is about its meaning.
- [codex-model-unsupported-can-mean-stale-client-identity.md](./codex-model-unsupported-can-mean-stale-client-identity.md): another case where the Codex CLI's behaviour was the ground truth.
- [claude-code-websearch-refused-as-no-implementation.md](./claude-code-websearch-refused-as-no-implementation.md): another local gate that refused a vendor action that works.
