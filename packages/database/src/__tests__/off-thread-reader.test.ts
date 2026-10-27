import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQL } from "bun";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import {
	OffThreadReader,
	type OffThreadReaderOptions,
	OffThreadReaderUnavailableError,
} from "../off-thread-reader";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	mock.restore();
});
const sourceUrl = new URL("../reader-worker.ts", import.meta.url).href;
function realFixture() {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-reader-"));
	const dbPath = join(dir, "test.db");
	const db = new Database(dbPath, { create: true });
	db.exec(
		"PRAGMA journal_mode = WAL; CREATE TABLE sample (i INTEGER, f REAL, t TEXT, n TEXT, b BLOB)",
	);
	db.run("INSERT INTO sample VALUES (?, ?, ?, ?, ?)", [
		42,
		1.25,
		"hello",
		null,
		new Uint8Array([0, 127, 255]),
	]);
	const adapter = new BunSqlAdapter(db);
	const reader = new OffThreadReader({
		dbPath,
		busyTimeoutMs: 100,
		embeddedCode: "",
		sourceUrl,
	});
	adapter.setOffThreadReader(reader);
	cleanups.push(
		() => rmSync(dir, { recursive: true, force: true }),
		() => adapter.close(),
		() => reader.close(),
	);
	return { adapter, reader };
}

class FakeWorker {
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	onmessageerror: ((event: MessageEvent) => void) | null = null;
	messages: Record<string, unknown>[] = [];
	terminated = 0;
	unref = mock(() => {});
	ready = true;
	retireAck = true;
	postMessage(message: Record<string, unknown>) {
		this.messages.push(message);
		if (message.kind === "open" && this.ready)
			queueMicrotask(() => this.emit({ kind: "ready" }));
		if (message.kind === "retire" && this.retireAck)
			queueMicrotask(() => this.emit({ kind: "retired" }));
	}
	emit(data: Record<string, unknown>) {
		this.onmessage?.({ data } as MessageEvent);
	}
	terminate() {
		this.terminated++;
	}
}
function fakeFixture(options: Partial<OffThreadReaderOptions> = {}) {
	const workers: FakeWorker[] = [];
	const warn = mock((_line: string) => {});
	const info = mock((_line: string) => {});
	const revokeObjectURL = mock((_url: string) => {});
	const reader = new OffThreadReader({
		dbPath: "/unused.db",
		busyTimeoutMs: 10,
		embeddedCode: Buffer.from("test worker").toString("base64"),
		sourceUrl,
		workerFactory: () => {
			const worker = new FakeWorker();
			workers.push(worker);
			return worker;
		},
		createObjectURL: () => "blob:test-reader",
		revokeObjectURL,
		warn,
		info,
		...options,
	});
	cleanups.push(() => reader.close());
	return { reader, workers, warn, info, revokeObjectURL };
}
const turns = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

it("spawns lazily from embedded code, logs readiness once per process, and selects source URLs when empty", async () => {
	const worker = new FakeWorker();
	const workerFactory = mock(
		(_url: string, _options?: WorkerOptions) => worker,
	);
	const createObjectURL = mock((_blob: Blob) => "blob:test-reader");
	const { reader, info } = fakeFixture({ workerFactory, createObjectURL });
	expect(workerFactory).not.toHaveBeenCalled();
	const read = reader.get("SELECT 1", []);
	await turns();
	expect(workerFactory).toHaveBeenCalledWith("blob:test-reader", {
		smol: true,
	});
	expect(await createObjectURL.mock.calls[0][0].text()).toBe("test worker");
	expect(info).toHaveBeenCalledWith(
		"Off-thread reader ready (embedded worker)",
	);
	expect(worker.messages[0]).toEqual({
		kind: "open",
		dbPath: "/unused.db",
		busyTimeoutMs: 10,
	});
	worker.emit({
		kind: "result",
		id: worker.messages[1].id,
		ok: true,
		row: { n: 1 },
		ms: 1,
	});
	expect(await read).toEqual({ n: 1 });
	await reader.close();
	const sourceWorker = new FakeWorker();
	const sourceFactory = mock(
		(_url: string, _options?: WorkerOptions) => sourceWorker,
	);
	const source = fakeFixture({
		embeddedCode: "",
		workerFactory: sourceFactory,
		createObjectURL,
	});
	const next = source.reader.get("SELECT 2", []);
	await turns();
	expect(sourceFactory).toHaveBeenCalledWith(sourceUrl, { smol: true });
	expect(createObjectURL).toHaveBeenCalledTimes(1);
	sourceWorker.emit({
		kind: "result",
		id: sourceWorker.messages[1].id,
		ok: true,
		row: { n: 2 },
		ms: 1,
	});
	expect(await next).toEqual({ n: 2 });
	expect(source.info).not.toHaveBeenCalled();
});

