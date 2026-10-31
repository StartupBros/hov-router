import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "../database-operations";

/**
 * file-modes.test.ts proves the helpers; this pins that the constructor calls
 * them. It opens a real database through DatabaseOperations and asserts on
 * what lands on disk, so deleting the wiring fails here even though the helper
 * suite stays green.
 *
 * Ported from SijanC147/better-ccflare db-constructor-file-mode.test.ts
 * (aa6787355).
 */
function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

let savedUmask: number;
let dir: string;
let savedDatabaseUrl: string | undefined;
let savedReaderWorker: string | undefined;

beforeEach(() => {
	// Under umask 077 bun:sqlite yields 0600 with no help from our code.
	savedUmask = process.umask(0o022);
	dir = mkdtempSync(join(tmpdir(), "hov-dbctor-"));
	// DATABASE_URL selects the PostgreSQL branch, which never reaches the code
	// under test.
	savedDatabaseUrl = process.env.DATABASE_URL;
	delete process.env.DATABASE_URL;
	savedReaderWorker = process.env.BETTER_CCFLARE_DB_READER_WORKER;
	process.env.BETTER_CCFLARE_DB_READER_WORKER = "0";
});

afterEach(() => {
	process.umask(savedUmask);
	if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
	else process.env.DATABASE_URL = savedDatabaseUrl;
	if (savedReaderWorker === undefined)
		delete process.env.BETTER_CCFLARE_DB_READER_WORKER;
	else process.env.BETTER_CCFLARE_DB_READER_WORKER = savedReaderWorker;
	rmSync(dir, { recursive: true, force: true });
});

describe("DatabaseOperations constructor file modes", () => {
	it("restricts the database and its WAL to 0600", async () => {
		const dbPath = join(dir, "data", "better-ccflare.db");
		const ops = new DatabaseOperations(dbPath);
		try {
			expect(existsSync(dbPath)).toBe(true);
			expect(mode(dbPath)).toBe(0o600);
			expect(existsSync(`${dbPath}-wal`)).toBe(true);
			expect(mode(`${dbPath}-wal`)).toBe(0o600);
		} finally {
			await ops.dispose();
		}
	});

	it("creates a missing database directory 0700", async () => {
		const dbDir = join(dir, "data");
		const ops = new DatabaseOperations(join(dbDir, "better-ccflare.db"));
		try {
			expect(mode(dbDir)).toBe(0o700);
		} finally {
			await ops.dispose();
		}
	});
});
