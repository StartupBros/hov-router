/**
 * Retention sweeps must not hold the event loop for the whole sweep (#613).
 *
 * Each batched DELETE is a synchronous call on SQLite, so a loop that only
 * awaits microtasks between batches blocks timers, the WAL checkpoint job and
 * every request handler until the last batch returns. These tests drive the
 * real DatabaseOperations facade on an in-memory database with a tiny batch
 * size so every loop runs more than one batch.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { CleanupPacer } from "../cleanup-pacing";
import { DatabaseOperations } from "../database-operations";

const DAY = 24 * 60 * 60 * 1000;
const BATCH_ENV = "BETTER_CCFLARE_DB_CLEANUP_BATCH_SIZE";

let db: DatabaseOperations;
let savedBatchSize: string | undefined;

beforeEach(() => {
	savedBatchSize = process.env[BATCH_ENV];
	process.env[BATCH_ENV] = "2";
	db = new DatabaseOperations(":memory:", { walMode: false });
});

afterEach(async () => {
	if (savedBatchSize === undefined) delete process.env[BATCH_ENV];
	else process.env[BATCH_ENV] = savedBatchSize;
	await db.close();
});

async function run(sql: string, params: unknown[]): Promise<void> {
	await db.getAdapter().run(sql, params);
}

async function count(table: string): Promise<number> {
	const row = await db
		.getAdapter()
		.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
	return Number(row?.n ?? 0);
}

async function seedRequests(n: number, timestamp: number, withPayload = false) {
	for (let i = 0; i < n; i++) {
		const id = `req-${timestamp}-${i}`;
		await run(
			`INSERT INTO requests (id, timestamp, method, path, success, response_time_ms, failover_attempts)
			 VALUES (?, ?, 'POST', '/v1/messages', TRUE, 1, 0)`,
			[id, timestamp],
		);
		if (withPayload) {
			await run(
				"INSERT INTO request_payloads (id, json, timestamp) VALUES (?, '{}', ?)",
				[id, timestamp],
			);
		}
	}
}

// Orphans predate the foreign key, so seeding one has to bypass it.
async function seedOrphanPayloads(n: number, timestamp: number) {
	await run("PRAGMA foreign_keys = OFF", []);
	for (let i = 0; i < n; i++) {
		await run(
			"INSERT INTO request_payloads (id, json, timestamp) VALUES (?, '{}', ?)",
			[`orphan-${i}`, timestamp],
		);
	}
	await run("PRAGMA foreign_keys = ON", []);
}

async function seedRoutingAttempts(n: number, timestamp: number) {
	for (let i = 0; i < n; i++) {
		await run(
			`INSERT INTO routing_attempts (
				id, parent_request_id, timestamp, provider, account_id, attempted_model,
				model_family, status_code, reason, scope, available_at,
				failover_attempts, physical_attempt, account_benched, route_suppressed,
				circuit_counted
			) VALUES (?, 'missing-parent', ?, 'anthropic', 'account', 'claude-opus-4',
				'opus', 429, 'model_scoped_429', 'model', NULL, 0, NULL, 0, 1, 0)`,
			[`attempt-${i}`, timestamp],
		);
	}
}

async function seedSnapshots(n: number, timestamp: number) {
	for (let i = 0; i < n; i++) {
		await run(
			`INSERT INTO usage_snapshots (account_id, timestamp, window_key, utilization, resets_at)
			 VALUES (?, ?, 'five_hour', 42.5, NULL)`,
			[`account-${i}`, timestamp],
		);
	}
}

/** Records every pacer call; refuses batches once `refuseAfter` batches ran. */
function recordingPacer(refuseAfter = Number.POSITIVE_INFINITY) {
	const calls: string[] = [];
	let batches = 0;
	let refused = false;
	const pacer: CleanupPacer = {
		mayRunBatch(table) {
			if (refused || batches >= refuseAfter) {
				refused = true;
				calls.push(`refuse ${table}`);
				return false;
			}
			batches++;
			calls.push(`run ${table}`);
			return true;
		},
		async afterBatch(table, batchMs) {
			expect(batchMs).toBeGreaterThanOrEqual(0);
			calls.push(`pause ${table}`);
		},
	};
	return { pacer, calls };
}

