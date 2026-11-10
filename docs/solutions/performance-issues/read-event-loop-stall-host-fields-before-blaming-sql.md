---
title: Read an event-loop stall line's host fields before blaming the SQL it names
date: 2026-11-10
category: performance-issues
module: event-loop-stall-monitor
problem_type: best_practice
component: observability
severity: medium
root_cause: measurement_methodology
related_components:
  - database
  - infrastructure
applies_when:
  - "An `[EventLoop] Event loop stall` or `Main-thread SQL saturation` warning names a main-thread SQL statement"
  - "A point lookup or a query on a small table shows seconds of time in a stall line"
  - "The router shares its host with memory- or disk-heavy workloads such as coding agents, builds or batch jobs"
  - "Deciding whether a stall needs query work, memory protection for the router, or a bound on another workload"
tags: [event-loop-stall, swap, page-faults, psi, schedstat, memory-pressure, slow-sql-log, memorylow]
---

# Read an event-loop stall line's host fields before blaming the SQL it names

## Context

When the router's main thread is held past a tick, `EventLoopStallMonitor` logs one warning (`apps/server/src/event-loop-stall-monitor.ts`, wired up in `apps/server/src/server.ts:1601-1606`). The line leads with the main-thread SQL that ran during the tick and its slowest statements, so it reads like a slow-query report:

```text
[2026-11-09T23:40:38.103Z] WARN: [EventLoop] Event loop stall: 16207ms late (tick took 17207ms, …); main-thread SQL in that tick: 59 statements, 9472ms; top: 9469ms ×14 (max 9469ms) SELECT incarnation, version, state_json, enrolled FROM quality_route_sessions WHERE principal_id = ? AND session_id = ? | …
```

That statement is a primary-key lookup (`PRIMARY KEY (principal_id, session_id)`, `packages/database/src/migrations.ts:345`). It did not take 9.5 s to execute. The fields at the end of the same line, which this excerpt cuts, show where the time went.

## Guidance

**Statement time is wall-clock time.** `packages/database/src/sqlite-statement-timing.ts` times each synchronous bun:sqlite call with `performance.now()` (`:107`, `:237-242`). It counts every millisecond the main thread spent inside the call, including time spent waiting for a CPU, for a page to come back from swap or disk, or for a lock. The tail of the line separates those:

| Field | Source | Meaning |
| --- | --- | --- |
| `main thread: Ams on CPU` | `/proc/thread-self/schedstat` (`apps/server/src/host-counters.ts:62-67`) | the main thread was running |
| `Bms waiting for a CPU` | same | runnable, but no CPU was free |
| `Cms off CPU` | tick − A − B (`event-loop-stall-monitor.ts:171-174`) | neither running nor runnable: blocked |
| `D major faults` | `/proc/thread-self/stat` field 12 (`host-counters.ts:72-83`) | page faults that had to read from disk or swap |
| `host stalled on io Xms (all tasks Yms), memory …, cpu …` | `/proc/pressure/{io,memory,cpu}` (`host-counters.ts:86-103`) | PSI. The bare value is `some`: at least one task on the host was stalled. "all tasks" is `full`: every non-idle task was stalled at once. cpu has `some` only. |

A counter file that fails to read is dropped and never read again (`host-counters.ts:112-135`), so on a host without PSI those fields are missing from the line. A missing field means not measured, not zero.

Read the fields in this order:

