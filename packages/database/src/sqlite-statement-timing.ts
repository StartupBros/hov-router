import type { Database } from "bun:sqlite";

/**
 * Main-thread SQLite timing for the post-start freeze in #606.
 *
 * Every bun:sqlite call on the main connection is synchronous, so a slow
 * statement freezes the whole event loop. The repositories go through
 * BunSqlAdapter, but ~176 call sites use the raw handle directly (the
 * accounts API handler among them), so timing is applied to the handle
 * itself where DatabaseOperations opens it. That one place covers both.
 *
 * Two outputs:
 * - `onSlow` fires for any single statement or transaction at or above the
 *   threshold.
 * - A per-window accumulator, drained by the event-loop stall monitor, so a
 *   stall made of many short statements still names them.
 *
 * Fingerprints replace string and numeric literals with `?`, because SQL
 * text here sometimes interpolates values; bound parameters are never read.
 * `iterate()` is left unwrapped: its rows are stepped lazily outside the
 * call, so timing the call would mislead.
 */

export const SLOW_SQL_STATEMENT_MS = 250;
const FINGERPRINT_MAX_CHARS = 160;
const WINDOW_MAX_DISTINCT_STATEMENTS = 256;
const WINDOW_TOP_STATEMENTS = 5;
const OVERFLOW_KEY = "(other statements)";
const TRANSACTION_KEY = "TRANSACTION";
const STATEMENT_METHODS = ["all", "get", "run", "values", "raw"] as const;
const TRANSACTION_VARIANTS = [
	"default",
	"deferred",
	"immediate",
	"exclusive",
] as const;

export type SqlStatementKind =
	| (typeof STATEMENT_METHODS)[number]
	| "exec"
	| "transaction";

export interface SlowSqlStatement {
	fingerprint: string;
	kind: SqlStatementKind;
	durationMs: number;
	/** Transactions only: time spent in the statements they ran. */
	innerSqlMs?: number;
}

export interface SqlWindowEntry {
	fingerprint: string;
	count: number;
	totalMs: number;
	maxMs: number;
}

export interface SqlWindowSummary {
	count: number;
	totalMs: number;
	/** Heaviest fingerprints by total time, at most five. */
	top: SqlWindowEntry[];
}

export interface SqliteStatementTimerOptions {
	slowThresholdMs?: number;
	now?: () => number;
	onSlow: (sample: SlowSqlStatement) => void;
}

// biome-ignore lint/suspicious/noExplicitAny: wraps bun:sqlite methods of every signature
type AnyFn = (...args: any[]) => any;
type MutableRecord = Record<string, unknown>;

export function fingerprintSql(sql: string): string {
	return sql
		.replace(/'(?:[^']|'')*'/g, "?")
		.replace(/\b\d+(?:\.\d+)?\b/g, "?")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, FINGERPRINT_MAX_CHARS);
}

export function formatSlowSqlStatement(sample: SlowSqlStatement): string {
	const line = `Slow main-thread SQL: ${Math.round(sample.durationMs)}ms ${sample.kind} ${sample.fingerprint}`;
	return sample.innerSqlMs === undefined
		? line
		: `${line} (${Math.round(sample.innerSqlMs)}ms in its statements)`;
}

export class SqliteStatementTimer {
	private readonly slowThresholdMs: number;
	private readonly now: () => number;
	private readonly onSlow: (sample: SlowSqlStatement) => void;
	private readonly instrumented = new WeakSet<object>();
	/** Raw SQL → totals; fingerprinted only when drained. */
	private window = new Map<string, Omit<SqlWindowEntry, "fingerprint">>();
	private windowCount = 0;
	private windowTotalMs = 0;
	/** Inner SQL time of each open transaction, innermost last. */
	private readonly transactionFrames: number[] = [];

	constructor(options: SqliteStatementTimerOptions) {
		this.slowThresholdMs = options.slowThresholdMs ?? SLOW_SQL_STATEMENT_MS;
		this.now = options.now ?? (() => performance.now());
		this.onSlow = options.onSlow;
	}

	instrument(db: Database): void {
		const handle = db as unknown as MutableRecord;
		const query = db.query as AnyFn;
		const prepare = db.prepare as AnyFn;
		const run = db.run as AnyFn;
		const exec = db.exec as AnyFn;
		const transaction = db.transaction as AnyFn;
		const timer = this;

		handle.query = function (this: unknown, sql: string, ...rest: unknown[]) {
			return timer.instrumentStatement(query.call(this, sql, ...rest), sql);
		};
		handle.prepare = function (this: unknown, sql: string, ...rest: unknown[]) {
			return timer.instrumentStatement(prepare.call(this, sql, ...rest), sql);
		};
		// `exec` and `run` are one prototype function that calls neither
		// instance property, so timing both never double counts.
		handle.run = function (this: unknown, sql: string, ...rest: unknown[]) {
			return timer.time(sql, "exec", () => run.call(this, sql, ...rest));
		};
		handle.exec = function (this: unknown, sql: string, ...rest: unknown[]) {
			return timer.time(sql, "exec", () => exec.call(this, sql, ...rest));
		};
		// bun:sqlite runs BEGIN/COMMIT on internal statements the patches above
		// never see, so the transaction is timed as a unit.
		handle.transaction = function (this: unknown, fn: AnyFn) {
			return timer.instrumentTransaction(transaction.call(this, fn));
		};
	}

