import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureSchema, runMigrations } from "../migrations";
import { addPerformanceIndexes } from "../performance-indexes";

/**
 * Each dropped index, with the wider index whose leading columns (and, for the
 * partial api-key index, the same WHERE clause) serve every lookup it served.
 */
const DROPPED_AND_COVERING = [
	["idx_requests_account_used", "idx_requests_account_timestamp"],
	["idx_requests_api_key", "idx_requests_api_key_timestamp"],
	[
		"idx_usage_snapshots_acct_win_time",
		"idx_usage_snapshots_acct_win_time_append_order",
	],
] as const;

/**
 * Dropped indexes no live query uses: EXPLAIN QUERY PLAN over every query in
 * the repository that reads `requests`, against production's schema and
 * sqlite_stat1, chose none of them outside a dev script (#762).
 */
const DROPPED_UNUSED = [
	"idx_requests_cost_model",
	"idx_requests_response_time",
	"idx_requests_tokens",
	"idx_requests_billing_type_timestamp",
] as const;

/** The definitions earlier binaries created, to rebuild a database they migrated. */
const PRIOR_BINARY_INDEX_SQL = [
	"CREATE INDEX idx_requests_account_used ON requests(account_used)",
	"CREATE INDEX idx_requests_api_key ON requests(api_key_id) WHERE api_key_id IS NOT NULL",
	"CREATE INDEX idx_usage_snapshots_acct_win_time ON usage_snapshots(account_id, window_key, timestamp DESC)",
	"CREATE INDEX idx_requests_cost_model ON requests(cost_usd, model, timestamp DESC) WHERE cost_usd > 0 AND model IS NOT NULL",
	"CREATE INDEX idx_requests_response_time ON requests(model, response_time_ms) WHERE response_time_ms IS NOT NULL AND model IS NOT NULL",
	"CREATE INDEX idx_requests_tokens ON requests(timestamp DESC, total_tokens) WHERE total_tokens > 0",
	"CREATE INDEX idx_requests_billing_type_timestamp ON requests(billing_type, timestamp DESC) WHERE billing_type IS NOT NULL",
];

const ALL_DROPPED = [
	...DROPPED_AND_COVERING.map(([dropped]) => dropped),
	...DROPPED_UNUSED,
];

function indexNames(db: Database): string[] {
	return (
		db
			.query("SELECT name FROM sqlite_master WHERE type = 'index'")
			.all() as Array<{ name: string }>
	).map((row) => row.name);
}

function expectDroppedAndCovered(db: Database): void {
	const names = indexNames(db);
	for (const [dropped, covering] of DROPPED_AND_COVERING) {
		expect(names).not.toContain(dropped);
		expect(names).toContain(covering);
	}
	for (const dropped of DROPPED_UNUSED) {
		expect(names).not.toContain(dropped);
	}
}

function migratedDatabase(dbPath = ":memory:"): Database {
	const db = new Database(dbPath);
	ensureSchema(db);
	runMigrations(db);
	return db;
}

function seedRows(db: Database): void {
	db.prepare(
		`INSERT INTO requests (id, timestamp, method, path, account_used, api_key_id)
		 VALUES (?, ?, 'POST', '/v1/messages', ?, ?)`,
	).run("req-1", 1_000, "acct-1", "key-1");
	db.prepare(
		`INSERT INTO usage_snapshots (account_id, timestamp, window_key, utilization)
		 VALUES (?, ?, ?, ?)`,
	).run("acct-1", 1_000, "five_hour", 12.5);
}

function rowCounts(db: Database): { requests: number; snapshots: number } {
	const count = (table: string) =>
		(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
	return { requests: count("requests"), snapshots: count("usage_snapshots") };
}

describe("redundant index drops", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redundant-index-drops-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("never creates the redundant indexes on a fresh database", () => {
		// ensureSchema and addPerformanceIndexes run on every boot. Checking each
		// on its own catches a create-then-drop that the end state would hide,
		// which on production's requests table means building a 2M-row index per
		// start.
		const db = new Database(":memory:");
		try {
			ensureSchema(db);
			const afterSchema = indexNames(db);
			expect(afterSchema).not.toContain("idx_requests_account_used");
			expect(afterSchema).not.toContain("idx_usage_snapshots_acct_win_time");

			runMigrations(db);
			expectDroppedAndCovered(db);

			// addPerformanceIndexes needs columns runMigrations adds, so it is
			// checked after the drop has already run: an index it still created
			// would reappear here, though runMigrations' last step drops it again.
			addPerformanceIndexes(db);
			const afterPerformance = indexNames(db);
			expect(afterPerformance).not.toContain("idx_requests_api_key");
			for (const dropped of DROPPED_UNUSED) {
				expect(afterPerformance).not.toContain(dropped);
			}
		} finally {
			db.close();
		}
	});

	it("drops the indexes an earlier binary created and keeps every row", () => {
		const db = migratedDatabase();
		try {
			seedRows(db);
			for (const sql of PRIOR_BINARY_INDEX_SQL) db.run(sql);
			for (const dropped of ALL_DROPPED) {
				expect(indexNames(db)).toContain(dropped);
			}

			runMigrations(db);
			expectDroppedAndCovered(db);
			expect(rowCounts(db)).toEqual({ requests: 1, snapshots: 1 });

			// A later boot finds nothing left to drop.
			expect(() => runMigrations(db)).not.toThrow();
			expectDroppedAndCovered(db);
		} finally {
			db.close();
		}
	});

	it("leaves a pre-append_order usage_snapshots table with only the append-order index", () => {
		const db = new Database(":memory:");
		try {
			db.run(`
				CREATE TABLE usage_snapshots (
					account_id TEXT NOT NULL,
					timestamp INTEGER NOT NULL,
					window_key TEXT NOT NULL,
					utilization REAL NOT NULL,
					resets_at INTEGER,
					active INTEGER NOT NULL DEFAULT 1
				)
			`);
			db.run(
				"CREATE INDEX idx_usage_snapshots_acct_win_time ON usage_snapshots(account_id, window_key, timestamp DESC)",
			);
			db.prepare(
				`INSERT INTO usage_snapshots (account_id, timestamp, window_key, utilization)
				 VALUES (?, ?, ?, ?)`,
			).run("legacy", 1_000, "seven_day", 10);

			runMigrations(db);
			expectDroppedAndCovered(db);
			expect(
				(
					db.query("SELECT COUNT(*) AS n FROM usage_snapshots").get() as {
						n: number;
					}
				).n,
			).toBe(1);
		} finally {
			db.close();
		}
	});

	it("takes no pre-migration backup for the drops alone", () => {
		// A backup copies the whole database file, about 5 GB in production, so
		// a reversible index drop must not set willMutate.
		const dbPath = path.join(tmpDir, "current.db");
		const prior = migratedDatabase(dbPath);
		seedRows(prior);
		for (const sql of PRIOR_BINARY_INDEX_SQL) prior.run(sql);
		prior.close();

		const db = new Database(dbPath);
		try {
			runMigrations(db, dbPath);
			expectDroppedAndCovered(db);
		} finally {
			db.close();
		}
		expect(
			fs.readdirSync(tmpDir).filter((name) => name.includes(".backup")),
		).toEqual([]);
	});
});
