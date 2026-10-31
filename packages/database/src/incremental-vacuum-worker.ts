import { Database } from "bun:sqlite";

/**
 * Dedicated worker for `PRAGMA incremental_vacuum(N)` and the periodic
 * `PRAGMA optimize` + `PRAGMA wal_checkpoint(TRUNCATE)` maintenance tick.
 *
 * Two kinds (discriminated by `kind`, defaulting to "vacuum" for backward
 * compatibility with kind-less messages):
 *   - "vacuum"   - the original incremental_vacuum behavior (below).
 *   - "optimize" - runs `PRAGMA optimize` + `PRAGMA wal_checkpoint(TRUNCATE)`
 *     with `busy_timeout = 0`. This is the ONLY WAL reclaimer: the main
 *     connection runs with `wal_autocheckpoint = 0` (see database-operations.ts)
 *     so all checkpointing happens here, off-thread, where it can't freeze the
 *     event loop. Previously this ran synchronously on the main
 *     thread via `DatabaseOperations.optimize()`; when the vacuum kind (or
 *     any other writer) held SQLite's single writer slot, `PRAGMA optimize`'s
 *     internal ANALYZE blocked inside SQLite's C-level busy handler for the
 *     full busy_timeout (10 s), freezing the entire event loop, then threw
 *     "database is locked". In the worker the main thread never blocks, and
 *     `busy_timeout = 0` turns contention into an instant, explicit skip
 *     (`{ ok: true, skipped: true }`), missing one 5-minute cycle while
 *     maintenance contends is normal and harmless; the next tick retries.
 *
 * Why a worker, not the main `sqliteDb` handle:
 *   `bun:sqlite` is synchronous (blocks the JS event loop for the duration of
 *   any call). `PRAGMA incremental_vacuum(N)` is a write transaction that
 *   moves up to N free pages back to the OS. For our hourly hourly retention
 *   tick (N≈8000, ~32 MiB) the operation is usually fast on local SSD, but
 *   under load or on a fragmented file it can climb into hundreds of
 *   milliseconds. Off-thread keeps the proxy's HTTP loop responsive.
 *
 * Locking: this still takes SQLite's single writer slot, so any concurrent
 * write from main or post-processor connections will wait on `busy_timeout`
 * until this finishes. That's expected and bounded by the chunk size we pass
 * in (small N → short hold).
 *
 * Memory knobs applied inside the worker connection:
 *  - `cache_size = -2000` (2 MiB): keep SQLite's page cache small; the worker
 *    is short-lived and doesn't need a big cache for one PRAGMA.
 *  - `temp_store = FILE`: never spill temp tables to RAM under cgroup pressure.
 *  - `mmap_size = 0`: no mmap; reads go through the page cache (still
 *    reclaimable by the kernel under MemoryHigh pressure).
 *  - `busy_timeout = 200`: small wait to absorb a brief write burst from the
 *    post-processor flushing a batched insert. Long enough to cover the
 *    common case (sub-100 ms commits), short enough that the worker can't
 *    extend the writer-slot hold meaningfully. Bumped from 0 after Greptile
 *    flagged that a zero timeout would silently skip every tick during
 *    sustained write activity — see the consecutive-skip counter in
 *    `incrementalVacuum()` for the escalation path. (Greptile #230)
 *
 * Durability: a vacuum request carries the main connection's configured
 * `synchronous` mode, applied before the PRAGMA. Without it this connection
 * ran at the compile-time default (FULL), whose commit fsyncs the WAL while
 * still holding the writer slot: on a local temp file, NORMAL cut a
 * 16,384-page chunk's median hold from 655 ms to 105 ms
 * (bench/incremental-vacuum-hold.ts). In WAL mode NORMAL
 * stays corruption-safe; a power loss can roll the chunk back, which only
 * leaves its pages on the freelist. A request without the field keeps the
 * connection default.
 *
 * Refuses if `auto_vacuum != 2` — the operation is a no-op there and would
 * mask a misconfigured DB. Callers should have gated already via the same
 * check on the main connection, but the worker double-checks since it
 * opens its own handle.
 */

/**
 * Row cap for `PRAGMA optimize`'s internal ANALYZE, set via `PRAGMA
 * analysis_limit` before it. Without a limit (SQLite's default of 0 =
 * unbounded) ANALYZE does a full index scan on every table it deems stale;
 * on large tables that holds SQLite's single writer slot for seconds, during
 * which every main-thread write parks in its busy handler, freezing the
 * event loop. 400 is SQLite's documented value
 * (https://sqlite.org/lang_analyze.html): it samples ~400 rows per index for
 * near-identical planner statistics while bounding each ANALYZE to
 * milliseconds.
 */
const ANALYZE_ANALYSIS_LIMIT = 400;

