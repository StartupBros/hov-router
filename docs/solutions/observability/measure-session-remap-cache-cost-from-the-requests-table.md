---
title: Measure session-remap cache cost on remaps of a conversation, not on raw or partition-order account switches
date: 2026-10-15
last_updated: 2026-10-30
category: observability
module: session-affinity
problem_type: best_practice
component: observability
severity: medium
applies_when:
  - Sizing how much prompt-cache rewriting a routing strategy causes by moving sessions between Anthropic accounts
  - Verifying after a deploy that a session-affinity or drain-soonest change reduced cache-breaking remaps
  - Counting same-session account changes from the requests table
  - Choosing the per-request baseline that excess cache-write tokens are measured against
  - Attributing why a session's conversation moved accounts before proposing a stickiness fix
tags:
  - cache-health
  - prompt-cache
  - session-affinity
  - drain-soonest
  - pace-band
  - remap
  - affinity-lane
  - conversation-parent
  - measurement-methodology
  - observability
---

# Measure session-remap cache cost on remaps of a conversation, not on raw or partition-order account switches

## Context

Issue #509 needed two numbers: how often `session-drain-soonest` moved a warm Anthropic
session to another account only because that account sat in a higher weekly pace band, and
how much prompt-cache rewriting those moves cost. The same numbers verify PR #510, the
warm-owner hold, after it has run in production. Routing decisions are not logged at the
default `LOG_LEVEL=warn` (issue #197), so the `requests` table in the production database is
the only durable record.

Two populations look like remaps and are not.

- **Concurrent spread.** The first count looked alarming: 7,531 same-session account changes
  within five minutes over 14 days. A Claude Code session sends parallel requests (subagents,
  tool calls), and those can land on different accounts at the same moment. Nothing moved;
  the session was spread. Filtering to sequential, non-failover switches leaves 1,882.
- **Lane interleaving.** Issue #516 then attributed those 1,882 switches and found that most
  of them still are not remaps. Session affinity does not pin an owner per session and model.
  It pins one per *affinity lane*, so one `(client_session_id, model)` partition interleaves
  several lanes, each with its own owner. Comparing a request with the previous row of its
  partition often compares two lanes. Reconstructing each request's own conversation parent
  shows that 1,571 of the 1,882 switches (83%) were not remaps of a warm conversation.

The 2026-10-08 investigation into cache TTL policy reached the matching conclusion on the cost
side: judge cache cost by cache-write volume, not by hit rate, because a high hit rate alone
cannot show that one policy is cheaper (session history).

## Guidance

**`requests.timestamp` is when the row was saved, not when the request started.** The save
passes `Date.now()` (`packages/database/src/repositories/request.repository.ts:380`). From
2026-10-27 to 2026-10-31, 84.8–89.4% of each day's requests that ran over 5 seconds carry a
timestamp within 2 seconds of their first attempt's start plus `response_time_ms` (92–96%
within 5 seconds), and at most 0.5% carry one near the start. So a request starts at
`timestamp - response_time_ms` and ends at `timestamp`. The proxy's in-memory
`requestMeta.timestamp` is the start; do not take the column's meaning from it.

The steps, queries and figures below were written reading `timestamp` as the start.
Steps 2 and 5 and the queries take `timestamp + response_time_ms` as the end, so the
concurrency check uses the earlier request's duration where the later one's belongs.
Step 8 and the queries take `ts - prev_ts` as the idle gap, which runs from end to end. The
warm-owner hold's clock runs from selection to selection: routing sets `assignedAt` when it
picks the owner (`packages/load-balancer/src/strategies/session-affinity.ts:1541`) and takes
the idle time as `now - assignedAt` (`:1526-1529`). The matching gap is therefore start to
start. The end-to-end gap differs from it by the later request's duration minus the earlier
one's, which can go either way. Rows are ordered by end, not start.

A new measurement should take `timestamp - COALESCE(response_time_ms, 0)` as the start and
`timestamp` as the end, order rows by start, and split the gap start to start, as Query 3c
in "The queries" does. A comparison
against a figure below must either recompute that figure the same way or apply the original
reading to both windows.

**The effect on the baseline figures, measured 2026-10-30.** Most of the change comes from
the overlap test. The original reading marks many pairs that ran one after the other as
overlapping, so the corrected pair count is more than twice the original. A changed gap
definition alone could only move pairs across the 5-minute line. Query 3's under-five-minute
figures for the baseline window:

| Figure | Original reading | Corrected reading |
|---|---:|---:|
| Sequential non-failover pairs | 61,254 | 135,986 |
| Baseline cache writes per request | 4,977 | 4,708 |
| To-higher-band remaps (kinds 4 and 5) | 73 | 117 |
| Their excess | 10.01M | 19.84M |
| Remaps per 1,000 pairs | 1.19 | 0.86 |
| Excess per pair | 163 | 146 |

So a corrected run finds 60% more remaps and twice the excess, but a lower rate per pair,
because the denominator grows faster. The post-#510 comparison under both readings is in
"Result for the post-#510 window" below.

1. **Partition by `client_session_id` and `model`, and compare each request with the previous
   one.** A model change breaks the cache by itself, so a switch only counts within one
   model. Keep `success = 1` rows on accounts with `provider = 'anthropic'`.

2. **Drop requests that overlap a request still in flight.** A request is concurrent when it
   starts before the latest end (`timestamp + response_time_ms`) of every earlier request in
   its partition. That removes 71% of the raw count (5,367 of 7,531).

3. **Drop failovers.** `failover_attempts > 0` marks a move that routing made on purpose
   after an attempt failed. These are rare (282) but expensive (about 139k cache-write tokens
   each), and no stickiness rule should hold them.

4. **What remains is the candidate population** (1,882 under five minutes in the baseline
   window): sequential, non-failover changes of the serving account in partition order. It
   is not yet a remap count.

