---
title: Prove which worker thread serves a lane by per-thread read-syscall deltas, not thread names or logs
date: 2026-11-03
category: workflow-issues
module: off-thread-sqlite-workers
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - Verifying in production that a query moved onto, or off, the interactive reader, the bulk reader or the writer thread
  - Deploying a change to the reader lanes or to the off-thread writer
  - Finding which worker thread a slow dashboard endpoint is waiting on
  - The logs cannot answer it, because production runs at warn level and the reads finish under 250 ms
root_cause: measurement_methodology
resolution_type: workflow_improvement
related_components:
  - observability
  - database
tags:
  - off-thread-reader
  - worker-thread
  - proc-io
  - syscr
  - production-verification
  - reader-lane
  - writer-thread
  - bun-worker
---

# Prove which worker thread serves a lane by per-thread read-syscall deltas, not thread names or logs

## Context

The router runs its SQLite work on several Bun Worker threads inside one process:

- the off-thread writer (#686, for #676);
- the bulk reader for heavy dashboard reads (#606);
- since #712 (for #709), a second reader labelled `interactive reader`. It serves the accounts page, which used to queue on the single reader behind heavy analytics scans that run 40-90 s.

Other Workers can run alongside them. After #712 was deployed, the question was whether `GET /api/accounts` really runs on the new thread in production. None of the obvious signals could answer it:

- **Thread names.** Every worker thread's `comm` reads `Worker`. The main thread reads `better-ccflare-`, cut to Linux's 15 characters. `OffThreadReader` spawns its workers with `{ smol: true }` and no `name` (`packages/database/src/off-thread-reader.ts:288-291`).
- **The ready line.** Each lane logs `Off-thread <label> ready` once (`off-thread-reader.ts:346-350`), but at info level. The level comes from `LOG_LEVEL` (`packages/logger/src/index.ts:89`), and production ran `LOG_LEVEL=warn` when this was measured (backend pid 4179860, 2026-11-04 UTC).
- **Slow-SQL warnings.** `Slow off-thread SQL` is logged at warn level, but only for statements of 250 ms or more (`SLOW_SQL_STATEMENT_MS`, `packages/database/src/sqlite-statement-timing.ts:26`). Only a labelled reader appends ` (interactive reader)` to it (`off-thread-reader.ts:364-366`), so an unsuffixed line can come from either the bulk reader or the writer. An accounts read takes about 32 ms, so it never produces the line at all.
- **`read_bytes`.** It stayed 0 on the readers while they served hundreds of megabytes (`rchar`), because the kernel page cache answered the reads.
- **Thread start times.** A reader spawns lazily on its first read (`off-thread-reader.ts:159`), so its start time only hints at which lane it is.

The writer was always the easy case. It was the only worker with steady `wchar`, and the #686 rollout proved it by reading per-thread `/proc` io for the backend pid (session history). The two readers needed something sharper.

## Guidance

Read each thread's counters from `/proc/<pid>/task/<tid>/io`, and drive one endpoint at a time.

1. **Take the backend pid from the guard, not from `pgrep`.** `/health` on `:8788` reports the live backend as `.handoff.pid`. Check its `git_sha` too: a measurement only counts if that build contains the change ([ancestry doc](./verify-fix-ancestry-before-citing-a-measured-rate.md)). On this host the service runs as the operator's own user, so the io files were readable without `sudo`.
2. **Snapshot every `Worker` thread's `syscr` and `wchar`, send a burst of one endpoint, then snapshot again.** In production, a reader's `syscr` (its count of read system calls) rose with every query it ran, and `wchar` singled out the writer.
3. **Take a quiet window of about the same length first.** Background traffic, such as the dashboard's own polls and request inserts, moves every counter a little. The lane is the thread whose burst delta dwarfs its quiet delta.
4. **Then test the lane under contention.** Start a heavy bulk-lane endpoint (`/api/stats` or `/api/analytics`) and time the interactive endpoint every 0.5 s while it runs. If the lanes really are separate, the interactive timings stay flat while both readers' `syscr` climb together.

The snapshot as it was run against production:

```bash
PID=$(curl -s http://127.0.0.1:8788/health | jq -r '.handoff.pid')
snap() {  # one line per Worker thread: tid syscr wchar
  for t in /proc/"$PID"/task/*; do
    [ "$(cat "$t/comm")" = Worker ] || continue
    printf '%s %s\n' "${t##*/}" "$(awk '/^syscr/ {s=$2} /^wchar/ {w=$2} END {print s, w}' "$t/io")"
  done | sort
}
snap > before.txt
# burst, for example 30 × curl -s -o /dev/null -H @"$KEY_FILE" http://127.0.0.1:8788/api/accounts
snap > after.txt
join before.txt after.txt | awk '{printf "tid %s syscr +%d wchar +%d\n", $1, $4-$2, $5-$3}'
```

The io file lists `wchar` before `syscr`, which is why the awk matches both fields by name rather than taking columns by position.

Production `/api` needs the admin key; only `/health` is exempt. Put the `x-api-key:` header line in a mode-600 file (`KEY_FILE` above), pass it with `-H @file`, delete it afterwards, and never print it.

Two cautions:

- Send bursts only to real dashboard routes ([unknown-path doc](./never-poll-an-unknown-path-against-a-local-ccflare.md)). This method uses dashboard reads, never inference traffic.
- Keep the contention test short. Each heavy bulk endpoint ran 40-90 s, and the dashboard polls `/api/stats` on its own (#711), so one or two runs are enough.

## Why This Matters

Without a thread-level measurement, the only evidence that a lane change worked is "the page feels faster", and a quieter host or a warmer cache could produce that too. A lane regression is silent. Suppose a refactor sends the accounts reads back to the bulk reader: nothing logs, because the reads stay under 250 ms while that reader is idle, and the page stalls again only when someone runs an analytics scan.

The burst shows the routing directly, and the contention test shows the property the lane exists to provide. Both take a minute, read only kernel counters, and need no restart, log-level change or code change.

## When to Apply

- After deploying anything that changes which lane a read uses, such as the `"interactive"` lane passed to `setOffThreadReader`, or how the workers are built (`packages/database/src/database-operations.ts:677-683`).
- When a dashboard endpoint is slow and the question is which worker thread it is waiting on.
- When proving that a write moved onto, or off, the writer thread. Use `wchar` the same way.

## Examples

Production on 2026-11-04 UTC: build 337c80cd (#712), backend pid 4179860, four `Worker` threads at the time.

| tid | Quiet window, 8.13 s | Burst: 30 × `GET /api/accounts` in 1.45 s | Identified as |
|---|---|---|---|
| 1511 | syscr +6,617 | syscr +194,822 | interactive reader |
| 4180200 | syscr +47 | syscr +2 | bulk reader |
| 4180175 | syscr +19 | syscr +1 | writer (`wchar` about +10 MB a minute) |
| 50109 | syscr +0 | syscr +0 | another Worker, not identified |

The 30 burst calls took 22-78 ms each, median 31 ms. In a separate 60 s sample, tid 1511 read 188 MB by `rchar` with `read_bytes` +0, which is why `read_bytes` cannot locate a reader.

Contention tests on the same deploy:

| Bulk-lane load | Accounts calls (all HTTP 200) | Accounts latency | Bulk tid `syscr` | Interactive tid `syscr` |
|---|---|---|---|---|
| `/api/stats` (38.8 s), then `/api/analytics?range=7d` (53.5 s) | 98 | median 32 ms, max 145 ms | +481,355 | +692,356 |
| `/api/analytics?range=30d` (85.3 s), independent re-run | 152 | median 32 ms, p95 62 ms, max 135 ms | +1,629,754 | +1,089,414 |

Before #712, those same accounts reads queued behind the single reader while a scan held it (#709).

**Possible improvement, not done.** On Bun 1.4.2 the `Worker` constructor's `name` option sets the Linux thread name, up to 15 characters. In a local probe, a worker named `interactive-rdr` showed up under that name in `/proc/self/task/*/comm`. It appeared on three threads, against one `Worker` thread for an unnamed worker; the extra two were not investigated. Passing each lane's label as the worker name would let `comm` identify the thread, but proving which lane a given endpoint uses would still take the burst.

## Related

- Issue #709 and PR #712: the interactive reader lane this method verified.
- Issue #676 and PR #686: the off-thread writer. Its rollout identified the writer from per-thread io (session history).
- Issue #606: where the off-thread bulk reader came from. Issues #710 and #711: the bulk-lane load that makes the contention test meaningful.
- [Worker SQLite connections run compile-default pragmas](../performance-issues/worker-sqlite-connections-run-compile-default-pragmas.md): how the worker connections are configured, and the inventory of worker sites.
- [Verify fix ancestry before citing a measured rate](./verify-fix-ancestry-before-citing-a-measured-rate.md): confirm the live `git_sha` carries the change before citing a measurement.
- [Never poll an unknown path against a local ccflare](./never-poll-an-unknown-path-against-a-local-ccflare.md): send bursts to known routes only.
- [RSS watchdog blind to swap-evicted memory](../performance-issues/rss-watchdog-blind-to-swap-evicted-memory.md): another `/proc` reading where the obvious counter misleads.
- [Snapshot a live SQLite DB with VACUUM INTO, not .backup](./snapshot-a-live-sqlite-db-with-vacuum-into-not-backup.md): inspecting the live production database without disturbing it.