	/** Returns the window since the last drain and starts a new one. */
	drainWindow(): SqlWindowSummary {
		const byFingerprint = new Map<string, SqlWindowEntry>();
		for (const [sql, entry] of this.window) {
			const fingerprint =
				sql === OVERFLOW_KEY || sql === TRANSACTION_KEY
					? sql
					: fingerprintSql(sql);
			const merged = byFingerprint.get(fingerprint);
			if (merged) {
				merged.count += entry.count;
				merged.totalMs += entry.totalMs;
				merged.maxMs = Math.max(merged.maxMs, entry.maxMs);
			} else {
				byFingerprint.set(fingerprint, { fingerprint, ...entry });
			}
		}
		const summary: SqlWindowSummary = {
			count: this.windowCount,
			totalMs: this.windowTotalMs,
			top: [...byFingerprint.values()]
				.sort((a, b) => b.totalMs - a.totalMs)
				.slice(0, WINDOW_TOP_STATEMENTS),
		};
		this.window = new Map();
		this.windowCount = 0;
		this.windowTotalMs = 0;
		return summary;
	}

	private instrumentStatement<T>(statement: T, sql: string): T {
		// query() returns its cached statement on every call: wrap it once.
		if (
			typeof statement !== "object" ||
			statement === null ||
			this.instrumented.has(statement)
		) {
			return statement;
		}
		this.instrumented.add(statement);
		const target = statement as MutableRecord;
		for (const kind of STATEMENT_METHODS) {
			const original = target[kind];
			if (typeof original !== "function") continue;
			const timer = this;
			target[kind] = function (this: unknown, ...args: unknown[]) {
				return timer.time(sql, kind, () =>
					(original as AnyFn).apply(this, args),
				);
			};
		}
		return statement;
	}

	private instrumentTransaction(transaction: AnyFn): AnyFn {
		const timed = this.timeTransaction(transaction);
		const source = transaction as unknown as MutableRecord;
		for (const variant of TRANSACTION_VARIANTS) {
			const original = source[variant];
			if (typeof original === "function") {
				Object.defineProperty(timed, variant, {
					value: this.timeTransaction(original as AnyFn),
				});
			}
		}
		if ("database" in source) {
			Object.defineProperty(timed, "database", { value: source.database });
		}
		return timed;
	}

	private timeTransaction(original: AnyFn): AnyFn {
		const timer = this;
		return function (this: unknown, ...args: unknown[]) {
			const start = timer.now();
			timer.transactionFrames.push(0);
			try {
				return original.apply(this, args);
			} finally {
				const durationMs = timer.now() - start;
				const innerSqlMs = timer.transactionFrames.pop() ?? 0;
				const parent = timer.transactionFrames.length - 1;
				if (parent >= 0) timer.transactionFrames[parent] += innerSqlMs;
				timer.record(TRANSACTION_KEY, Math.max(0, durationMs - innerSqlMs));
				if (durationMs >= timer.slowThresholdMs) {
					timer.onSlow({
						fingerprint: TRANSACTION_KEY,
						kind: "transaction",
						durationMs,
						innerSqlMs,
					});
				}
			}
		};
	}

	private time<T>(sql: string, kind: SqlStatementKind, call: () => T): T {
		const start = this.now();
		try {
			return call();
		} finally {
			const durationMs = this.now() - start;
			this.record(sql, durationMs);
			if (durationMs >= this.slowThresholdMs) {
				this.onSlow({ fingerprint: fingerprintSql(sql), kind, durationMs });
			}
		}
	}

	private record(sql: string, durationMs: number): void {
		this.windowCount++;
		this.windowTotalMs += durationMs;
		const frame = this.transactionFrames.length - 1;
		if (frame >= 0) this.transactionFrames[frame] += durationMs;

		let key = sql;
		let entry = this.window.get(key);
		if (!entry && this.window.size >= WINDOW_MAX_DISTINCT_STATEMENTS) {
			key = OVERFLOW_KEY;
			entry = this.window.get(key);
		}
		if (!entry) {
			entry = { count: 0, totalMs: 0, maxMs: 0 };
			this.window.set(key, entry);
		}
		entry.count++;
		entry.totalMs += durationMs;
		if (durationMs > entry.maxMs) entry.maxMs = durationMs;
	}
}
