import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BatchExpectedChangesError,
	BunSqlAdapter,
} from "../adapters/bun-sql-adapter";
import {
	connectionPragmas,
	type DatabaseConfig,
	DatabaseOperations,
} from "../database-operations";
import {
	getInstanceId,
	startHeartbeatLoop,
	writeHeartbeat,
} from "../multi-instance-guard";
import {
	OffThreadReaderUnavailableError,
	OffThreadWriteOutcomeUnknownError,
	OffThreadWriter,
	type OffThreadWriterOptions,
	type ReaderWorker,
	type WorkerPragma,
} from "../off-thread-reader";
import { withDatabaseRetry } from "../retry";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	mock.restore();
});
const sourceUrl = new URL("../reader-worker.ts", import.meta.url).href;
const turns = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
const lines = (fn: { mock: { calls: unknown[][] } }) =>
	fn.mock.calls.map(([line]) => String(line));

function tempDb(): string {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-writer-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "test.db");
}

/** A real main connection, plus a real (lazily spawned) writer on the same file. */
function realFixture(
	options: {
		pragmas?: WorkerPragma[];
		mainBusyTimeoutMs?: number;
		maxSpawns?: number;
	} = {},
) {
	const dbPath = tempDb();
	const db = new Database(dbPath, { create: true });
	db.exec(
		`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${options.mainBusyTimeoutMs ?? 5000}`,
	);
	db.exec(`
		CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT UNIQUE);
		CREATE TABLE audit (v TEXT);
		CREATE TRIGGER t_audit AFTER INSERT ON t BEGIN INSERT INTO audit VALUES (new.v); END;
	`);
	const adapter = new BunSqlAdapter(db);
	const warn = mock((_line: string) => {});
	const writer = new OffThreadWriter({
		dbPath,
		busyTimeoutMs: 5000,
		embeddedCode: "",
		sourceUrl,
		pragmas: options.pragmas ?? [{ sql: "PRAGMA busy_timeout = 5000" }],
		maxSpawns: options.maxSpawns,
		warn,
		info: () => {},
	});
	cleanups.push(
		() => adapter.close(),
		() => writer.close(),
	);
	return { dbPath, db, adapter, writer, warn };
}

class FakeWorker implements ReaderWorker {
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	onmessageerror: ((event: MessageEvent) => void) | null = null;
	messages: Record<string, unknown>[] = [];
	answered = new Set<number>();
	terminated = 0;
	unref() {}
	postMessage(message: Record<string, unknown>) {
		this.messages.push(message);
		if (message.kind === "open")
			queueMicrotask(() => this.emit({ kind: "ready" }));
		if (message.kind === "retire")
			queueMicrotask(() => this.emit({ kind: "retired" }));
	}
	writes() {
		return this.messages.filter((message) => message.kind === "write");
	}
	/** Settle the oldest unanswered write successfully. */
	answer(value: unknown = 1) {
		const next = this.writes().find(
			(message) => !this.answered.has(message.id as number),
		);
		if (!next) throw new Error("no unanswered write");
		this.answered.add(next.id as number);
		this.emit({ kind: "result", id: next.id, ok: true, value, ms: 1 });
	}
	emit(data: Record<string, unknown>) {
		this.onmessage?.({ data } as MessageEvent);
	}
	terminate() {
		this.terminated++;
	}
}

/** Clones each message the way a real Worker's postMessage does. */
class CloningWorker extends FakeWorker {
	override postMessage(message: Record<string, unknown>) {
		structuredClone(message);
		super.postMessage(message);
	}
}

function fakeWriter(
	options: Partial<OffThreadWriterOptions> = {},
	make: () => FakeWorker = () => new FakeWorker(),
) {
	const workers: FakeWorker[] = [];
	const warn = mock((_line: string) => {});
	const writer = new OffThreadWriter({
		dbPath: "/unused.db",
		busyTimeoutMs: 10,
		embeddedCode: "",
		sourceUrl,
		pragmas: [],
		workerFactory: () => {
			const worker = make();
			workers.push(worker);
			return worker;
		},
		warn,
		info: () => {},
		...options,
	});
	cleanups.push(() => writer.close());
	return { writer, workers, warn };
}