describe("off-thread reader real protocol", () => {
	it("preserves all/get binding types, missing rows, and SQLite errors", async () => {
		const { adapter, reader } = realFixture();
		expect(
			JSON.stringify(
				await reader.all("SELECT * FROM sample WHERE i = ?", [42]),
			),
		).toBe(
			JSON.stringify(
				await adapter.query("SELECT * FROM sample WHERE i = ?", [42]),
			),
		);
		expect(JSON.stringify(await reader.get("SELECT * FROM sample", []))).toBe(
			JSON.stringify(await adapter.get("SELECT * FROM sample")),
		);
		expect(
			await reader.get("SELECT * FROM sample WHERE i = ?", [-1]),
		).toBeNull();
		const error = await adapter
			.query("SELECT missing FROM sample")
			.catch((e) => e);
		const workerError = await reader
			.all("SELECT missing FROM sample", [])
			.catch((e) => e);
		expect(workerError).toBeInstanceOf(Error);
		expect(workerError.message).toBe(error.message);
		expect(workerError.name).toBe(error.name);
		expect(workerError.code).toBe(error.code);
		expect(reader.readsServed).toBe(3);
	});
	it("matches ten concurrent reads and sees a synchronously committed write", async () => {
		const { adapter, reader } = realFixture();
		expect(
			await Promise.all(
				Array.from({ length: 10 }, (_, i) => reader.all("SELECT ? AS n", [i])),
			),
		).toEqual(Array.from({ length: 10 }, (_, n) => [{ n }]));
		const write = adapter.run("INSERT INTO sample(i) VALUES (?)", [99]);
		expect(await reader.get("SELECT i FROM sample WHERE i = ?", [99])).toEqual({
			i: 99,
		});
		await write;
		await reader.close();
		await expect(reader.all("SELECT 1", [])).rejects.toBeInstanceOf(
			OffThreadReaderUnavailableError,
		);
	});
	it("uses a read-only connection with bounded memory and file-backed temp storage", async () => {
		const { reader } = realFixture();
		expect(await reader.get("PRAGMA cache_size", [])).toEqual({
			cache_size: -16384,
		});
		expect(await reader.get("PRAGMA mmap_size", [])).toEqual({ mmap_size: 0 });
		expect(await reader.get("PRAGMA temp_store", [])).toEqual({
			temp_store: 1,
		});
		const error = await reader
			.all("INSERT INTO sample(i) VALUES (1)", [])
			.catch((error) => error);
		expect(error).toMatchObject({ code: "SQLITE_READONLY" });
	});
	it("keeps the event loop free, with a planted blocking negative", async () => {
		const { adapter, reader } = realFixture();
		const sql =
			"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c";
		let n = 250_000;
		let calibrationMs = 0;
		while (n <= 32_000_000) {
			const start = performance.now();
			await adapter.query(sql, [n]);
			calibrationMs = performance.now() - start;
			if (calibrationMs >= 600) break;
			n *= 2;
		}
		expect(calibrationMs).toBeGreaterThanOrEqual(600);
		expect(n).toBeLessThanOrEqual(32_000_000);
		async function lag(read: () => Promise<unknown>) {
			let last = performance.now();
			let maxLag = 0;
			const timer = setInterval(() => {
				const now = performance.now();
				maxLag = Math.max(maxLag, now - last - 10);
				last = now;
			}, 10);
			try {
				await new Promise((resolve) => setTimeout(resolve, 30));
				await read();
				await new Promise((resolve) => setTimeout(resolve, 30));
			} finally {
				clearInterval(timer);
			}
			return maxLag;
		}
		const negativeLag = await lag(() => adapter.query(sql, [n]));
		await reader.get("SELECT 1", []);
		const served = reader.readsServed;
		const workerLag = await lag(() => adapter.queryOffThread(sql, [n]));
		console.info(JSON.stringify({ n, calibrationMs, negativeLag, workerLag }));
		expect(negativeLag).toBeGreaterThanOrEqual(500);
		expect(workerLag).toBeLessThan(200);
		expect(workerLag).toBeLessThan(negativeLag / 3);
		expect(reader.readsServed).toBe(served + 1);
	}, 60_000);
});

