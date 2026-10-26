/**
 * Paces a batched retention delete (#613).
 *
 * On SQLite every batch is a synchronous statement on the main thread, and
 * awaiting it resolves as a microtask, so a loop that only awaits its batches
 * holds the event loop until the last one returns. A backlog of a million rows
 * froze the server for two minutes that way, starving request handlers and the
 * WAL checkpoint job, and another process waiting for the write lock (a
 * retiring backend during an overlap handoff) could not get in between
 * batches that were a millisecond apart.
 */
export interface CleanupPacer {
	/** Checked before every batch, including a table's first; false ends the loop. */
	mayRunBatch(table: string): boolean;
	/** Awaited after a full batch, before the next one. */
	afterBatch(table: string, batchMs: number): Promise<void>;
}

/** A macrotask boundary: timers and I/O callbacks run before it resolves. */
function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Runs `runBatch` until it deletes fewer than `batchSize` rows or the pacer
 * refuses. Without a pacer it still yields a macrotask between batches, so a
 * manual or CLI cleanup finishes the whole backlog without freezing the loop.
 */
export async function deleteInBatches(
	table: string,
	batchSize: number,
	runBatch: () => Promise<number>,
	pacer?: CleanupPacer,
): Promise<number> {
	let total = 0;
	while (!pacer || pacer.mayRunBatch(table)) {
		const started = performance.now();
		const deleted = await runBatch();
		total += deleted;
		if (deleted !== batchSize) break;
		if (pacer) await pacer.afterBatch(table, performance.now() - started);
		else await yieldToEventLoop();
	}
	return total;
}
