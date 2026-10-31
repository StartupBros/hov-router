---
title: A SQLite connection a worker opens itself runs Bun's compile defaults, not the runtime config
date: 2026-10-31
category: performance-issues
module: database-maintenance-workers
problem_type: performance_issue
component: database
severity: high
symptoms:
  - "A worker's own bun:sqlite connection committed at synchronous=FULL while db_synchronous was NORMAL, and nothing logged the difference."
  - "One 16,384-page incremental-vacuum chunk held SQLite's writer slot for p50 654.8 ms and p99 1673.8 ms on a local temp file."
  - "Cutting the chunk under FULL never brought p95 under 100 ms (pages-1024 had a p50 of 62.2 ms and a p95 of 124.6 ms)."
  - "Earlier instance (#624): the --serve main connection ran FULL with mmap 0, and in high io-pressure 15 s intervals event-loop stalls fell from 0.815 per interval (66 stalls, 51 of them writes) to 0.125 (2 stalls, 0 writes) after the fix."
root_cause: config_error
resolution_type: code_fix
related_components:
  - background_job
retire_when: "Every bun:sqlite connection is opened through one shared factory that applies the runtime config. Check that `grep -rn 'new Database(' packages apps` (excluding tests and the generated inline-* workers) returns only that factory."
tags:
  - sqlite
  - bun-sqlite
  - pragma
  - synchronous
  - wal
  - worker-thread
  - writer-lock
  - incremental-vacuum
---

# A SQLite connection a worker opens itself runs Bun's compile defaults, not the runtime config

## Problem

`configureSqlite()` in `packages/database/src/database-operations.ts` applies the configured pragmas to the main connection only. Those are `db_synchronous`, the page cache, mmap, `wal_autocheckpoint = 0` and the busy timeout. Every other `new Database(path)` starts at bun:sqlite's compile defaults instead: `synchronous=FULL` (2), `wal_autocheckpoint=1000` and `busy_timeout` 0. That includes a maintenance worker's connection, which cannot see the runtime config, and a CLI probe. Some of these sites set their own `busy_timeout` afterwards. Before #669, none of them set `synchronous`. Nothing errors and nothing logs the difference. The cost appears only as latency, or as memory.

This class has now bitten three times:

- **Upstream tombii/better-ccflare PR #231** ("respect mmapSize=0 in configureSqlite") fixed mmap on the main connection. The comment in `packages/database/src/vacuum-worker.ts` records the same trap for that worker's own connection: about 15 GiB mapped on a 15 GiB database, then an OOM kill. Its fix set the memory pragmas (`mmap_size`, `cache_size`, `temp_store`), plus `busy_timeout` and `journal_mode`, but not `synchronous`.
- **#624**: the `--serve` path opened the main database before the server's runtime settings were applied. Production therefore ran `synchronous=FULL` and mmap 0 instead of the configured NORMAL. (session history)
- **#669**: the incremental-vacuum worker (`packages/database/src/incremental-vacuum-worker.ts`) copied the memory pragmas but never set `synchronous`. Every vacuum chunk committed at FULL whatever `db_synchronous` said, and the commit sync was most of the time the chunk held the writer slot.

## Symptoms

- A worker connection's `PRAGMA synchronous` reads 2 while the main connection reads 1. You only see this if something reads the pragma back from inside the worker.
- **Vacuum chunk hold, FULL.** One default chunk (`chunkPages` 16,384 in `incrementalVacuumAdaptive`) had these holds in 100 reps on a temp file: p50 654.8 ms, p95 1406.1 ms, p99 1673.8 ms.
- **Smaller chunks under FULL** (20 reps each). These shortened the hold but still paid the commit sync:

  | chunk | p50 | p95 |
  |---|---|---|
  | pages-1024 | 62.2 ms | 124.6 ms |
  | pages-8192 | 305.8 ms | — |

- **#624 instance.** Production event-loop stalls were counted per 15 s interval with io-some of at least 2.5 s:
  - Before the fix: 0.815 per interval (66 stalls, 51 of them writes, in 81 intervals).
  - After the fix: 0.125 per interval (2 stalls, 0 writes, in 16 intervals).

  The result is posted on #606.

## What Didn't Work

