---
title: A translated stream's keepalive ping must reset the client's idle clocks, never the router's evidence clocks
date: 2026-10-27
category: integration-issues
module: sse-stream-translation
problem_type: integration_issue
component: proxy
symptoms:
  - "Claude Code on the ai-gateway / LiteLLM lane shows 'API Error: Connection lost mid-response. The response above may be incomplete.' while a long tool call is generated"
  - "The guard logs response_body_idle_timeout about 120 s after the last bytes it forwarded on an openai-compatible account"
  - "After the keepalive fix, a silent xai, kilo or qwen upstream would hold its first candidate pre-commit for about 810 s instead of failing over at 420 s (found in review, never observed live)"
root_cause: incorrect_assumption
resolution_type: code_fix
severity: high
related_components:
  - guard
  - openai-formats
  - usage-collector
tags:
  - keepalive
  - ping
  - idle-timeout
  - precommit-gate
  - sse-translation
  - litellm
  - claude-code
  - guard
---

# A translated stream's keepalive ping must reset the client's idle clocks, never the router's evidence clocks

## Problem

Requests routed from Claude Code to the mac-studio DeepSeek lane (guard `:8788` → backend `:8789` → openai-compatible account `ai-gateway-chat` → LiteLLM `chat` → oMLX) started failing with "Connection lost mid-response" whenever the model spent minutes generating a tool call. The fix (#636) made the openai-formats translator send Anthropic `ping` events into downstream silence. Its first version also let those locally made pings count as proof that the upstream was alive, which would have hidden a hung xai, kilo or qwen upstream from the pre-commit gate (#638, fixed by #639).

There are several idle clocks between the upstream and Claude Code. A ping the router makes itself must feed the clocks that protect the client and must stay out of the clocks that judge the upstream.

## Symptoms

- Claude Code prints `API Error: Connection lost mid-response. The response above may be incomplete.` after some output is already on screen. The partial response stays visible.
- `journalctl -u ccflare-stack.service --since -2h -o cat | grep response_body_idle_timeout` shows the guard cutting the stream. The line carries the guard request `id`, `elapsedMs` and `responseIdleTimeoutMs` (`scripts/ccflare-guard.mjs:3061-3068`), plus the abort-owner and response-telemetry fields. None of those name the account, so join on the request id or the time window to find it.
- A completed stream's `anthropic_stream_terminal_outcome` (which includes `pingEventCount`) is logged at info (`packages/proxy/src/response-handler.ts:1454`). Production runs with `LOG_LEVEL=warn`, so on a successful stream you cannot see whether pings were sent. Only non-completed outcomes log at warn.

Claude Code 2.1.311 contains two different messages for stalled streams. Telling them apart is the first diagnostic step.

- `Connection lost mid-response. The response above may be incomplete.` The transport dropped after output was shown, and in this incident that was the router's guard cutting the body.
- `The response stopped arriving`. In the earlier investigation this was Claude Code's own stream watchdog firing, not a router cut.

## What Didn't Work

- **Assuming held pings are harmless pre-commit.** The #636 PR said pings held by the pre-commit gate never reach the client, so they could not matter. They never reached the client, but the gate's frame classifier marks `ping` as `keepalive` with `validProtocolActivity: true` (`packages/proxy/src/anthropic-sse-frame-classifier.ts:227-228`), and the gate pushed its protocol-idle deadline forward on every valid protocol frame. On openai-compatible this had no effect, because #505 had already disabled protocol idle for that provider. xai, kilo and qwen use the same translator but were not exempt. A silent upstream there would have produced a synthesized ping every 25 s, each one moving the 420 s deadline. The first candidate would then fail over only at the request-wide commitment deadline: 14 min for Claude Code requests, or about 810 s on the first candidate once the 30 s fallback reserve is taken out (`packages/proxy/src/anthropic-precommit-rescue.ts:26-44`). This was caught in review. No live grok hang was observed, so #639 prevents the delay rather than repairing a reported one.
- **(session history)** In the #504 work, lowering Claude Code's first-byte timer with `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS` was tried and reverted. A recovery was first credited to oMLX memory changes, but it came from a smaller re-prompt finishing inside the client window. Client-side timer tuning and model-host tuning are both the wrong lever for router-side idle cuts.

## Solution

Two changes, one per side of the contract.

**#636 (`da46c93c`): give the client bytes during upstream silence.** After 25 s of downstream silence, `transformStreamingResponse` in `packages/openai-formats/src/stream.ts` emits `event: ping` (`DEFAULT_KEEPALIVE_INTERVAL_MS`, line 21). It stops pinging once the upstream body itself has been silent for 15 min (`DEFAULT_KEEPALIVE_MAX_UPSTREAM_SILENCE_MS`, line 28), so a truly hung upstream still trips the guard. It never pings before `message_start` or after a terminal error frame. The interval, the silence cap and a scheduler are injectable for tests (`keepaliveIntervalMs`, `keepaliveMaxUpstreamSilenceMs`, `keepaliveScheduler`).

**#639 (`03777716`): keep those pings out of the gate's evidence.** The gate takes `keepaliveIsProtocolActivity`. When it is false, a `keepalive` frame is still classified and buffered but no longer refreshes the protocol-idle deadline:

```ts
// packages/proxy/src/anthropic-semantic-preflight.ts (applyFrameDecision)
if (
	classification.validProtocolActivity &&
	(keepaliveIsProtocolActivity || classification.kind !== "keepalive")
) {
	lastValidProtocolActivityAt = Date.now();
	if (terminalDeadline === undefined && protocolIdleTimeoutEnabled) {
		protocolIdleDeadline = lastValidProtocolActivityAt + semanticTimeoutMs;
	}
}
```

```ts
// packages/proxy/src/handlers/proxy-operations.ts (pre-commit gate call)
disableProtocolIdleTimeout:
	hasIrreversibleCodexWebSocketWrite ||
	isProtocolIdleExemptProvider(account.provider),
keepaliveIsProtocolActivity: !isTranslatedSseProvider(account.provider),
```

`isTranslatedSseProvider` covers `openai-compatible`, `kilo`, `qwen` and `xai`, the providers that inherit `OpenAICompatibleProvider.processResponse` and so run the translator. Turning pings off for all of them loses no evidence. The translator never forwards an upstream keepalive, and every ping on a translated stream is made locally: one right after the synthesized `message_start` (`stream.ts:256`), and the rest on the keepalive timer (`stream.ts:542`). Native Anthropic streams keep the default (`true`), because a native upstream's pings come from the upstream.

## Why This Works

Each idle clock answers one of two questions. Is the client still receiving bytes? Or has the upstream shown it is alive? A locally made ping is a correct answer to the first and a false answer to the second.

| Clock | Default / production value | Reset by a translator ping? |
|---|---|---|
| Claude Code's own stream watchdog | client-side | Yes. This is the point. The `stream.ts:18-19` comment records that Claude Code honours at most 30 consecutive pings before its 300 s idle floor applies, so a 25 s cadence covers about 17.5 min. |
| Guard response-body idle watchdog | 120 s (`DEFAULT_GUARD_RESPONSE_IDLE_TIMEOUT_MS`, `scripts/ccflare-guard.mjs:80`; env `GUARD_RESPONSE_IDLE_TIMEOUT_MS`) | Yes. `arm()` (`ccflare-guard.mjs:1056`) runs on every forwarded chunk (`:1072`). This is the clock that cut #633. |
| Backend post-commit semantic liveness | protocol idle refreshed per valid frame (`anthropic-semantic-liveness.ts:270-278`) | Yes. After commit the client already has output, and the goal is not to cut a working stream. |
| Usage collector inactivity eviction | 15 min since #641 (`TIME_CONSTANTS.STREAM_TIMEOUT_DEFAULT`; env `CF_STREAM_TIMEOUT_MS`); was 60 s | Yes, as a side effect. The collector taps the same body the client receives (`response-handler.ts:1267-1270`), and any chunk, ping included, refreshes `lastActivity` (`usage-collector.ts:1004`), which the eviction check reads. It no longer needs pings: since #641 the default outlasts every other timer in this table that can end a silent stream, so the eviction only frees abandoned state. `outlasts every timer that can still end a live stream` in `usage-collector-lifecycle.test.ts` fails if either side moves. |
| Pre-commit protocol-idle deadline | code default 120 s (`ANTHROPIC_PRE_COMMIT_SEMANTIC_TIMEOUT_MS`); production 420 s via `CCFLARE_ANTHROPIC_PRECOMMIT_TIMEOUT_MS` in the service environment; hard cap 10 min | Native: yes, because those pings come from the upstream. openai-compatible: the deadline is off entirely (#505). xai, kilo, qwen: **no, since #639**. |
| Pre-commit commitment deadline (meaningful progress) | 150 s generic, 14 min for Claude Code requests (`anthropic-precommit-rescue.ts:26-44`) | No. Only a meaningful, `message_stop`, error or unknown frame commits the gate. |
| Guard accepted request deadline | `GUARD_ACCEPTED_CAP_MS`, 1,470,000 ms | No. It is a fixed timer armed when the request is accepted and cleared only when the guard disposes the request. Nothing re-arms it. |

Two consequences explain the incident's shape:

- **Before commit, translator pings reach neither the guard nor the client.** The gate holds them. Pre-commit client liveness belongs to the rescue ping in `anthropic-precommit-rescue.ts`, which starts at 135 s with a 25 s interval. The #636 cadence deliberately matches that rescue interval. So the guard's 120 s cut can only bite after commit, which is after output is visible, and that is why Claude Code said "mid-response".
- **#505 and #639 are the same rule from two sides.** #505 says a silence the router cannot see past (LiteLLM drops upstream keepalives) is not evidence of a dead upstream. #639 says a liveness signal the router made itself is not evidence of a live one.

## Prevention

- **Any frame the router makes itself must declare which clocks it may feed.** Rescue pings, translator pings and synthesized `message_start` frames are all local. Before adding another, walk the table above and decide for each clock whether a local frame is a valid answer. The default is: client-side clocks yes, evidence clocks no.
- **New translated providers join the set automatically or fail a test.** `describe("isTranslatedSseProvider")` in `packages/proxy/src/__tests__/anthropic-semantic-preflight.test.ts` iterates the provider registry and requires `isTranslatedSseProvider(name)` to equal `getProvider(name) instanceof OpenAICompatibleProvider`. A new subclass that is left out of `TRANSLATED_SSE_PROVIDERS` fails this test.
- **Behavioural guards on both layers.** The gate test with `keepaliveIsProtocolActivity: false` expects `semantic_timeout` while pings keep arriving. The proxy test `translated keepalive pings (issue #638)` in `proxy-anthropic-semantic-failover.test.ts` drives a real xai provider with a 10 ms keepalive against a held-open upstream and expects a `semantic_timeout` stall event. Before the fix, these got `meaningful_progress_timeout` and no stall event respectively. Four mutations of the fix were each run against the new #638 tests, and each turned one red: dropping the proxy wiring and removing `xai` from `TRANSLATED_SSE_PROVIDERS` fail `times out a silent xai upstream while translated pings keep flowing`; passing `false` for every provider fails `still lets real upstream pings hold a native anthropic stream open`; and a gate that ignores the option fails `does not refresh precommit idle on pings that are not upstream evidence`.
- **Diagnose by clock, not by message.** Grep the guard for `response_body_idle_timeout` first. If it is absent and the client still reported a stall, the cut was on the client or the upstream side. Because successful-stream outcomes are info-level, raise `LOG_LEVEL` on a test instance (port 8081), not in production, when you need `pingEventCount`.

## Related Issues

- #633: guard 120 s idle cut on translated streams during long tool calls; fixed by PR #636.
- #638: translated keepalive pings must not extend the pre-commit protocol-idle deadline; fixed by PR #639.
- #504 / PR #505: openai-compatible exempt from pre-commit protocol idle (the mirror rule).
- #634: usage collector evicted silent streams before the guard's idle cut, losing their rows; fixed by PR #641 (open pending confirmation).
- #493: guard idle watchdog arms before headers are flushed (open; same watchdog, different arming bug).
- #356: earlier precedent on what counts as meaningful progress versus activity.
- [Bun 1.4 stream cancel and net close semantics](../workflow-issues/bun-1-4-stream-cancel-and-net-close-semantics.md): adjacent translated-stream test behaviour.
