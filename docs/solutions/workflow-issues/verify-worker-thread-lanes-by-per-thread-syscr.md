---
title: Prove which worker lane serves an endpoint by per-thread read-syscall deltas, not thread names or logs
date: 2026-11-03
last_updated: 2026-11-04
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
  - thread-name
---

# Prove which worker lane serves an endpoint by per-thread read-syscall deltas, not thread names or logs

## Context

The router runs its SQLite work on several Bun Worker threads inside one process:

- the off-thread writer (#686, for #676);
- the bulk reader for heavy dashboard reads (#606);
- since #712 (for #709), a second reader labelled `interactive reader`. It serves the accounts page, which used to queue on the single reader behind heavy analytics scans that can run for tens of seconds.

Other Workers can run alongside them. After #712 was deployed, the question was whether `GET /api/accounts` really runs on the new thread in production. None of the obvious signals could answer it:

- **Thread names.** At the time, every worker thread's `comm` read `Worker`, because the workers were spawned with `{ smol: true }` and no `name`. The main thread reads `better-ccflare-`, cut to Linux's 15 characters. Each database worker now names its thread after its lane ([Thread names](#thread-names) below). That says which thread is which lane, but still not which lane an endpoint's reads go to.
- **The ready line.** Each lane logs `Off-thread <label> ready` once (`packages/database/src/off-thread-reader.ts:352-356`), but at info level. The level comes from `LOG_LEVEL` (`packages/logger/src/index.ts:89`), and production ran `LOG_LEVEL=warn` when this was measured (backend pid 4179860, 2026-11-04 UTC).
- **Slow-SQL warnings.** `Slow off-thread SQL` is logged at warn level, but only for statements of 250 ms or more (`SLOW_SQL_STATEMENT_MS`, `packages/database/src/sqlite-statement-timing.ts:26`). Only a labelled reader appends ` (interactive reader)` to it (`off-thread-reader.ts:370-372`), so an unsuffixed line can come from either the bulk reader or the writer. An accounts read takes about 32 ms, so it never produces the line at all.
- **`read_bytes`.** It stayed 0 on the readers while they served hundreds of megabytes (`rchar`), because the kernel page cache answered the reads.
- **Thread start times.** A reader spawns lazily on its first read (`off-thread-reader.ts:161`), so its start time only hints at which lane it is.

The writer was always the easy case. It was the only worker with steady `wchar`, and the #686 rollout proved it by reading per-thread `/proc` io for the backend pid (session history). The two readers needed something sharper.

## Guidance

Read each thread's counters from `/proc/<pid>/task/<tid>/io`, and drive one endpoint at a time.

1. **Take the backend pid from the guard, not from `pgrep`.** `/health` on `:8788` reports the live backend as `.handoff.pid`. Check its `git_sha` too: a measurement only counts if that build contains the change ([ancestry doc](./verify-fix-ancestry-before-citing-a-measured-rate.md)). On this host the service runs as the operator's own user, so the io files were readable without `sudo`.
2. **Snapshot every database worker thread's `syscr` and `wchar`, send a burst of one endpoint, then snapshot again.** In production, a reader's `syscr` (its count of read system calls) rose with every query it ran, and `wchar` singled out the writer.
3. **Take a quiet window of about the same length first.** Background traffic, such as the dashboard's own polls and request inserts, moves every counter a little. The lane is the thread whose burst delta dwarfs its quiet delta.
4. **Then test the lane under contention.** Start a heavy bulk-lane endpoint (`/api/stats` or `/api/analytics`) and time the interactive endpoint every 0.5 s while it runs. If the lanes really are separate, the interactive timings stay flat while both readers' `syscr` climb together.

The snapshot, for builds that name their worker threads:

```bash
PID=$(curl -s http://127.0.0.1:8788/health | jq -r '.handoff.pid')
snap() {  # one line per database worker thread: tid name syscr wchar
  for t in /proc/"$PID"/task/*; do
    c=$(cat "$t/comm")
    case $c in db-*) ;; *) continue ;; esac
    printf '%s %s %s\n' "${t##*/}" "$c" "$(awk '/^syscr/ {s=$2} /^wchar/ {w=$2} END {print s, w}' "$t/io")"
  done | sort
}
snap > before.txt
# burst, for example 30 × curl -s -o /dev/null -H @"$KEY_FILE" http://127.0.0.1:8788/api/accounts
snap > after.txt
join before.txt after.txt | awk '{printf "%s tid %s syscr +%d wchar +%d\n", $2, $1, $6-$3, $7-$4}'
```

On a build from before the names, every worker reads `Worker`, as in the #712 measurement: replace the `case` line with `[ "$c" = Worker ] || continue`, and the rest works unchanged.

The io file lists `wchar` before `syscr`, which is why the awk matches both fields by name rather than taking columns by position.

Production `/api` needs the admin key; only `/health` is exempt. Put the `x-api-key:` header line in a mode-600 file (`KEY_FILE` above), pass it with `-H @file`, delete it afterwards, and never print it.

Two cautions:

- Send bursts only to real dashboard routes ([unknown-path doc](./never-poll-an-unknown-path-against-a-local-ccflare.md)). This method uses dashboard reads, never inference traffic.
- Keep the contention test short. Each heavy bulk endpoint ran 39-85 s when this was written. Since #722 (2026-11-04) the recurring bulk-lane scans are cheap: a public subscription-value refresh takes about 0.33 s warm, and the Codex scanner's usage report about 0.19 s run alone. So the endpoint you start in step 4 supplies the contention. One or two runs are enough.

### Thread names

Each database worker passes its lane's name as the Worker `name` option, and Bun sets that as the OS thread name. The names live in `DB_WORKER_THREAD_NAMES` (`packages/database/src/worker-thread-names.ts`):

| Thread name | Worker | Present |
|---|---|---|
| `db-read-bulk` | bulk reader | from its first read |
| `db-read-inter` | interactive reader | from its first read |
| `db-writer` | off-thread writer | from its first write |
| `db-incvac` | incremental vacuum and `optimizeAsync()` | from its first job |
| `db-compact` | compaction, `compact()` | from its first job |
| `db-integrity` | integrity check | only while a check runs |

So `ps -L -o tid,comm,pcpu -p "$PID"` lists each lane's thread with its CPU, and a worker that faults and respawns keeps its name under a new tid. `top -H` cuts the name to its column width: at the default width both readers show as `db-read+`, so widen it (`top -H -w 200 -p "$PID"`). Four things still need care:

- **A missing name means the worker has not started.** It does not mean naming failed. Right after a restart, `db-read-inter` appears only once something has loaded the accounts page.
- **A name can briefly show on two threads.** The helper threads a worker creates start with its name and rename themselves within milliseconds, so a snapshot can catch one under the worker's name.
- **Linux keeps 15 bytes of a name** and drops the rest without an error. `packages/database/src/__tests__/worker-thread-names.test.ts` holds each name to 15 bytes and checks each lane's thread in `/proc`.
- **A name says which thread is which lane, not which lane an endpoint uses.** Proving that still takes the burst.

## Why This Matters

Without a thread-level measurement, the only evidence that a lane change worked is "the page feels faster", and a quieter host or a warmer cache could produce that too. A lane regression is silent. Suppose a refactor sends the accounts reads back to the bulk reader: nothing logs, because the reads stay under 250 ms while that reader is idle, and the page stalls again only when someone runs an analytics scan.

The burst shows the routing directly, and the contention test shows the property the lane exists to provide. Both take a minute, read only kernel counters, and need no restart, log-level change or code change.

## When to Apply

- After deploying anything that changes which lane a read uses, such as the `"interactive"` lane passed to `setOffThreadReader`, or how the workers are built (`packages/database/src/database-operations.ts:680-690`).
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

## Related

- Issue #709 and PR #712: the interactive reader lane this method verified.
- Issue #676 and PR #686: the off-thread writer. Its rollout identified the writer from per-thread io (session history).
- Issue #606: where the off-thread bulk reader came from. Issue #710 and the Codex scanner's `report()` call (`packages/http-api/src/services/external-codex-scanner.ts`) were the recurring bulk-lane load until #722 fixed #710's query plan; after that deploy `report()` all but stopped logging as slow (once, at 1.0 s, in the first 51 minutes) ([planner-tie learning](../performance-issues/sqlite-planner-tie-between-low-cardinality-and-account-index.md)). Since #601 the dashboard no longer polls `/api/stats`, so #711 is not part of it.
- [Worker SQLite connections run compile-default pragmas](../performance-issues/worker-sqlite-connections-run-compile-default-pragmas.md): how the worker connections are configured, and the inventory of worker sites.
- [Verify fix ancestry before citing a measured rate](./verify-fix-ancestry-before-citing-a-measured-rate.md): confirm the live `git_sha` carries the change before citing a measurement.
- [Never poll an unknown path against a local ccflare](./never-poll-an-unknown-path-against-a-local-ccflare.md): send bursts to known routes only.
- [RSS watchdog blind to swap-evicted memory](../performance-issues/rss-watchdog-blind-to-swap-evicted-memory.md): another `/proc` reading where the obvious counter misleads.
- [Snapshot a live SQLite DB with VACUUM INTO, not .backup](./snapshot-a-live-sqlite-db-with-vacuum-into-not-backup.md): inspecting the live production database without disturbing it.
