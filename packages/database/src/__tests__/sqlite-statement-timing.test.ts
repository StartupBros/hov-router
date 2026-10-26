import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
	fingerprintSql,
	formatSlowSqlStatement,
	type SlowSqlStatement,
	SqliteStatementTimer,
} from "../sqlite-statement-timing";

/**
 * A clock the test advances by hand. Each statement method is timed by two
 * now() calls, so `step` is the duration every timed call appears to take.
 */
function steppingClock(step: number) {
	let t = 0;
	const clock = {
		step,
		now: () => {
			const value = t;
			t += clock.step;
			return value;
		},
	};
	return clock;
}

function timedDb(step = 1, slowThresholdMs = 250) {
	const clock = steppingClock(step);
	const slow: SlowSqlStatement[] = [];
	const timer = new SqliteStatementTimer({
		slowThresholdMs,
		now: clock.now,
		onSlow: (sample) => slow.push(sample),
	});
	const db = new Database(":memory:");
	timer.instrument(db);
	return { db, timer, slow, clock };
}

describe("fingerprintSql", () => {
	it("collapses whitespace and replaces literals so no values reach the log", () => {
		expect(
			fingerprintSql(
				"SELECT *\n\t FROM requests  WHERE account_id = 'acct-secret' AND timestamp < 1761500000000 LIMIT 50",
			),
		).toBe(
			"SELECT * FROM requests WHERE account_id = ? AND timestamp < ? LIMIT ?",
		);
	});

	it("keeps identifiers that contain digits and escaped quotes inside literals", () => {
		expect(fingerprintSql("SELECT v2_col FROM t1 WHERE name = 'it''s'")).toBe(
			"SELECT v2_col FROM t1 WHERE name = ?",
		);
	});

	it("truncates long statements", () => {
		const sql = `SELECT ${"column_name, ".repeat(40)}x FROM t`;
		expect(fingerprintSql(sql).length).toBeLessThanOrEqual(160);
	});
});

describe("formatSlowSqlStatement", () => {
	it("gives duration, kind and fingerprint, plus inner SQL for transactions", () => {
		expect(
			formatSlowSqlStatement({
				kind: "all",
				durationMs: 21_480.6,
				fingerprint: "SELECT * FROM accounts",
			}),
		).toBe("Slow main-thread SQL: 21481ms all SELECT * FROM accounts");
		expect(
			formatSlowSqlStatement({
				kind: "transaction",
				durationMs: 700,
				innerSqlMs: 300.2,
				fingerprint: "TRANSACTION",
			}),
		).toBe(
			"Slow main-thread SQL: 700ms transaction TRANSACTION (300ms in its statements)",
		);
	});
});