5. **Reconstruct each candidate's conversation parent.**
   - **Why the partition is not enough.** Affinity is keyed by
     `deriveAffinityLaneKey` (`packages/proxy/src/handlers/account-selector.ts:1223`).
     The key combines the session, protocol family, path, model family, effective model and
     canonical `anthropic-beta` signature, plus the route profile when one applies. Of
     these, the `requests` table cannot reconstruct the `anthropic-beta` signature.
   - **The parent.** It is the latest earlier request, in the same session and model and
     within the past hour, that had finished before this one started and whose prompt
     total this one extends:
     `total(parent) <= total(r) <= 1.10 * total(parent) + 20000`, where
     `total = input + cache_read + cache_creation`.
   - **Three cases are not remaps.** The parent is already on the new account. The new
     account is already warm, with cache reads at least half the prompt. Or there is no
     continuation parent. Everything else is a remap of a warm conversation, either off the
     previous account or off a third account.
   - **The split barely depends on the tolerance.** At k = 1.05, 1.10 and 1.25, the
     parent-already-on-new-account class holds 702, 694 and 687 of the 1,575
     same-or-lower-band candidates.

6. **Take the baseline from the same population.** Excess cache writes are
   `SUM(MAX(cache_creation_input_tokens - baseline, 0))`, where the baseline is the mean cache
   writes of *same-account, sequential, non-failover* pairs after the *same* idle gap.
   - Under 5 minutes that is 4,977 tokens (59,372 pairs).
   - Over 5 to 60 minutes it is 26,376 tokens (3,125 pairs), because a five-minute cache has
     expired by then whichever account serves.

   An earlier pass of this investigation used 5,391. That figure mixed in 133,191 overlapping
   same-account pairs (5,574 tokens each), so it described a different population and
   understated the excess.

7. **Classify each candidate by weekly pace band.** Join the hourly `usage_snapshots` row
   (`window_key = 'seven_day'`) for the old and new account at the switch hour. Then band
   `(100 - utilization) / hours until resets_at` with the production thresholds:
   `quotaPressureBand`, `packages/proxy/src/handlers/usage-throttling.ts:888-895`, rate at
   `:949`. A remap to a strictly higher band is the population the warm-owner hold targets.

8. **Split the idle gap at 5 minutes.** The hold applies only while the owner served the
   previous turn less than `ANTHROPIC_WARM_CACHE_MS` ago, and for at most
   `ANTHROPIC_PRESSURE_HOLD_CAP_MS` (`packages/load-balancer/src/strategies/session-drain-soonest.ts:25`
   and `:27`). Remaps after 5 to 60 minutes are reported separately: by design the hold does
   not cover them.

9. **Count process restarts in every window you compare.**
   - **Why restarts matter.** The affinity map is an in-process `Map`
     (`packages/load-balancer/src/strategies/session-affinity.ts:262`). Until PR #661
     (9193caf7, live from the 2026-10-30 23:06 UTC start), a restart forgot every owner and
     each lane's next request was routed as a new session. Since then a backend start
     rebuilds the map from the `affinityLane` block that each request writes into
     `routing_attempt_summary` (`restoreAffinityPins`,
     `packages/load-balancer/src/strategies/affinity-restore.ts`). Lanes still start fresh
     after a restore abandoned at its 3-second budget or 20,000-record cap (`/health`
     reports it under `routing.affinityRestore`), in strict drain-soonest mode, for
     child-home, quality and web-search helper lanes, and for lanes idle past the affinity
     TTL.
   - **The size of the effect.** In the baseline window, same-partition pairs that spanned
     an upstream start switched accounts 52% of the time (74 of 142), against about 3%
     otherwise. Remaps that followed a restart carried 12.15M of the 47.37M same-or-lower-band
     remap excess.
   - **How to count.** Count upstream starts from `journalctl -u ccflare-stack.service`:
     there is one `Dashboard will be available` line per start. The journal retained the
     baseline window only from 2026-10-02 23:33 UTC, and it shows 56 starts from then to the
     window's end.
     In a window before PR #661, more deploys or memory recycles show more remaps for
     reasons unrelated to routing policy. From PR #657 (6f2a6ebf) on, each request's routing
     summary also carries `processStartedAt`, and a matched pair straddles a start when its
     two requests carry different values. For a window that includes the 2026-10-30 23:06
     UTC start or later ones, report straddling pairs separately rather than comparing
     journal start counts. A restored start should move few lanes, so its start count no
     longer predicts remaps.

10. **Read the production database only with `sqlite3 -readonly`.** Never size or verify this
    with scripted requests through Anthropic accounts; AGENTS.md prohibits scripted Anthropic
    inference.

### The queries

Queries 1 and 2 read the window `[start_ms, end_ms)` from one `VALUES` row; Queries 3, 3c and 4 read
it from the one-row temp table `p`. The values in Queries 1 to 3c are the pre-#510 baseline window,
2026-10-01 19:13:49 UTC to 2026-10-15 19:13:49 UTC. It ends at the deploy: the deploy script
rewrote the production pin at 19:13:49 UTC, 51 seconds after PR #510 merged. Run each with
`sqlite3 -readonly ~/.config/better-ccflare/better-ccflare.db < query.sql`.

