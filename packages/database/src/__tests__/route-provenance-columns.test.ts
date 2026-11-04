import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import "@better-ccflare/core";
import { ensureSchema, runMigrations } from "../migrations";
import {
	isRouteProvenanceColumn,
	ROUTE_PROVENANCE_COLUMNS,
} from "./route-provenance.fixture";

const SORTED = [...ROUTE_PROVENANCE_COLUMNS].sort();

function requestColumns(db: Database): string[] {
	return db
		.query<{ name: string }, []>("PRAGMA table_info(requests)")
		.all()
		.map((r) => r.name);
}

// Every provenance column a schema path produces, found by name rather than by
// the pinned list, so a column added on one path only shows up as a difference.
function provenanceColumns(columns: Iterable<string>): string[] {
	return [...new Set(columns)].filter(isRouteProvenanceColumn).sort();
}

function sqliteFresh(): string[] {
	const db = new Database(":memory:");
	try {
		ensureSchema(db);
		return provenanceColumns(requestColumns(db));
	} finally {
		db.close();
	}
}

test("SQLite fresh ensureSchema creates exactly the 8 route provenance columns", () => {
	expect(sqliteFresh()).toEqual(SORTED);
});

test("SQLite upgrade adds exactly the 8 route provenance columns and is idempotent", () => {
	const db = new Database(":memory:");
	try {
		ensureSchema(db);
		runMigrations(db);
		// Rebuild an old-shape table: requests minus every provenance column.
		const keep = requestColumns(db).filter((c) => !isRouteProvenanceColumn(c));
		db.run(
			`CREATE TABLE requests_old AS SELECT ${keep.join(", ")} FROM requests`,
		);
		db.run("DROP TABLE requests");
		db.run("ALTER TABLE requests_old RENAME TO requests");
		expect(provenanceColumns(requestColumns(db))).toEqual([]);
		runMigrations(db);
		expect(provenanceColumns(requestColumns(db))).toEqual(SORTED);
		runMigrations(db);
		expect(provenanceColumns(requestColumns(db))).toEqual(SORTED);
	} finally {
		db.close();
	}
});