- **Sizing the chunk.** The profiling brief asked whether to cut the 16,384-page default toward a ~100 ms hold. Every `pages-N` series ran under FULL, and none of them reached a p95 under 100 ms. The lever was the sync mode, not the size. The default stayed at 16,384.
- **The derived figure.** #613 estimated about 2.8 s per chunk from a whole incremental vacuum's average rate: 75.5 s to free 1.66 GiB, about 0.17 ms per page. That was never a measured hold. Measured holds were:
  - p50 552.7 ms in the baseline run
  - p50 654.8 ms for FULL in the after run

  The pattern is the same as [verify-fix-ancestry-before-citing-a-measured-rate](../workflow-issues/verify-fix-ancestry-before-citing-a-measured-rate.md): a number in permanent rationale has to be a measurement of the thing it describes.
- **Two samples.** A 2026-10-28 refute pass reported two local samples, 168 ms and 1,149 ms. That spread was variance, not a signal. The 20-run-plus baseline was the next step. (per the profiling brief)
- **Hypotheses the baseline rejected:**
  - *Free pages at the file tail.* The tail-free p50 was 600.2 ms against 552.7 ms, so not cheaper.
  - *The 2 MiB worker page cache.* A 256 MiB cache saved about 124 ms at p50, but the hold stayed at 568 ms.
  - *The post-commit autocheckpoint.* It adds about 36 ms to the call, outside the probe-measured hold.
- **Fixing only the main connection.** #624 fixed the `--serve` main connection. The same session grepped the pragmas and noticed that the read-only reader worker uses its own pragmas. No one checked the writable worker connections for `synchronous` until #669. (session history)

## Solution

#669 carries the configured mode in the worker request, because the worker has no access to the runtime config:

```ts
// database-operations.ts, incrementalVacuum()
const result = await this.maintenanceOwner.run({
	dbPath: this.resolvedDbPath,
	pages,
	kind: "vacuum",
	synchronous: this.dbConfig.synchronous,
});
```

The worker (`runIncrementalVacuum`):

1. Refuses an unknown mode before it opens the database.
2. Applies `PRAGMA synchronous = <mode>` before `PRAGMA incremental_vacuum`.
3. Reads the applied level back and returns it in the result.

A request without the field keeps the connection default. The bench aborts if the reported level does not match the request.

Hold in ms, 100 reps per series, same run, series interleaved:

| series | p50 | p95 | p99 (95% CI) |
|---|---|---|---|
| request without `synchronous` (FULL) | 654.8 | 1406.1 | 1673.8 (1406–1970) |
| `synchronous: "NORMAL"` | 105.0 | 200.8 | 233.3 (201–453) |

- **Pairs.** NORMAL was faster in 100/100 back-to-back pairs. The median per-pair difference was 542.9 ms, the median ratio 5.57x.
- **Golden checks, every rep:**
  - the freelist dropped by exactly 16,384
  - the probe row committed
  - `quick_check` returned ok

The production config default is already `NORMAL` (`packages/config/src/index.ts`), so a default install now vacuums at NORMAL. An install that sets `db_synchronous=FULL` keeps FULL.

## Why This Works

The SQLite documentation for `PRAGMA synchronous` says: "With synchronous=FULL in WAL mode, an additional sync operation of the WAL file happens after each transaction commit". Under NORMAL, "no sync operations occur during most transactions".

Two measurements put that sync inside the writer-slot hold:

- A replica that times `exec` in-thread with no autocheckpoint had a p50 of 103.6 ms at NORMAL against 691.9 ms at FULL.
- Across reps, the hold correlated with device flush time (Spearman 0.62).

A chunk is one autocommit write transaction. Under FULL, the second connection waits through the whole WAL fsync.

**Durability:**

- The documentation says "WAL mode is safe from corruption with synchronous=NORMAL". It also says a transaction committed at NORMAL "might roll back following a power loss or system crash".
- For a vacuum chunk, a rollback only leaves its pages on the freelist for the next tick.
- The worker now trades exactly the durability the main connection was already configured to trade, and no more.

## Prevention

**For every `new Database(` outside `configureSqlite()`, decide each pragma explicitly.** Set `synchronous`, `busy_timeout`, `wal_autocheckpoint`, `mmap_size`, `cache_size` and `temp_store`, or write down why the compile default is right for that connection. The memory set alone is not enough: the vacuum workers copied it, and `synchronous` is the one that cost latency.