```sql
.headers on
.mode column
-- Window: [start_ms, end_ms). Edit the VALUES row only.
-- 1790882029000 = 2026-10-01T19:13:49Z, 1792091629000 = 2026-10-15T19:13:49Z (PR #510 deploy: pin rewrite, 51 s after merge).

-- Query 1: what a naive "same session changed account" count is made of.
WITH p(start_ms, end_ms) AS (VALUES (1790882029000, 1792091629000)),
r AS (
  SELECT r.timestamp ts, r.account_used acct,
         COALESCE(r.failover_attempts, 0) fa,
         COALESCE(r.cache_creation_input_tokens, 0) cc,
         LAG(r.account_used) OVER w prev_acct,
         LAG(r.timestamp) OVER w prev_ts,
         MAX(r.timestamp + COALESCE(r.response_time_ms, 0)) OVER (
           PARTITION BY r.client_session_id, r.model ORDER BY r.timestamp
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) prior_end
  FROM requests r JOIN accounts a ON a.id = r.account_used, p
  WHERE a.provider = 'anthropic' AND r.success = 1
    AND r.client_session_id IS NOT NULL
    AND r.timestamp >= p.start_ms AND r.timestamp < p.end_ms
  WINDOW w AS (PARTITION BY r.client_session_id, r.model ORDER BY r.timestamp)
)
SELECT CASE
         WHEN prev_acct = acct AND prior_end > ts THEN '1 same account, overlapping'
         WHEN prev_acct = acct THEN '2 same account, sequential'
         WHEN prior_end > ts THEN '3 switch, overlaps in-flight request'
         WHEN fa > 0 THEN '4 switch, failover'
         ELSE '5 switch, sequential, no failover'
       END kind,
       COUNT(*) n, ROUND(AVG(cc)) avg_cache_write
FROM r
WHERE prev_acct IS NOT NULL AND ts - prev_ts < 300000
GROUP BY 1 ORDER BY 1;

-- Query 2: sequential non-failover switches by weekly pace band, with excess
-- cache writes over same-account sequential pairs after the same idle gap.
WITH p(start_ms, end_ms) AS (VALUES (1790882029000, 1792091629000)),
r AS (
  SELECT r.timestamp ts, r.account_used acct,
         COALESCE(r.failover_attempts, 0) fa,
         COALESCE(r.cache_creation_input_tokens, 0) cc,
         LAG(r.account_used) OVER w prev_acct,
         LAG(r.timestamp) OVER w prev_ts,
         MAX(r.timestamp + COALESCE(r.response_time_ms, 0)) OVER (
           PARTITION BY r.client_session_id, r.model ORDER BY r.timestamp
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) prior_end
  FROM requests r JOIN accounts a ON a.id = r.account_used, p
  WHERE a.provider = 'anthropic' AND r.success = 1
    AND r.client_session_id IS NOT NULL
    AND r.timestamp >= p.start_ms AND r.timestamp < p.end_ms
  WINDOW w AS (PARTITION BY r.client_session_id, r.model ORDER BY r.timestamp)
),
seq AS (
  SELECT *, CASE WHEN ts - prev_ts < 300000 THEN 'a <5m' ELSE 'b 5-60m' END gap
  FROM r
  WHERE prev_acct IS NOT NULL AND ts - prev_ts < 3600000
    AND (prior_end IS NULL OR prior_end <= ts) AND fa = 0
),
base AS (
  SELECT gap, AVG(cc) b, COUNT(*) pairs FROM seq WHERE prev_acct = acct GROUP BY gap
),
snap AS (
  SELECT account_id, timestamp / 3600000 hb, MAX(utilization) u, MAX(resets_at) rs
  FROM usage_snapshots, p
  WHERE window_key = 'seven_day'
    AND timestamp >= p.start_ms - 86400000 AND timestamp < p.end_ms
  GROUP BY 1, 2
),
sw AS (
  SELECT seq.gap, seq.cc,
         (100 - so.u) / MAX((so.rs - seq.ts) / 3600000.0, 0.01) rate_old,
         (100 - sn.u) / MAX((sn.rs - seq.ts) / 3600000.0, 0.01) rate_new
  FROM seq
  LEFT JOIN snap so ON so.account_id = seq.prev_acct AND so.hb = seq.ts / 3600000
  LEFT JOIN snap sn ON sn.account_id = seq.acct AND sn.hb = seq.ts / 3600000
  WHERE seq.prev_acct <> seq.acct
),
banded AS (
  SELECT gap, cc,
    CASE WHEN rate_old IS NULL OR rate_new IS NULL THEN NULL
         WHEN rate_old >= 4 THEN 5 WHEN rate_old >= 2 THEN 4 WHEN rate_old >= 1 THEN 3
         WHEN rate_old >= 0.5 THEN 2 WHEN rate_old >= 0.25 THEN 1 ELSE 0 END band_old,
    CASE WHEN rate_old IS NULL OR rate_new IS NULL THEN NULL
         WHEN rate_new >= 4 THEN 5 WHEN rate_new >= 2 THEN 4 WHEN rate_new >= 1 THEN 3
         WHEN rate_new >= 0.5 THEN 2 WHEN rate_new >= 0.25 THEN 1 ELSE 0 END band_new
  FROM sw
)
SELECT banded.gap,
       CASE WHEN band_old IS NULL THEN 'unknown (no snapshot that hour)'
            WHEN band_new > band_old THEN 'to-higher-band'
            ELSE 'same-or-lower-band' END cls,
       COUNT(*) n,
       ROUND(SUM(cc) / 1e6, 1) cache_write_M,
       ROUND(SUM(MAX(cc - base.b, 0)) / 1e6, 1) excess_M,
       ROUND(base.b) baseline_per_req,
       base.pairs baseline_pairs
FROM banded JOIN base ON base.gap = banded.gap
GROUP BY 1, 2 ORDER BY 1, 2;
```

Query 3 splits Query 2's under-five-minute switches into non-remaps and remaps of a warm
conversation. It builds temp tables, which `sqlite3 -readonly` allows because the temp
database is separate from the opened file. It takes about two minutes on the production
database.

