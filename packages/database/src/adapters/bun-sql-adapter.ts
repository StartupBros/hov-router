import type { Database } from "bun:sqlite";
import { OffThreadReaderUnavailableError } from "../off-thread-reader";
import {
	assertExpectedChanges,
	BatchExpectedChangesError,
	type BatchStatement,
} from "./batch-statement";

interface SqlReader {
	all<R>(sql: string, params: unknown[]): Promise<R[]>;
	get<R>(sql: string, params: unknown[]): Promise<R | null>;
}

/**
 * Which off-thread reader serves a read. Each reader runs its reads one at a
 * time, so a long analytics scan on `bulk` delays everything queued behind it.
 * `interactive` is for short, bounded reads a page waits on (#709); without an
 * interactive reader attached, they share the bulk one.
 */
export type OffThreadReadLane = "bulk" | "interactive";

/** The off-thread writer as the adapter sees it (see OffThreadWriter). */
export interface SqlWriter {
	run(sql: string, params: unknown[]): Promise<number>;
	runGet<R>(sql: string, params: unknown[]): Promise<R | null>;
	batch(statements: BatchStatement[]): Promise<number[]>;
	close(): Promise<void>;
}

/**
 * Row batch size (per DELETE statement) used by retention cleanup loops.
 * Configurable via BETTER_CCFLARE_DB_CLEANUP_BATCH_SIZE — lower this if rows
 * are large (e.g. TOASTed payload JSON) and batches are hitting the
 * statement_timeout before completing. See issue #412.
 *
 * Requires an integer: the value is bound directly into a SQL LIMIT and
 * compared against an integer deleted-row count to detect the last batch, so
 * a fractional value (e.g. 200.5) would break both.
 */
export function getCleanupBatchSize(): number {
	const requested = Number(process.env.BETTER_CCFLARE_DB_CLEANUP_BATCH_SIZE);
	return Number.isInteger(requested) && requested > 0 ? requested : 200;
}

export { BatchExpectedChangesError, type BatchStatement };

/**
 * SQL adapter over bun:sqlite, wrapping the existing synchronous Database.
 *
 * `query` and `get` read on this connection; `queryOffThread` and
 * `getOffThread` read on a reader thread when one is attached. The `run*`
 * methods write through the off-thread writer when one is attached, and on
 * this connection otherwise.
 *
 * `runBatchWithChanges` is the only atomic multi-statement write. There is no
 * general transaction: while a writer is attached this connection is
 * `query_only`, so a transaction opened here could not write.
 */
export class BunSqlAdapter {
	private readonly offThreadReaders: Partial<
		Record<OffThreadReadLane, SqlReader>
	> = {};
	private writer?: SqlWriter;

	setOffThreadReader(
		reader: SqlReader | undefined,
		lane: OffThreadReadLane = "bulk",
	): void {
		this.offThreadReaders[lane] = reader;
	}

	private readerFor(lane: OffThreadReadLane): SqlReader | undefined {
		return (
			(lane === "interactive"
				? this.offThreadReaders.interactive
				: undefined) ?? this.offThreadReaders.bulk
		);
	}

	/**
	 * Route run/runWithChanges/runBatchWithChanges/runReturningOne to an
	 * off-thread writer (#676). While one is attached the main
	 * connection is `PRAGMA query_only`, so a write that bypasses the adapter
	 * fails loudly (SQLITE_READONLY) instead of racing the writer's order.
	 */
	setWriter(writer: SqlWriter | undefined): void {
		this.writer = writer;
		this.sqliteDb.exec(`PRAGMA query_only = ${writer ? 1 : 0}`);
	}

	/**
	 * True while a writer is attached. The main connection is then query_only,
	 * so every write must go through the adapter, which falls back to the main
	 * connection itself if the writer cannot take it.
	 */
	writerAttached(): boolean {
		return this.writer !== undefined;
	}

	/** Drain and stop the writer, then hand writes back to this connection. */
	async retireWriter(): Promise<void> {
		const writer = this.writer;
		if (!writer) return;
		try {
			await writer.close();
		} finally {
			if (this.writer === writer) this.setWriter(undefined);
		}
	}

