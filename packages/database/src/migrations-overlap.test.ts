import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ensureSchema, runMigrations } from "./migrations";

test("unchanged boot leaves SQLite schema and prepared statements intact", () => {
	const db = new Database(":memory:");
	try {
		ensureSchema(db);
		runMigrations(db);
		const version = db.query("PRAGMA schema_version").get();
		const prepared = db.query("SELECT revision FROM routing_policy_revision");
		const before = prepared.get();
		ensureSchema(db);
		runMigrations(db);
		expect(db.query("PRAGMA schema_version").get()).toEqual(version);
		expect(prepared.get()).toEqual(before);
	} finally {
		db.close();
	}
});