/** Largest event-loop delay seen while `work` runs, from a 10 ms interval. */
async function lag(work: () => Promise<unknown>): Promise<number> {
	let last = performance.now();
	let maxLag = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		maxLag = Math.max(maxLag, now - last - 10);
		last = now;
	}, 10);
	try {
		await sleep(30);
		await work();
		await sleep(30);
	} finally {
		clearInterval(timer);
	}
	return maxLag;
}

function thrown(fn: () => unknown): Error & { code?: string; errno?: number } {
	try {
		fn();
	} catch (error) {
		return error as Error & { code?: string; errno?: number };
	}
	throw new Error("expected a throw");
}

describe("off-thread writer real protocol", () => {
	it("keeps the event loop free while another connection holds the write lock, with a main-thread negative", async () => {
		const { dbPath, db, adapter, writer } = realFixture({
			mainBusyTimeoutMs: 1500,
		});
		const holder = new Database(dbPath);
		cleanups.push(() => holder.close());
		const holdLock = (ms: number) => {
			holder.exec("BEGIN IMMEDIATE");
			setTimeout(() => holder.exec("COMMIT"), ms);
		};

		// Negative: on the main connection the wait happens inside SQLite's busy
		// handler, so even the timer that would release the lock cannot fire.
		holdLock(300);
		const negativeLag = await lag(() =>
			adapter.run("INSERT INTO t(v) VALUES ('main')"),
		);

		adapter.setWriter(writer);
		holdLock(1000);
		const start = performance.now();
		let writeMs = 0;
		const workerLag = await lag(async () => {
			await adapter.run("INSERT INTO t(v) VALUES ('worker')");
			writeMs = performance.now() - start;
		});
		console.info(JSON.stringify({ negativeLag, workerLag, writeMs }));

		expect(negativeLag).toBeGreaterThanOrEqual(1200);
		// The write really waited for the lock, on the worker.
		expect(writeMs).toBeGreaterThanOrEqual(900);
		expect(workerLag).toBeLessThan(200);
		expect(writer.writesServed).toBe(1);
		expect(db.query("SELECT v FROM t ORDER BY id").all()).toEqual([
			{ v: "main" },
			{ v: "worker" },
		]);
	}, 20_000);

	it("commits in call order, counts only the outer statement, and keeps main query_only", async () => {
		const { db, adapter, writer } = realFixture();
		adapter.setWriter(writer);
		const expected = Array.from({ length: 50 }, (_, i) => `v${i}`);
		const counts = await Promise.all(
			expected.map((v) =>
				adapter.runWithChanges("INSERT INTO t(v) VALUES (?)", [v]),
			),
		);
		// The AFTER INSERT trigger's audit rows are not counted.
		expect(counts).toEqual(expected.map(() => 1));
		expect(
			db
				.query<{ v: string }, []>("SELECT v FROM t ORDER BY id")
				.all()
				.map((row) => row.v),
		).toEqual(expected);
		expect(db.query("SELECT count(*) AS n FROM audit").get()).toEqual({
			n: 50,
		});
		expect(
			await adapter.runWithChanges("UPDATE t SET v = v || '!' WHERE id <= 3"),
		).toBe(3);
		expect(writer.writesServed).toBe(51);

		expect(db.query("PRAGMA query_only").get()).toEqual({ query_only: 1 });
		expect(
			thrown(() => db.run("INSERT INTO t(v) VALUES ('raw')")),
		).toMatchObject({ code: "SQLITE_READONLY" });
		// Connection settings still apply under query_only (closeOwnedResources).
		db.exec("PRAGMA busy_timeout = 0");
		expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 0 });

		await adapter.retireWriter();
		expect(adapter.writerAttached()).toBe(false);
		expect(db.query("PRAGMA query_only").get()).toEqual({ query_only: 0 });
		db.run("INSERT INTO t(v) VALUES ('raw')");
	});

	it("forwards SQLite errors in the main thread's shape and runs batches atomically", async () => {
		const { dbPath, db, adapter, writer } = realFixture();
		adapter.setWriter(writer);
		await adapter.run("INSERT INTO t(v) VALUES ('a')");

		const offThread = (await adapter
			.run("INSERT INTO t(v) VALUES ('a')")
			.catch((error) => error)) as Error & { code?: string; errno?: number };
		const reference = new Database(dbPath);
		cleanups.push(() => reference.close());
		const onMain = thrown(() => reference.run("INSERT INTO t(v) VALUES ('a')"));
		expect(onMain.code).toBe("SQLITE_CONSTRAINT_UNIQUE");
		const shape = (error: Error & { code?: string; errno?: number }) => ({
			name: error.name,
			message: error.message,
			code: error.code,
			errno: error.errno,
		});
		expect(offThread).toBeInstanceOf(Error);
		expect(shape(offThread)).toEqual(shape(onMain));

		const mismatch = await adapter
			.runBatchWithChanges([
				{ sql: "INSERT INTO t(v) VALUES ('b')", expectedChanges: 1 },
				{
					sql: "UPDATE t SET v = 'z' WHERE v = 'missing'",
					expectedChanges: 1,
				},
			])
			.catch((error) => error);
		expect(mismatch).toBeInstanceOf(BatchExpectedChangesError);
		expect(mismatch).toMatchObject({
			name: "BatchExpectedChangesError",
			statementIndex: 1,
			expectedChanges: 1,
			actualChanges: 0,
		});
		// The first statement rolled back with the batch.
		expect(db.query("SELECT v FROM t WHERE v = 'b'").all()).toEqual([]);

		expect(
			await adapter.runBatchWithChanges([
				{ sql: "INSERT INTO t(v) VALUES ('b')" },
				{
					sql: "UPDATE t SET v = v || '!' WHERE v IN ('a', 'b')",
					expectedChanges: 2,
				},
			]),
		).toEqual([1, 2]);
		expect(
			await adapter.runReturningOne<{ id: number; v: string }>(
				"INSERT INTO t(v) VALUES ('c') RETURNING id, v",
			),
		).toEqual({ id: expect.any(Number), v: "c" });
		expect(
			await adapter.runReturningOne(
				"DELETE FROM t WHERE v = 'nope' RETURNING id",
			),
		).toBeNull();
		expect(writer.writesServed).toBe(4);
	});

	it("gives the writer connection the main connection's settings", async () => {
		const config: DatabaseConfig = {
			busyTimeoutMs: 1234,
			cacheSize: -16384,
			synchronous: "NORMAL",
			mmapSize: 0,
		};
		const { adapter, writer, warn } = realFixture({
			pragmas: [
				...connectionPragmas(config),
				{ sql: "PRAGMA this is not valid", bestEffort: true },
			],
		});
		adapter.setWriter(writer);
		const read = (name: string) => adapter.runReturningOne(`PRAGMA ${name}`);
		expect(await read("synchronous")).toEqual({ synchronous: 1 });
		expect(await read("busy_timeout")).toEqual({ timeout: 1234 });
		expect(await read("cache_size")).toEqual({ cache_size: -16384 });
		expect(await read("mmap_size")).toEqual({ mmap_size: 0 });
		expect(await read("foreign_keys")).toEqual({ foreign_keys: 1 });
		expect(await read("wal_autocheckpoint")).toEqual({
			wal_autocheckpoint: 0,
		});
		expect(await read("temp_store")).toEqual({ temp_store: 2 });
		expect(
			lines(warn).some((line) =>
				line.startsWith(
					"off-thread writer setting not applied: PRAGMA this is not valid",
				),
			),
		).toBe(true);
	});

	it("hands writes back to a writable main connection once the writer cannot open", async () => {
		const { db, adapter, writer, warn } = realFixture({
			pragmas: [{ sql: "PRAGMA this is not valid" }],
			maxSpawns: 2,
		});
		adapter.setWriter(writer);
		await adapter.run("INSERT INTO t(v) VALUES ('fallback')");
		expect(db.query("SELECT v FROM t").all()).toEqual([{ v: "fallback" }]);
		expect(adapter.writerAttached()).toBe(false);
		expect(db.query("PRAGMA query_only").get()).toEqual({ query_only: 0 });
		expect(writer.writesServed).toBe(0);
		expect(lines(warn)).toContain(
			"falling back to main-thread writes for the rest of this process",
		);
	});

	it("drains posted writes at close, then runs later writes on the main connection in order", async () => {
		const { dbPath, db, adapter, writer } = realFixture();
		adapter.setWriter(writer);
		await adapter.run("INSERT INTO t(v) VALUES ('warm')");
		const holder = new Database(dbPath);
		cleanups.push(() => holder.close());
		holder.exec("BEGIN IMMEDIATE");
		const names = Array.from({ length: 20 }, (_, i) => `w${i}`);
		const posted = names.map((v) =>
			adapter.run("INSERT INTO t(v) VALUES (?)", [v]),
		);
		await turns();
		const retired = adapter.retireWriter();
		const late = adapter.run("INSERT INTO t(v) VALUES ('late')");
		setTimeout(() => holder.exec("COMMIT"), 200);
		await Promise.all([...posted, retired, late]);
		expect(
			db
				.query<{ v: string }, []>("SELECT v FROM t ORDER BY id")
				.all()
				.map((row) => row.v),
		).toEqual(["warm", ...names, "late"]);
		// 'late' arrived after close began, so it ran on the main connection.
		expect(writer.writesServed).toBe(21);
		expect(adapter.writerAttached()).toBe(false);
		expect(db.query("PRAGMA query_only").get()).toEqual({ query_only: 0 });
	});
});

