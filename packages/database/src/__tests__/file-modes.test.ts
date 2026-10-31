import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensurePrivateDir,
	restrictDbBackups,
	restrictDbFile,
	restrictDbFiles,
} from "../file-modes";
import { ensureSchema, runMigrations } from "../migrations";

/**
 * better-ccflare.db stores api_key, refresh_token and access_token as plaintext
 * TEXT, so the database, its sidecars and every VACUUM INTO backup must be
 * readable by the owner only.
 *
 * Ported from SijanC147/better-ccflare db-file-mode.test.ts and
 * backup-file-modes.test.ts (aa6787355, 2f4b3eb3b).
 *
 * The umask is pinned at 022 and every fixture is chmodded to 0644 explicitly:
 * under umask 077 SQLite would create 0600 files on its own, and every
 * assertion here would pass against reverted source.
 */
function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

function seedWorldReadable(path: string): void {
	writeFileSync(path, "x");
	chmodSync(path, 0o644);
	expect(mode(path)).toBe(0o644);
}

let savedUmask: number;
let dir: string;

beforeEach(() => {
	savedUmask = process.umask(0o022);
	dir = mkdtempSync(join(tmpdir(), "hov-dbmode-"));
});

afterEach(() => {
	process.umask(savedUmask);
	rmSync(dir, { recursive: true, force: true });
});

describe("restrictDbFile", () => {
	it("brings a 0644 file to 0600", () => {
		const p = join(dir, "x.db");
		seedWorldReadable(p);
		expect(restrictDbFile(p)).toBe(true);
		expect(mode(p)).toBe(0o600);
	});

	it("reports false for a file that does not exist", () => {
		expect(restrictDbFile(join(dir, "absent.db"))).toBe(false);
	});

	it("refuses to touch a directory", () => {
		// A directory that loses its execute bits locks the operator out of
		// everything under it, and the database lives in that directory.
		const sub = join(dir, "sub");
		mkdirSync(sub);
		chmodSync(sub, 0o755);
		expect(restrictDbFile(sub)).toBe(false);
		expect(mode(sub)).toBe(0o755);
	});
});

describe("restrictDbFiles", () => {
	it("restricts the database, every sidecar and the backups in one call", () => {
		const db = join(dir, "better-ccflare.db");
		const paths = [
			db,
			`${db}-wal`,
			`${db}-shm`,
			`${db}-journal`,
			`${db}.backup.1778991199258`,
		];
		for (const path of paths) seedWorldReadable(path);

		restrictDbFiles(db);

		for (const path of paths) expect(mode(path)).toBe(0o600);
	});

	it("restricts the real database's sidecars when the configured path is a symlink", () => {
		// SQLite's unix VFS resolves a symlinked database path and names the
		// -wal, -shm and -journal after the target, so sweeping the alias's
		// suffixed paths would find nothing and leave the real ones 0644.
		mkdirSync(join(dir, "data"));
		const real = join(dir, "data", "better-ccflare.db");
		const alias = join(dir, "better-ccflare.db");
		const sidecars = [`${real}-wal`, `${real}-shm`, `${real}-journal`];
		seedWorldReadable(real);
		for (const path of sidecars) seedWorldReadable(path);
		symlinkSync(real, alias);

		restrictDbFiles(alias);

		expect(mode(real)).toBe(0o600);
		for (const path of sidecars) expect(mode(path)).toBe(0o600);
		expect(lstatSync(alias).isSymbolicLink()).toBe(true);
	});

	it("sweeps backups beside both the configured path and the real database", () => {
		// runMigrations names backups from the configured path, so they sit
		// beside the alias; a database once configured by its real path has
		// them beside the target.
		mkdirSync(join(dir, "data"));
		const real = join(dir, "data", "better-ccflare.db");
		const alias = join(dir, "better-ccflare.db");
		const backups = [`${alias}.backup.1`, `${real}.backup.2`];
		seedWorldReadable(real);
		for (const path of backups) seedWorldReadable(path);
		symlinkSync(real, alias);

		restrictDbFiles(alias);

		for (const path of backups) expect(mode(path)).toBe(0o600);
	});

	it("gives a WAL created afterwards 0600 because the database is restricted first", () => {
		const p = join(dir, "better-ccflare.db");
		const db = new Database(p, { create: true });
		try {
			expect(mode(p)).toBe(0o644);
			restrictDbFiles(p);
			expect(mode(p)).toBe(0o600);

			// SQLite's unix VFS creates the -wal with the main file's mode.
			db.exec("PRAGMA journal_mode = WAL");
			db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
			db.exec("INSERT INTO t (id) VALUES (1)");

			expect(existsSync(`${p}-wal`)).toBe(true);
			expect(mode(`${p}-wal`)).toBe(0o600);
		} finally {
			db.close();
		}
	});
});