	/**
	 * Run `offThread` on the writer when one is attached. Only a write the
	 * worker never received comes back as OffThreadReaderUnavailableError; that
	 * detaches the writer for good and runs `onMain` here. Any other error,
	 * including an outcome-unknown write, propagates: re-running it could apply
	 * it twice.
	 */
	private async viaWriter<T>(
		offThread: (writer: SqlWriter) => Promise<T>,
		onMain: () => Promise<T>,
	): Promise<T> {
		const writer = this.writer;
		if (writer) {
			try {
				return await offThread(writer);
			} catch (error) {
				if (!(error instanceof OffThreadReaderUnavailableError)) throw error;
				if (this.writer === writer) this.setWriter(undefined);
			}
		}
		return onMain();
	}

	/** SELECTs only; never use for reads of uncommitted writes in a main-thread transaction. */
	async queryOffThread<R>(
		sql: string,
		params: unknown[] = [],
		lane: OffThreadReadLane = "bulk",
	): Promise<R[]> {
		const reader = this.readerFor(lane);
		if (reader) {
			try {
				return await reader.all<R>(sql, params);
			} catch (error) {
				if (!(error instanceof OffThreadReaderUnavailableError)) throw error;
			}
		}
		return this.query<R>(sql, params);
	}

	/** SELECTs only; never use for reads of uncommitted writes in a main-thread transaction. */
	async getOffThread<R>(
		sql: string,
		params: unknown[] = [],
		lane: OffThreadReadLane = "bulk",
	): Promise<R | null> {
		const reader = this.readerFor(lane);
		if (reader) {
			try {
				return await reader.get<R>(sql, params);
			} catch (error) {
				if (!(error instanceof OffThreadReaderUnavailableError)) throw error;
			}
		}
		return this.get<R>(sql, params);
	}
	/** The underlying bun:sqlite Database */
	private readonly sqliteDb: Database;

	constructor(sqliteDb: Database) {
		this.sqliteDb = sqliteDb;
	}

	/** Return the underlying bun:sqlite Database. */
	getSQLiteDb(): Database {
		return this.sqliteDb;
	}

	/**
	 * Retry a synchronous SQLite call asynchronously when the database is
	 * locked by another connection (SQLITE_BUSY / errno 5).
	 *
	 * SQLite's built-in busy_timeout retries at the C level via usleep(), which
	 * blocks the Bun event loop for the entire wait.  This wrapper instead lets
	 * the busy_timeout exhaust normally (giving the C layer a short chance to
	 * self-resolve), then catches the resulting error and re-schedules with
	 * setTimeout so the event loop stays free between attempts.  This is
	 * necessary when a long-running exclusive operation such as VACUUM is running
	 * on a separate Worker connection.
	 */
	private async withBusyRetry<T>(fn: () => T): Promise<T> {
		const deadline = Date.now() + 10 * 60 * 1000; // retry for up to 10 minutes
		while (true) {
			try {
				return fn();
			} catch (err) {
				const isBusy =
					err instanceof Error &&
					"code" in err &&
					(err as { code?: string }).code === "SQLITE_BUSY";
				if (isBusy && Date.now() < deadline) {
					await new Promise<void>((resolve) => setTimeout(resolve, 500));
					continue;
				}
				throw err;
			}
		}
	}

	/**
	 * Execute a SELECT query returning multiple rows.
	 */
	async query<R>(sqlStr: string, params: unknown[] = []): Promise<R[]> {
		const db = this.sqliteDb;
		return this.withBusyRetry(() =>
			// biome-ignore lint/suspicious/noExplicitAny: SQLite params can be any binding type
			db.query<R, any[]>(sqlStr).all(...(params as any[])),
		);
	}

	/**
	 * Execute a SELECT query returning a single row or null.
	 */
	async get<R>(sqlStr: string, params: unknown[] = []): Promise<R | null> {
		const db = this.sqliteDb;
		const result = await this.withBusyRetry(() =>
			// biome-ignore lint/suspicious/noExplicitAny: SQLite params can be any binding type
			db.query<R, any[]>(sqlStr).get(...(params as any[])),
		);
		return (result as R) ?? null;
	}