describe("retention sweep yields between batches (#613)", () => {
	it("lets a timer scheduled before cleanupOldRequests fire before the sweep returns", async () => {
		const old = Date.now() - 100 * DAY;
		await seedRequests(5, old, true);
		await seedRoutingAttempts(5, old);

		let timerFired = false;
		setTimeout(() => {
			timerFired = true;
		}, 0);
		const result = await db.cleanupOldRequests(DAY, DAY);
		const firedBeforeReturn = timerFired;

		expect(result).toEqual({
			removedRequests: 5,
			removedPayloads: 5,
			removedRoutingAttempts: 5,
		});
		expect(firedBeforeReturn).toBe(true);
	});

	it("lets a timer scheduled before pruneUsageSnapshots fire before it returns", async () => {
		await seedSnapshots(5, Date.now() - 100 * DAY);

		let timerFired = false;
		setTimeout(() => {
			timerFired = true;
		}, 0);
		const removed = await db.pruneUsageSnapshots(Date.now() - DAY);
		const firedBeforeReturn = timerFired;

		expect(removed).toBe(5);
		expect(firedBeforeReturn).toBe(true);
	});
});

describe("retention sweep pacer", () => {
	it("is consulted before every batch and paused after every full batch of all five loops", async () => {
		const old = Date.now() - 100 * DAY;
		await seedRequests(3, old, true);
		await seedOrphanPayloads(3, Date.now());
		await seedRoutingAttempts(3, old);
		await seedSnapshots(3, old);
		const { pacer, calls } = recordingPacer();

		const result = await db.cleanupOldRequests(DAY, DAY, pacer);
		const removedSnapshots = await db.pruneUsageSnapshots(
			Date.now() - DAY,
			pacer,
		);

		expect(result).toEqual({
			removedRequests: 3,
			removedPayloads: 6,
			removedRoutingAttempts: 3,
		});
		expect(removedSnapshots).toBe(3);
		// Batch size 2 over 3 rows: a full batch, a pause, then a short batch.
		const perTable = (table: string) => [
			`run ${table}`,
			`pause ${table}`,
			`run ${table}`,
		];
		expect(calls).toEqual([
			...perTable("request_payloads"),
			...perTable("orphaned_payloads"),
			...perTable("requests"),
			...perTable("routing_attempts"),
			...perTable("usage_snapshots"),
		]);
	});

	it("stops the sweep with partial counts when it refuses, and the next sweep continues", async () => {
		const old = Date.now() - 100 * DAY;
		await seedRequests(5, old);
		await seedRoutingAttempts(3, old);
		// Payload loops run one empty batch each, then requests gets one batch.
		const { pacer, calls } = recordingPacer(3);

		const stopped = await db.cleanupOldRequests(DAY, DAY, pacer);

		expect(stopped).toEqual({
			removedRequests: 2,
			removedPayloads: 0,
			removedRoutingAttempts: 0,
		});
		expect(calls).toEqual([
			"run request_payloads",
			"run orphaned_payloads",
			"run requests",
			"pause requests",
			"refuse requests",
			"refuse routing_attempts",
		]);
		expect(await count("requests")).toBe(3);
		expect(await count("routing_attempts")).toBe(3);

		const next = await db.cleanupOldRequests(DAY, DAY);

		expect(next).toEqual({
			removedRequests: 3,
			removedPayloads: 0,
			removedRoutingAttempts: 3,
		});
		expect(await count("requests")).toBe(0);
	});

	it("runs no batch at all when it refuses up front", async () => {
		await seedSnapshots(3, Date.now() - 100 * DAY);
		const { pacer, calls } = recordingPacer(0);

		const removed = await db.pruneUsageSnapshots(Date.now() - DAY, pacer);

		expect(removed).toBe(0);
		expect(calls).toEqual(["refuse usage_snapshots"]);
		expect(await count("usage_snapshots")).toBe(3);
	});
});