describe("restrictDbBackups", () => {
	it("restricts a backup's own -wal, -shm and .partial", () => {
		// These carry database pages too. The .partial is what a SIGTERM during
		// VACUUM INTO leaves behind.
		const db = join(dir, "better-ccflare.db");
		const siblings = [
			`${db}.backup.1779028256026-wal`,
			`${db}.backup.1779028256026-shm`,
			`${db}.backup.1779028256026.partial`,
		];
		seedWorldReadable(db);
		for (const path of siblings) seedWorldReadable(path);

		restrictDbBackups(db);

		for (const path of siblings) expect(mode(path)).toBe(0o600);
	});

	it("restricts a hand-renamed backup the pruner would skip", () => {
		const db = join(dir, "better-ccflare.db");
		const kept = `${db}.backup.keep-before-the-migration`;
		seedWorldReadable(db);
		seedWorldReadable(kept);

		restrictDbBackups(db);

		expect(mode(kept)).toBe(0o600);
	});

	it("leaves another database's backup and unrelated files alone", () => {
		const db = join(dir, "better-ccflare.db");
		const ours = `${db}.backup.1`;
		const theirs = join(dir, "other.db.backup.1");
		const notes = `${db}.notes`;
		for (const path of [db, ours, theirs, notes]) seedWorldReadable(path);

		restrictDbBackups(db);

		expect(mode(ours)).toBe(0o600);
		expect(mode(theirs)).toBe(0o644);
		expect(mode(notes)).toBe(0o644);
	});

	it("does not throw when the directory does not exist", () => {
		const missing = join(dir, "gone", "better-ccflare.db");
		expect(() => restrictDbBackups(missing)).not.toThrow();
	});
});

describe("ensurePrivateDir", () => {
	it("creates a missing directory 0700 and leaves created parents at the umask default", () => {
		const parent = join(dir, "xdg");
		const leaf = join(parent, "better-ccflare");

		ensurePrivateDir(leaf);

		expect(mode(leaf)).toBe(0o700);
		// Only the directory this application owns is made private. A parent it
		// had to create (for example ~/.config on a fresh machine) is shared
		// with other software and keeps the ordinary mode.
		expect(mode(parent)).toBe(0o755);
	});

	it("never changes the mode of a directory that already exists", () => {
		// Production keeps its runner scripts in the existing 0755 config
		// directory; chmodding it would be a side effect nobody asked for.
		const existing = join(dir, "existing");
		mkdirSync(existing);
		chmodSync(existing, 0o755);

		ensurePrivateDir(existing);

		expect(mode(existing)).toBe(0o755);
	});
});

describe("VACUUM INTO backups written by runMigrations", () => {
	it("writes the .backup.<ts> as 0600", () => {
		// A legacy account_tier column is one of runMigrations' destructive
		// triggers, so it takes a backup first.
		const p = join(dir, "better-ccflare.db");
		const db = new Database(p, { create: true });
		ensureSchema(db);
		db.prepare(
			"INSERT INTO accounts (id, name, provider, refresh_token, created_at) VALUES (?, ?, ?, ?, ?)",
		).run("a", "a", "anthropic", "secret-token", Date.now());
		db.prepare("ALTER TABLE accounts ADD COLUMN account_tier TEXT").run();
		db.close();

		const db2 = new Database(p);
		try {
			runMigrations(db2, p);
		} finally {
			db2.close();
		}

		const backups = readdirSync(dir).filter((f) =>
			f.startsWith("better-ccflare.db.backup."),
		);
		expect(backups.length).toBeGreaterThan(0);
		for (const b of backups) {
			// VACUUM INTO writes at the umask default and renameSync keeps the
			// mode it finds, so without a chmod before the rename this backup
			// lands world-readable with every credential the source holds.
			expect(mode(join(dir, b))).toBe(0o600);
		}
	});
});
