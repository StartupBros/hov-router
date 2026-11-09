---
title: SQLite planned a per-account query on the billing_type index because its statistics tied it with the account index
date: 2026-11-04
category: performance-issues
module: sqlite-query-planning
problem_type: performance_issue
component: database
symptoms:
  - "Slow off-thread SQL lines for aggregateTokensByModel: 84 in about 42 hours, 1,029 s in total, up to 82.5 s each"
  - One public subscription-value refresh read 3.9 GiB from the requests table
  - Other bulk-reader statements also logged as slow, and stopped when the fix deployed
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [sqlite, query-plan, explain-query-plan, sqlite-stat1, analysis-limit, index-selection, slow-sql-log, subscription-value]
---

# SQLite planned a per-account query on the billing_type index because its statistics tied it with the account index

## Problem

`RequestRepository.aggregateTokensByModel` values one account's open usage window for the public subscription value. Its two statements filtered on `account_used = ?`, `path = '/v1/messages'`, `billing_type = 'plan'` and a timestamp range. SQLite answered them from `idx_requests_billing_type_timestamp`, which walks every account's plan-billed rows in the window and reads each row's table page to check its account. One refresh of the public value (8 accounts, 2 statements each) read 3.9 GiB in production (#710).

The mechanism is recorded where it can't drift: the comment above `planBilled` in `packages/database/src/repositories/request.repository.ts`, and the header of `packages/database/src/repositories/__tests__/request-aggregate-tokens-by-model-plan.test.ts`. This doc keeps what the code can't: how the tie was found, what it looked like in the slow log, and where else it can happen.

## Symptoms

- `Slow off-thread SQL` lines (threshold 250 ms) for this statement: 84 between 2026-11-02 11:24Z and the fix's deploy at 2026-11-04 05:18Z, 1,029 s in total, max 82.5 s. That window includes this investigation's own read-only probes.
- A single spot check of the public value endpoint took 26.7 s before the deploy and 1.7 s after.
- Two other bulk-reader statements looked like heavy loads of their own (next section).

## What Didn't Work

- **Reading the slow log's per-statement totals as independent loads.** In the same window the Codex scanner's usage report (`report()` in `external-usage.repository.ts`) logged 238 times (913 s in total, max 35.1 s), and the alerts snapshot query on `usage_snapshots` logged 196 times (187 s, max 20.6 s). Both were treated as recurring bulk-lane loads. Run alone, read-only and with a warm cache, the report takes 0.19 s, and the alerts query plans on its intended index under production's statistics. In the first 51 minutes after the deploy, the report logged once (1.0 s) and the alerts query not at all.
  - The logged time is one statement's execution inside the reader worker: the `performance.now()` span around the read in `packages/database/src/reader-worker.ts`. It excludes queue wait, and reads have no busy retry.
  - So what slowed those two was most likely the 3.9 GiB refreshes competing with them for cache and disk. That is inference: their slow lines stopped at the deploy, but the mechanism was not measured.
- **Treating it as scan size.** #710 was filed as "rescans each 7-day window every minute", with incremental totals or a per-window cache as the proposed fixes. The cost came from the plan, not the volume: the account index answers the same refresh in 510 MiB. After the fix, a refresh takes 0.33-0.40 s at most once a minute, and incremental totals were judged not worth building.
- **A plan test that leaned on the statistics.** The first version of the test treated production's `sqlite_stat1` rows as what decided the plan. Review showed the old predicate misplans with no statistics at all, so the fixture alone proves nothing about the cause. The test header now says so.

## Solution

PR #722 wraps the low-cardinality term so no index can serve it:

```ts
const planBilled = "COALESCE(billing_type, '') = 'plan'";
```

The two predicates select the same rows. That was checked against NULL, `''`, `'PLAN'`, `'plan '`, an integer and a blob. Both statements now plan on `idx_requests_account_timestamp`. The plan test loads production's 17 `sqlite_stat1` rows for `requests` into a migrated in-memory database, captures the SQL the repository sends, and asserts each statement's `EXPLAIN QUERY PLAN`. With the old predicate restored it fails and shows the billing_type index.

SQLite's own ways to steer the planner, a unary `+billing_type` or `INDEXED BY`, were not used: they are SQLite syntax, and the repository's SQL also ran on PostgreSQL when the fix landed. `COALESCE` is plain SQL. #723 removed PostgreSQL support later that day, so those hints are now allowed; the `COALESCE` predicate stays because it already plans on the right index.

