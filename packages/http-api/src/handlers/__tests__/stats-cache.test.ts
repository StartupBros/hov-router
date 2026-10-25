import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { DatabaseOperations } from "@better-ccflare/database";
import {
	createRecentErrorsHandler,
	createStatsHandler,
	createStatsResetHandler,
} from "../stats";

const url = (query = "") => new URL(`http://localhost/api/stats${query}`);
let db: DatabaseOperations;
let clock: number;

beforeEach(async () => {
	db = new DatabaseOperations(":memory:");
	clock = Date.now();
	spyOn(Date, "now").mockImplementation(() => clock);
	await db
		.getAdapter()
		.run(
			"INSERT INTO requests (id, timestamp, method, path, success, response_time_ms, failover_attempts, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			[
				"recent",
				clock - 1000,
				"POST",
				"/v1/messages",
				true,
				12,
				0,
				"test-model",
			],
		);
});
afterEach(async () => {
	mock.restore();
	await db.close();
});

describe("stats caching and database invalidation", () => {
	it("deduplicates concurrent and sequential loads with independent response bodies", async () => {
		const load = spyOn(db.getStatsRepository(), "getAggregatedStats");
		const handler = createStatsHandler(db);
		const responses = await Promise.all([
			handler(url()),
			handler(url()),
			handler(url()),
		]);
		for (const response of responses)
			expect((await response.json()).totalRequests).toBe(1);
		expect((await (await handler(url())).json()).totalRequests).toBe(1);
		expect(load).toHaveBeenCalledTimes(1);
	});
	it("shares a cache only among handlers for the same database", async () => {
		const load = spyOn(db.getStatsRepository(), "getAggregatedStats");
		await createStatsHandler(db)(url());
		await createStatsHandler(db)(url());
		expect(load).toHaveBeenCalledTimes(1);
		const other = new DatabaseOperations(":memory:");
		try {
			expect(
				(await (await createStatsHandler(other)(url())).json()).totalRequests,
			).toBe(0);
		} finally {
			await other.close();
		}
	});
	it("normalizes equivalent parameters and keeps different windows separate", async () => {
		const load = spyOn(db.getStatsRepository(), "getAggregatedStats");
		const handler = createStatsHandler(db);
		await handler(url());
		await handler(url("?since=invalid&errorsSinceHours=-1"));
		expect(load).toHaveBeenCalledTimes(1);
		await handler(url("?since=7"));
		await handler(url("?since=7&errorsSinceHours=48"));
		expect(load).toHaveBeenCalledTimes(3);
	});
	it("expires after ten seconds and keeps account and model counts lifetime", async () => {
		await db
			.getAdapter()
			.run(
				"INSERT INTO requests (id, timestamp, method, path, success, response_time_ms, failover_attempts, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				[
					"old",
					clock - 90 * 86400000,
					"POST",
					"/v1/messages",
					true,
					12,
					0,
					"old-model",
				],
			);
		const load = spyOn(db.getStatsRepository(), "getAggregatedStats");
		const handler = createStatsHandler(db);
		const body = await (await handler(url("?since=7"))).json();
		expect(body.totalRequests).toBe(1);
		expect(body.accounts[0].requestCount).toBe(2);
		expect(
			body.topModels.map((model: { model: string }) => model.model).sort(),
		).toEqual(["old-model", "test-model"]);
		clock += 9999;
		await handler(url("?since=7"));
		expect(load).toHaveBeenCalledTimes(1);
		clock++;
		await handler(url("?since=7"));
		expect(load).toHaveBeenCalledTimes(2);
	});
	it("does not cache a failed load", async () => {
		const load = spyOn(
			db.getStatsRepository(),
			"getAggregatedStats",
		).mockRejectedValueOnce(new Error("query failed"));
		const handler = createStatsHandler(db);
		await expect(handler(url())).rejects.toThrow("query failed");
		expect((await (await handler(url())).json()).totalRequests).toBe(1);
		expect(load).toHaveBeenCalledTimes(2);
	});
	it("invalidates after retention but not a no-op or payload-only cleanup", async () => {
		const load = spyOn(db.getStatsRepository(), "getAggregatedStats");
		const handler = createStatsHandler(db);
		await handler(url());
		await db.cleanupOldRequests(0);
		await handler(url());
		await db.cleanupOldRequests(0, 86400000);
		await handler(url());
		expect(load).toHaveBeenCalledTimes(1);
		await db.cleanupOldRequests(0, 0);
		expect((await (await handler(url())).json()).totalRequests).toBe(0);
		expect(load).toHaveBeenCalledTimes(2);
	});
	it("invalidates after the atomic reset and does not invalidate a rolled-back reset", async () => {
		const adapter = db.getAdapter();
		await adapter.run(
			"CREATE TRIGGER fail_reset BEFORE DELETE ON routing_attempts BEGIN SELECT RAISE(ABORT, 'reset failed'); END",
		);
		await adapter.run(
			"INSERT INTO routing_attempts (id, parent_request_id, timestamp, provider, account_id, status_code, reason, scope, failover_attempts, account_benched, route_suppressed, circuit_counted) VALUES ('attempt', 'recent', ?, 'fixture', 'account', 429, 'model_scoped_429', 'model', 0, 0, 1, 0)",
			[clock],
		);
		const load = spyOn(db.getStatsRepository(), "getAggregatedStats");
		const handler = createStatsHandler(db);
		await handler(url());
		await expect(createStatsResetHandler(db)()).rejects.toThrow("reset failed");
		expect((await (await handler(url())).json()).totalRequests).toBe(1);
		expect(load).toHaveBeenCalledTimes(1);
		await adapter.run("DROP TRIGGER fail_reset");
		await createStatsResetHandler(db)();
		expect((await (await handler(url())).json()).totalRequests).toBe(0);
		expect(
			await adapter.get("SELECT COUNT(*) AS n FROM routing_attempts"),
		).toEqual({ n: 0 });
		expect(load).toHaveBeenCalledTimes(2);
	});
});