1. **Was the thread running?** If `on CPU` is close to the SQL time, the statement was doing work: look at its plan, indexes and row counts. No stall in the data below took this branch; it follows from the field definitions.
2. **Was it waiting for a CPU?** A large `waiting for a CPU` share means CPU contention. Look at host cpu pressure and what else was running.
3. **Otherwise it was blocked.** When `off CPU` is close to the tick, the SQL time measures how long the thread was blocked inside the call, not what the query costs. Then check, in order:
   - **Did the whole host stall?** If io plus memory "all tasks" is a large share of the tick (25% or more in the rule below), nothing on the host was running. The router's memory protection cannot help there; `docs/systemd.md` ("Protection on a shared host") says so. Find the workload that filled memory or saturated the disk and bound it, and run an OOM daemon.
   - **Did the router fault?** Many major faults on a quieter host mean the router's own pages were reclaimed and read back. That is the case `MemoryLow` on the service and its slice is for (`docs/systemd.md`, PR #776).
   - **Neither?** Look at io `some`. A high value means some task, possibly the router, was waiting on disk, but the line doesn't say which task or what the router waited on. Then look at the statement. A point lookup or a read of a small table does not need seconds of disk reads by itself. A statement that scans can, so check its plan and how much it reads before ruling it out ([SQLite planned a per-account query on the billing_type index](sqlite-planner-tie-between-low-cardinality-and-account-index.md) is a real case: one refresh read 3.9 GiB).
4. **Zero major faults does not clear the host.** The router maps the first 256 MB of the database by default (`mmapSize`, `packages/config/src/index.ts:2848`). A cold page inside that window comes back as a major fault. A page SQLite reads with an ordinary file read blocks on disk without counting one. The 23:41:00Z example below had 0 faults while every task on the host was stalled on io for 73% of the tick.
5. **Don't judge one stall from a single field.** No single field says what a given stall waited on: swap, a disk read or a lock. Neither does the classifier below. Each field only rules some causes in or out.