```sql
.headers on
.mode column
-- Query 3: split Query 2's under-5-minute switches into "not a remap" and "remap of a
-- warm conversation" by reconstructing each request's conversation parent.
-- Window: [start_ms, end_ms). Edit the p row only. Temp tables work under -readonly.
CREATE TEMP TABLE p AS SELECT 1790882029000 start_ms, 1792091629000 end_ms;

CREATE TEMP TABLE sw AS
WITH r AS (
  SELECT r.id, r.client_session_id sid, r.model, r.timestamp ts, r.account_used acct,
         COALESCE(r.failover_attempts, 0) fa,
         COALESCE(r.input_tokens, 0) + COALESCE(r.cache_read_input_tokens, 0)
           + COALESCE(r.cache_creation_input_tokens, 0) total,
         COALESCE(r.cache_read_input_tokens, 0) cr,
         COALESCE(r.cache_creation_input_tokens, 0) cc,
         LAG(r.account_used) OVER w prev_acct,
         LAG(r.timestamp) OVER w prev_ts,
         MAX(r.timestamp + COALESCE(r.response_time_ms, 0)) OVER (
           PARTITION BY r.client_session_id, r.model ORDER BY r.timestamp
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) prior_end
  FROM requests r JOIN accounts a ON a.id = r.account_used, p
  WHERE a.provider = 'anthropic' AND r.success = 1
    AND r.client_session_id IS NOT NULL
    AND r.timestamp >= p.start_ms AND r.timestamp < p.end_ms
  WINDOW w AS (PARTITION BY r.client_session_id, r.model ORDER BY r.timestamp)
),
seq AS (
  SELECT * FROM r
  WHERE prev_acct IS NOT NULL AND ts - prev_ts < 300000
    AND (prior_end IS NULL OR prior_end <= ts) AND fa = 0
),
snap AS (
  SELECT account_id, timestamp / 3600000 hb, MAX(utilization) u, MAX(resets_at) rs
  FROM usage_snapshots, p
  WHERE window_key = 'seven_day'
    AND timestamp >= p.start_ms - 86400000 AND timestamp < p.end_ms
  GROUP BY 1, 2
),
rated AS (
  SELECT seq.*,
         (100 - so.u) / MAX((so.rs - seq.ts) / 3600000.0, 0.01) rate_old,
         (100 - sn.u) / MAX((sn.rs - seq.ts) / 3600000.0, 0.01) rate_new
  FROM seq
  LEFT JOIN snap so ON so.account_id = seq.prev_acct AND so.hb = seq.ts / 3600000
  LEFT JOIN snap sn ON sn.account_id = seq.acct AND sn.hb = seq.ts / 3600000
)
SELECT id, sid, model, ts, acct, prev_acct, total, cr, cc,
  CASE WHEN acct = prev_acct THEN 'same'
       WHEN rate_old IS NULL OR rate_new IS NULL THEN 'unknown'
       WHEN (CASE WHEN rate_new >= 4 THEN 5 WHEN rate_new >= 2 THEN 4 WHEN rate_new >= 1 THEN 3
                  WHEN rate_new >= 0.5 THEN 2 WHEN rate_new >= 0.25 THEN 1 ELSE 0 END)
          > (CASE WHEN rate_old >= 4 THEN 5 WHEN rate_old >= 2 THEN 4 WHEN rate_old >= 1 THEN 3
                  WHEN rate_old >= 0.5 THEN 2 WHEN rate_old >= 0.25 THEN 1 ELSE 0 END)
       THEN 'to-higher-band' ELSE 'same-or-lower-band' END cls
FROM rated;

-- Baseline: mean cache writes of same-account sequential pairs under 5 minutes. The rate
-- denominator is every sequential non-failover pair under 5 minutes.
CREATE TEMP TABLE base AS
SELECT AVG(CASE WHEN cls = 'same' THEN cc END) b, COUNT(*) pairs FROM sw;
DELETE FROM sw WHERE cls = 'same';

-- Candidate parents: every successful Anthropic request of those sessions, from an hour
-- before the window.
CREATE TEMP TABLE cand AS
SELECT r.id, r.client_session_id sid, r.model, r.timestamp ts,
       r.timestamp + COALESCE(r.response_time_ms, 0) te, r.account_used acct,
       COALESCE(r.input_tokens, 0) + COALESCE(r.cache_read_input_tokens, 0)
         + COALESCE(r.cache_creation_input_tokens, 0) total
FROM requests r JOIN accounts a ON a.id = r.account_used, p
WHERE a.provider = 'anthropic' AND r.success = 1
  AND r.timestamp >= p.start_ms - 3600000 AND r.timestamp < p.end_ms
  AND r.client_session_id IN (SELECT DISTINCT sid FROM sw);
CREATE INDEX temp.cand_sm ON cand(sid, model, ts);

-- Conversation parent: the latest earlier, already finished request in the same session and
-- model whose prompt total this request extends by at most 10% + 20k tokens.
CREATE TEMP TABLE par AS
SELECT s.*,
  (SELECT q.acct FROM cand q
   WHERE q.sid = s.sid AND q.model = s.model AND q.ts < s.ts AND q.ts >= s.ts - 3600000
     AND q.te <= s.ts AND q.id <> s.id
     AND q.total <= s.total AND s.total <= q.total * 1.10 + 20000
   ORDER BY q.ts DESC LIMIT 1) parent_acct
FROM sw s;

SELECT cls,
  CASE WHEN parent_acct = acct THEN '1 not a remap: parent already on the new account'
       WHEN cr >= 0.5 * total THEN '2 not a remap: new account already warm'
       WHEN parent_acct IS NULL THEN '3 not a remap: no continuation parent'
       WHEN parent_acct = prev_acct THEN '4 remap: off the previous account'
       ELSE '5 remap: off a third account' END kind,
  COUNT(*) n,
  ROUND(1000.0 * COUNT(*) / base.pairs, 2) per_1k_pairs,
  ROUND(SUM(MAX(cc - base.b, 0)) / 1e6, 2) excess_M,
  ROUND(SUM(MAX(cc - base.b, 0)) / base.pairs) excess_per_pair,
  ROUND(base.b) baseline_per_req,
  base.pairs pairs
FROM par, base
GROUP BY 1, 2 ORDER BY 1, 2;
```

Query 3c is Query 3 under the corrected timestamp reading (see the timestamp note), and it
reports both gap buckets. It reproduces this doc's corrected figures for to-higher-band
remaps (kinds 4 and 5):

| Window | Under 5 minutes | 5–60 minutes |
|---|---:|---:|
| Baseline | 117 (19.84M) | 36 (5.56M) |
| Post-#510 | 327 (46.57M) | 124 (17.37M) |

For the post-#510 window, set `p` to `1792091629000, 1793301229000`. It took about 45 seconds
per window on the production database on 2026-10-31.

