/**
 * Tests for the incremental-vacuum worker's `synchronous` request field.
 *
 * The vacuum worker opens its own connection, which used to run at the
 * compile-time default (FULL) whatever the main connection was configured for.
 * Under FULL the chunk's commit fsyncs the WAL while it still holds SQLite's
 * single writer slot; for a 16,384-page chunk that sync was most of the hold
 * (bench/incremental-vacuum-hold.ts). `incrementalVacuum()` now sends the
 * configured mode and the worker applies it before the PRAGMA.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseOperations } from "../database-operations";
import type { MaintenanceWorker } from "../maintenance-worker-owner";

type VacuumResult = {
	ok: boolean;
	mode?: number;
	synchronous?: number;
	error?: string;
};

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ccflare-incvac-sync-test-"));
}

function spawnWorker(): Worker {
	return new Worker(
		new URL("../incremental-vacuum-worker.ts", import.meta.url).href,
	);
}

function roundTrip<T>(worker: Worker, message: unknown): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		worker.onmessage = (event: MessageEvent) => resolve(event.data as T);
		worker.onerror = (event: ErrorEvent) =>
			reject(new Error(event.message ?? "worker error"));
		worker.postMessage(message);
	});
}

function freelistCount(dbPath: string): number {
	const db = new Database(dbPath, { readonly: true });
	try {
		return (
			db.query("PRAGMA freelist_count").get() as { freelist_count: number }
		).freelist_count;
	} finally {
		db.close();
	}
}

/** An auto_vacuum=INCREMENTAL DB (born through DatabaseOperations) with free pages. */
async function seedFreelist(dbPath: string): Promise<number> {
	const dbOps = new DatabaseOperations(dbPath);
	await dbOps.close();
	const db = new Database(dbPath);
	try {
		db.exec("CREATE TABLE filler (b BLOB)");
		db.exec(
			"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300) INSERT INTO filler SELECT randomblob(4000) FROM n",
		);
		db.exec("DROP TABLE filler");
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} finally {
		db.close();
	}
	return freelistCount(dbPath);
}

describe("incremental-vacuum worker: synchronous request field", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = makeTempDir();
		dbPath = path.join(tmpDir, "test.db");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	for (const [mode, level] of [
		["OFF", 0],
		["NORMAL", 1],
		["FULL", 2],
	] as const) {
		it(`runs the chunk at synchronous=${mode} when the request asks for it`, async () => {
			const before = await seedFreelist(dbPath);
			expect(before).toBeGreaterThan(16);

			const worker = spawnWorker();
			try {
				const result = await roundTrip<VacuumResult>(worker, {
					kind: "vacuum",
					dbPath,
					pages: 16,
					synchronous: mode,
				});
				expect(result.ok).toBe(true);
				expect(result.mode).toBe(2);
				expect(result.synchronous).toBe(level);
			} finally {
				worker.terminate();
			}
			expect(freelistCount(dbPath)).toBe(before - 16);
		});
	}

	it("leaves the connection default when the request carries no mode", async () => {
		const before = await seedFreelist(dbPath);
		const probe = new Database(dbPath, { readonly: true });
		const connectionDefault = (
			probe.query("PRAGMA synchronous").get() as { synchronous: number }
		).synchronous;
		probe.close();

		const worker = spawnWorker();
		try {
			const result = await roundTrip<VacuumResult>(worker, {
				kind: "vacuum",
				dbPath,
				pages: 16,
			});
			expect(result.ok).toBe(true);
			expect(result.synchronous).toBe(connectionDefault);
		} finally {
			worker.terminate();
		}
		expect(freelistCount(dbPath)).toBe(before - 16);
	});

	it("refuses an unknown mode without opening a write transaction", async () => {
		const before = await seedFreelist(dbPath);

		const worker = spawnWorker();
		try {
			const result = await roundTrip<VacuumResult>(worker, {
				kind: "vacuum",
				dbPath,
				pages: 16,
				synchronous: "NORMAL; DROP TABLE requests",
			});
			expect(result.ok).toBe(false);
			expect(result.error).toContain("synchronous");
		} finally {
			worker.terminate();
		}
		expect(freelistCount(dbPath)).toBe(before);
	});
});

describe("DatabaseOperations.incrementalVacuum: synchronous mode", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = makeTempDir();
		dbPath = path.join(tmpDir, "test.db");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	/** Real workers, with every request the owner posts recorded. */
	function recordingFactory(sent: Record<string, unknown>[]) {
		return (specifier: string, options?: WorkerOptions): MaintenanceWorker => {
			const worker = new Worker(specifier, options);
			const post = worker.postMessage.bind(worker);
			worker.postMessage = (message: unknown) => {
				sent.push(message as Record<string, unknown>);
				post(message);
			};
			return worker;
		};
	}

	for (const configured of ["NORMAL", "FULL"] as const) {
		it(`sends the configured synchronous=${configured} with the vacuum request`, async () => {
			const sent: Record<string, unknown>[] = [];
			const dbOps = new DatabaseOperations(
				dbPath,
				{ synchronous: configured },
				undefined,
				{ workerFactory: recordingFactory(sent) },
			);
			try {
				await dbOps.incrementalVacuum(1);
			} finally {
				await dbOps.close();
			}
			const vacuum = sent.filter((m) => m.kind === "vacuum");
			expect(vacuum).toHaveLength(1);
			expect(vacuum[0]?.synchronous).toBe(configured);
		});
	}
});
