/**
 * Writer-slot hold of one incremental-vacuum chunk: the `chunkPages` default
 * (16384) of `incrementalVacuumAdaptive` in packages/database/src/database-operations.ts.
 *
 * Consumer: whoever changes that default re-runs this to see the new hold.
 * Delete it when the default is bounded by a test, or the adaptive vacuum goes.
 *
 * Each rep builds a fresh temp DB in the production schema (ensureSchema +
 * runMigrations: auto_vacuum=INCREMENTAL, WAL), inserts chronological request
 * and payload rows from a fixed seed, deletes payloads with the production
 * retention statement in 200-row batches, checkpoints (TRUNCATE) and fsyncs.
 * It then runs one chunk while a second connection, on its own thread, measures
 * the hold: it polls `BEGIN IMMEDIATE; ROLLBACK` with busy_timeout=0 until
 * SQLITE_BUSY, then retries a one-row INSERT with busy_timeout=0 until it
 * commits. Hold = first BUSY attempt -> committing attempt, on that thread's
 * clock, to within one poll interval at each end.
 *
 * Series (one lever each, interleaved round-robin so host drift hits all):
 *   primary           production worker, 16384 pages, oldest payloads freed, request
 *                     without `synchronous` (the connection default, FULL)
 *   primary-normal    as primary, with the `synchronous: "NORMAL"` that
 *                     incrementalVacuum() sends under the production config
 *   tail-free         newest payloads freed instead (free pages at the file tail)
 *   replica-*         same pragmas as the production worker, `exec` timed in-thread;
 *                     -ckpt0 turns off the post-commit autocheckpoint; -syncnormal-ckpt0
 *                     also drops the commit fsync (the main connection's synchronous);
 *                     -cache256m-ckpt0 gives the worker the main connection's page cache
 *   cold-file         the DB file's page cache dropped (dd iflag=nocache) before the chunk
 *   pages-N           the production worker at a smaller chunk
 *
 * Never opens the live database. Writes only under a fresh /tmp directory and
 * deletes each rep's files.
 *
 * Run: bun run bench/incremental-vacuum-hold.ts --out <dir> [--reps 30] [--reps-other 20] [--series a,b]
 */