```sql
.headers on
.mode column
-- Query 3c: Query 3 under the corrected timestamp reading, for both gap buckets.
-- start = timestamp - response_time_ms, end = timestamp. Rows are ordered by start, a pair
-- is sequential when no earlier request of the partition ends after this one starts, and the
-- idle gap runs start to start, which is the warm-owner hold's clock.
-- Window: [start_ms, end_ms) on save time. Edit the p row only. Temp tables work under -readonly.
CREATE TEMP TABLE p AS SELECT 1790882029000 start_ms, 1792091629000 end_ms;

CREATE TEMP TABLE rc AS
WITH b AS (
  SELECT r.id, r.client_session_id sid, r.model,
         r.timestamp - COALESCE(r.response_time_ms, 0) st, r.timestamp en,
         r.account_used acct, COALESCE(r.failover_attempts, 0) fa,
         COALESCE(r.input_tokens, 0) + COALESCE(r.cache_read_input_tokens, 0)
           + COALESCE(r.cache_creation_input_tokens, 0) total,
         COALESCE(r.cache_read_input_tokens, 0) cr,
         COALESCE(r.cache_creation_input_tokens, 0) cc
  FROM requests r JOIN accounts a ON a.id = r.account_used, p
  WHERE a.provider = 'anthropic' AND r.success = 1
    AND r.client_session_id IS NOT NULL
    AND r.timestamp >= p.start_ms AND r.timestamp < p.end_ms
)
SELECT *, LAG(acct) OVER w prev_acct, LAG(st) OVER w prev_st,
       MAX(en) OVER (PARTITION BY sid, model ORDER BY st, id
                     ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) prior_end
FROM b WINDOW w AS (PARTITION BY sid, model ORDER BY st, id);

CREATE TEMP TABLE sq AS
SELECT id, sid, model, st, acct, prev_acct, total, cr, cc, st - prev_st gap
FROM rc
WHERE prev_acct IS NOT NULL AND fa = 0 AND (prior_end IS NULL OR prior_end <= st)
  AND st - prev_st < 3600000;

CREATE TEMP TABLE snap AS
SELECT account_id, timestamp / 3600000 hb, MAX(utilization) u, MAX(resets_at) rs
FROM usage_snapshots, p
WHERE window_key = 'seven_day'
  AND timestamp >= p.start_ms - 86400000 AND timestamp < p.end_ms
GROUP BY 1, 2;

CREATE TEMP TABLE sw AS
WITH rated AS (
  SELECT sq.*, CASE WHEN gap < 300000 THEN 'a <5m' ELSE 'b 5-60m' END g,
         (100 - so.u) / MAX((so.rs - sq.st) / 3600000.0, 0.01) rate_old,
         (100 - sn.u) / MAX((sn.rs - sq.st) / 3600000.0, 0.01) rate_new
  FROM sq
  LEFT JOIN snap so ON so.account_id = sq.prev_acct AND so.hb = sq.st / 3600000
  LEFT JOIN snap sn ON sn.account_id = sq.acct AND sn.hb = sq.st / 3600000
)
SELECT g, id, sid, model, st, acct, prev_acct, total, cr, cc,
  CASE WHEN acct = prev_acct THEN 'same'
       WHEN rate_old IS NULL OR rate_new IS NULL THEN 'unknown'
       WHEN (CASE WHEN rate_new >= 4 THEN 5 WHEN rate_new >= 2 THEN 4 WHEN rate_new >= 1 THEN 3
                  WHEN rate_new >= 0.5 THEN 2 WHEN rate_new >= 0.25 THEN 1 ELSE 0 END)
          > (CASE WHEN rate_old >= 4 THEN 5 WHEN rate_old >= 2 THEN 4 WHEN rate_old >= 1 THEN 3
                  WHEN rate_old >= 0.5 THEN 2 WHEN rate_old >= 0.25 THEN 1 ELSE 0 END)
       THEN 'to-higher-band' ELSE 'same-or-lower-band' END cls
FROM rated;

-- Baseline per bucket: mean cache writes of same-account sequential pairs. The rate
-- denominator is every sequential non-failover pair of the bucket.
CREATE TEMP TABLE base AS
SELECT g, AVG(CASE WHEN cls = 'same' THEN cc END) b, COUNT(*) pairs FROM sw GROUP BY g;
DELETE FROM sw WHERE cls = 'same';

-- Candidate parents: every successful Anthropic request of those sessions, saved from three
-- hours before the window, because a long request is saved well after it starts.
CREATE TEMP TABLE cand AS
SELECT r.id, r.client_session_id sid, r.model,
       r.timestamp - COALESCE(r.response_time_ms, 0) st, r.timestamp en, r.account_used acct,
       COALESCE(r.input_tokens, 0) + COALESCE(r.cache_read_input_tokens, 0)
         + COALESCE(r.cache_creation_input_tokens, 0) total
FROM requests r JOIN accounts a ON a.id = r.account_used, p
WHERE a.provider = 'anthropic' AND r.success = 1
  AND r.timestamp >= p.start_ms - 10800000 AND r.timestamp < p.end_ms
  AND r.client_session_id IN (SELECT DISTINCT sid FROM sw);
CREATE INDEX temp.cand_sm ON cand(sid, model, st);

-- Conversation parent: the latest earlier request in the same session and model that had
-- finished by this one's start and whose prompt total this one extends by at most 10% + 20k.
CREATE TEMP TABLE par AS
SELECT s.*,
  (SELECT q.acct FROM cand q
   WHERE q.sid = s.sid AND q.model = s.model AND q.st < s.st AND q.st >= s.st - 3600000
     AND q.en <= s.st AND q.id <> s.id
     AND q.total <= s.total AND s.total <= q.total * 1.10 + 20000
   ORDER BY q.st DESC LIMIT 1) parent_acct
FROM sw s;

SELECT par.g, cls,
  CASE WHEN parent_acct = acct THEN '1 not a remap: parent already on the new account'
       WHEN cr >= 0.5 * total THEN '2 not a remap: new account already warm'
       WHEN parent_acct IS NULL THEN '3 not a remap: no continuation parent'
       WHEN parent_acct = prev_acct THEN '4 remap: off the previous account'
       ELSE '5 remap: off a third account' END kind,
  COUNT(*) n,
  ROUND(1000.0 * COUNT(*) / base.pairs, 2) per_1k_pairs,
  ROUND(SUM(MAX(cc - base.b, 0)) / 1e6, 2) excess_M,
  ROUND(SUM(MAX(cc - base.b, 0)) / base.pairs) excess_per_pair,
  ROUND(base.b) baseline_per_req,
  base.pairs pairs
FROM par JOIN base ON base.g = par.g
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
```

