import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

/**
 * Opens, read-write, a database file the main connection already owns, and
 * never creates one. For maintenance workers that open their own connection.
 *
 * A missing file means it was deleted or moved under the running process.
 * Bun's default open flags create a file in that case: on 10-28 a worker
 * created an empty file at the production path while the backend kept
 * writing to the deleted original, and the vacuum kind then refused with a
 * misleading `auto_vacuum=0` (#668). This open fails instead, naming the
 * missing path.
 */
export function openExistingDatabase(dbPath: string): Database {
	try {
		return new Database(dbPath, { readwrite: true, create: false });
	} catch (err) {
		if (!existsSync(dbPath)) {
			throw new Error(`database file missing at ${dbPath}; not created`, {
				cause: err,
			});
		}
		throw err;
	}
}
