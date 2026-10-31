/**
 * Pins the analytics totals CTE (`filtered_requests`) on a seeded database.
 * The CTE selects only the columns the aggregates read; the filters in
 * `whereClause` run against `requests r` inside the CTE, so they do not
 * depend on the CTE's column list. These expectations hold before and after
 * narrowing the CTE from `SELECT *`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@better-ccflare/database";
import type { APIContext } from "../../types";
import { createAnalyticsHandler } from "../analytics";

type Body = {
	totals: Record<string, number | null>;
	tokenBreakdown: Record<string, number>;
};

describe("analytics totals on a seeded database", () => {
	let dbOps: DatabaseOperations;

	beforeEach(async () => {
		dbOps = new DatabaseOperations(
			join(tmpdir(), `test-analytics-${randomBytes(6).toString("hex")}.db`),
		);
		const adapter = dbOps.getAdapter();
		const ts = Date.now() - 60_000;
		const rows: Array<
			[
				string,
				string | null,
				number,
				number,
				number,
				number,
				string,
				number | null,
				number,
				number,
				number,
				number,
				string,
			]
		> = [
			// id, account, success, rt, total_tokens, cost, billing, tps, in, cr, cc, out, model
			["r1", "acct-a", 1, 100, 30, 0.5, "plan", 10, 10, 5, 5, 10, "m-a"],
			["r2", "acct-b", 1, 200, 60, 1.5, "api", 20, 20, 10, 10, 20, "m-b"],
			["r3", null, 0, 300, 0, 0.25, "api", null, 0, 0, 0, 0, "m-a"],
		];
		for (const r of rows) {
			await adapter.run(
				`INSERT INTO requests (id, timestamp, method, path, account_used, success, response_time_ms,
					total_tokens, cost_usd, billing_type, output_tokens_per_second,
					input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens, model)
				 VALUES (?, ?, 'POST', '/v1/messages', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[r[0], ts, ...r.slice(1)],
			);
		}
	});

	afterEach(() => {
		dbOps.dispose?.();
	});

	function call(query: Record<string, string>): Promise<Body> {
		const handler = createAnalyticsHandler({
			db: {} as APIContext["db"],
			config: {} as APIContext["config"],
			dbOps,
		} as APIContext);
		return handler(new URLSearchParams({ range: "24h", ...query })).then(
			(res) => res.json() as Promise<Body>,
		);
	}

	it("returns the expected totals and token breakdown", async () => {
		const body = await call({});

		expect(body.totals.requests).toBe(3);
		expect(body.totals.successRate).toBeCloseTo(200 / 3, 6);
		expect(body.totals.activeAccounts).toBe(3);
		expect(body.totals.avgResponseTime).toBe(200);
		expect(body.totals.totalTokens).toBe(90);
		expect(body.totals.totalCostUsd).toBeCloseTo(2.25, 9);
		expect(body.totals.planCostUsd).toBeCloseTo(0.5, 9);
		expect(body.totals.apiCostUsd).toBeCloseTo(1.75, 9);
		expect(body.totals.avgTokensPerSecond).toBe(15);
		expect(body.tokenBreakdown.inputTokens).toBe(30);
		expect(body.tokenBreakdown.cacheReadInputTokens).toBe(15);
		expect(body.tokenBreakdown.cacheCreationInputTokens).toBe(15);
		expect(body.tokenBreakdown.outputTokens).toBe(30);
	});

	it("applies a model and status filter that reference columns outside the CTE select list", async () => {
		const body = await call({ models: "m-a", status: "success" });

		expect(body.totals.requests).toBe(1);
		expect(body.totals.successRate).toBe(100);
		expect(body.totals.avgResponseTime).toBe(100);
		expect(body.totals.totalTokens).toBe(30);
		expect(body.totals.totalCostUsd).toBeCloseTo(0.5, 9);
		expect(body.totals.planCostUsd).toBeCloseTo(0.5, 9);
		expect(body.totals.apiCostUsd).toBe(0);
		expect(body.tokenBreakdown.outputTokens).toBe(10);
	});
});
