import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "../migrations";

const ISSUANCE_COLUMNS = ["counter_identity", "issuance_count"];

const FORBIDDEN_CONTENT_COLUMNS = [
	"first_issued_at",
	"last_issued_at",
	"first_writer_revision",
	"first_build_sha",
	"first_decoder_revision",
	"last_writer_revision",
	"last_build_sha",
	"last_decoder_revision",
	"raw_key",
	"key_material",
	"key_id",
	"query",
	"prompt",
	"url",
	"title",
	"citation",
	"account_id",
	"credential",
	"replay_payload",
	"replay_token",
	"request_body",
	"response_body",
	"cost",
];

function columns(db: Database): string[] {
	return db
		.query<{ name: string }, []>(
			"PRAGMA table_info(server_tool_replay_issuance)",
		)
		.all()
		.map((row) => row.name);
}

function tableSql(db: Database): string {
	return (
		db
			.query<{ sql: string }, []>(
				"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'server_tool_replay_issuance'",
			)
			.get()?.sql ?? ""
	);
}

function expectContentFreeSchema(actualColumns: string[], ddl: string): void {
	expect(actualColumns).toEqual(ISSUANCE_COLUMNS);
	for (const forbidden of FORBIDDEN_CONTENT_COLUMNS) {
		expect(actualColumns).not.toContain(forbidden);
		expect(ddl).not.toMatch(new RegExp(`\\b${forbidden}\\b`, "i"));
	}
}

function expectIssuanceDdl(ddl: string): void {
	const normalized = ddl.replace(/\s+/g, " ");
	for (const column of ISSUANCE_COLUMNS) {
		expect(ddl).toMatch(new RegExp(`\\b${column}\\b`));
	}
	expect(normalized).toContain(
		"CHECK (issuance_count >= 0 AND issuance_count <= 2147483648)",
	);
	expect(normalized).not.toContain("FOREIGN KEY");
}

describe("server-tool replay issuance migrations", () => {
	it("creates a bounded content-free SQLite table on fresh install", () => {
		const db = new Database(":memory:");
		try {
			ensureSchema(db);
			const ddl = tableSql(db);
			expectContentFreeSchema(columns(db), ddl);
			expectIssuanceDdl(ddl);
			expect(
				db
					.query<{ count: number }, []>(
						"SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'server_tool_proof_controls'",
					)
					.get()?.count,
			).toBe(0);
		} finally {
			db.close();
		}
	});

	it("recreates the SQLite table through the upgrade path", () => {
		const db = new Database(":memory:");
		try {
			ensureSchema(db);
			db.run("DROP TABLE server_tool_replay_issuance");
			runMigrations(db);
			const ddl = tableSql(db);
			expectContentFreeSchema(columns(db), ddl);
			expectIssuanceDdl(ddl);
		} finally {
			db.close();
		}
	});
});
