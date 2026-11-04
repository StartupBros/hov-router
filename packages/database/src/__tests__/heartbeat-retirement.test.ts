import { describe, expect, it } from "bun:test";
import type { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { startHeartbeatLoop } from "../multi-instance-guard";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function turns() {
	await new Promise<void>((resolve) => setTimeout(resolve, 5));
}
/**
 * The --serve adapter with its writer thread attached: heartbeat writes and the
 * retirement DELETE both go through `run`, and the writer executes them one at
 * a time in posting order. `execute` sees a statement when it starts running,
 * not when it is posted.
 */
function writerAdapter(execute: (sql: string) => Promise<void>): BunSqlAdapter {
	let queue: Promise<void> = Promise.resolve();
	return {
		writerAttached: () => true,
		run: (sql: string) => {
			const job = queue.then(() => execute(sql));
			queue = job.catch(() => {});
			return job;
		},
	} as unknown as BunSqlAdapter;
}

describe("heartbeat loop retirement", () => {
	it("holds a pending cleanup and shares the same failed stop without repeating it", async () => {
		const clearing = deferred();
		let calls = 0;
		const adapter = writerAdapter(async () => {
			calls++;
			await clearing.promise;
		});
		const stop = startHeartbeatLoop(adapter, {
			intervalMs: 100_000,
			settlementTimeoutMs: 10,
		});
		const stopped = stop();
		try {
			await expect(stopped).rejects.toThrow("heartbeat retirement unconfirmed");
			expect(stop()).toBe(stopped);
			expect(calls).toBe(1);
		} finally {
			clearing.resolve();
			await stopped.catch(() => {});
		}
	});
	it("serializes ticks and waits for an in-flight write before deleting its row", async () => {
		const writing = deferred();
		const calls: string[] = [];
		const adapter = writerAdapter(async (sql: string) => {
			calls.push(sql.startsWith("DELETE") ? "delete" : "write");
			if (!sql.startsWith("DELETE")) await writing.promise;
		});
		const stop = startHeartbeatLoop(adapter, { intervalMs: 1 });
		try {
			await turns();
			expect(calls).toEqual(["write"]);
			const stopped = stop();
			expect(stop()).toBe(stopped);
			await turns();
			expect(calls).toEqual(["write"]);
			writing.resolve();
			await stopped;
			expect(calls).toEqual(["write", "delete"]);
			await turns();
			expect(calls).toHaveLength(2);
		} finally {
			writing.resolve();
			await stop();
		}
	});
	it("starts no tick while its owner is closing", async () => {
		let closing = true;
		const calls: string[] = [];
		const adapter = writerAdapter(async (sql: string) => {
			calls.push(sql.startsWith("DELETE") ? "delete" : "write");
		});
		const stop = startHeartbeatLoop(adapter, {
			intervalMs: 1,
			isClosing: () => closing,
		});
		try {
			await turns();
			expect(calls).toEqual([]);
			closing = false;
			await turns();
			expect(calls).toContain("write");
		} finally {
			await stop();
		}
	});
	it("holds unresolved write ownership after its finite stop budget", async () => {
		const writing = deferred();
		const calls: string[] = [];
		const adapter = writerAdapter(async (sql: string) => {
			calls.push(sql.startsWith("DELETE") ? "delete" : "write");
			if (!sql.startsWith("DELETE")) await writing.promise;
		});
		const stop = startHeartbeatLoop(adapter, {
			intervalMs: 1,
			settlementTimeoutMs: 10,
		});
		await turns();
		try {
			await expect(stop()).rejects.toThrow("heartbeat retirement unconfirmed");
			expect(calls).toEqual(["write"]);
		} finally {
			writing.resolve();
			await stop().catch(() => {});
		}
	});
});