import { Database } from "bun:sqlite";
import {
	appendFileSync,
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	statfsSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import {
	isMainThread,
	Worker as NodeWorker,
	parentPort,
	workerData,
} from "node:worker_threads";
import {
	ensureSchema,
	runMigrations,
} from "../packages/database/src/migrations";

const PROD_WORKER = resolve(
	import.meta.dir,
	"../packages/database/src/incremental-vacuum-worker.ts",
);
const SEED = 0x5eed;
const ROWS = 28_000;
const RETENTION_FRACTION = 0.4; // share of payload rows the retention sweep deletes
const BATCH = 200; // getCleanupBatchSize() default
const POLL_MS = 0.25;
const MIN_FREE_BYTES = 5 * 1024 ** 3;
const SYNCHRONOUS_LEVEL = { OFF: 0, NORMAL: 1, FULL: 2 } as const;
const HEADLINE_SERIES = new Set(["primary", "primary-normal"]); // take --reps; the rest --reps-other

// Control words shared with the probe thread.
const STATE = 0;
const STOP = 1;
const READY = 1;
const SAW_BUSY = 2;
const COMMITTED = 3;

type Layout = "head-free" | "tail-free";
interface Series {
	name: string;
	pages: number;
	layout: Layout;
	worker: "production" | "replica";
	cache: "warm" | "cold-file";
	synchronous?: "OFF" | "NORMAL" | "FULL";
	walAutocheckpoint?: number;
	cacheSize?: number;
	quickCheck?: boolean;
}

const ALL_SERIES: Series[] = [
	{
		name: "primary",
		pages: 16384,
		layout: "head-free",
		worker: "production",
		cache: "warm",
		quickCheck: true,
	},
	{
		name: "primary-normal",
		pages: 16384,
		layout: "head-free",
		worker: "production",
		cache: "warm",
		synchronous: "NORMAL",
		quickCheck: true,
	},
	{
		name: "tail-free",
		pages: 16384,
		layout: "tail-free",
		worker: "production",
		cache: "warm",
	},
	{
		name: "replica-default",
		pages: 16384,
		layout: "head-free",
		worker: "replica",
		cache: "warm",
	},
	{
		name: "replica-ckpt0",
		pages: 16384,
		layout: "head-free",
		worker: "replica",
		cache: "warm",
		walAutocheckpoint: 0,
	},
	{
		name: "replica-syncnormal-ckpt0",
		pages: 16384,
		layout: "head-free",
		worker: "replica",
		cache: "warm",
		synchronous: "NORMAL",
		walAutocheckpoint: 0,
	},
	{
		name: "replica-cache256m-ckpt0",
		pages: 16384,
		layout: "head-free",
		worker: "replica",
		cache: "warm",
		walAutocheckpoint: 0,
		cacheSize: -262144,
	},
	{
		name: "cold-file",
		pages: 16384,
		layout: "head-free",
		worker: "production",
		cache: "cold-file",
	},
	{
		name: "pages-1024",
		pages: 1024,
		layout: "head-free",
		worker: "production",
		cache: "warm",
	},
	{
		name: "pages-2048",
		pages: 2048,
		layout: "head-free",
		worker: "production",
		cache: "warm",
	},
	{
		name: "pages-4096",
		pages: 4096,
		layout: "head-free",
		worker: "production",
		cache: "warm",
	},
	{
		name: "pages-8192",
		pages: 8192,
		layout: "head-free",
		worker: "production",
		cache: "warm",
	},
];

function isBusy(err: unknown): boolean {
	const e = err as { code?: unknown; message?: unknown };
	return (
		String(e?.code ?? "").startsWith("SQLITE_BUSY") ||
		/database is locked/.test(String(e?.message ?? ""))
	);
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleepMs(ms: number): void {
	Atomics.wait(sleeper, 0, 0, ms);
}

// ---------------------------------------------------------------- threads

/** Second connection: main-connection pragmas, except busy_timeout=0 so it can poll. */
function runProbe(data: {
	dbPath: string;
	sab: SharedArrayBuffer;
	probeId: string;
}): void {
	const ctl = new Int32Array(data.sab);
	const db = new Database(data.dbPath);
	db.exec("PRAGMA busy_timeout = 0");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA wal_autocheckpoint = 0");
	db.exec("PRAGMA foreign_keys = ON");
	const begin = db.prepare("BEGIN IMMEDIATE");
	const rollback = db.prepare("ROLLBACK");
	const insert = db.prepare(
		"INSERT INTO requests (id, timestamp, method, path, status_code, success, response_time_ms, failover_attempts) VALUES (?, ?, 'POST', '/v1/messages', 200, 1, 1, 0)",
	);
	const deadline = performance.now() + 120_000;
	Atomics.store(ctl, STATE, READY);

	let preAttempts = 0;
	let lastFreeEnd = Number.NaN;
	let firstBusyStart = Number.NaN;
	while (true) {
		if (Atomics.load(ctl, STOP) === 1 || performance.now() > deadline) {
			db.close();
			parentPort?.postMessage({ outcome: "never_busy", preAttempts });
			return;
		}
		const s = performance.now();
		try {
			begin.run();
			rollback.run();
			lastFreeEnd = performance.now();
			preAttempts++;
		} catch (err) {
			if (!isBusy(err)) throw err;
			firstBusyStart = s;
			break;
		}
		sleepMs(POLL_MS);
	}
	Atomics.store(ctl, STATE, SAW_BUSY);

	let busyAttempts = 1;
	let lastBusyEnd = performance.now();
	let successStart = Number.NaN;
	let successEnd = Number.NaN;
	while (true) {
		sleepMs(POLL_MS);
		const s = performance.now();
		try {
			insert.run(data.probeId, Date.now());
			successStart = s;
			successEnd = performance.now();
			break;
		} catch (err) {
			if (!isBusy(err)) throw err;
			busyAttempts++;
			lastBusyEnd = performance.now();
			if (s > deadline) {
				db.close();
				parentPort?.postMessage({ outcome: "timeout", busyAttempts });
				return;
			}
		}
	}
	Atomics.store(ctl, STATE, COMMITTED);
	// Frames the chunk wrote: a PASSIVE checkpoint copies them but never shrinks the file.
	const walBytes = existsSync(`${data.dbPath}-wal`)
		? statSync(`${data.dbPath}-wal`).size
		: 0;
	db.close();
	parentPort?.postMessage({
		walBytes,
		outcome: "committed",
		preAttempts,
		busyAttempts,
		holdMs: successStart - firstBusyStart,
		holdLowerMs: lastBusyEnd - firstBusyStart,
		holdUpperMs: successStart - lastFreeEnd,
		writeMs: successEnd - successStart,
	});
}

/** The production worker's steps, with the one `exec` timed. Measurement only. */
function runReplica(data: {
	dbPath: string;
	pages: number;
	synchronous?: string;
	walAutocheckpoint?: number;
	cacheSize?: number;
}): void {
	parentPort?.once("message", () => {
		const tOpen = performance.now();
		const db = new Database(data.dbPath);
		db.exec("PRAGMA busy_timeout = 200");
		db.exec(`PRAGMA cache_size = ${data.cacheSize ?? -2000}`);
		db.exec("PRAGMA temp_store = FILE");
		db.exec("PRAGMA mmap_size = 0");
		if (data.synchronous) db.exec(`PRAGMA synchronous = ${data.synchronous}`);
		if (data.walAutocheckpoint !== undefined)
			db.exec(`PRAGMA wal_autocheckpoint = ${data.walAutocheckpoint}`);
		const sync = (
			db.query("PRAGMA synchronous").get() as { synchronous: number }
		).synchronous;
		const ckpt = (
			db.query("PRAGMA wal_autocheckpoint").get() as {
				wal_autocheckpoint: number;
			}
		).wal_autocheckpoint;
		const cache = (
			db.query("PRAGMA cache_size").get() as { cache_size: number }
		).cache_size;
		const mode = (
			db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }
		).auto_vacuum;
		const t0 = performance.now();
		db.exec(`PRAGMA incremental_vacuum(${data.pages})`);
		const t1 = performance.now();
		db.close();
		const t2 = performance.now();
		parentPort?.postMessage({
			mode,
			sync,
			ckpt,
			cache,
			openMs: t0 - tOpen,
			execMs: t1 - t0,
			closeMs: t2 - t1,
		});
	});
	parentPort?.postMessage("ready");
}

if (!isMainThread) {
	if (workerData.role === "probe") runProbe(workerData);
	else if (workerData.role === "replica") runReplica(workerData);
}

// ---------------------------------------------------------------- fixture

function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const FILLER = "abcdefghijklmnopqrstuvwxyz0123456789 ".repeat(2000);
const T0 = 1_760_000_000_000;

function fsyncPath(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function buildTemplate(path: string): void {
	const db = new Database(path);
	db.exec("PRAGMA auto_vacuum = INCREMENTAL"); // before anything allocates a page
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	ensureSchema(db);
	runMigrations(db); // no dbPath: no backup file
	db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	db.close();
}

interface FixtureStats {
	pageCount: number;
	freelist: number;
	autoVacuum: number;
	buildMs: number;
}

function buildFixture(
	template: string,
	path: string,
	layout: Layout,
): FixtureStats {
	const started = performance.now();
	copyFileSync(template, path);
	const db = new Database(path);
	db.exec("PRAGMA synchronous = OFF"); // not measured; fsync below makes the fixture durable
	db.exec("PRAGMA foreign_keys = ON");
	const insReq = db.prepare(
		"INSERT INTO requests (id, timestamp, method, path, account_used, status_code, success, error_message, response_time_ms, failover_attempts, model) VALUES (?, ?, 'POST', '/v1/messages', ?, 200, 1, NULL, ?, 0, ?)",
	);
	const insPay = db.prepare(
		"INSERT INTO request_payloads (id, json, timestamp) VALUES (?, ?, ?)",
	);
	const rnd = mulberry32(SEED);
	const insertBatch = db.transaction((from: number, to: number) => {
		for (let i = from; i < to; i++) {
			const id = `req-${i.toString().padStart(6, "0")}`;
			const ts = T0 + i * 1000;
			insReq.run(
				id,
				ts,
				`acct-${Math.floor(rnd() * 8)}`,
				Math.floor(rnd() * 60_000),
				`model-${Math.floor(rnd() * 4)}`,
			);
			const size = Math.round(1024 * 64 ** rnd()); // log-uniform 1 KiB..64 KiB
			insPay.run(id, `{"body":"${FILLER.slice(0, size - 11)}"}`, ts);
		}
	});
	for (let i = 0; i < ROWS; i += 500) insertBatch(i, Math.min(ROWS, i + 500));

	const cutoff = T0 + Math.floor(ROWS * RETENTION_FRACTION) * 1000;
	const tailCutoff = T0 + Math.floor(ROWS * (1 - RETENTION_FRACTION)) * 1000;
	const del =
		layout === "head-free"
			? db.prepare(
					"DELETE FROM request_payloads WHERE id IN (SELECT id FROM request_payloads WHERE timestamp IS NOT NULL AND timestamp < ? LIMIT ?)",
				)
			: db.prepare(
					"DELETE FROM request_payloads WHERE id IN (SELECT id FROM request_payloads WHERE timestamp IS NOT NULL AND timestamp >= ? LIMIT ?)",
				);
	const arg = layout === "head-free" ? cutoff : tailCutoff;
	while (del.run(arg, BATCH).changes === BATCH) {}

	db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	const pageCount = (
		db.query("PRAGMA page_count").get() as { page_count: number }
	).page_count;
	const freelist = (
		db.query("PRAGMA freelist_count").get() as { freelist_count: number }
	).freelist_count;
	const autoVacuum = (
		db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }
	).auto_vacuum;
	db.close();
	fsyncPath(path);
	fsyncPath(resolve(path, ".."));
	return {
		pageCount,
		freelist,
		autoVacuum,
		buildMs: performance.now() - started,
	};
}

// ---------------------------------------------------------------- one rep

function callWebWorker(
	w: Worker,
	msg: unknown,
): Promise<Record<string, unknown>> {
	return new Promise((res, rej) => {
		w.onmessage = (e) => res(e.data);
		w.onerror = (e) => rej(e);
		w.postMessage(msg);
	});
}

function nodeMessage<T>(w: NodeWorker): Promise<T> {
	return new Promise((res, rej) => {
		w.once("message", res);
		w.once("error", rej);
	});
}

async function waitFor(pred: () => boolean, ms = 30_000): Promise<void> {
	const end = performance.now() + ms;
	while (!pred()) {
		if (performance.now() > end) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 1));
	}
}