Moving SQLite work off the main thread is a separate lever. The router already did this for writes (PR #686, for issue #676) and for the accounts page's reads (PR #712). It keeps the event loop ticking while the disk is slow, but the request still waits for its data, and nothing measured here says the point lookups above should move.

## Why This Matters

Each stall line was classified by its own fields under rules fixed before counting:
- **SQL:** main-thread SQL is 50% or more of the tick.
- **FAULT:** not SQL, and 50 or more major faults.
- **HOSTWIDE:** io plus memory "all tasks" is 25% or more of the tick.
- **OTHER:** the rest.

Stalls of 1-5 s are the countermetric. All counts come from the production router's journal.

| Window (UTC) | Stall lines | Stalls ≥5 s | HOSTWIDE | FAULT | SQL | OTHER | 1-5 s: HOSTWIDE / FAULT / SQL / OTHER |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2026-11-02 19:20 to 11-09 20:27, counted 11-09 | 1,172 | 158 | 76 | 75 | 3 | 4 | 239 / 81 / 35 / 59 |
| 2026-11-04 06:35 to 11-09 20:27, counted 11-10 | 1,099 | 143 | 69 | 68 | 2 | 4 | 229 / 81 / 31 / 58 |

The second row exists because the journal had rotated: its start is the oldest line still in it, and the first count can no longer be reproduced.

Even the SQL-class stalls were mostly not slow queries. From 2026-11-04 06:35Z to 11-10 01:00Z, 38 stalls of 1 s or more were SQL-class. The test, fixed before counting, was "blocked" (on CPU under 50% of the SQL time) against "ran" (50% or more):
- **Blocked:** 38 of 38. The on-CPU share was at most 35%, median 1%.
- **Host:** 32 of the 38 coincided with a whole-host stall. Only 5 of the 38 had 50 or more major faults.
- **The other 6:** all had io `some` at 25-67% of the tick. Four were on point lookups or small tables (`accounts` twice, `api_keys`, `quality_route_sessions`). Two were `usage_windows` queries, whose cost when nothing is blocking has not been measured, so those two may not be bystanders.

Read top-down, these lines send an engineer to tune indexes on a lookup that already uses its primary key. Read from the tail, most of them point at memory and disk pressure on a shared host.

What is not yet known:
- **Protection.** `MemoryLow` was applied on the managed host on 2026-11-10, and the coding-agent tool processes there were bounded in RAM and swap the same day. No pressure episode has happened since, so neither has been seen reducing stalls.
- **The 6 blocked stalls with no whole-host stall.** What they waited on is unknown.

## When to Apply

- Before opening an issue or writing a fix for a statement named in a stall or saturation line. Both labels come from the same formatter (`event-loop-stall-monitor.ts:134-136`); saturation lines fire when main-thread SQL reaches 500 ms in a tick (`:23`).
- When a statement that normally takes under a millisecond shows seconds.
- When stall counts change after a host change: more RAM, swap, new co-tenants, or a different disk.

## Examples

**Whole-host stall, 2026-11-09 23:40:38Z** (statement list trimmed):

```text
Event loop stall: 16207ms late (tick took 17207ms, …); main-thread SQL in that tick: 59 statements, 9472ms; top: 9469ms ×14 (max 9469ms) SELECT incarnation, … FROM quality_route_sessions WHERE principal_id = ? AND session_id = ? | …; main thread: 342ms on CPU, 47ms waiting for a CPU, 16818ms off CPU, 32 major faults; host stalled on io 13877ms (all tasks 9230ms), memory 5120ms (all tasks 3886ms), cpu 796ms
```

- **The class misleads here.** SQL is 9,472 of 17,207 ms, so this counts as SQL-class.
- **The thread barely ran.** It ran 342 ms in the whole tick, 4% of the SQL time, and was off CPU for 16,818 ms.
- **Faults don't explain it.** 32 major faults can't account for 16.8 s.
- **The whole host stalled.** Every task on the host was stalled on io for 9,230 ms and on memory for 3,886 ms, 76% of the tick together.

Verdict: a whole-host stall, with the lookup as a bystander. At that moment a coding agent's tool processes on the same host held about 68 GiB of swap, and the kernel logged an out-of-memory report for their cgroup at 23:41:12Z.

**Zero faults, host still stalled, 2026-11-09 23:41:00Z** (trimmed):

```text
Event loop stall: 14038ms late (tick took 15038ms, …); main-thread SQL in that tick: 28 statements, 11951ms; top: 11949ms ×9 (max 11949ms) SELECT incarnation, … FROM quality_route_sessions … | …; main thread: 146ms on CPU, 34ms waiting for a CPU, 14857ms off CPU, 0 major faults; host stalled on io 12570ms (all tasks 10948ms), memory 2918ms (all tasks 2697ms), cpu 337ms
```

- **Faults alone would clear it.** With no major faults, the fault count says the router was not paged out.
- **The host fields don't.** Every task was stalled on io for 10,948 ms, 73% of the tick.

**Blocked with no whole-host stall, 2026-11-06 00:27:02Z** (trimmed):

```text
Event loop stall: 1175ms late (tick took 2175ms, began 1246.0s after process start); main-thread SQL in that tick: 15 statements, 2020ms; top: 2019ms ×4 (max 2019ms) SELECT incarnation, … FROM quality_route_sessions … | …; main thread: 32ms on CPU, 2ms waiting for a CPU, 2141ms off CPU, 0 major faults; host stalled on io 1468ms (all tasks 0ms), memory 117ms (all tasks 0ms), cpu 720ms
```

- **The lookup was blocked.** It held the thread for 2 s while the thread ran for 32 ms.
- **Nothing points at the router or the host.** No major faults, and no whole-host stall.
- **Something waited on disk.** Some task was waiting on io for two-thirds of the tick. A primary-key lookup does not read seconds of data on its own, so the wait was most likely contention, but the line cannot say for what.

## Related

- [An RSS-only containment watchdog goes blind when the kernel swaps the leak out](rss-watchdog-blind-to-swap-evicted-memory.md): the same host pressure, seen from the memory watchdog.
- [A SQLite connection a worker opens itself runs Bun's compile defaults](worker-sqlite-connections-run-compile-default-pragmas.md): a case where the statements were part of the cause. Main-thread writes at `synchronous=FULL` stalled under io pressure until #624.
- [SQLite planned a per-account query on the billing_type index](sqlite-planner-tie-between-low-cardinality-and-account-index.md): a statement whose disk reads were its own fault.
- [`docs/systemd.md`, "Protection on a shared host"](../../systemd.md): `MemoryLow` on the service and its slice (PR #776).
- Issues #606 (dashboard reads off the main thread) and #676 (main-thread INSERT under host IO pressure); PRs #686 and #712.