describe("SqliteStatementTimer", () => {
	it("reports a statement at or above the threshold with its fingerprint and no params", () => {
		const { db, slow } = timedDb(300);
		db.exec("CREATE TABLE t (name TEXT)");
		slow.length = 0;

		db.query("SELECT name FROM t WHERE name = ?").all("secret-param");

		expect(slow).toEqual([
			{
				kind: "all",
				durationMs: 300,
				fingerprint: "SELECT name FROM t WHERE name = ?",
			},
		]);
		expect(JSON.stringify(slow)).not.toContain("secret-param");
	});

	it("does not report statements under the threshold", () => {
		const { db, slow } = timedDb(10);
		db.exec("CREATE TABLE t (a INTEGER)");
		db.query("SELECT a FROM t").all();
		expect(slow).toEqual([]);
	});

	it("returns results unchanged across get, all, values, run and as()", () => {
		const { db } = timedDb();
		db.exec("CREATE TABLE t (a INTEGER)");
		const insert = db.query("INSERT INTO t VALUES (?)");
		expect(insert.run(1).changes).toBe(1);
		insert.run(2);

		expect(db.query("SELECT a FROM t ORDER BY a").all()).toEqual([
			{ a: 1 },
			{ a: 2 },
		]);
		expect(db.query("SELECT a FROM t WHERE a = ?").get(2)).toEqual({ a: 2 });
		expect(db.query("SELECT a FROM t ORDER BY a").values()).toEqual([[1], [2]]);

		class Row {}
		const rows = db.query("SELECT a FROM t ORDER BY a").as(Row).all();
		expect(rows[0]).toBeInstanceOf(Row);
		expect(rows.map((r) => (r as unknown as { a: number }).a)).toEqual([1, 2]);
	});

	it("propagates errors and still records the failed statement", () => {
		const { db, timer } = timedDb(5);
		db.exec("CREATE TABLE t (a INTEGER PRIMARY KEY)");
		db.query("INSERT INTO t VALUES (?)").run(1);
		timer.drainWindow();

		// Fails while stepping, inside the timed statement method.
		expect(() => db.query("INSERT INTO t VALUES (?)").run(1)).toThrow();
		// Fails while compiling, inside the timed db.run.
		expect(() => db.run("INSERT INTO no_such_table VALUES (1)")).toThrow();

		const summary = timer.drainWindow();
		expect(summary.count).toBe(2);
		expect(summary.top.map((entry) => entry.fingerprint).sort()).toEqual([
			"INSERT INTO no_such_table VALUES (?)",
			"INSERT INTO t VALUES (?)",
		]);
	});

	it("patches a cached query() statement once, so repeat calls are not double counted", () => {
		const { db, timer } = timedDb(7);
		db.exec("CREATE TABLE t (a INTEGER)");
		timer.drainWindow();

		db.query("SELECT a FROM t").all();
		db.query("SELECT a FROM t").all();

		const summary = timer.drainWindow();
		expect(summary.count).toBe(2);
		expect(summary.totalMs).toBe(14);
		expect(summary.top).toEqual([
			{ fingerprint: "SELECT a FROM t", count: 2, totalMs: 14, maxMs: 7 },
		]);
	});

	it("times prepare(), db.run and db.exec", () => {
		const { db, timer } = timedDb(3);
		db.exec("CREATE TABLE t (a INTEGER)");
		db.run("INSERT INTO t VALUES (?)", [1]);
		db.prepare("SELECT a FROM t").get();
		const fingerprints = timer
			.drainWindow()
			.top.map((entry) => entry.fingerprint)
			.sort();
		expect(fingerprints).toEqual([
			"CREATE TABLE t (a INTEGER)",
			"INSERT INTO t VALUES (?)",
			"SELECT a FROM t",
		]);
	});

	it("groups statements that differ only in literals under one fingerprint", () => {
		const { db, timer } = timedDb(2);
		db.exec("CREATE TABLE t (a INTEGER)");
		timer.drainWindow();
		db.run("DELETE FROM t WHERE a < 10");
		db.run("DELETE FROM t WHERE a < 20");
		expect(timer.drainWindow().top).toEqual([
			{
				fingerprint: "DELETE FROM t WHERE a < ?",
				count: 2,
				totalMs: 4,
				maxMs: 2,
			},
		]);
	});

	it("ranks the window by total time and resets after a drain", () => {
		const { db, timer, clock } = timedDb(1);
		db.exec("CREATE TABLE t (a INTEGER)");
		timer.drainWindow();
		clock.step = 5;
		db.query("SELECT a FROM t").all();
		clock.step = 40;
		db.query("SELECT count(*) FROM t").get();

		const summary = timer.drainWindow();
		expect(summary.top.map((entry) => entry.fingerprint)).toEqual([
			"SELECT count(*) FROM t",
			"SELECT a FROM t",
		]);
		expect(timer.drainWindow()).toEqual({ count: 0, totalMs: 0, top: [] });
	});

	it("reports a slow transaction and counts only its own time in the window", () => {
		const { db, timer, slow, clock } = timedDb(1, 250);
		db.exec("CREATE TABLE t (a INTEGER)");
		timer.drainWindow();
		const insertMany = db.transaction((values: number[]) => {
			for (const value of values) {
				db.query("INSERT INTO t VALUES (?)").run(value);
			}
		});
		clock.step = 100;

		insertMany([1, 2, 3]);

		// The transaction's start read advances the clock 100; each of the three
		// inner statements spans 100 and advances it 200. So the transaction
		// reads 700 ms: 300 inner SQL plus 400 of its own.
		expect(slow).toEqual([
			{
				kind: "transaction",
				fingerprint: "TRANSACTION",
				durationMs: 700,
				innerSqlMs: 300,
			},
		]);
		const summary = timer.drainWindow();
		expect(summary.totalMs).toBe(700);
		expect(summary.count).toBe(4);
		expect(summary.top).toEqual([
			{ fingerprint: "TRANSACTION", count: 1, totalMs: 400, maxMs: 400 },
			{
				fingerprint: "INSERT INTO t VALUES (?)",
				count: 3,
				totalMs: 300,
				maxMs: 100,
			},
		]);
		expect(db.query("SELECT count(*) AS n FROM t").get()).toEqual({ n: 3 });
	});

	it("keeps the transaction variants and database reference working", () => {
		const { db } = timedDb();
		db.exec("CREATE TABLE t (a INTEGER)");
		const insert = db.transaction((value: number) => {
			db.query("INSERT INTO t VALUES (?)").run(value);
			return value * 2;
		});
		expect(insert(1)).toBe(2);
		expect(insert.immediate(2)).toBe(4);
		expect(insert.deferred(3)).toBe(6);
		expect(insert.exclusive(4)).toBe(8);
		expect(insert.database).toBe(db);
		expect(db.query("SELECT count(*) AS n FROM t").get()).toEqual({ n: 4 });
	});

	it("rolls back, rethrows and still reports a transaction whose body throws", () => {
		const { db, slow } = timedDb(1, 0);
		db.exec("CREATE TABLE t (a INTEGER)");
		const failing = db.transaction(() => {
			db.query("INSERT INTO t VALUES (1)").run();
			throw new Error("boom");
		});
		slow.length = 0;
		expect(() => failing()).toThrow("boom");
		expect(slow.filter((sample) => sample.kind === "transaction")).toEqual([
			{
				kind: "transaction",
				fingerprint: "TRANSACTION",
				durationMs: 3,
				innerSqlMs: 1,
			},
		]);
		expect(db.query("SELECT count(*) AS n FROM t").get()).toEqual({ n: 0 });
	});

	it("credits a nested transaction's whole time to its parent's inner SQL", () => {
		const { db, slow } = timedDb(1, 0);
		db.exec("CREATE TABLE t (a INTEGER)");
		const inner = db.transaction(() => {
			db.query("INSERT INTO t VALUES (1)").run();
		});
		const outer = db.transaction(() => {
			inner();
		});
		slow.length = 0;
		outer();
		const transactions = slow.filter((sample) => sample.kind === "transaction");
		// Inner: start read +1, statement spans 1 (+2), end read → 3 total, 1 inner.
		// Outer: start read +1, then the nested transaction's reads advance 4 → 5
		// total, of which the nested transaction's 3 counts as inner SQL.
		expect(
			transactions.map((sample) => [sample.durationMs, sample.innerSqlMs]),
		).toEqual([
			[3, 1],
			[5, 3],
		]);
	});

	it("bounds distinct statements per window", () => {
		const { db, timer } = timedDb(1);
		timer.drainWindow();
		for (let i = 0; i < 400; i++) {
			db.query(`SELECT ${i} AS v_${i}`).get();
		}
		const summary = timer.drainWindow();
		expect(summary.count).toBe(400);
		expect(summary.totalMs).toBe(400);
		expect(summary.top.length).toBeLessThanOrEqual(5);
	});
});