Query 4 classifies affinity-lane owner transitions from the `affinityLane` records that
every routing summary has carried since #661. With the window shown, it produced the
lane-record counts in "Result for the post-#510 window", in under a second. Read its classes
within these limits:

- **End-of-request state.** Each record is the lane's state when a request ended. Requests
  that overlap on one lane interleave, so ordering by `observedAt` can pair records out of
  order.
- **Idle time can be overstated.** `asg - pasg` overstates the old owner's idle time when a
  request that selected it was still running.
- **Class 5 is mixed.** It holds both failovers and fresh assignments after an expired or
  evicted entry, because both change the owner without setting `upgradedAt`.
- **Classes 4c and 4e are ambiguous.** They are the patterns a hold that failed to engage
  would leave, but a tier or fallback-rung recovery leaves 4e too. The records cannot tell
  those apart, or a pace-band outclass from a tier or rung one. Issue #663 tracks recording
  that.
- **Dropped rows leave gaps.** A turn whose row the async writer dropped leaves a gap in the
  lane's sequence.

```sql
.headers on
.mode column
-- Query 4: classify affinity-lane owner transitions from the affinityLane records that every
-- routing summary carries since #661 (first backend start writing them: 2026-10-30 23:06:11 UTC,
-- processStartedAt 1793401571642). Each record is the lane's owner state at the end of one
-- request, so diffing it against the lane's previous record shows what changed in between.
-- Window: [start_ms, end_ms) on save time. Edit the p row only. Temp tables work under -readonly.
CREATE TEMP TABLE p AS SELECT 1793401571642 start_ms, 1793414310000 end_ms;

CREATE TEMP TABLE lr AS
SELECT r.id, a.provider prov,
  json_extract(r.routing_attempt_summary, '$.processStartedAt') ps,
  json_extract(r.routing_attempt_summary, '$.affinityLane.digest') dg,
  json_extract(r.routing_attempt_summary, '$.affinityLane.observedAt') obs,
  json_extract(r.routing_attempt_summary, '$.affinityLane.owner.candidateId') cand,
  json_extract(r.routing_attempt_summary, '$.affinityLane.owner.assignedAt') asg,
  json_extract(r.routing_attempt_summary, '$.affinityLane.owner.upgradedAt') upg,
  json_extract(r.routing_attempt_summary, '$.affinityLane.owner.pressureHoldSince') phs,
  json_extract(r.routing_attempt_summary, '$.affinityLane.owner.fallbackCandidateId') fb
FROM requests r LEFT JOIN accounts a ON a.id = r.account_used, p
WHERE r.timestamp >= p.start_ms AND r.timestamp < p.end_ms
  AND instr(r.routing_attempt_summary, '"affinityLane"') > 0;

CREATE TEMP TABLE tr AS
SELECT *, LAG(cand) OVER w pcand, LAG(asg) OVER w pasg, LAG(phs) OVER w pphs,
       LAG(ps) OVER w pps, LAG(obs) OVER w pobs
FROM lr WHERE dg IS NOT NULL
WINDOW w AS (PARTITION BY dg ORDER BY obs, id);

-- An owner change is a changed candidate id. An outclass sets upgradedAt equal to the new
-- assignedAt; a failover, or a fresh assignment after an expired or evicted entry, leaves it
-- unset. asg - pasg is the old owner's idle time on the hold's clock; asg - pphs is how long
-- the hold had run.
SELECT prov,
  CASE WHEN pobs IS NULL THEN '0 first record of lane in window'
       WHEN cand IS NULL THEN '1 tombstone'
       WHEN pcand IS NULL THEN '2 install after tombstone'
       WHEN cand = pcand AND phs IS NOT NULL THEN '3a kept, warm hold'
       WHEN cand = pcand AND fb IS NOT NULL THEN '3b kept, fallback serving'
       WHEN cand = pcand THEN '3c kept'
       WHEN upg IS NULL THEN '5 owner changed, no upgradedAt'
       WHEN upg <> asg THEN '6 owner changed, upgradedAt <> assignedAt'
       WHEN pphs IS NOT NULL AND asg - pphs >= 1800000 THEN '4a outclass, hold at 30 min cap'
       WHEN pphs IS NOT NULL AND asg - pasg >= 300000 THEN '4b outclass, hold released at 5 min idle'
       WHEN pphs IS NOT NULL THEN '4c outclass, held owner active < 5 min'
       WHEN asg - pasg >= 300000 THEN '4d outclass, owner idle >= 5 min, no hold'
       ELSE '4e outclass, owner active < 5 min, no hold' END cls,
  CASE WHEN ps IS NULL OR pps IS NULL THEN 'n/a'
       WHEN ps <> pps THEN 'straddles a start' ELSE 'same process' END proc,
  COUNT(*) n
FROM tr GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
```

## Why This Matters

Each filter changes the decision the number supports. Sized from the raw count, the
warm-owner hold looked like a fix for 7,531 events. Partition-order filtering cut that to 307
to-higher-band switches. Conversation parents cut it again, to 73 remaps of a warm
conversation, and only 59 of those were moves the hold addresses (8.47M excess). The other
14 followed a restart, left a spent owner, or are unexplained.

The two kinds of figure fail differently. Row counts from Query 2 overstate remaps four to
seven times. Its excess tokens overstate them by only 7 to 13%, because the non-remap rows
are cheap: they average a few thousand cache-write tokens, while a remap of a warm
conversation rewrites about 200k. So:

- Quote excess tokens.
- Never quote a Query 2 row count, or a rate of Query 2 rows, as a remap count.
- Attribute a remap only after the conversation-parent split. Otherwise lane interleaving
  dominates every per-row cause.

