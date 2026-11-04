/**
 * Each database worker names its thread, so /proc/<pid>/task/<tid>/comm and
 * `top -H` say which lane a thread serves. Unnamed, every one reads "Worker".
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "../database-operations";
import { runIntegrityCheckInWorker } from "../integrity-check-runner";
import { DB_WORKER_THREAD_NAMES } from "../worker-thread-names";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-thread-names-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** Every thread name in this process. */
function threadNames(): string[] {
	return readdirSync("/proc/self/task").flatMap((tid) => {
		try {
			return [readFileSync(`/proc/self/task/${tid}/comm`, "utf8").trim()];
		} catch {
			return []; // the thread exited between the listing and the read
		}
	});
}

const notLinux = process.platform !== "linux";

describe("database worker thread names", () => {
	it("fit Linux's 15-byte thread name and are distinct", () => {
		const names = Object.values(DB_WORKER_THREAD_NAMES);
		for (const name of names)
			expect(Buffer.byteLength(name)).toBeLessThanOrEqual(15);
		expect(new Set(names).size).toBe(names.length);
	});

	it.skipIf(notLinux)(
		"give each DatabaseOperations lane's thread that lane's name",
		async () => {
			const ops = new DatabaseOperations(join(tempDir(), "test.db"));
			cleanups.push(() => ops.close());
			await ops.initializeAsync();
			const adapter = ops.getAdapter();
			const {
				bulkReader,
				interactiveReader,
				writer,
				incrementalVacuum,
				compaction,
			} = DB_WORKER_THREAD_NAMES;
			// Every worker spawns on its first job, so starting one lane at a
			// time shows which name each lane gets. Check for at least one
			// thread: the helper threads a worker creates start with its name
			// and rename themselves within milliseconds.
			const named = () => {
				const names = threadNames();
				return [
					bulkReader,
					interactiveReader,
					writer,
					incrementalVacuum,
					compaction,
				].filter((name) => names.includes(name));
			};
			expect(named()).toEqual([]);
			await adapter.getOffThread("SELECT 1", [], "bulk");
			expect(named()).toEqual([bulkReader]);
			await adapter.getOffThread("SELECT 1", [], "interactive");
			expect(named()).toEqual([bulkReader, interactiveReader]);
			expect(ops.startWriterThread()).toBe(true);
			await adapter.runReturningOne("PRAGMA synchronous");
			expect(named()).toEqual([bulkReader, interactiveReader, writer]);
			expect((await ops.optimizeAsync()).ok).toBe(true);
			expect(named()).toEqual([
				bulkReader,
				interactiveReader,
				writer,
				incrementalVacuum,
			]);
			expect((await ops.compact()).error).toBeUndefined();
			expect(named()).toEqual([
				bulkReader,
				interactiveReader,
				writer,
				incrementalVacuum,
				compaction,
			]);
		},
	);

	it.skipIf(notLinux)(
		"names the integrity check's thread while it runs",
		async () => {
			const dbPath = join(tempDir(), "test.db");
			const ops = new DatabaseOperations(dbPath);
			await ops.initializeAsync();
			await ops.close();

			let settled = false;
			const run = runIntegrityCheckInWorker(dbPath, {
				kind: "quick",
				busyTimeoutMs: 1000,
			}).finally(() => {
				settled = true;
			});
			let seen = false;
			while (!settled && !seen) {
				seen = threadNames().includes(DB_WORKER_THREAD_NAMES.integrityCheck);
				if (!seen) await Bun.sleep(1);
			}
			expect(await run).toEqual({ ok: true });
			expect(seen).toBe(true);
		},
	);
});