describe("off-thread writer fault lifecycle", () => {
	it("fails a posted write as outcome-unknown and neither the adapter nor withDatabaseRetry runs it again", async () => {
		const { db, adapter } = realFixture();
		const { writer, workers } = fakeWriter({ writeTimeoutMs: 50 });
		adapter.setWriter(writer);
		let calls = 0;
		const error = await withDatabaseRetry(
			() => {
				calls++;
				return adapter.run("INSERT INTO t(v) VALUES ('once')");
			},
			{ attempts: 3, delayMs: 1 },
		).catch((caught) => caught);
		expect(error).toBeInstanceOf(OffThreadWriteOutcomeUnknownError);
		expect(calls).toBe(1);
		expect(workers[0]?.writes()).toHaveLength(1);
		expect(workers[0]?.terminated).toBe(1);
		expect(db.query("SELECT count(*) AS n FROM t").get()).toEqual({ n: 0 });
		// Still attached: the next write goes to a fresh worker.
		expect(adapter.writerAttached()).toBe(true);
		const next = adapter.run("INSERT INTO t(v) VALUES ('next')");
		await turns();
		workers[1]?.answer();
		await next;
		expect(workers).toHaveLength(2);
		expect(writer.writesServed).toBe(1);
	});

	it("re-arms the watchdog on each settled write and earns back the spawn budget", async () => {
		const { writer, workers } = fakeWriter({
			writeTimeoutMs: 200,
			maxSpawns: 2,
		});
		const first = writer.run("first");
		const second = writer.run("second").catch((error) => error);
		await turns();
		await sleep(100);
		workers[0]?.answer();
		expect(await first).toBe(1);
		// Past the first deadline (~200 ms), before the re-armed one (~300 ms).
		await sleep(150);
		expect(workers[0]?.terminated).toBe(0);
		expect(await second).toBeInstanceOf(OffThreadWriteOutcomeUnknownError);
		expect(workers[0]?.terminated).toBe(1);

		// Fault, success, fault: without the reset two faults would exhaust a
		// budget of 2 and the fifth write would be refused.
		const third = writer.run("third");
		await turns();
		workers[1]?.answer();
		expect(await third).toBe(1);
		expect(await writer.run("fourth").catch((error) => error)).toBeInstanceOf(
			OffThreadWriteOutcomeUnknownError,
		);
		const fifth = writer.run("fifth");
		await turns();
		workers[2]?.answer();
		expect(await fifth).toBe(1);
	});

	it("bounds the close drain and fails what is still pending as outcome-unknown", async () => {
		const { writer, workers } = fakeWriter({ closeDrainMs: 50 });
		const pending = writer.run("never answered").catch((error) => error);
		await turns();
		const start = performance.now();
		await writer.close();
		const elapsed = performance.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(40);
		expect(elapsed).toBeLessThan(1000);
		expect(await pending).toBeInstanceOf(OffThreadWriteOutcomeUnknownError);
		expect(workers[0]?.terminated).toBe(1);
		expect(
			await writer.run("after close").catch((error) => error),
		).toBeInstanceOf(OffThreadReaderUnavailableError);
	});

	it("rejects only the request that cannot be cloned, and keeps the worker", async () => {
		const { writer, workers } = fakeWriter(
			{ writeTimeoutMs: 50 },
			() => new CloningWorker(),
		);
		const bad = await writer
			.run("INSERT", [() => "not cloneable"])
			.catch((error) => error);
		expect(bad).toBeInstanceOf(Error);
		expect(bad).not.toBeInstanceOf(OffThreadWriteOutcomeUnknownError);
		expect(bad).not.toBeInstanceOf(OffThreadReaderUnavailableError);
		expect(workers[0]?.writes()).toHaveLength(0);
		// Nothing pending, so no watchdog fires against the healthy worker.
		await sleep(100);
		expect(workers[0]?.terminated).toBe(0);
		const good = writer.run("INSERT", [1]);
		await turns();
		workers[0]?.answer();
		expect(await good).toBe(1);
		expect(workers).toHaveLength(1);
	});
});