/**
 * `PRAGMA optimize` mask. A bare `PRAGMA optimize` only considers tables that
 * queries on the same connection have used, and this worker opens a fresh
 * connection every tick, so it never re-analyzed anything: production planned
 * against sqlite_stat1 written when `requests` held 39k rows, at 2.1M. 0x10000
 * checks every table; 0x02 runs ANALYZE on those whose size has drifted far
 * from their stats (SQLite's documented setting for a newly opened connection,
 * https://sqlite.org/pragma.html#pragma_optimize). Most ticks analyze nothing.
 * Other open connections, including the main one, keep the statistics they
 * loaded until they next reload the schema (in practice, the next restart).
 */
const OPTIMIZE_MASK = "0x10002";

export type SynchronousMode = "OFF" | "NORMAL" | "FULL";

const SYNCHRONOUS_MODES: ReadonlySet<unknown> = new Set<SynchronousMode>([
	"OFF",
	"NORMAL",
	"FULL",
]);

export type IncrementalVacuumRequest = (
	| {
			kind?: "vacuum";
			dbPath: string;
			pages: number;
			synchronous?: SynchronousMode;
	  }
	| { kind: "optimize"; dbPath: string }
	| { kind: "retire" }
) & { generation?: number; jobId?: number };

export type IncrementalVacuumResult =
	| { ok: true; mode: number; synchronous: number }
	| { ok: true; skipped: boolean }
	| { ok: false; error: string };

// A failed connection close must never be mistaken for released DB ownership.
let retirementSafe = true;
let retired = false;
function closeConnection(db: Database | undefined): void {
	try {
		db?.close();
	} catch (error) {
		retirementSafe = false;
		throw error;
	}
}

function applyWorkerPragmas(db: Database): void {
	db.exec("PRAGMA cache_size = -2000");
	db.exec("PRAGMA temp_store = FILE");
	db.exec("PRAGMA mmap_size = 0");
}

function isSqliteBusy(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code?: unknown }).code === "SQLITE_BUSY"
	);
}

function runIncrementalVacuum(
	dbPath: string,
	pages: number,
	synchronous: unknown,
): IncrementalVacuumResult {
	if (synchronous !== undefined && !SYNCHRONOUS_MODES.has(synchronous)) {
		return {
			ok: false,
			error: `Invalid synchronous mode: ${JSON.stringify(synchronous)} (must be OFF, NORMAL, or FULL)`,
		};
	}
	let db: Database | undefined;
	try {
		db = new Database(dbPath);
		db.exec("PRAGMA busy_timeout = 200");
		applyWorkerPragmas(db);
		if (synchronous !== undefined)
			db.exec(`PRAGMA synchronous = ${synchronous}`);
		const appliedSynchronous = (
			db.query("PRAGMA synchronous").get() as { synchronous: number }
		).synchronous;
		const mode = (
			db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }
		).auto_vacuum;
		if (mode !== 2)
			return {
				ok: false,
				error: `auto_vacuum=${mode}; expected 2 (INCREMENTAL). Run startup bootstrap migration first.`,
			};
		const n = Math.max(1, Math.trunc(Number(pages) || 1));
		db.exec(`PRAGMA incremental_vacuum(${n})`);
		return { ok: true, mode, synchronous: appliedSynchronous };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	} finally {
		closeConnection(db);
	}
}

function runOptimize(dbPath: string): IncrementalVacuumResult {
	let db: Database | undefined;
	try {
		db = new Database(dbPath);
		// Never park a maintenance worker in a long busy handler during traffic.
		db.exec("PRAGMA busy_timeout = 0");
		applyWorkerPragmas(db);
		db.exec(`PRAGMA analysis_limit = ${ANALYZE_ANALYSIS_LIMIT}`);
		db.exec(`PRAGMA optimize=${OPTIMIZE_MASK}`);
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		return { ok: true, skipped: false };
	} catch (err) {
		return isSqliteBusy(err)
			? { ok: true, skipped: true }
			: { ok: false, error: err instanceof Error ? err.message : String(err) };
	} finally {
		closeConnection(db);
	}
}

self.onmessage = (event: MessageEvent<IncrementalVacuumRequest>) => {
	const request = event.data;
	if (request.kind === "retire") {
		retired = true;
		if (retirementSafe) {
			self.postMessage({
				kind: "retired",
				generation: request.generation,
				closed: true,
			});
			self.close();
		}
		return;
	}
	if (retired || !retirementSafe) return;
	// Synchronous functions complete their finally-close before the result receipt.
	const result =
		request.kind === "optimize"
			? runOptimize(request.dbPath)
			: runIncrementalVacuum(
					request.dbPath,
					request.pages,
					request.synchronous,
				);
	self.postMessage({
		...result,
		generation: request.generation,
		jobId: request.jobId,
		closed: true,
	});
};