	/**
	 * Execute one DML statement with a RETURNING clause and return its row.
	 */
	async runReturningOne<R>(
		sqlStr: string,
		params: unknown[] = [],
	): Promise<R | null> {
		const db = this.sqliteDb;
		return this.viaWriter(
			(writer) => writer.runGet<R>(sqlStr, params),
			async () => {
				const result = await this.withBusyRetry(() =>
					// biome-ignore lint/suspicious/noExplicitAny: SQLite params can be any binding type
					db.query<R, any[]>(sqlStr).get(...(params as any[])),
				);
				return (result as R) ?? null;
			},
		);
	}

	/**
	 * Execute an INSERT/UPDATE/DELETE query with no return value.
	 */
	async run(sqlStr: string, params: unknown[] = []): Promise<void> {
		const db = this.sqliteDb;
		// run() resolves to void, so the two paths' results are not compared.
		await this.viaWriter<unknown>(
			(writer) => writer.run(sqlStr, params),
			// biome-ignore lint/suspicious/noExplicitAny: SQLite params can be any binding type
			() => this.withBusyRetry(() => db.run(sqlStr, params as any[])),
		);
	}

	/**
	 * Execute an INSERT/UPDATE/DELETE query and return the number of affected rows.
	 */
	async runWithChanges(
		sqlStr: string,
		params: unknown[] = [],
	): Promise<number> {
		const db = this.sqliteDb;
		return this.viaWriter(
			(writer) => writer.run(sqlStr, params),
			() =>
				this.withBusyRetry(() => {
					// `db.run().changes` includes writes made by AFTER triggers. The SQL
					// changes() function reports only the outer statement, which is the
					// count repository CAS checks.
					// biome-ignore lint/suspicious/noExplicitAny: SQLite params can be any binding type
					db.run(sqlStr, params as any[]);
					return (
						db
							.query<{ changes: number }, []>("SELECT changes() AS changes")
							.get()?.changes ?? 0
					);
				}),
		);
	}

	/** Execute a fixed DML batch atomically and return each affected-row count. */
	async runBatchWithChanges(statements: BatchStatement[]): Promise<number[]> {
		const db = this.sqliteDb;
		return this.viaWriter(
			(writer) => writer.batch(statements),
			() =>
				this.withBusyRetry(() =>
					db.transaction(() => {
						const changesQuery = db.query<{ changes: number }, []>(
							"SELECT changes() AS changes",
						);
						return statements.map((statement, index) => {
							db.run(statement.sql, (statement.params ?? []) as never[]);
							const actualChanges = changesQuery.get()?.changes ?? 0;
							assertExpectedChanges(statement, actualChanges, index);
							return actualChanges;
						});
					})(),
				),
		);
	}

	/**
	 * Execute raw SQL string (for PRAGMAs and DDL).
	 * Uses exec().
	 */
	async unsafe(sqlStr: string, params?: unknown[]): Promise<unknown> {
		if (params && params.length > 0) {
			// biome-ignore lint/suspicious/noExplicitAny: SQLite params can be any binding type
			return this.sqliteDb.run(sqlStr, params as any[]);
		}
		this.sqliteDb.exec(sqlStr);
		return;
	}

	/**
	 * Close the database connection.
	 */
	async close(): Promise<void> {
		// PRAGMA wal_checkpoint is best-effort cleanup. It can fail with
		// SQLITE_IOERR_VNODE (errno 6922) when the underlying file or its
		// -wal/-shm siblings have been unlinked by a concurrent cleanup
		// path before this close runs (e.g. a test that calls fs.unlinkSync
		// on /tmp/<test>.db in afterAll before DatabaseFactory.reset()).
		// close() must not throw — callers like DatabaseFactory.closeAll()
		// discard the returned promise via `void instance.close()`, so any
		// rejection here surfaces as an "Unhandled error between tests"
		// even though every assertion already passed.
		try {
			this.sqliteDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		} catch (error) {
			console.warn("PRAGMA wal_checkpoint failed during SQLite close:", error);
		}
		this.sqliteDb.close();
	}
}