describe("DatabaseOperations writer thread", () => {
	it("routes repository writes and heartbeats through the writer, and retirement keeps it attached", async () => {
		const file = tempDb();
		const ops = new DatabaseOperations(file, {
			synchronous: "NORMAL",
			mmapSize: 8 * 1024 * 1024,
		});
		cleanups.push(() => ops.close());
		await ops.initializeAsync();
		expect(ops.startWriterThread()).toBe(true);
		expect(ops.startWriterThread()).toBe(true);
		const adapter = ops.getAdapter();
		const writer = (ops as unknown as { offThreadWriter: OffThreadWriter })
			.offThreadWriter;
		expect(adapter.getSQLiteDb().query("PRAGMA query_only").get()).toEqual({
			query_only: 1,
		});
		expect(await adapter.runReturningOne("PRAGMA synchronous")).toEqual({
			synchronous: 1,
		});
		expect(await adapter.runReturningOne("PRAGMA cache_size")).toEqual({
			cache_size: -16384,
		});
		// The main connection keeps its mapping; the writer gets none.
		expect(adapter.getSQLiteDb().query("PRAGMA mmap_size").get()).toEqual({
			mmap_size: 8 * 1024 * 1024,
		});
		expect(await adapter.runReturningOne("PRAGMA mmap_size")).toEqual({
			mmap_size: 0,
		});

		await ops.setAgentPreference("agent-1", "model-a");
		await ops.setAgentPreference("agent-1", "model-b");
		expect(await ops.getAgentPreference("agent-1")).toEqual({
			model: "model-b",
		});

		const peek = new Database(file, { readonly: true });
		cleanups.push(() => peek.close());
		const heartbeatIds = () =>
			peek
				.query<{ instance_id: string }, []>(
					"SELECT instance_id FROM instance_heartbeats",
				)
				.all()
				.map((row) => row.instance_id);
		await writeHeartbeat(adapter);
		expect(heartbeatIds()).toContain(getInstanceId());
		const served = writer.writesServed;
		expect(served).toBeGreaterThanOrEqual(3);

		await ops.retireInstanceHeartbeat();
		expect(heartbeatIds()).not.toContain(getInstanceId());
		expect(writer.writesServed).toBeGreaterThanOrEqual(served + 1);
		// Quiesce retires the heartbeat; it does not drain the writer.
		expect(adapter.writerAttached()).toBe(true);

		await ops.close();
		expect(adapter.writerAttached()).toBe(false);
	});

	it("retires the heartbeat within its bound while another connection holds the write lock", async () => {
		const file = tempDb();
		const ops = new DatabaseOperations(file, { busyTimeoutMs: 1800 });
		cleanups.push(() => ops.close());
		await ops.initializeAsync();
		expect(ops.startWriterThread()).toBe(true);
		await writeHeartbeat(ops.getAdapter());
		const peek = new Database(file, { readonly: true });
		cleanups.push(() => peek.close());
		const ownRow = () =>
			peek
				.query(
					"SELECT 1 AS present FROM instance_heartbeats WHERE instance_id = ?",
				)
				.all(getInstanceId());
		expect(ownRow()).toEqual([{ present: 1 }]);
		const holder = new Database(file);
		cleanups.push(() => holder.close());
		holder.run("BEGIN IMMEDIATE");
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const start = performance.now();
		const loopLag = await lag(() => ops.retireInstanceHeartbeat());
		const elapsed = performance.now() - start;
		console.info(JSON.stringify({ elapsed, loopLag }));
		expect(elapsed).toBeLessThan(1500);
		expect(loopLag).toBeLessThan(200);
		expect(warn).toHaveBeenCalledTimes(1);
		// The DELETE is still queued behind the lock, not lost.
		expect(ownRow()).toEqual([{ present: 1 }]);
		holder.run("ROLLBACK");
		// Close drains the queued DELETE once the lock is free.
		await ops.close();
		expect(ownRow()).toEqual([]);
	}, 20_000);

	it("queues the retirement DELETE behind a tick still in the writer, so the tick cannot leave the row behind", async () => {
		const file = tempDb();
		const ops = new DatabaseOperations(file, { busyTimeoutMs: 100 });
		cleanups.push(() => ops.close());
		await ops.initializeAsync();
		expect(ops.startWriterThread()).toBe(true);
		// Stop the built-in 5 s loop; this test drives its own.
		await ops.retireInstanceHeartbeat();
		const adapter = ops.getAdapter();
		const peek = new Database(file, { readonly: true });
		cleanups.push(() => peek.close());
		const ownRow = () =>
			peek
				.query(
					"SELECT 1 AS present FROM instance_heartbeats WHERE instance_id = ?",
				)
				.all(getInstanceId());
		expect(ownRow()).toEqual([]);
		const holder = new Database(file);
		cleanups.push(() => holder.close());
		holder.run("BEGIN IMMEDIATE");
		const stop = startHeartbeatLoop(adapter, {
			intervalMs: 20,
			settlementTimeoutMs: 200,
		});
		// A tick is now posted and waiting out the lock in the writer.
		await sleep(120);
		expect(ownRow()).toEqual([]);
		const outcome = await stop().then(
			() => "settled",
			(error: Error) => error.message,
		);
		expect(outcome).toContain("heartbeat retirement unconfirmed");
		holder.run("ROLLBACK");
		// Posted after the DELETE, so it settles once the DELETE has committed.
		await adapter.runReturningOne("PRAGMA synchronous");
		expect(ownRow()).toEqual([]);
	}, 20_000);

	it("stays off for the kill switch and in-memory databases", async () => {
		const previous = process.env.BETTER_CCFLARE_DB_WRITER_WORKER;
		cleanups.push(() => {
			if (previous === undefined)
				delete process.env.BETTER_CCFLARE_DB_WRITER_WORKER;
			else process.env.BETTER_CCFLARE_DB_WRITER_WORKER = previous;
		});
		process.env.BETTER_CCFLARE_DB_WRITER_WORKER = "off";
		const ops = new DatabaseOperations(tempDb());
		cleanups.push(() => ops.close());
		expect(ops.startWriterThread()).toBe(false);
		expect(ops.getAdapter().writerAttached()).toBe(false);
		await ops.setAgentPreference("agent-1", "model-a");

		delete process.env.BETTER_CCFLARE_DB_WRITER_WORKER;
		const memory = new DatabaseOperations(":memory:");
		cleanups.push(() => memory.close());
		expect(memory.startWriterThread()).toBe(false);

		const closed = new DatabaseOperations(tempDb());
		await closed.close();
		expect(closed.startWriterThread()).toBe(false);
	});
});
