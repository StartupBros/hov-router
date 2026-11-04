import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "../database-operations";
import { DatabaseFactory } from "../factory";
import { PostgresUrlRefusedError } from "../postgres-refusal";

const PASSWORD = "s3cret";
const POSTGRES_URLS = [
	`postgres://user:${PASSWORD}@synthetic.invalid/never-connect`,
	`postgresql://user:${PASSWORD}@synthetic.invalid/never-connect`,
];
// Values that never selected PostgreSQL keep opening SQLite (R1, R3).
const SQLITE_VALUES: Array<string | undefined> = [
	undefined,
	"",
	"mysql://x",
	"POSTGRES://x",
	"sqlite:///tmp/x.db",
];

const SAVED_KEYS = [
	"DATABASE_URL",
	"BETTER_CCFLARE_DB_PATH",
	"ccflare_DB_PATH",
	"XDG_CONFIG_HOME",
	"BETTER_CCFLARE_DB_READER_WORKER",
] as const;
let saved: Record<string, string | undefined>;
let dir: string;

function setDatabaseUrl(value: string | undefined): void {
	if (value === undefined) delete process.env.DATABASE_URL;
	else process.env.DATABASE_URL = value;
}

function dbFilesUnder(root: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { recursive: true })
		.map(String)
		.filter((name) => /better-ccflare\.db/.test(name));
}

beforeEach(() => {
	saved = Object.fromEntries(SAVED_KEYS.map((k) => [k, process.env[k]]));
	dir = mkdtempSync(join(tmpdir(), "hov-pg-refusal-"));
	delete process.env.BETTER_CCFLARE_DB_PATH;
	delete process.env.ccflare_DB_PATH;
	process.env.BETTER_CCFLARE_DB_READER_WORKER = "0";
});

afterEach(async () => {
	await DatabaseFactory.closeAll();
	for (const key of SAVED_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	rmSync(dir, { recursive: true, force: true });
});

describe("PostgreSQL DATABASE_URL refusal", () => {
	for (const url of POSTGRES_URLS) {
		it(`the constructor refuses ${url.split(":")[0]}:// before opening a file`, () => {
			setDatabaseUrl(url);
			const dbPath = join(dir, "data", "better-ccflare.db");
			let thrown: unknown;
			try {
				new DatabaseOperations(dbPath);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(PostgresUrlRefusedError);
			expect(dbFilesUnder(dir)).toEqual([]);
			expect(existsSync(join(dir, "data"))).toBe(false);
		});
	}

	for (const value of SQLITE_VALUES) {
		it(`the constructor opens SQLite when DATABASE_URL is ${JSON.stringify(value)}`, async () => {
			setDatabaseUrl(value);
			const dbPath = join(dir, "better-ccflare.db");
			const ops = new DatabaseOperations(dbPath);
			try {
				expect(existsSync(dbPath)).toBe(true);
				expect(ops.getDatabase().query("SELECT 1 AS one").get()).toEqual({
					one: 1,
				});
			} finally {
				await ops.dispose();
			}
		});
	}

	it("the message names the removal and the guide, never the URL", () => {
		setDatabaseUrl(POSTGRES_URLS[1]);
		let message = "";
		try {
			new DatabaseOperations(join(dir, "better-ccflare.db"));
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("PostgreSQL support was removed");
		expect(message).toContain(
			'"PostgreSQL support removed" in docs/hov-router-migration.md',
		);
		expect(message).toContain("v3.7.1");
		expect(message).not.toContain(PASSWORD);
		expect(message).not.toContain("synthetic.invalid");
	});

	function seedLegacyCcflareDb(): string {
		const configHome = join(dir, "config");
		const legacyDir = join(configHome, "ccflare");
		mkdirSync(legacyDir, { recursive: true });
		const legacy = new Database(join(legacyDir, "ccflare.db"), {
			create: true,
		});
		legacy.exec("CREATE TABLE legacy_marker (id INTEGER)");
		legacy.close();
		writeFileSync(join(legacyDir, "ccflare.db-shm"), "");
		process.env.XDG_CONFIG_HOME = configHome;
		return configHome;
	}

	// Declared before the control below: the factory checks for a legacy copy
	// once per process, and this case must reach that check.
	it("the factory refuses before copying a legacy ccflare.db", () => {
		if (process.platform === "win32") return;
		const configHome = seedLegacyCcflareDb();
		setDatabaseUrl(POSTGRES_URLS[0]);

		DatabaseFactory.initialize();
		expect(() => DatabaseFactory.getInstance()).toThrow(
			PostgresUrlRefusedError,
		);
		expect(dbFilesUnder(configHome)).toEqual([]);
	});

	it("control: without the URL the same seed is copied, so the case above reaches the copy", () => {
		if (process.platform === "win32") return;
		const configHome = seedLegacyCcflareDb();
		setDatabaseUrl(undefined);

		DatabaseFactory.initialize();
		DatabaseFactory.getInstance();
		expect(dbFilesUnder(configHome)).toContain(
			join("better-ccflare", "better-ccflare.db"),
		);
	});

	it("getInstanceAsync rejects with the same refusal", async () => {
		setDatabaseUrl(POSTGRES_URLS[1]);
		DatabaseFactory.initialize(join(dir, "better-ccflare.db"));
		await expect(DatabaseFactory.getInstanceAsync()).rejects.toBeInstanceOf(
			PostgresUrlRefusedError,
		);
		expect(dbFilesUnder(dir)).toEqual([]);
	});
});
