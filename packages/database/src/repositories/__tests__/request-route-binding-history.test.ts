import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { DatabaseOperations } from "../../database-operations";
import { ensureSchema, runMigrations } from "../../migrations";
import { RequestRepository } from "../request.repository";

interface Row {
	id: string;
	startedAt: number;
	completedAt: number;
	sessionId?: string;
	clientSessionId?: string | null;
	apiKeyId?: string | null;
	accountUsed?: string | null;
	routeProfileId?: string | null;
	path?: string;
	internalOrigin?: number | null;
}

function userId(sessionId: string): string {
	return JSON.stringify({
		device_id: "device",
		account_uuid: "account",
		session_id: sessionId,
	});
}

async function insertRow(adapter: BunSqlAdapter, row: Row): Promise<void> {
	await adapter.run(
		`INSERT INTO requests (id, timestamp, method, path, account_used, response_time_ms,
			api_key_id, client_session_id, route_profile_id, internal_origin)
		 VALUES (?, ?, 'POST', ?, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			row.completedAt,
			row.path ?? "/v1/messages",
			row.accountUsed === undefined ? "account-1" : row.accountUsed,
			row.completedAt - row.startedAt,
			row.apiKeyId === undefined ? "key-1" : row.apiKeyId,
			row.clientSessionId === undefined
				? userId(row.sessionId ?? "session")
				: row.clientSessionId,
			row.routeProfileId ?? null,
			row.internalOrigin ?? null,
		],
	);
}

function sqliteAdapter(): BunSqlAdapter {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return new BunSqlAdapter(db);
}

async function withRepository(
	verify: (repo: RequestRepository, adapter: BunSqlAdapter) => Promise<void>,
): Promise<void> {
	const adapter = sqliteAdapter();
	try {
		await verify(new RequestRepository(adapter), adapter);
	} finally {
		await adapter.close();
	}
}

describe("route binding history", () => {
	test("keeps each session's newest committed row by start time, newest session first", async () => {
		await withRepository(async (repo, adapter) => {
			await insertRow(adapter, {
				id: "early-x",
				sessionId: "switched",
				routeProfileId: "x",
				startedAt: 1_500,
				completedAt: 1_600,
			});
			await insertRow(adapter, {
				id: "later-y",
				sessionId: "switched",
				routeProfileId: "y",
				startedAt: 2_500,
				completedAt: 2_600,
			});
			// A long request that started first but completed last does not
			// outrank the native switch that started after it.
			await insertRow(adapter, {
				id: "long-x",
				sessionId: "went-native",
				routeProfileId: "x",
				startedAt: 2_000,
				completedAt: 9_000,
			});
			await insertRow(adapter, {
				id: "native",
				sessionId: "went-native",
				routeProfileId: null,
				startedAt: 3_000,
				completedAt: 3_100,
			});
			await insertRow(adapter, {
				id: "other-key",
				sessionId: "switched",
				apiKeyId: "key-2",
				routeProfileId: "x",
				startedAt: 2_700,
				completedAt: 2_800,
			});

			expect(await repo.listRouteBindingSessionsSince(1_000, 10)).toEqual({
				sessions: [
					{
						apiKeyId: "key-2",
						sessionId: "switched",
						routeProfileId: "x",
						lastStartedAt: 2_700,
					},
					{
						apiKeyId: "key-1",
						sessionId: "switched",
						routeProfileId: "y",
						lastStartedAt: 2_500,
					},
				],
				capReached: false,
			});
		});
	});

	test("ignores rows that could not have committed or cannot be keyed", async () => {
		await withRepository(async (repo, adapter) => {
			await insertRow(adapter, {
				id: "bound",
				routeProfileId: "x",
				startedAt: 2_000,
				completedAt: 2_100,
			});
			const ignored: Row[] = [
				{ id: "no-account", routeProfileId: null, accountUsed: null },
				{
					id: "count",
					routeProfileId: null,
					path: "/v1/messages/count_tokens",
				},
				{ id: "internal", routeProfileId: null, internalOrigin: 1 },
				{ id: "no-key", routeProfileId: null, apiKeyId: null },
				{ id: "no-user", routeProfileId: null, clientSessionId: null },
				{ id: "bad-json", routeProfileId: null, clientSessionId: "{broken" },
				{
					id: "legacy-format",
					routeProfileId: null,
					clientSessionId: "user_abc_account_def_session_session",
				},
				{
					id: "numeric-session",
					routeProfileId: null,
					clientSessionId: '{"session_id":42}',
				},
			].map((row) => ({ ...row, startedAt: 3_000, completedAt: 3_100 }));
			for (const row of ignored) await insertRow(adapter, row);
			// Bound rows that cannot be keyed to a caller are not returned either.
			for (const apiKeyId of [null, ""]) {
				await insertRow(adapter, {
					id: `keyless-${apiKeyId}`,
					sessionId: "keyless",
					apiKeyId,
					routeProfileId: "x",
					startedAt: 2_500,
					completedAt: 2_600,
				});
			}
			await insertRow(adapter, {
				id: "before-window",
				sessionId: "stale",
				routeProfileId: "x",
				startedAt: 400,
				completedAt: 999,
			});
			await insertRow(adapter, {
				id: "empty-profile",
				sessionId: "blank",
				routeProfileId: "",
				startedAt: 2_000,
				completedAt: 2_100,
			});

			expect(await repo.listRouteBindingSessionsSince(1_000, 10)).toEqual({
				sessions: [
					{
						apiKeyId: "key-1",
						sessionId: "session",
						routeProfileId: "x",
						lastStartedAt: 2_000,
					},
				],
				capReached: false,
			});
		});
	});

	test("keeps a row that started before the window but completed inside it", async () => {
		await withRepository(async (repo, adapter) => {
			await insertRow(adapter, {
				id: "long",
				routeProfileId: "x",
				startedAt: 500,
				completedAt: 1_500,
			});
			expect(await repo.listRouteBindingSessionsSince(1_000, 10)).toEqual({
				sessions: [
					{
						apiKeyId: "key-1",
						sessionId: "session",
						routeProfileId: "x",
						lastStartedAt: 500,
					},
				],
				capReached: false,
			});
		});
	});

	test("returns the newest sessions up to the cap and reports overflow", async () => {
		await withRepository(async (repo, adapter) => {
			for (const [index, sessionId] of ["one", "two", "three"].entries()) {
				await insertRow(adapter, {
					id: sessionId,
					sessionId,
					routeProfileId: "x",
					startedAt: 2_000 + index,
					completedAt: 2_100 + index,
				});
			}
			const capped = await repo.listRouteBindingSessionsSince(1_000, 2);
			expect(capped.capReached).toBe(true);
			expect(capped.sessions.map((row) => row.sessionId)).toEqual([
				"three",
				"two",
			]);
			const exact = await repo.listRouteBindingSessionsSince(1_000, 3);
			expect(exact.capReached).toBe(false);
			expect(exact.sessions).toHaveLength(3);
		});
	});
});

test("route binding history is one off-thread read of limit + 1 rows over a timestamp range, never a table scan", async () => {
	const adapter = sqliteAdapter();
	const read = spyOn(adapter, "queryOffThread");
	try {
		await insertRow(adapter, {
			id: "bound",
			routeProfileId: "x",
			startedAt: 2_000,
			completedAt: 2_100,
		});
		await new RequestRepository(adapter).listRouteBindingSessionsSince(
			1_000,
			2,
		);
		expect(read).toHaveBeenCalledTimes(1);
		const [sql, params] = read.mock.calls[0];
		expect(params).toEqual([1_000, 3]);
		const plan = await adapter.query<{ detail: string }>(
			`EXPLAIN QUERY PLAN ${sql}`,
			params,
		);
		// Either timestamp-bearing index is a bounded range read; production's
		// planner picks the (api_key_id, timestamp) skip-scan.
		const requestsAccess = plan
			.map(({ detail }) => detail)
			.filter((detail) => /\brequests\b/.test(detail));
		expect(requestsAccess.length).toBeGreaterThan(0);
		for (const detail of requestsAccess) {
			expect(detail).toMatch(/^SEARCH requests USING .*INDEX .*timestamp>\?/);
		}
	} finally {
		read.mockRestore();
		await adapter.close();
	}
});

test("DatabaseOperations delegates the route binding history read", async () => {
	const db = new DatabaseOperations(":memory:", { walMode: false });
	try {
		await insertRow(db.getAdapter(), {
			id: "bound",
			routeProfileId: "x",
			startedAt: 2_000,
			completedAt: 2_100,
		});
		expect(await db.listRouteBindingSessionsSince(1_000, 5)).toEqual({
			sessions: [
				{
					apiKeyId: "key-1",
					sessionId: "session",
					routeProfileId: "x",
					lastStartedAt: 2_000,
				},
			],
			capReached: false,
		});
	} finally {
		await db.dispose();
	}
});
