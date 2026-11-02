import { Database, type Statement } from "bun:sqlite";
import {
	assertExpectedChanges,
	BatchExpectedChangesError,
	type BatchStatement,
} from "./adapters/batch-statement";

type WorkerPragma = { sql: string; bestEffort?: boolean };
type ReaderRequest =
	| {
			kind: "open";
			dbPath: string;
			busyTimeoutMs: number;
			access?: "read" | "write";
			pragmas?: WorkerPragma[];
			busyRetryMs?: number;
	  }
	| {
			kind: "read";
			id: number;
			mode: "all" | "get";
			sql: string;
			params: unknown[];
	  }
	| {
			kind: "write";
			id: number;
			mode: "run" | "get" | "batch";
			sql: string;
			params: unknown[];
			statements?: BatchStatement[];
	  }
	| { kind: "retire" };

let db: Database | undefined;
let changesQuery: Statement<{ changes: number }, []> | undefined;
let busyRetryMs = 0;

function errorDetail(error: unknown) {
	const err = error as Error & { code?: string; errno?: number };
	return {
		message: err.message ?? String(error),
		name: err.name ?? "Error",
		...(err.code === undefined ? {} : { code: err.code }),
		...(err.errno === undefined ? {} : { errno: err.errno }),
		...(error instanceof BatchExpectedChangesError
			? {
					batch: {
						statementIndex: error.statementIndex,
						expectedChanges: error.expectedChanges,
						actualChanges: error.actualChanges,
					},
				}
			: {}),
	};
}

// The main thread's adapter retries SQLITE_BUSY with a 500 ms timer for up to
// ten minutes. Blocking is this thread's job, so the same loop sleeps in place;
// later writes wait behind it, which keeps them in submission order.
function withBusyRetry<T>(fn: () => T): T {
	const deadline = Date.now() + busyRetryMs;
	while (true) {
		try {
			return fn();
		} catch (error) {
			if (
				(error as { code?: string }).code === "SQLITE_BUSY" &&
				Date.now() < deadline
			) {
				Bun.sleepSync(500);
				continue;
			}
			throw error;
		}
	}
}

function changes(handle: Database): number {
	changesQuery ??= handle.query<{ changes: number }, []>(
		"SELECT changes() AS changes",
	);
	return changesQuery.get()?.changes ?? 0;
}

function write(
	handle: Database,
	message: Extract<ReaderRequest, { kind: "write" }>,
): unknown {
	const params = message.params as never[];
	if (message.mode === "get")
		return withBusyRetry(
			() => handle.query(message.sql).get(...params) ?? null,
		);
	if (message.mode === "run")
		return withBusyRetry(() => {
			// Count only the outer statement, as the main-thread path does:
			// `db.run().changes` would include rows written by AFTER triggers.
			handle.run(message.sql, params);
			return changes(handle);
		});
	const statements = message.statements ?? [];
	return withBusyRetry(() =>
		handle.transaction(() =>
			statements.map((statement, index) => {
				handle.run(statement.sql, (statement.params ?? []) as never[]);
				const actualChanges = changes(handle);
				assertExpectedChanges(statement, actualChanges, index);
				return actualChanges;
			}),
		)(),
	);
}

function open(message: Extract<ReaderRequest, { kind: "open" }>): string[] {
	const warnings: string[] = [];
	if (message.access === "write") {
		busyRetryMs = Math.max(0, Math.trunc(message.busyRetryMs ?? 0));
		db = new Database(message.dbPath, { readwrite: true, create: false });
		for (const pragma of message.pragmas ?? []) {
			try {
				db.exec(pragma.sql);
			} catch (error) {
				if (!pragma.bestEffort) throw error;
				warnings.push(
					`${pragma.sql}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return warnings;
	}
	db = new Database(message.dbPath, { readonly: true });
	db.exec(
		`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(message.busyTimeoutMs))}`,
	);
	db.exec("PRAGMA cache_size = -16384");
	// As in vacuum-worker, avoid mapping a multi-GiB file into this worker.
	db.exec("PRAGMA mmap_size = 0");
	db.exec("PRAGMA temp_store = FILE");
	return warnings;
}

// SQLite statements run synchronously: messages execute in arrival order.
self.onmessage = (event: MessageEvent<ReaderRequest>) => {
	const message = event.data;
	if (message.kind === "open") {
		try {
			const warnings = open(message);
			self.postMessage(
				warnings.length > 0 ? { kind: "ready", warnings } : { kind: "ready" },
			);
		} catch (error) {
			changesQuery = undefined;
			db?.close();
			db = undefined;
			self.postMessage({
				kind: "open-failed",
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return;
	}
	if (message.kind === "retire") {
		changesQuery = undefined;
		db?.close();
		db = undefined;
		self.postMessage({ kind: "retired" });
		self.close();
		return;
	}
	const start = performance.now();
	if (message.kind === "write") {
		try {
			if (!db) throw new Error("off-thread writer database is not open");
			const value = write(db, message);
			self.postMessage({
				kind: "result",
				id: message.id,
				ok: true,
				value,
				ms: performance.now() - start,
			});
		} catch (error) {
			self.postMessage({
				kind: "result",
				id: message.id,
				ok: false,
				error: errorDetail(error),
				ms: performance.now() - start,
			});
		}
		return;
	}
	try {
		if (!db) throw new Error("off-thread reader database is not open");
		const statement = db.query(message.sql);
		const params = message.params as never[];
		const result =
			message.mode === "all"
				? { rows: statement.all(...params) }
				: { row: statement.get(...params) ?? null };
		self.postMessage({
			kind: "result",
			id: message.id,
			ok: true,
			...result,
			ms: performance.now() - start,
		});
	} catch (error) {
		const err = error as Error & { code?: string };
		self.postMessage({
			kind: "result",
			id: message.id,
			ok: false,
			error: {
				message: err.message ?? String(error),
				name: err.name ?? "Error",
				...(err.code === undefined ? {} : { code: err.code }),
			},
			ms: performance.now() - start,
		});
	}
};
