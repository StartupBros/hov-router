/**
 * runIntegrityCheckInWorker builds a Blob URL for the embedded worker code on
 * every run. Terminating the worker does not release that URL, so each tick
 * kept another copy of the worker code alive until the URL was revoked.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EMBEDDED_INTEGRITY_CHECK_WORKER_CODE } from "../inline-integrity-check-worker";
import { runIntegrityCheckInWorker } from "../integrity-check-runner";

describe("integrity-check runner blob URL", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccflare-integrity-url-"));
		dbPath = path.join(tmpDir, "test.db");
		const db = new Database(dbPath, { create: true });
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
		db.close();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("revokes every object URL it creates, per run", async () => {
		const created: string[] = [];
		const revoked: string[] = [];
		const realCreate = URL.createObjectURL.bind(URL);
		const realRevoke = URL.revokeObjectURL.bind(URL);
		const createSpy = spyOn(URL, "createObjectURL").mockImplementation(
			(obj: Blob | MediaSource) => {
				const url = realCreate(obj as Blob);
				created.push(url);
				return url;
			},
		);
		const revokeSpy = spyOn(URL, "revokeObjectURL").mockImplementation(
			(url: string) => {
				revoked.push(url);
				realRevoke(url);
			},
		);
		try {
			for (const kind of ["quick", "full"] as const) {
				const result = await runIntegrityCheckInWorker(dbPath, {
					kind,
					busyTimeoutMs: 1000,
				});
				expect(result).toEqual({ ok: true });
			}
		} finally {
			createSpy.mockRestore();
			revokeSpy.mockRestore();
		}

		if (EMBEDDED_INTEGRITY_CHECK_WORKER_CODE) {
			// Built worker present: one URL per run, all revoked.
			expect(created.length).toBe(2);
		}
		expect(revoked.sort()).toEqual(created.sort());
	});
});