describe("off-thread reader fault lifecycle", () => {
	it("closes during open without a later readiness fault", async () => {
		const worker = new FakeWorker();
		worker.ready = false;
		const { reader, warn } = fakeFixture({
			workerFactory: () => worker,
			readyTimeoutMs: 20,
		});
		const read = reader.all("SELECT 1", []).catch((error) => error);
		await reader.close();
		expect(await read).toBeInstanceOf(OffThreadReaderUnavailableError);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(warn).not.toHaveBeenCalled();
		expect(worker.terminated).toBe(1);
	});
	it("bounds retirement when a stuck worker cannot acknowledge", async () => {
		const worker = new FakeWorker();
		worker.retireAck = false;
		const { reader, revokeObjectURL } = fakeFixture({
			workerFactory: () => worker,
		});
		const read = reader.all("SELECT 1", []).catch((error) => error);
		await turns();
		const start = performance.now();
		await reader.close();
		expect(performance.now() - start).toBeGreaterThanOrEqual(900);
		expect(await read).toBeInstanceOf(OffThreadReaderUnavailableError);
		expect(worker.terminated).toBe(1);
		expect(revokeObjectURL).toHaveBeenCalledTimes(1);
	});
	it("warns on spawn failure, revokes its URL, and stops after the spawn budget", async () => {
		const workerFactory = mock(() => {
			throw new Error("spawn failed");
		});
		const { reader, warn, revokeObjectURL } = fakeFixture({
			workerFactory,
			maxSpawns: 2,
		});
		await expect(reader.all("SELECT 1", [])).rejects.toBeInstanceOf(
			OffThreadReaderUnavailableError,
		);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain("spawn failed");
		await expect(reader.all("SELECT 1", [])).rejects.toBeInstanceOf(
			OffThreadReaderUnavailableError,
		);
		await expect(reader.all("SELECT 1", [])).rejects.toBeInstanceOf(
			OffThreadReaderUnavailableError,
		);
		expect(workerFactory).toHaveBeenCalledTimes(2);
		expect(revokeObjectURL).toHaveBeenCalledTimes(2);
		expect(
			warn.mock.calls.filter(([line]) =>
				line.includes(
					"falling back to main-thread reads for the rest of this process",
				),
			),
		).toHaveLength(1);
	});
	it.each([
		"error",
		"messageerror",
	])("rejects all in-flight reads on %s and respawns", async (kind) => {
		const { reader, workers } = fakeFixture();
		const reads = [reader.all("SELECT 1", []), reader.get("SELECT 2", [])];
		const settled = Promise.allSettled(reads);
		await turns();
		expect(workers[0].messages.filter((m) => m.kind === "read")).toHaveLength(
			2,
		);
		if (kind === "error")
			workers[0].onerror?.({
				message: "worker broke",
				preventDefault() {},
			} as ErrorEvent);
		else workers[0].onmessageerror?.({ data: "bad message" } as MessageEvent);
		for (const result of await settled) {
			expect(result.status).toBe("rejected");
			if (result.status === "rejected")
				expect(result.reason).toBeInstanceOf(OffThreadReaderUnavailableError);
		}
		const next = reader.get("SELECT 3", []);
		await turns();
		expect(workers).toHaveLength(2);
		const message = workers[1].messages.find((m) => m.kind === "read");
		workers[1].emit({
			kind: "result",
			id: message?.id,
			ok: true,
			row: { n: 3 },
			ms: 1,
		});
		expect(await next).toEqual({ n: 3 });
		expect(workers[0].terminated).toBe(1);
		expect(workers[1].unref).toHaveBeenCalledTimes(1);
	});
	it("times out only the hung read with a plain error and faults its siblings", async () => {
		const { reader, workers } = fakeFixture({ readTimeoutMs: 20 });
		const first = reader.all("SELECT 'secret'", []).catch((e) => e);
		const sibling = reader.all("SELECT 2", []).catch((e) => e);
		const error = await first;
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(OffThreadReaderUnavailableError);
		expect(error.message).toBe(
			"off-thread read timed out after 20ms: SELECT ?",
		);
		expect(await sibling).toBeInstanceOf(OffThreadReaderUnavailableError);
		expect(workers[0].terminated).toBe(1);
	});
	it.each([
		"open-failed",
		"ready-timeout",
	])("rejects unavailable on %s", async (kind) => {
		const worker = new FakeWorker();
		worker.ready = false;
		const { reader, warn } = fakeFixture({
			workerFactory: () => worker,
			readyTimeoutMs: 20,
		});
		const read = reader.all("SELECT 1", []).catch((e) => e);
		if (kind === "open-failed")
			worker.emit({ kind: "open-failed", error: "cannot open database" });
		expect(await read).toBeInstanceOf(OffThreadReaderUnavailableError);
		expect(worker.terminated).toBe(1);
		expect(warn).toHaveBeenCalledTimes(1);
	});
	it("treats SQLITE_BUSY as unavailable without terminating the worker", async () => {
		const { reader, workers, warn } = fakeFixture();
		const read = reader.all("SELECT 1", []).catch((e) => e);
		await turns();
		const message = workers[0].messages.find((m) => m.kind === "read");
		workers[0].emit({
			kind: "result",
			id: message?.id,
			ok: false,
			error: {
				message: "database is locked",
				name: "SQLiteError",
				code: "SQLITE_BUSY",
			},
			ms: 10,
		});
		expect(await read).toBeInstanceOf(OffThreadReaderUnavailableError);
		expect(workers[0].terminated).toBe(0);
		expect(warn).not.toHaveBeenCalled();
	});
	it("logs slow fingerprints, serves successful reads, and retires idempotently", async () => {
		const { reader, workers, warn, revokeObjectURL } = fakeFixture();
		const read = reader.all("SELECT 'private'", []);
		await turns();
		const message = workers[0].messages.find((m) => m.kind === "read");
		workers[0].emit({
			kind: "result",
			id: message?.id,
			ok: true,
			rows: [{ n: 1 }],
			ms: 300,
		});
		expect(await read).toEqual([{ n: 1 }]);
		expect(reader.readsServed).toBe(1);
		expect(warn).toHaveBeenCalledWith(
			"Slow off-thread SQL: 300ms all SELECT ?",
		);
		const pending = reader.get("SELECT 2", []).catch((e) => e);
		await turns();
		const close = reader.close();
		expect(reader.close()).toBe(close);
		expect(await pending).toBeInstanceOf(OffThreadReaderUnavailableError);
		await close;
		expect(workers[0].terminated).toBe(1);
		expect(revokeObjectURL).toHaveBeenCalledTimes(1);
	});
});

