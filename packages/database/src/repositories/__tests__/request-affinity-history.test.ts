import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import "@better-ccflare/core";
import { attemptRequest } from "../../__tests__/route-provenance.fixture";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { DatabaseOperations } from "../../database-operations";
import { ensureSchema, runMigrations } from "../../migrations";
import { RequestRepository } from "../request.repository";

const newest = '{"affinityLane":{"digest":"newest"}}';
const boundary = '{"affinityLane":{"digest":"boundary"}}';
const oldest = '{"affinityLane":{"digest":"oldest"}}';

async function insertSummary(
	adapter: BunSqlAdapter,
	id: string,
	timestamp: number,
	summary: string | null,
): Promise<void> {
	await adapter.run(
		"INSERT INTO requests (id, timestamp, method, path, routing_attempt_summary) VALUES (?, ?, 'POST', '/v1/messages', ?)",
		[id, timestamp, summary],
	);
}

function sqliteAdapter(): BunSqlAdapter {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return new BunSqlAdapter(db);
}

async function withRepository(
	_backend: "SQLite",
	verify: (repo: RequestRepository, adapter: BunSqlAdapter) => Promise<void>,
): Promise<void> {
	const adapter = sqliteAdapter();
	try {
		await verify(new RequestRepository(adapter), adapter);
	} finally {
		await adapter.close();
	}
}

for (const backend of ["SQLite"] as const) {
	describe(`${backend} affinity history`, () => {
		test("returns only literal-key summaries inside the inclusive window, newest first", async () => {
			await withRepository(backend, async (repo, adapter) => {
				// Deliberately insert out of order and exercise the exact boundary.
				await insertSummary(adapter, "boundary", 1000, boundary);
				await insertSummary(adapter, "too-old", 999, oldest);
				await insertSummary(adapter, "newest", 3000, newest);
				await insertSummary(adapter, "null", 5000, null);
				await insertSummary(adapter, "no-block", 4000, '{"version":1}');
				await insertSummary(adapter, "unquoted", 4500, "affinityLane");
				await insertSummary(adapter, "wrong-case", 4600, '{"affinitylane":{}}');
				expect(await repo.listAffinityLaneSummariesSince(1000, 10)).toEqual({
					summaries: [newest, boundary],
					capReached: false,
				});
			});
		});

		test("returns exactly the cap with overflow, but reports no overflow at the exact cap or for an empty read", async () => {
			await withRepository(backend, async (repo, adapter) => {
				await insertSummary(adapter, "oldest", 1000, oldest);
				await insertSummary(adapter, "boundary", 2000, boundary);
				await insertSummary(adapter, "newest", 3000, newest);
				expect(await repo.listAffinityLaneSummariesSince(1000, 2)).toEqual({
					summaries: [newest, boundary],
					capReached: true,
				});
				expect(await repo.listAffinityLaneSummariesSince(2000, 2)).toEqual({
					summaries: [newest, boundary],
					capReached: false,
				});
				expect(await repo.listAffinityLaneSummariesSince(4000, 2)).toEqual({
					summaries: [],
					capReached: false,
				});
			});
		});

		test("returns malformed summary text containing the literal key without parsing it", async () => {
			await withRepository(backend, async (repo, adapter) => {
				const malformed = '{"affinityLane":broken';
				await insertSummary(adapter, "malformed", 2000, malformed);
				expect(await repo.listAffinityLaneSummariesSince(1000, 10)).toEqual({
					summaries: [malformed],
					capReached: false,
				});
			});
		});

		test("includes a request started before the TTL when save refreshes its row timestamp", async () => {
			await withRepository(backend, async (repo, adapter) => {
				const savedAt = 1_800_000_000_000;
				const ttl = 5 * 60 * 60 * 1000;
				const startedAt = savedAt - ttl - 1000;
				// U4 is independent of U2's sanitizer: seed the raw lane record,
				// then exercise the real save/upsert that preserves it.
				await insertSummary(adapter, attemptRequest.id, startedAt, oldest);
				expect(
					await repo.listAffinityLaneSummariesSince(savedAt - ttl, 10),
				).toEqual({ summaries: [], capReached: false });
				const clock = spyOn(Date, "now").mockReturnValue(savedAt);
				try {
					await repo.save({
						...attemptRequest,
						responseTime: savedAt - startedAt,
					});
				} finally {
					clock.mockRestore();
				}
				expect(
					await repo.listAffinityLaneSummariesSince(savedAt - ttl, 10),
				).toEqual({ summaries: [oldest], capReached: false });
			});
		});
	});
}

test("SQLite performs one off-thread read of limit + 1 rows using idx_requests_timestamp", async () => {
	const adapter = sqliteAdapter();
	const read = spyOn(adapter, "queryOffThread");
	try {
		await insertSummary(adapter, "newest", 3000, newest);
		expect(
			await new RequestRepository(adapter).listAffinityLaneSummariesSince(
				1000,
				2,
			),
		).toEqual({ summaries: [newest], capReached: false });
		expect(read).toHaveBeenCalledTimes(1);
		const [sql, params] = read.mock.calls[0];
		expect(params).toContain(1000);
		expect(params?.at(-1)).toBe(3);
		const plan = await adapter.query<{ detail: string }>(
			`EXPLAIN QUERY PLAN ${sql}`,
			params,
		);
		expect(
			plan.some(({ detail }) =>
				/USING INDEX idx_requests_timestamp \(/.test(detail),
			),
		).toBe(true);
		expect(sql).not.toMatch(/json_extract|::jsonb|count\(/i);
	} finally {
		read.mockRestore();
		await adapter.close();
	}
});

test("DatabaseOperations delegates the bounded history read", async () => {
	const db = new DatabaseOperations(":memory:", { walMode: false });
	try {
		await insertSummary(db.getAdapter(), "oldest", 1000, oldest);
		await insertSummary(db.getAdapter(), "newest", 3000, newest);
		expect(await db.listAffinityLaneSummariesSince(1000, 1)).toEqual({
			summaries: [newest],
			capReached: true,
		});
	} finally {
		await db.dispose();
	}
});