describe("recent error groups on their own route", () => {
	const errorsUrl = (query = "") =>
		new URL(`http://localhost/api/stats/recent-errors${query}`);
	const insertError = (id: string, ageMs: number, message: string) =>
		db
			.getAdapter()
			.run(
				"INSERT INTO requests (id, timestamp, method, path, success, response_time_ms, failover_attempts, model, error_message, status_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					id,
					clock - ageMs,
					"POST",
					"/v1/messages",
					false,
					12,
					0,
					"test-model",
					message,
					529,
				],
			);
	const codes = async (response: Response) =>
		(
			(await response.json()) as { recentErrors: { errorCode: string }[] }
		).recentErrors.map((group) => group.errorCode);

	beforeEach(async () => {
		await insertError("fresh", 60_000, "overloaded");
		await insertError("stale", 3 * 86400000, "rate_limited");
	});

	it("returns only the error groups inside the requested window", async () => {
		const handler = createRecentErrorsHandler(db);
		expect(await codes(await handler(errorsUrl()))).toEqual(["overloaded"]);
		expect(
			await codes(await handler(errorsUrl("?errorsSinceHours=168"))),
		).toEqual(["overloaded", "rate_limited"]);
	});

	it("skips the lifetime account, model and aggregate queries", async () => {
		const repository = db.getStatsRepository();
		const heavy = [
			spyOn(repository, "getAggregatedStats"),
			spyOn(repository, "getAccountStats"),
			spyOn(repository, "getTopModels"),
			spyOn(repository, "getActiveAccountCount"),
		];
		await createRecentErrorsHandler(db)(errorsUrl("?errorsSinceHours=168"));
		for (const spy of heavy) expect(spy).not.toHaveBeenCalled();
	});

	it("caches per normalized window and clears when requests are deleted", async () => {
		const load = spyOn(db.getStatsRepository(), "getRecentErrorGroups");
		const handler = createRecentErrorsHandler(db);
		await handler(errorsUrl());
		await handler(errorsUrl("?errorsSinceHours=-1"));
		await handler(errorsUrl("?errorsSinceHours=24"));
		expect(load).toHaveBeenCalledTimes(1);
		await handler(errorsUrl("?errorsSinceHours=99999"));
		await handler(errorsUrl("?errorsSinceHours=8760"));
		expect(load).toHaveBeenCalledTimes(2);
		await db.cleanupOldRequests(0, 0);
		expect(await codes(await handler(errorsUrl()))).toEqual([]);
		expect(load).toHaveBeenCalledTimes(3);
	});
});