/** /proc/diskstats counters for the block device holding `dir` (Linux only). */
function diskCounters(dir: string): number[] | undefined {
	const dev = statSync(dir).dev;
	const major = (dev >> 8) & 0xfff;
	const minor = (dev & 0xff) | ((dev >> 12) & 0xfff00);
	const line = (
		existsSync("/proc/diskstats") ? readFileSync("/proc/diskstats", "utf8") : ""
	)
		.split("\n")
		.map((l) => l.trim().split(/\s+/))
		.find((p) => Number(p[0]) === major && Number(p[1]) === minor);
	// sectors read, sectors written, ms doing I/O, flushes completed, ms flushing
	return line
		? [5, 9, 12, 18, 19].map((i) => Number(line[i] ?? Number.NaN))
		: undefined;
}

function diskDelta(before?: number[], after?: number[]) {
	if (!before || !after) return undefined;
	const d = after.map((v, i) => v - before[i]);
	return {
		readMiB: (d[0] * 512) / 1024 ** 2,
		writeMiB: (d[1] * 512) / 1024 ** 2,
		ioMs: d[2],
		flushes: d[3],
		flushMs: d[4],
	};
}

function removeDb(path: string): void {
	for (const p of [path, `${path}-wal`, `${path}-shm`])
		rmSync(p, { force: true });
}