describe("adapter off-thread fallback", () => {
	it("keeps PostgreSQL on its existing query/get path even with a reader attached", async () => {
		const unsafe = mock(async () => [{ n: 1 }]);
		const adapter = new BunSqlAdapter({ unsafe } as unknown as SQL, false);
		const all = mock(async <R>() => [] as R[]);
		const get = mock(async <R>() => null as R | null);
		adapter.setOffThreadReader({ all, get });
		expect(await adapter.queryOffThread("SELECT ? AS n", [1])).toEqual([
			{ n: 1 },
		]);
		expect(await adapter.getOffThread("SELECT ? AS n", [1])).toEqual({ n: 1 });
		expect(unsafe).toHaveBeenCalledWith("SELECT $1 AS n", [1]);
		expect(all).not.toHaveBeenCalled();
		expect(get).not.toHaveBeenCalled();
	});
	it("propagates read timeouts without rerunning the hung SQL on the main thread", async () => {
		const { adapter } = realFixture();
		const { reader } = fakeFixture({ readTimeoutMs: 20 });
		adapter.setOffThreadReader(reader);
		const query = spyOn(adapter, "query");
		const error = await adapter
			.queryOffThread("SELECT 'private'")
			.catch((error) => error);
		expect(error.message).toBe(
			"off-thread read timed out after 20ms: SELECT ?",
		);
		expect(error).not.toBeInstanceOf(OffThreadReaderUnavailableError);
		expect(query).not.toHaveBeenCalled();
	});
	it("delegates without a reader and retries only unavailable errors on the main thread", async () => {
		const { adapter } = realFixture();
		adapter.setOffThreadReader(undefined);
		const query = spyOn(adapter, "query");
		const get = spyOn(adapter, "get");
		expect(await adapter.queryOffThread("SELECT ? AS n", [1])).toEqual([
			{ n: 1 },
		]);
		expect(await adapter.getOffThread("SELECT ? AS n", [2])).toEqual({ n: 2 });
		adapter.setOffThreadReader({
			all: async () => {
				throw new OffThreadReaderUnavailableError("unavailable");
			},
			get: async () => {
				throw new OffThreadReaderUnavailableError("unavailable");
			},
		});
		expect(await adapter.queryOffThread("SELECT ? AS n", [3])).toEqual([
			{ n: 3 },
		]);
		expect(await adapter.getOffThread("SELECT ? AS n", [4])).toEqual({ n: 4 });
		expect(query).toHaveBeenLastCalledWith("SELECT ? AS n", [3]);
		expect(get).toHaveBeenLastCalledWith("SELECT ? AS n", [4]);
		const error = Object.assign(new Error("SQL broke"), {
			code: "SQLITE_ERROR",
		});
		adapter.setOffThreadReader({
			all: async () => {
				throw error;
			},
			get: async () => {
				throw error;
			},
		});
		await expect(adapter.queryOffThread("SELECT 9")).rejects.toBe(error);
		await expect(adapter.getOffThread("SELECT 9")).rejects.toBe(error);
		expect(query).toHaveBeenCalledTimes(2);
		expect(get).toHaveBeenCalledTimes(2);
	});
});
