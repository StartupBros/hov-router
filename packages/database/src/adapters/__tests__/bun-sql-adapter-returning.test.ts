import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../bun-sql-adapter";

describe("BunSqlAdapter.runReturningOne", () => {
	it("executes one SQLite DML RETURNING statement and returns its row", async () => {
		const db = new Database(":memory:");
		try {
			db.run(
				"CREATE TABLE counters (id TEXT PRIMARY KEY, value INTEGER NOT NULL)",
			);
			const adapter = new BunSqlAdapter(db);

			const row = await adapter.runReturningOne<{ value_text: string }>(
				`INSERT INTO counters (id, value) VALUES (?, 1)
				 RETURNING CAST(value AS TEXT) AS value_text`,
				["counter-1"],
			);

			expect(row).toEqual({ value_text: "1" });
		} finally {
			db.close();
		}
	});

	it("returns null when conditional SQLite DML returns no row", async () => {
		const db = new Database(":memory:");
		try {
			db.run(
				"CREATE TABLE counters (id TEXT PRIMARY KEY, value INTEGER NOT NULL)",
			);
			const adapter = new BunSqlAdapter(db);

			await expect(
				adapter.runReturningOne<{ value_text: string }>(
					`UPDATE counters SET value = value + 1
					 WHERE id = ? RETURNING CAST(value AS TEXT) AS value_text`,
					["missing"],
				),
			).resolves.toBeNull();
		} finally {
			db.close();
		}
	});
});