The baseline matters as much as the filter. Excess cost is a difference, and a baseline taken
from another population moves it. The overlapping same-account pairs carry larger cache
writes than sequential ones, so mixing them in shrinks the excess and blurs the before/after
comparison.

## When to Apply

- Before quoting a cache-cost figure for any change to session stickiness, owner retention,
  drain ordering, or account priority on Anthropic routes.
- When verifying a deployed routing change: re-run the queries over a post-deploy window and
  compare like with like, including the restart count.
- When a dashboard or alert reports "session switches": check whether it separates concurrent
  spread, failover and lane interleaving from remaps of a conversation.

## Examples

### Baseline, before PR #510 (14 days ending 2026-10-15 19:13:49 UTC)

Query 1, all same-session pairs under five minutes:

| Kind | Pairs | Avg cache writes |
|---|---:|---:|
| Same account, overlapping | 133,191 | 5,574 |
| Same account, sequential | 59,397 | 4,984 |
| Switch, overlaps an in-flight request | 5,367 | 21,558 |
| Switch, failover | 282 | 138,993 |
| Switch, sequential, no failover | 1,882 | 37,399 |

Query 2, sequential non-failover switches:

| Idle gap | Class | Switches | Cache writes | Excess | Baseline per request |
|---|---|---:|---:|---:|---:|
| < 5 min | same-or-lower-band | 1,575 | 58.7M | 54.5M | 4,977 |
| < 5 min | to-higher-band | 307 | 11.7M | 10.7M | 4,977 |
| 5–60 min | same-or-lower-band | 251 | 15.5M | 12.6M | 26,376 |
| 5–60 min | to-higher-band | 77 | 7.3M | 6.1M | 26,376 |

No switch fell in the `unknown` class: every switch hour had a weekly snapshot for both
accounts. An earlier rolling-window run of the same method, using the 5,391 baseline, gave
304 to-higher-band switches and 10.2M excess. The difference comes from the window edges and
the baseline population.

Query 3, the under-five-minute switches split by conversation parent (denominator: 61,254
sequential non-failover pairs; baseline 4,977):

| Band class | Kind | Rows | Per 1,000 pairs | Excess | Excess per pair |
|---|---|---:|---:|---:|---:|
| same-or-lower-band | Not a remap: parent already on the new account | 694 | 11.33 | 3.53M | 58 |
| same-or-lower-band | Not a remap: new account already warm | 634 | 10.35 | 2.82M | 46 |
| same-or-lower-band | Not a remap: no continuation parent | 9 | 0.15 | 0.80M | 13 |
| same-or-lower-band | Remap off the previous account | 203 | 3.31 | 40.28M | 658 |
| same-or-lower-band | Remap off a third account | 35 | 0.57 | 7.09M | 116 |
| to-higher-band | Not a remap: parent already on the new account | 82 | 1.34 | 0.13M | 2 |
| to-higher-band | Not a remap: new account already warm | 149 | 2.43 | 0.61M | 10 |
| to-higher-band | Not a remap: no continuation parent | 3 | 0.05 | 0.01M | 0 |
| to-higher-band | Remap off the previous account | 71 | 1.16 | 9.70M | 158 |
| to-higher-band | Remap off a third account | 2 | 0.03 | 0.31M | 5 |

The to-higher-band remaps total 73 rows, 1.19 per 1,000 pairs and 10.01M excess, or 163
excess tokens per pair. Query 2's 307 rows are 5.01 per 1,000.

### Where the remaps came from