**Decide the open flags too.** Bun's default flags create a missing file. A worker that does not own the database opens it through `openExistingDatabase` (`packages/database/src/open-existing-database.ts`), which fails with "database file missing at <path>" instead (#668).

**Pass config values in the worker request** and validate them before opening the database. A worker cannot read the runtime config, and a hard-coded value drifts from `db_synchronous`.

**Report the applied value back and test it.** `packages/database/src/__tests__/incremental-vacuum-sync-mode.test.ts` asserts the level the worker reports, for OFF, NORMAL and FULL. It also covers a request with no field and a refused injected value.

**Measure a hold from a second connection, not by timing the call:**

1. Open a second connection on its own thread with `busy_timeout=0`.
2. Poll `BEGIN IMMEDIATE; ROLLBACK` until it returns SQLITE_BUSY.
3. Retry a one-row INSERT until it commits.
4. The hold runs from the first BUSY attempt to the committing attempt.

`bench/incremental-vacuum-hold.ts` implements this. Timing `exec` alone includes work done after the lock is released, such as the roughly 36 ms autocheckpoint. On a noisy host, interleave the series round-robin and trust the paired comparison over percentile drift. In this run the variance envelope escalated (48% and 135% p95 drift) while 100/100 pairs agreed.

**Inventory at this revision.** Every non-test `new Database(` site, excluding the generated inline workers:

| site | mode | on `--serve` | `synchronous` |
|---|---|---|---|
| `database-operations.ts` constructor | read-write | yes | `configureSqlite()` |
| `incremental-vacuum-worker.ts` `runIncrementalVacuum` | read-write, existing file only | yes, adaptive vacuum after retention cleanup | from the request since #669 |
| `incremental-vacuum-worker.ts` `runOptimize` | read-write, existing file only | yes, every minute (the `wal-checkpoint` job in `apps/server/src/server.ts`) | compile default, FULL |
| `vacuum-worker.ts` | read-write, existing file only | no; full VACUUM from the CLI compact command | compile default, FULL |
| `reader-worker.ts` | readonly | yes, dashboard reads | n/a |
| `integrity-check-worker.ts` | readonly | yes, the integrity scheduler | n/a |
| `analyze-performance.ts` | readonly | no, CLI | n/a |
| `packages/cli-commands/src/commands/stats.ts` `checkWriterLockAvailable` | read-write, `BEGIN IMMEDIATE` then `ROLLBACK` | no, CLI | n/a, never commits |

Notes on the inventory:

- **`runOptimize` is the known leftover.** It runs `PRAGMA optimize` and `PRAGMA wal_checkpoint(TRUNCATE)` at FULL with `busy_timeout=0`, so a busy tick skips rather than blocks. Its cost at FULL is unmeasured and it was deliberately left unchanged. The pragma docs suggest the cost is small: a WAL checkpoint syncs the same way under NORMAL and FULL, and FULL adds a sync only to commits, which this kind makes only on a tick where `PRAGMA optimize` runs ANALYZE. Measure it with the second-connection probe before changing it.
- **`wal_autocheckpoint` stays at the default 1000 on the vacuum worker's connection**, while the main connection sets 0. The baseline measured that checkpoint outside the hold.

## Related Issues

- #669: vacuum chunks run at the configured `synchronous` mode (this fix).
- #624: `--serve` opens the database with the server's config (the main-connection instance).
- Upstream tombii/better-ccflare PR #231: mmap on the main connection. Its trap is recorded for the worker connection in `vacuum-worker.ts`.
- #613 (open): the retention-backlog stall, and the source of the derived ~2.8 s per-chunk figure.
- #668: on 2026-10-28 the production vacuum worker read `auto_vacuum=0` at the database path while the main-side gate passed. The config directory had been deleted under the running backend. When it reappeared, the worker's default-flag open created an empty file at the path, while the main connection kept writing to the deleted original. Fixed by opening worker connections existing-only.
- [verify-fix-ancestry-before-citing-a-measured-rate](../workflow-issues/verify-fix-ancestry-before-citing-a-measured-rate.md)
