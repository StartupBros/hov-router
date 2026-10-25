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
import type { APIContext } from "../../types";
import { createAnalyticsHandler } from "../analytics";

const HOUR = 60 * 60 * 1000;
let db: DatabaseOperations;
let clock: number;
let modelPerfCalls: { sql: string; params: unknown[] }[];

async function insertRequest(
	id: string,
	ageMs: number,
	model: string,
	responseTimeMs: number,
	success = true,
) {
	await db
		.getAdapter()
		.run(
			"INSERT INTO requests (id, timestamp, method, path, success, response_time_ms, failover_attempts, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			[
				id,
				clock - ageMs,
				"POST",
				"/v1/messages",
				success,
				responseTimeMs,
				0,
				model,
			],
		);
}

beforeEach(async () => {
	db = new DatabaseOperations(":memory:");
	clock = Date.now();
	spyOn(Date, "now").mockImplementation(() => clock);
	modelPerfCalls = [];
	const adapter = db.getAdapter();
	const query = adapter.query.bind(adapter);
	spyOn(adapter, "query").mockImplementation(((
		sql: string,
		params?: unknown[],
	) => {
		if (sql.includes("PERCENT_RANK"))
			modelPerfCalls.push({ sql, params: params ?? [] });
		return query(sql, params);
	}) as typeof adapter.query);

	for (let i = 1; i <= 20; i++)
		await insertRequest(`in-a-${i}`, i * 1000, "model-a", i * 100, i !== 20);
	await insertRequest("in-b-1", 2000, "model-b", 50);
	// Outside the 24h window: must not affect any model's figures.
	await insertRequest("old-a-1", 48 * HOUR, "model-a", 999_999, false);
	await insertRequest("old-c-1", 48 * HOUR, "model-c", 10);
});
afterEach(async () => {
	mock.restore();
	await db.close();
});

const analytics = () =>
	createAnalyticsHandler({ dbOps: db } as unknown as APIContext)(
		new URLSearchParams({ range: "24h" }),
	);

describe("analytics model performance", () => {
	it("aggregates only requests inside the selected window", async () => {
		const body = await (await analytics()).json();
		const byModel = Object.fromEntries(
			body.modelPerformance.map((m: { model: string }) => [m.model, m]),
		);

		expect(Object.keys(byModel).sort()).toEqual(["model-a", "model-b"]);
		expect(byModel["model-a"].avgResponseTime).toBe(1050);
		expect(byModel["model-a"].p95ResponseTime).toBe(2000);
		expect(byModel["model-a"].errorRate).toBe(5);
		expect(byModel["model-b"].avgResponseTime).toBe(50);
	});

	it("reads the window from the timestamp index instead of walking every model's history", async () => {
		await analytics();
		expect(modelPerfCalls).toHaveLength(1);
		const [{ sql, params }] = modelPerfCalls;
		const plan = (
			await db
				.getAdapter()
				.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params)
		)
			.map((row) => row.detail)
			.join("\n");

		expect(plan).not.toContain("idx_requests_response_time");
		expect(plan).toMatch(
			/SEARCH r USING (COVERING )?INDEX \S+ \(timestamp>\?\)/,
		);
	});
});
