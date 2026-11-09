/**
 * Query-plan test for RequestRepository.aggregateTokensByModel (issue #710).
 *
 * With `billing_type = 'plan'` in the WHERE clause, SQLite answers the
 * per-account window query from idx_requests_billing_type_timestamp, which
 * walks every account's plan-billed rows in the window and reads each row's
 * table page to check its account. With no statistics the planner rates that
 * index and idx_requests_account_timestamp the same and takes the billing_type
 * one. Production's statistics leave the tie in place: the periodic
 * `PRAGMA optimize` samples ~400 rows per index (`analysis_limit`,
 * incremental-vacuum-worker.ts), sees one billing_type value, and records 401
 * rows per value for both indexes. Full counts on 2026-11-04 (1,122,013 rows,
 * 2 billing_type values, 11 accounts) would have picked the account index. On
 * the production database one public-value refresh (8 accounts, 2 statements
 * each) read 3.9 GiB on the billing_type index, against 510 MiB on the account
 * index.
 *
 * This test plans each statement the repository sends under production's
 * statistics. The steer did not depend on them: the old predicate took the
 * billing_type index on a fresh schema too.
 *
 * Migrations have dropped idx_requests_billing_type_timestamp since #762, as no
 * query uses it any more. The test still pins the account-index SEARCH, so a
 * predicate change or a new low-cardinality index cannot move this query back
 * onto a walk unnoticed.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { runMigrations } from "../../migrations";
import { RequestRepository } from "../request.repository";

/**
 * sqlite_stat1 rows for `requests`, copied from production on 2026-11-04,
 * less the rows for the indexes migrations now drop (idx_requests_account_used,
 * idx_requests_api_key, and the four unused ones from #762): DROP INDEX deletes
 * their rows.
 */
const PRODUCTION_REQUESTS_STAT1: Array<[string, string]> = [
	["idx_requests_account_timestamp", "2125429 401 1"],
	["idx_requests_analytics_covering", "2125429 1 1 1 1 1 1 1 1 1 1 1 1 1"],
	["idx_requests_api_key_timestamp", "1515834 210 1"],
	["idx_requests_cleanup", "2125429 1 1"],
	["idx_requests_model_timestamp", "2019371 201 1"],
	["idx_requests_project_timestamp", "193990 401 1"],
	["idx_requests_success_timestamp", "2125429 401 1"],
	["idx_requests_summary_covering", "2125429 1 1 1 1 1 1 1 1 1 1 1 1 1 1"],
	["idx_requests_timestamp", "2125429 1"],
	["idx_requests_timestamp_account", "2125429 1 1"],
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
			// Migrations drop this index (#762); this only bites if it comes back.
			expect(plan).not.toContain("idx_requests_billing_type_timestamp");
		}
	});
});