async function runRep(
	s: Series,
	rep: number,
	dir: string,
	template: string,
	warmDb: string,
): Promise<Record<string, unknown>> {
	const free = statfsSync(dir);
	if (free.bavail * free.bsize < MIN_FREE_BYTES)
		throw new Error(`under ${MIN_FREE_BYTES} bytes free in ${dir}; stopping`);
	const dbPath = join(dir, `rep-${s.name}-${rep}.db`);
	const load1 = loadavg()[0];
	const fixture = buildFixture(template, dbPath, s.layout);
	if (fixture.autoVacuum !== 2)
		throw new Error(`fixture auto_vacuum=${fixture.autoVacuum}`);
	if (fixture.freelist < s.pages)
		throw new Error(`freelist ${fixture.freelist} < chunk ${s.pages}`);
	// Production's main connection never closes, so no worker close is ever the
	// last one (which would checkpoint and delete the WAL inside the worker call).
	const main = new Database(dbPath);
	main.exec("PRAGMA busy_timeout = 5000");
	main.exec("PRAGMA synchronous = NORMAL");
	main.exec("PRAGMA wal_autocheckpoint = 0");
	if (s.cache === "cold-file") {
		const dd = Bun.spawnSync([
			"dd",
			`if=${dbPath}`,
			"iflag=nocache",
			"count=0",
			"status=none",
		]);
		if (dd.exitCode !== 0) throw new Error(`dd nocache failed: ${dd.stderr}`);
	}

	// Vacuum side first, warmed, so the probe's polling window stays short.
	let prodWorker: Worker | undefined;
	let replica: NodeWorker | undefined;
	if (s.worker === "production") {
		prodWorker = new Worker(PROD_WORKER);
		const warm = await callWebWorker(prodWorker, {
			kind: "vacuum",
			dbPath: warmDb,
			pages: 1,
		});
		if (warm.ok !== true)
			throw new Error(`warm-up failed: ${JSON.stringify(warm)}`);
	} else {
		replica = new NodeWorker(import.meta.path, {
			workerData: {
				role: "replica",
				dbPath,
				pages: s.pages,
				synchronous: s.synchronous,
				walAutocheckpoint: s.walAutocheckpoint,
				cacheSize: s.cacheSize,
			},
		});
		await nodeMessage(replica);
	}

	const sab = new SharedArrayBuffer(8);
	const ctl = new Int32Array(sab);
	const probeId = `probe-${s.name}-${rep}`;
	const probe = new NodeWorker(import.meta.path, {
		workerData: { role: "probe", dbPath, sab, probeId },
	});
	const probeDone = nodeMessage<Record<string, unknown>>(probe);
	await waitFor(() => Atomics.load(ctl, STATE) >= READY);

	const diskBefore = diskCounters(dir);
	const t0 = performance.now();
	let vacuumResult: Record<string, unknown>;
	if (prodWorker) {
		vacuumResult = await callWebWorker(prodWorker, {
			kind: "vacuum",
			dbPath,
			pages: s.pages,
			...(s.synchronous ? { synchronous: s.synchronous } : {}),
		});
		if (
			s.synchronous &&
			vacuumResult.synchronous !== SYNCHRONOUS_LEVEL[s.synchronous]
		)
			throw new Error(
				`worker ran synchronous=${vacuumResult.synchronous}, asked ${s.synchronous}`,
			);
	} else {
		const done = nodeMessage<Record<string, unknown>>(replica as NodeWorker);
		(replica as NodeWorker).postMessage("go");
		vacuumResult = await done;
	}
	const callMs = performance.now() - t0;
	const disk = diskDelta(diskBefore, diskCounters(dir)); // whole device: includes other processes
	const probeStateAtResult = Atomics.load(ctl, STATE);
	Atomics.store(ctl, STOP, 1);
	const probeResult = await probeDone;
	prodWorker?.terminate();
	await replica?.terminate();
	await probe.terminate();

	const walBytes = (probeResult.walBytes as number | undefined) ?? 0;
	const pageCountAfter = (
		main.query("PRAGMA page_count").get() as { page_count: number }
	).page_count;
	const freelistAfter = (
		main.query("PRAGMA freelist_count").get() as { freelist_count: number }
	).freelist_count;
	const probeRow = (
		main
			.query("SELECT count(*) AS n FROM requests WHERE id = ?")
			.get(probeId) as { n: number }
	).n;
	const quickCheck = s.quickCheck
		? (main.query("PRAGMA quick_check").get() as { quick_check: string })
				.quick_check
		: undefined;
	main.close();
	removeDb(dbPath);

	const freelistDrop = fixture.freelist - freelistAfter;
	const golden =
		vacuumResult.ok !== false &&
		probeResult.outcome === "committed" &&
		probeRow === 1 &&
		Math.abs(freelistDrop - s.pages) <= 8 &&
		(quickCheck === undefined || quickCheck === "ok");
	return {
		series: s.name,
		rep,
		load1,
		fixture,
		callMs,
		disk,
		vacuumResult,
		probe: probeResult,
		probeCommittedBeforeResult: probeStateAtResult === COMMITTED,
		walBytes,
		pageCountAfter,
		freelistAfter,
		freelistDrop,
		pageCountDrop: fixture.pageCount - pageCountAfter,
		probeRow,
		quickCheck,
		golden,
	};
}