Measured on the production database, read-only, 2026-11-04, running Bun's SQLite with the reader worker's cache settings, for one refresh:

| Predicate | Read syscalls | Bytes read | Warm time |
| --- | ---: | ---: | ---: |
| `billing_type = 'plan'` | 1,004,452 | 3.9 GiB | 2.1 s |
| `COALESCE(billing_type, '') = 'plan'` | 130,528 | 510 MiB | 0.33 s |

## Why This Works

Both indexes serve "equality on the leading column plus a timestamp range":

- `idx_requests_account_timestamp` on `(account_used, timestamp DESC)`.
- `idx_requests_billing_type_timestamp` on `(billing_type, timestamp DESC) WHERE billing_type IS NOT NULL`, a partial index that `packages/database/src/performance-indexes.ts` created. After the fix no query used it, and migrations have dropped it since #762. The lesson still applies to any new index led by a low-cardinality column.

The planner chose the same way under three kinds of statistics:

| Statistics | `billing_type = 'plan'` | `COALESCE(...)` |
| --- | --- | --- |
| None | billing_type index | account index |
| Production's sampled `sqlite_stat1` | billing_type index | account index |
| Full counts (2 billing_type values, 11 accounts) | account index | account index |

Production's statistics never break the tie. `PRAGMA optimize` runs ANALYZE with `analysis_limit = 400` (`ANALYZE_ANALYSIS_LIMIT` in `packages/database/src/incremental-vacuum-worker.ts`). The roughly 400-row sample saw one leading value in each index, so `sqlite_stat1` records 401 rows per value for both: `2123332 401 1` for billing_type and `2125429 401 1` for account. The account column's 11 real values make no difference, so this is not only a two-value-column problem. The leading row count is stale as well: 2,125,429 in the statistics against about 1.12 million rows counted on 2026-11-04. The comment above `ANALYZE_ANALYSIS_LIMIT` says the 400-row sample gives "near-identical planner statistics"; for these two indexes it did not.

`COALESCE(billing_type, '')` is an expression that no index covers. That leaves the account index as the only one that matches, whatever the statistics say.

## Prevention

- **Check a slow statement's plan under production's statistics.** Copy the table's `sqlite_stat1` rows from production (read-only) into a migrated in-memory database, and run `EXPLAIN QUERY PLAN` three times: with no statistics, with production's, and with full counts. If the plan changes between them, the planner is choosing on a tie. The plan test is the template.
- **Read `N 401 1` as "the sample saw one value", not as a measurement.** Production's `sqlite_stat1` has the same shape on `idx_requests_success_timestamp`, `idx_requests_project_timestamp` and `idx_requests_account_used`, on `external_usage_events` (`226339 401 1`), and on `usage_snapshots` (`690186 401 401 1`). An equality on any of those leading columns can tie the same way.
  - Only these statements were checked: the ones that filter `requests` on `billing_type` (none other does) and the alerts snapshot query (right index). The rest were not audited.
- **Keep a second, low-cardinality equality off the index.** When a query already has a selective equality, wrap the other term as here, or pin the plan with a test.
- **Time a slow-log statement alone before counting it as load.** Totals per statement include time that other scans caused.
- **`analysis_limit = 400` stays.** An unbounded ANALYZE on large tables holds SQLite's single writer slot for seconds, which is why the limit exists (see the comment above `ANALYZE_ANALYSIS_LIMIT`). The fix doesn't depend on the statistics, so raising the limit is a separate decision.

## Related Issues

- Issue #710 and PR #722: the problem and the fix.
- Issue #709 and PR #712: the reader lanes. These statements run on the bulk reader.
- [Prove which worker lane serves an endpoint by per-thread read-syscall deltas](../workflow-issues/verify-worker-thread-lanes-by-per-thread-syscr.md): how to tell which worker thread a statement runs on.
- [A SQLite connection a worker opens itself runs Bun's compile defaults](./worker-sqlite-connections-run-compile-default-pragmas.md): the worker that runs `PRAGMA optimize` and so writes these statistics.
- Issue #480 (open): uncached dashboard statistics at 2.7-2.9 s. It may share this cause; that has not been checked.
