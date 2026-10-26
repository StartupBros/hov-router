import type {
	CleanupPacer,
	DatabaseOperations,
} from "@better-ccflare/database";
import type { Logger } from "@better-ccflare/logger";

/**
 * Wall-clock budget for one periodic or startup retention sweep (#613). A
 * backlog larger than one budget is finished by the following hourly sweeps.
 */
export const RETENTION_SWEEP_BUDGET_MS = 30_000;
/**
 * Shortest pause between batches. SQLite's default busy handler polls for the
 * write lock at most every 100 ms, so a longer gap lets a writer in another
 * process (the retiring backend during an overlap handoff) get in.
 */
export const RETENTION_PAUSE_MIN_MS = 150;
/** A slow batch earns a proportionally longer pause, up to the cap. */
export const RETENTION_PAUSE_BATCH_RATIO = 5;
export const RETENTION_PAUSE_MAX_MS = 2_000;

export function retentionPauseMs(batchMs: number): number {
	return Math.min(
		RETENTION_PAUSE_MAX_MS,
		Math.max(RETENTION_PAUSE_MIN_MS, batchMs * RETENTION_PAUSE_BATCH_RATIO),
	);
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
export function sleepUnlessAborted(
	ms: number,
	signal: AbortSignal,
): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

export interface RetentionSweepClock {
	now(): number;
	sleep(ms: number, signal: AbortSignal): Promise<void>;
}

const systemClock: RetentionSweepClock = {
	now: () => performance.now(),
	sleep: sleepUnlessAborted,
};

export type RetentionSweepStop = "budget" | "stopped";

/**
 * Paces one sweep: a real pause after every full batch, and a refusal once the
 * budget is spent or the backend is told to stop. A refusal is sticky, so every
 * table after the one it happened in runs no batch at all.
 */
export class RetentionSweepPacer implements CleanupPacer {
	stoppedBy: RetentionSweepStop | null = null;
	stoppedIn: string | null = null;
	readonly budgetMs: number;
	private readonly deadline: number;

	constructor(
		private readonly signal: AbortSignal,
		budgetMs: number,
		private readonly clock: RetentionSweepClock = systemClock,
	) {
		this.budgetMs = budgetMs;
		this.deadline = clock.now() + budgetMs;
	}

	mayRunBatch(table: string): boolean {
		if (this.stoppedBy) return false;
		if (this.signal.aborted) this.stoppedBy = "stopped";
		else if (this.clock.now() >= this.deadline) this.stoppedBy = "budget";
		else return true;
		this.stoppedIn = table;
		return false;
	}

	afterBatch(_table: string, batchMs: number): Promise<void> {
		return this.clock.sleep(retentionPauseMs(batchMs), this.signal);
	}
}

/** One log line for a sweep that ended before its backlog did, else null. */
export function describeRetentionSweepStop(
	pacer: RetentionSweepPacer,
): string | null {
	if (pacer.stoppedBy === "budget") {
		return `Retention sweep used its ${pacer.budgetMs}ms budget in ${pacer.stoppedIn}; the next sweep continues`;
	}
	if (pacer.stoppedBy === "stopped") {
		return `Retention sweep stopped in ${pacer.stoppedIn}: backend is shutting down`;
	}
	return null;
}

/**
 * Owns the periodic and startup retention sweeps. Each sweep gets a fresh
 * budget; stop() ends every sweep at its next batch boundary and resolves once
 * they have returned, so quiesce and shutdown never close the database under a
 * batch. Stopping is one-way, like quiesce and shutdown themselves.
 */
export class RetentionSweeps {
	private readonly abort = new AbortController();
	private readonly inFlight = new Set<Promise<void>>();

	constructor(
		private readonly budgetMs = RETENTION_SWEEP_BUDGET_MS,
		private readonly clock: RetentionSweepClock = systemClock,
	) {}

	run<T>(sweep: (pacer: RetentionSweepPacer) => Promise<T>): Promise<T> {
		const pacer = new RetentionSweepPacer(
			this.abort.signal,
			this.budgetMs,
			this.clock,
		);
		const running = sweep(pacer);
		const settled = running.then(
			() => {},
			() => {},
		);
		this.inFlight.add(settled);
		void settled.then(() => this.inFlight.delete(settled));
		return running;
	}

	async stop(): Promise<void> {
		this.abort.abort();
		await Promise.all(this.inFlight);
	}
}

export interface RetentionCleanupResult {
	removedRequests: number;
	removedPayloads: number;
	removedRoutingAttempts: number;
}

/**
 * Logs a retention sweep and starts page reclamation when any retained data was
 * removed. Kept separate from the server lifecycle so attempt-only sweeps are
 * covered without booting a server.
 */
export function scheduleAdaptiveVacuumAfterRetentionCleanup(
	result: RetentionCleanupResult,
	dbOps: Pick<DatabaseOperations, "incrementalVacuumAdaptive">,
	log: Pick<Logger, "info" | "error">,
	durationMs: number,
): boolean {
	const { removedRequests, removedPayloads, removedRoutingAttempts } = result;
	if (
		removedRequests === 0 &&
		removedPayloads === 0 &&
		removedRoutingAttempts === 0
	) {
		return false;
	}

	log.info(
		`Periodic cleanup: removed ${removedRequests} requests, ${removedPayloads} payloads, ${removedRoutingAttempts} routing attempts in ${durationMs}ms`,
	);
	void dbOps
		.incrementalVacuumAdaptive()
		.then((vacuumResult) => {
			if (vacuumResult.reclaimedPages > 0) {
				log.info(
					`Adaptive incremental vacuum reclaimed ${vacuumResult.reclaimedPages} pages in ${vacuumResult.chunks} chunk(s)`,
				);
			}
		})
		.catch((err) => {
			log.error(`Incremental vacuum error: ${err}`);
		});
	return true;
}