// ---------------------------------------------------------------- stats

function nearestRank(sorted: number[], p: number): number {
	return sorted[
		Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
	];
}

function describe(values: number[]) {
	const v = values.filter(Number.isFinite).sort((a, b) => a - b);
	if (v.length === 0) return { n: 0 };
	const mean = v.reduce((a, b) => a + b, 0) / v.length;
	const sd = Math.sqrt(
		v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, v.length - 1),
	);
	const med = nearestRank(v, 0.5);
	const mad = nearestRank(
		v.map((x) => Math.abs(x - med)).sort((a, b) => a - b),
		0.5,
	);
	const r = (x: number) => Math.round(x * 10) / 10;
	return {
		n: v.length,
		min: r(v[0]),
		p50: r(med),
		p95: r(nearestRank(v, 0.95)),
		p99: r(nearestRank(v, 0.99)),
		max: r(v[v.length - 1]),
		mean: r(mean),
		cv: Math.round((sd / mean) * 1000) / 1000,
		mad: r(mad),
	};
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const flag = (name: string) => {
		const i = args.indexOf(name);
		return i >= 0 ? args[i + 1] : undefined;
	};
	const out = resolve(flag("--out") ?? "incvac-hold-out");
	const repsPrimary = Number(flag("--reps") ?? 30);
	const repsOther = Number(flag("--reps-other") ?? 20);
	const only = flag("--series")?.split(",");
	const series = ALL_SERIES.filter((s) => !only || only.includes(s.name));
	mkdirSync(out, { recursive: true });
	const dir = mkdtempSync("/tmp/incvac-hold-");
	const template = join(dir, "template.db");
	const warmDb = join(dir, "warm.db");
	buildTemplate(template);
	copyFileSync(template, warmDb);
	const repsPath = join(out, "reps.jsonl");
	writeFileSync(repsPath, "");

	const reps = (s: Series) =>
		HEADLINE_SERIES.has(s.name) ? repsPrimary : repsOther;
	const rounds = Math.max(...series.map(reps));
	const results: Record<string, unknown>[] = [];
	try {
		for (let r = 0; r < rounds; r++) {
			for (let k = 0; k < series.length; k++) {
				const s = series[(r + k) % series.length]; // rotate the order every round
				if (r >= reps(s)) continue;
				const res = await runRep(s, r, dir, template, warmDb);
				results.push(res);
				appendFileSync(repsPath, `${JSON.stringify(res)}\n`);
				const p = res.probe as { holdMs?: number };
				console.log(
					`[${s.name} #${r}] hold=${p.holdMs?.toFixed(1)}ms call=${(res.callMs as number).toFixed(1)}ms golden=${res.golden} load1=${(res.load1 as number).toFixed(2)}`,
				);
			}
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	const summary: Record<string, unknown> = {};
	for (const s of series) {
		const rows = results.filter((x) => x.series === s.name);
		const fx = rows.map((x) => x.fixture as FixtureStats);
		const vr = rows.map(
			(x) =>
				x.vacuumResult as {
					execMs?: number;
					openMs?: number;
					closeMs?: number;
					sync?: number;
					ckpt?: number;
					cache?: number;
				},
		);
		summary[s.name] = {
			config: s,
			goldenPass: `${rows.filter((x) => x.golden).length}/${rows.length}`,
			probeCommittedBeforeResult: `${rows.filter((x) => x.probeCommittedBeforeResult).length}/${rows.length}`,
			fixtureDeterministic:
				new Set(fx.map((f) => `${f.pageCount}/${f.freelist}`)).size === 1
					? `${fx[0]?.pageCount}/${fx[0]?.freelist}`
					: "VARIES",
			holdMs: describe(rows.map((x) => (x.probe as { holdMs: number }).holdMs)),
			holdBoundWidthMs: describe(
				rows.map((x) => {
					const p = x.probe as { holdUpperMs: number; holdLowerMs: number };
					return p.holdUpperMs - p.holdLowerMs;
				}),
			),
			workerCallMs: describe(rows.map((x) => x.callMs as number)),
			replicaExecMs: describe(vr.map((v) => v.execMs ?? Number.NaN)),
			replicaOpenCloseMs: describe(
				vr.map((v) => (v.openMs ?? Number.NaN) + (v.closeMs ?? Number.NaN)),
			),
			replicaPragmas:
				vr[0]?.sync === undefined
					? undefined
					: {
							synchronous: vr[0].sync,
							wal_autocheckpoint: vr[0].ckpt,
							cache_size: vr[0].cache,
						},
			walMiB: describe(rows.map((x) => (x.walBytes as number) / 1024 ** 2)),
			deviceWriteMiBDuringCall: describe(
				rows.map(
					(x) =>
						(x.disk as { writeMiB?: number } | undefined)?.writeMiB ??
						Number.NaN,
				),
			),
			deviceFlushMsDuringCall: describe(
				rows.map(
					(x) =>
						(x.disk as { flushMs?: number } | undefined)?.flushMs ?? Number.NaN,
				),
			),
			freelistDrop: describe(rows.map((x) => x.freelistDrop as number)),
			pageCountDrop: describe(rows.map((x) => x.pageCountDrop as number)),
			fixtureBuildMs: describe(fx.map((f) => f.buildMs)),
			load1: describe(rows.map((x) => x.load1 as number)),
		};
		// variance_envelope.py input: consecutive blocks of 10 reps, p95 per block.
		const holds = rows.map((x) => (x.probe as { holdMs: number }).holdMs);
		for (let b = 0; b * 10 + 10 <= holds.length; b++) {
			const block = holds.slice(b * 10, b * 10 + 10).sort((a, c) => a - c);
			writeFileSync(
				join(out, `block-${s.name}-${b}.json`),
				JSON.stringify({ p95_ms: nearestRank(block, 0.95) }),
			);
		}
	}
	writeFileSync(
		join(out, "summary.json"),
		`${JSON.stringify(summary, null, 2)}\n`,
	);
	console.log(JSON.stringify(summary, null, 2));
}

if (isMainThread) await main();