The full attribution is in the
[#516 comment](https://github.com/StartupBros-com/better-ccflare/issues/516#issuecomment-6203127045),
with every query. It adds a restart timeline from the journal, burst detection and the
router's own banding to Query 3's split, and assigns each row to the first class it matches.

- **Same-or-lower-band remaps, 238 rows, about 47.4M:**
  - 12.15M followed a process restart.
  - 2.61M fell in process-wide cold-switch bursts with no recorded restart.
  - 3.84M left an owner whose usage window was spent.
  - 1.07M were higher-band moves under the router's own banding.
  - 0.15M changed route profile.
  - **27.56M is unexplained.** In 136 of those 140 rows the owner was tied for the best band
    under the router's banding, and the strategy does not move an owner out of a tie. So the
    cause is not a band comparison. Attributing it needs the affinity decision recorded on
    each request.
- **To-higher-band remaps, 73 rows, 10.01M:**
  - 59 rows (8.47M) are moves the warm-owner hold addresses: 44 confirmed by the router's
    banding and 15 in a burst whose owner was also outranked.
  - The rest followed a restart (7 rows, 0.81M), left a spent owner (4 rows, 0.46M), or are
    residual (3 rows, 0.26M).

### How far each number can be trusted

- **Query 3's to-higher-band remaps are an upper bound** on what the hold can address.
  - The query checks only the weekly band. It does not check tier, fallback rung, billing
    class, restarts, or whether the owner was still available. An owner that was
    rate-limited or paused moves regardless of the hold.
  - The hourly `MAX(utilization)` and `MAX(resets_at)` can pair a pre-rollover utilization
    with a post-rollover reset inside one hour.
  - 166 of the 1,882 sequential switches are Fable-family requests. The live strategy bands
    those by the model-scoped `seven_day_fable` window, not the all-model `seven_day` window
    the query uses.
- **The conversation parent is matched on token totals, not on a prompt hash.** A parent that
  failed over or used another model is not found, and the row lands in the no-parent class.
- **The 5–60 minute bucket measures exposure, not cost.** The `requests` table does not record
  each request's cache TTL. The bucket therefore blends 1-hour-TTL main conversations, where
  a switch rewrites a still-warm cache, with 5-minute-TTL workers, whose cache was cold
  anyway.
- **Concurrent spread has its own cost:** overlapping switches average 21,558 cache-write
  tokens against 5,574 for overlapping same-account pairs. Stickiness does not control that
  population, so it does not belong in a remap figure.

### Comparing after the deploy

1. Confirm that production serves a build containing PR #510: its merge commit must be an
   ancestor of the `git_sha` reported by `/health`. See
   [verify-fix-ancestry-before-citing-a-measured-rate.md](../workflow-issues/verify-fix-ancestry-before-citing-a-measured-rate.md).
2. Set the window to `(1792091629000, 1793301229000)`, the 14 days from
   2026-10-15 19:13:49 UTC to 2026-10-29 19:13:49 UTC.
   - For an earlier read, use 7 days (`1792696429000` as the end); the rates in step 3 make
     the two window lengths comparable.
3. Compare Query 3's to-higher-band remap rows (kinds 4 and 5), not Query 2's row counts.
   Use the per-1,000-pairs rate and the excess per pair, because traffic volume changes.
   The baseline is 1.19 remaps per 1,000 pairs and 163 excess tokens per pair under the
   original reading, or 0.86 and 146 under the corrected one (Query 3c; see the timestamp note).
   Compare like with like.
4. Count upstream starts in the post-deploy window and set them beside the baseline's 56
   (over the 12.8 days of the baseline window that the journal retained).
   A large difference in restarts moves remaps whatever the hold does. For an exact
   comparison, re-run the #516 waterfall and compare its class 7 and 5b rows.
   - This window ends before PR #661 reached production, so every start in it forgot all
     owners. If you extend a window past the 2026-10-30 23:06 UTC start, also confirm
     that #661's merge commit (9193caf7) is an ancestor of the deployed `git_sha`. Then
     exclude pairs that straddle a start (different `processStartedAt`) from the hold
     comparison instead of setting start counts side by side, because restored starts
     keep most owners.
5. Expect the under-five-minute to-higher-band remaps to drop, not reach zero.
   - The hold is capped at 30 minutes per episode.
   - It applies only to Anthropic owners in sticky mode outclassed by pace band alone, at
     the same tier and fallback rung.
   - Owners that become unavailable still move. In this window a restart also forgets every
     owner; from PR #661 on it does so only when restore cannot cover the lane (step 9).
   - The 5–60 minute to-higher-band row may rise. A held session moves once its owner has
     been idle for 5 minutes or more, so some remaps that used to land under five minutes now
     land in that bucket. That is the intended trade: the move happens once the five-minute
     cache has gone cold.

### Result for the post-#510 window

Measured 2026-10-30 over the step 2 window.

- **The rate rose instead of falling.**
  - Original reading: under-five-minute to-higher-band remaps went from 1.19 to 2.65 per
    1,000 pairs (73 to 150 remaps, 10.01M to 21.97M, 163 to 389 per pair).
  - Corrected reading: they went from 0.86 to 2.41 (117 to 327 remaps, 19.84M to 46.57M,
    146 to 343 per pair).
  - The corrected pair counts barely moved (135,986 and 135,871), so traffic volume does
    not explain the rise. The rate was above the baseline's 0.86 on 13 of the 15 days.
  - The 5–60 minute rate rose too, from 10.27 to 50.94 per 1,000 pairs of that bucket (36 to
    124 remaps, corrected reading).
- **Restarts do not explain it.**
  - The journal kept only 2026-10-27 03:27 UTC onward. That covers 2.66 days of the window
    and 16 backend starts.
  - In that part, the 58 under-five-minute pairs that straddled a start produced 9
    to-higher-band remaps (1.35M). The 22,148 pairs with no start between their turns
    produced 70 (10.52M), or 3.16 per 1,000.
  - Traffic can reach a new backend some time after its start line. Counting every pair
    whose earlier turn began within 10 minutes after a start as a restart pair removes 7
    more remaps, which still leaves 3.03 per 1,000.
  - 2026-10-29 had one start and 2.47 per 1,000.
- **The bucket is not exactly the hold's population.** The hold's idle clock belongs to one
  affinity lane. Step 8 splits on the gap to the previous request of the partition, which
  can belong to another lane. A remap in the under-five-minute bucket can therefore be a lane
  that was idle for longer. This alone does not explain a rise, since both windows mix lanes
  this way.
- **The first lane records show the hold engaging.** Query 4 read the `affinityLane`
  records saved in the 3.5 hours after the 2026-10-30 23:06 UTC start.
  - 482 records kept the owner under an active hold.
  - Each record's owner was diffed against the lane's previous record. That found 37
    owner changes on Anthropic lanes, all outclass moves (`upgradedAt` equal to `assignedAt`):
    - 2 when the hold reached its 30-minute cap;
    - 10 after a hold that ended before its cap. In all 10 the held owner had last been
      selected 301 to 1,572 seconds earlier, so the hold released at its 5-minute idle limit;
    - 25 after the lane's owner had been idle for 5 minutes or more with no hold recorded.
  - None outclassed an owner that was active within 5 minutes with no hold recorded. That is
    the pattern a hold that failed to engage would leave. Three and a half hours is a small
    sample, and no lane records exist for the 2026-10-15 to 10-29 window.
  - What raised the 2026-10-15 to 10-29 rate is not recorded in the `requests` table.
    Issue #663 tracks recording it, starting with Query 4 over a longer window.

## Related

- [diagnose-new-model-cache-alerts-by-context-mix-and-sample-support.md](diagnose-new-model-cache-alerts-by-context-mix-and-sample-support.md)
  is the sibling rule for cache metrics: fix the population and token semantics before
  reading an aggregate.
- [verify-fix-ancestry-before-citing-a-measured-rate.md](../workflow-issues/verify-fix-ancestry-before-citing-a-measured-rate.md)
  covers checking the measured build before citing a rate.
- [native-cache-ttl-policy-is-not-proxy-retention.md](../integration-issues/native-cache-ttl-policy-is-not-proxy-retention.md)
  explains why main conversations and workers carry different cache TTLs.
- [commit-bound-routing.md](../architecture-patterns/commit-bound-routing.md) describes
  session owner retention and re-pin reasons in the same strategy.
- `docs/load-balancing.md`, section "Drain ordering", states the routing order and the
  warm-owner hold's limits.
- Issue #509 is the originating issue. PR #510 shipped the warm-owner hold. Issue #516
  attributes the same-or-lower-band remaps. Issue #197 tracks routing decisions being
  invisible in production logs.
