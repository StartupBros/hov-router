import { chmodSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Logger } from "@better-ccflare/logger";

// Ported from SijanC147/better-ccflare packages/database/src/file-modes.ts
// (aa6787355, 2f4b3eb3b), with the -journal sidecar and ensurePrivateDir added.

const log = new Logger("DatabaseFileModes");

/**
 * 0600. The accounts table stores api_key, refresh_token and access_token as
 * plaintext TEXT, so every file that can hold database pages must be readable
 * by the owner only.
 */
export const DB_FILE_MODE = 0o600;

/** 0700, for a directory this application creates to hold the database. */
export const DB_DIR_MODE = 0o700;

const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

/**
 * Bring one database file to 0600 if it exists and is a regular file.
 *
 * Regular files only: a directory that loses its execute bits locks the
 * operator out of everything under it, and the database lives there.
 *
 * Warns rather than throws. chmod fails legitimately on a bind-mounted volume,
 * on a file owned by another user, and on filesystems without Unix modes, and
 * none of those makes the database unusable.
 *
 * Returns true when the file now reads 0600 as far as this call can tell.
 */
export function restrictDbFile(path: string): boolean {
	try {
		const info = statSync(path);
		if (!info.isFile()) return false;
		if ((info.mode & 0o777) === DB_FILE_MODE) return true;
		chmodSync(path, DB_FILE_MODE);
		log.info(`Restricted ${path} permissions to 0600`);
		return true;
	} catch (error) {
		// The sidecars are absent most of the time; that is the normal case.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		log.warn(`Could not restrict ${path} permissions: ${error}`);
		return false;
	}
}

/**
 * Restrict a SQLite database, its sidecars and its backups.
 *
 * Call this with the main database file BEFORE turning WAL on. SQLite's unix
 * VFS creates a new -wal and -shm with the main database file's mode, so
 * fixing the database first means the WAL is born 0600. The sidecars are
 * still swept because an unclean shutdown can leave ones an earlier binary
 * created at 0644.
 */
export function restrictDbFiles(dbPath: string): void {
	restrictDbFile(dbPath);
	for (const suffix of SIDECAR_SUFFIXES) restrictDbFile(`${dbPath}${suffix}`);
	restrictDbBackups(dbPath);
}

/**
 * Bring every `<db>.backup.*` file beside the database to 0600.
 *
 * A backup holds the same plaintext credentials as the database it copies,
 * and it does not inherit the source's mode: `VACUUM INTO` creates the copy at
 * the umask default. Backups written by an older binary are on disk now and
 * nothing else revisits them, so they are swept here.
 *
 * Matches on the `<basename>.backup.` prefix, which also covers a
 * hand-renamed backup, a `.partial` left by an interrupted VACUUM INTO, and a
 * backup's own -wal and -shm.
 */
export function restrictDbBackups(dbPath: string): void {
	const dir = dirname(dbPath);
	const prefix = `${basename(dbPath)}.backup.`;

	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		log.warn(`Could not list ${dir} to restrict database backups: ${error}`);
		return;
	}

	for (const name of entries) {
		if (name.startsWith(prefix)) restrictDbFile(join(dir, name));
	}
}

/**
 * Create `dir` as 0700 if it does not exist yet. Missing parents are created
 * with the ordinary umask mode, because they are shared with other software
 * (`~/.config` on a fresh machine). A directory that already exists is never
 * chmodded: an operator may keep other files in it, and production does.
 */
export function ensurePrivateDir(dir: string): void {
	try {
		mkdirSync(dir, { mode: DB_DIR_MODE });
		return;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST") return;
		if (code !== "ENOENT") throw error;
	}
	mkdirSync(dirname(dir), { recursive: true });
	try {
		mkdirSync(dir, { mode: DB_DIR_MODE });
	} catch (error) {
		// Another process created it between the two calls; leave its mode.
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}
