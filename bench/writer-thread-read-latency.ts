/**
 * Countermetric for the SQLite writer thread (#676): main-thread read latency
 * under steady write load, with writes on the main connection versus on the
 * worker's own connection.
 *
 * Why it can regress: a commit from another connection changes the WAL, so
 * the main connection's next read transaction discards its whole page cache
 * (256 MiB by default) and re-reads pages from the OS. Writes on the main
 * connection never invalidate its own cache.
 *
 * Consumer: the #676 PR's evidence, and whoever weighs a cache mitigation or
 * changes which reads stay on the main thread. Delete it when the writer
 * thread is removed or a test bounds the read regression.
 *
 * Workload, from a fixed seed: a fresh temp DB in the production schema and
 * default connection settings (DatabaseOperations), prefilled with `--rows`
 * requests over 7 days. Each phase runs for `--seconds`: a write load of
 * `--write-hz` requests per second (INSERT, then an UPDATE of the same row
 * once the INSERT resolves, un-awaited as the proxy does), main-thread reads
 * at 50 Hz, and a 10 ms event-loop lag probe. Each read tick times a point
 * lookup, the newest 50 rows, and a 1 h aggregate; every 10th tick adds a
 * 24 h GROUP BY. Phases alternate main/worker in ABBA order after one
 * unrecorded warm-up of each, with a TRUNCATE checkpoint between phases.
 *
 * Predeclared: denominator = every read issued in a recorded phase.
 * Metric = event-loop lag (p99, max) and write latency. Countermetric =
 * per-query read p50/p95/p99, plus the count of rounds where the worker
 * phase's p99 was higher.
 *
 * Never opens the live database; writes only under a fresh /tmp directory,
 * deleted at exit. A temp file on this host is not the production disk.
 *
 * Run: bun run bench/writer-thread-read-latency.ts [--rows 200000] [--write-hz 20] [--seconds 5] [--rounds 4]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	connectionPragmas,
	DatabaseOperations,
} from "../packages/database/src/database-operations";
import { OffThreadWriter } from "../packages/database/src/off-thread-reader";

function flag(name: string, fallback: number): number {
	const index = process.argv.indexOf(`--${name}`);
	if (index < 0) return fallback;
	const value = Number(process.argv[index + 1]);
	if (!Number.isFinite(value) || value <= 0)
		throw new Error(`--${name} needs a positive number`);
	return value;
}

const ROWS = flag("rows", 200_000);
const WRITE_HZ = flag("write-hz", 20);
const SECONDS = flag("seconds", 5);
const ROUNDS = flag("rounds", 4);
const READ_INTERVAL_MS = 20;
const LAG_INTERVAL_MS = 10;
const MODELS = ["opus", "sonnet", "haiku", "glm", "gpt", "deepseek"];

// mulberry32: deterministic across runs.
let seed = 0x5eed;
function random(): number {
	seed |= 0;
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)] as T;

const INSERT = `INSERT INTO requests (id, timestamp, method, path, account_used,
	status_code, success, response_time_ms, model, input_tokens, output_tokens,
	total_tokens, cost_usd, agent_used, project)
	VALUES (?, ?, 'POST', '/v1/messages', ?, 200, 1, ?, ?, ?, ?, ?, ?, ?, ?)`;
const UPDATE = `UPDATE requests SET response_time_ms = ?, output_tokens = ?,
	total_tokens = total_tokens + ?, cost_usd = cost_usd + ? WHERE id = ?`;

function row(id: string, timestamp: number): unknown[] {
	const input = Math.floor(random() * 50_000);
	const output = Math.floor(random() * 4_000);
	return [
		id,
		timestamp,
		`account-${Math.floor(random() * 12)}`,
		Math.floor(random() * 30_000),
		pick(MODELS),
		input,
		output,
		input + output,
		random() * 0.5,
		`agent-${Math.floor(random() * 40)}`,
		`/home/user/project-${Math.floor(random() * 25)}`,
	];
}

function quantile(sorted: number[], q: number): number {
	if (sorted.length === 0) return Number.NaN;
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}
function summary(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	const round = (value: number) => Math.round(value * 1000) / 1000;
	return {
		n: sorted.length,
		p50: round(quantile(sorted, 0.5)),
		p95: round(quantile(sorted, 0.95)),
		p99: round(quantile(sorted, 0.99)),
		max: round(sorted.at(-1) ?? Number.NaN),
	};
}

type Arm = "main" | "worker";
type Sample = {
	reads: Record<string, number[]>;
	lag: number[];
	writeMs: number[];
	writes: number;
};

const dir = mkdtempSync(join(tmpdir(), "ccflare-writer-bench-"));
const dbPath = join(dir, "bench.db");
const ops = new DatabaseOperations(dbPath);
const adapter = ops.getAdapter();
const db = adapter.getSQLiteDb();
const ids: string[] = [];
const now = Date.now();
const prefill = db.prepare(INSERT);
db.transaction(() => {
	for (let i = 0; i < ROWS; i++) {
		const id = `prefill-${i}`;
		ids.push(id);
		prefill.run(...(row(id, now - 7 * 86_400_000 + (i / ROWS) * 7 * 86_400_000) as never[]));
	}
})();
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

const writer = new OffThreadWriter({
	dbPath,
	busyTimeoutMs: 10_000,
	pragmas: connectionPragmas({
		busyTimeoutMs: 10_000,
		cacheSize: -16384,
		synchronous: "FULL",
		mmapSize: 0,
	}),
	embeddedCode: "",
	sourceUrl: resolve(import.meta.dir, "../packages/database/src/reader-worker.ts"),
	info: () => {},
});

const point = db.query("SELECT * FROM requests WHERE id = ?");
const recent = db.query(
	"SELECT id, timestamp, model, status_code FROM requests ORDER BY timestamp DESC LIMIT 50",
);
const hour = db.query(
	"SELECT COUNT(*) AS n, SUM(total_tokens) AS tokens, SUM(cost_usd) AS cost FROM requests WHERE timestamp > ?",
);
const day = db.query(
	"SELECT model, COUNT(*) AS n, SUM(total_tokens) AS tokens FROM requests WHERE timestamp > ? GROUP BY model",
);

let sequence = 0;
async function phase(arm: Arm): Promise<Sample> {
	adapter.setWriter(arm === "worker" ? writer : undefined);
	const sample: Sample = {
		reads: { point: [], recent: [], hour: [], day: [] },
		lag: [],
		writeMs: [],
		writes: 0,
	};
	const outstanding = new Set<Promise<void>>();
	const time = (name: string, read: () => unknown) => {
		const start = performance.now();
		read();
		sample.reads[name]?.push(performance.now() - start);
	};
	let tick = 0;
	let lastLag = performance.now();
	const lagTimer = setInterval(() => {
		const at = performance.now();
		sample.lag.push(Math.max(0, at - lastLag - LAG_INTERVAL_MS));
		lastLag = at;
	}, LAG_INTERVAL_MS);
	const readTimer = setInterval(() => {
		const at = Date.now();
		time("point", () => point.get(pick(ids)));
		time("recent", () => recent.all());
		time("hour", () => hour.get(at - 3_600_000));
		if (tick++ % 10 === 0) time("day", () => day.all(at - 86_400_000));
	}, READ_INTERVAL_MS);
	const writeTimer = setInterval(() => {
		const id = `bench-${sequence++}`;
		ids.push(id);
		const start = performance.now();
		const job = adapter
			.run(INSERT, row(id, Date.now()))
			.then(() =>
				adapter.run(UPDATE, [
					Math.floor(random() * 30_000),
					Math.floor(random() * 4_000),
					Math.floor(random() * 4_000),
					random() * 0.1,
					id,
				]),
			)
			.then(() => {
				sample.writeMs.push(performance.now() - start);
				sample.writes += 2;
			})
			.finally(() => outstanding.delete(job));
		outstanding.add(job);
	}, 1000 / WRITE_HZ);
	await new Promise((done) => setTimeout(done, SECONDS * 1000));
	clearInterval(writeTimer);
	clearInterval(readTimer);
	clearInterval(lagTimer);
	await Promise.all(outstanding);
	adapter.setWriter(undefined);
	db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	return sample;
}

function merge(samples: Sample[]): Sample {
	const merged: Sample = {
		reads: { point: [], recent: [], hour: [], day: [] },
		lag: [],
		writeMs: [],
		writes: 0,
	};
	for (const sample of samples) {
		for (const [name, values] of Object.entries(sample.reads))
			merged.reads[name]?.push(...values);
		merged.lag.push(...sample.lag);
		merged.writeMs.push(...sample.writeMs);
		merged.writes += sample.writes;
	}
	return merged;
}

try {
	await phase("main");
	await phase("worker");
	const recorded: Record<Arm, Sample[]> = { main: [], worker: [] };
	for (let round = 0; round < ROUNDS; round++) {
		const order: Arm[] = round % 2 === 0 ? ["main", "worker"] : ["worker", "main"];
		for (const arm of order) recorded[arm].push(await phase(arm));
	}
	const report: Record<string, unknown> = {
		config: {
			rows: ROWS,
			writeHz: WRITE_HZ,
			seconds: SECONDS,
			rounds: ROUNDS,
			mainCacheSize: db.query("PRAGMA cache_size").get(),
			mainSynchronous: db.query("PRAGMA synchronous").get(),
			bun: Bun.version,
		},
	};
	for (const arm of ["main", "worker"] as Arm[]) {
		const merged = merge(recorded[arm]);
		report[arm] = {
			writes: merged.writes,
			writeMs: summary(merged.writeMs),
			lagMs: summary(merged.lag),
			readMs: Object.fromEntries(
				Object.entries(merged.reads).map(([name, values]) => [
					name,
					summary(values),
				]),
			),
		};
	}
	// Paired per round: worker phase p99 above the main phase p99.
	report.workerP99Higher = Object.fromEntries(
		["point", "recent", "hour", "day"].map((name) => [
			name,
			`${recorded.worker.filter((sample, round) => {
				const main = recorded.main[round] as Sample;
				const p99 = (values: number[]) =>
					quantile([...values].sort((a, b) => a - b), 0.99);
				return (
					p99(sample.reads[name] ?? []) > p99(main.reads[name] ?? [])
				);
			}).length}/${ROUNDS}`,
		]),
	);
	console.log(JSON.stringify(report, null, 2));
} finally {
	await writer.close();
	await ops.close();
	rmSync(dir, { recursive: true, force: true });
}
