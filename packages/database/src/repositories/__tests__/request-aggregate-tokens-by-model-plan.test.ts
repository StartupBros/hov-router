/**
 * Query-plan test for RequestRepository.aggregateTokensByModel (issue #710).
 *
 * The periodic `PRAGMA optimize` runs ANALYZE with `analysis_limit = 400`
 * (incremental-vacuum-worker.ts). Sampling ~400 rows of an index whose leading
 * column has few distinct values sees only one value, so production's
 * sqlite_stat1 records 401 rows per `billing_type` value, the same figure it
 * records per `account_used` value. With those statistics the planner answers
 * the per-account window query from idx_requests_billing_type_timestamp, which
 * walks every account's plan-billed rows in the window and reads each row's
 * table page to check its account. On the production database on 2026-11-04
 * one public-value refresh (8 accounts, 2 statements each) read 3.9 GiB that
 * way, against 510 MiB on idx_requests_account_timestamp.
 *
 * This test loads production's statistics into a real SQLite database and asks
 * the planner which index each statement the repository sends would use.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { runMigrations } from "../../migrations";
import { RequestRepository } from "../request.repository";

/** sqlite_stat1 rows for `requests`, copied from production on 2026-11-04. */
const PRODUCTION_REQUESTS_STAT1: Array<[string, string]> = [
	["idx_requests_account_timestamp", "2125429 401 1"],
	["idx_requests_account_used", "2125429 401"],
	["idx_requests_analytics_covering", "2125429 1 1 1 1 1 1 1 1 1 1 1 1 1"],
	["idx_requests_api_key", "1515834 210"],
	["idx_requests_api_key_timestamp", "1515834 210 1"],
	["idx_requests_billing_type_timestamp", "2123332 401 1"],
	["idx_requests_cleanup", "2125429 1 1"],
	["idx_requests_cost_model", "1995836 2 2 1"],
	["idx_requests_model_timestamp", "2019371 201 1"],
	["idx_requests_project_timestamp", "193990 401 1"],
	["idx_requests_response_time", "2019371 201 2"],
	["idx_requests_success_timestamp", "2125429 401 1"],
	["idx_requests_summary_covering", "2125429 1 1 1 1 1 1 1 1 1 1 1 1 1 1"],
	["idx_requests_timestamp", "2125429 1"],
	["idx_requests_timestamp_account", "2125429 1 1"],
	["idx_requests_tokens", "2009012 1 1"],
	["sqlite_autoindex_requests_1", "2125429 1"],
];

interface CapturedRead {
	sql: string;
	params: unknown[];
}

function loadProductionStatistics(db: Database): void {
	// ANALYZE creates sqlite_stat1; replace its requests rows with production's
	// and reload them into the planner.
	db.run("ANALYZE");
	db.run("DELETE FROM sqlite_stat1 WHERE tbl = 'requests'");
	const insert = db.prepare(
		"INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES ('requests', ?, ?)",
	);
	for (const [idx, stat] of PRODUCTION_REQUESTS_STAT1) insert.run(idx, stat);
	db.run("ANALYZE sqlite_schema");
}

function planOf(db: Database, read: CapturedRead): string {
	return (
		db
			.query(`EXPLAIN QUERY PLAN ${read.sql}`)
			.all(...(read.params as never[])) as Array<{ detail: string }>
	)
		.map((row) => row.detail)
		.join(" | ");
}

describe("RequestRepository.aggregateTokensByModel query plan", () => {
	let db: Database;
	let repo: RequestRepository;
	let reads: CapturedRead[];

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db);
		const adapter = new BunSqlAdapter(db);
		const queryOffThread = adapter.queryOffThread.bind(adapter);
		reads = [];
		adapter.queryOffThread = ((sql: string, params: unknown[] = [], lane) => {
			reads.push({ sql, params });
			return queryOffThread(sql, params, lane);
		}) as typeof adapter.queryOffThread;
		repo = new RequestRepository(adapter);
		loadProductionStatistics(db);
	});

	it("the loaded statistics are the ones production plans with", () => {
		const row = db
			.query(
				"SELECT stat FROM sqlite_stat1 WHERE idx = 'idx_requests_billing_type_timestamp'",
			)
			.get() as { stat: string };
		expect(row.stat).toBe("2123332 401 1");
	});

	it("reads one account's window from the account index, not the billing_type index", async () => {
		await repo.aggregateTokensByModel("acc1", 1_000, 2_000);
		const requestReads = reads.filter((read) =>
			/\bFROM requests\b/.test(read.sql),
		);
		// The token aggregate and the advisor-usage pass.
		expect(requestReads).toHaveLength(2);
		for (const read of requestReads) {
			const plan = planOf(db, read);
			expect(plan).toContain(
				"SEARCH requests USING INDEX idx_requests_account_timestamp (account_used=? AND timestamp>? AND timestamp<?)",
			);
			expect(plan).not.toContain("idx_requests_billing_type_timestamp");
		}
	});
});
