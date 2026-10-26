import { Logger } from "@better-ccflare/logger";
import {
	fingerprintSql,
	SLOW_SQL_STATEMENT_MS,
} from "./sqlite-statement-timing";

export interface ReaderWorker {
	onmessage: ((event: MessageEvent) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
	onmessageerror: ((event: MessageEvent) => void) | null;
	postMessage(message: unknown): void;
	terminate(): void;
	unref?(): void;
}

export interface OffThreadReaderOptions {
	dbPath: string;
	busyTimeoutMs: number;
	embeddedCode: string;
	sourceUrl: string;
	workerFactory?: (specifier: string, options?: WorkerOptions) => ReaderWorker;
	createObjectURL?: (blob: Blob) => string;
	revokeObjectURL?: (url: string) => void;
	readTimeoutMs?: number;
	readyTimeoutMs?: number;
	maxSpawns?: number;
	warn?: (message: string) => void;
	info?: (message: string) => void;
}

export class OffThreadReaderUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OffThreadReaderUnavailableError";
	}
}

type PendingRead = {
	mode: "all" | "get";
	sql: string;
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};
type Lease = {
	worker: ReaderWorker;
	url?: string;
	ready: Promise<void>;
	resolveReady: () => void;
	rejectReady: (error: Error) => void;
	readyTimer?: ReturnType<typeof setTimeout>;
	retireTimer?: ReturnType<typeof setTimeout>;
	resolveRetired?: () => void;
};

let loggedReady = false;

/** A lazy read-only SQLite connection whose statements never run on the serving thread. */
export class OffThreadReader {
	private lease?: Lease;
	private readonly pending = new Map<number, PendingRead>();
	private nextId = 0;
	private faults = 0;
	private closed = false;
	private closePromise?: Promise<void>;
	private served = 0;
	private readonly warn: (message: string) => void;
	private readonly info: (message: string) => void;
	private readonly readTimeoutMs: number;
	private readonly readyTimeoutMs: number;
	private readonly maxSpawns: number;

	constructor(private readonly options: OffThreadReaderOptions) {
		const log = new Logger("OffThreadSql");
		this.warn = options.warn ?? ((message) => log.warn(message));
		this.info = options.info ?? ((message) => log.info(message));
		this.readTimeoutMs = options.readTimeoutMs ?? 120_000;
		this.readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
		this.maxSpawns = options.maxSpawns ?? 3;
	}

	get readsServed(): number {
		return this.served;
	}

	all<R>(sql: string, params: unknown[] = []): Promise<R[]> {
		return this.read("all", sql, params) as Promise<R[]>;
	}
	get<R>(sql: string, params: unknown[] = []): Promise<R | null> {
		return this.read("get", sql, params) as Promise<R | null>;
	}

	private async read(
		mode: "all" | "get",
		sql: string,
		params: unknown[],
	): Promise<unknown> {
		if (this.closed)
			throw new OffThreadReaderUnavailableError("off-thread reader closed");
		if (this.faults >= this.maxSpawns)
			throw new OffThreadReaderUnavailableError(
				"off-thread reader spawn budget exhausted",
			);
		const lease = this.lease ?? this.spawn();
		await lease.ready;
		if (this.closed || this.lease !== lease)
			throw new OffThreadReaderUnavailableError(
				"off-thread reader unavailable",
			);
		return new Promise((resolve, reject) => {
			const id = ++this.nextId;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				const error = new Error(
					`off-thread read timed out after ${this.readTimeoutMs}ms: ${fingerprintSql(sql)}`,
				);
				reject(error);
				this.fault("read timeout", error, lease);
			}, this.readTimeoutMs);
			this.pending.set(id, { mode, sql, resolve, reject, timer });
			try {
				lease.worker.postMessage({ kind: "read", id, mode, sql, params });
			} catch (error) {
				this.fault("read postMessage failed", error, lease);
			}
		});
	}

	private spawn(): Lease {
		let url: string | undefined;
		let worker: ReaderWorker;
		try {
			if (this.options.embeddedCode) {
				url = (this.options.createObjectURL ?? URL.createObjectURL)(
					new Blob(
						[Buffer.from(this.options.embeddedCode, "base64").toString("utf8")],
						{ type: "text/javascript" },
					),
				);
			}
			worker = (
				this.options.workerFactory ??
				((specifier, options) => new Worker(specifier, options))
			)(url ?? this.options.sourceUrl, { smol: true });
		} catch (error) {
			if (url) this.revoke(url);
			throw this.fault("spawn failed", error);
		}
		let resolveReady!: () => void;
		let rejectReady!: (error: Error) => void;
		const ready = new Promise<void>((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		const lease: Lease = { worker, url, ready, resolveReady, rejectReady };
		this.lease = lease;
		worker.onmessage = (event) => this.receive(lease, event.data);
		worker.onerror = (event) => {
			event.preventDefault?.();
			this.fault("worker error", event.message, lease);
		};
		worker.onmessageerror = () => {
			this.fault(
				"worker messageerror",
				"could not deserialize worker message",
				lease,
			);
		};
		lease.readyTimer = setTimeout(
			() =>
				this.fault(
					"ready timeout",
					`not ready after ${this.readyTimeoutMs}ms`,
					lease,
				),
			this.readyTimeoutMs,
		);
		try {
			worker.unref?.();
			worker.postMessage({
				kind: "open",
				dbPath: this.options.dbPath,
				busyTimeoutMs: this.options.busyTimeoutMs,
			});
		} catch (error) {
			this.fault("open postMessage failed", error, lease);
		}
		return lease;
	}

	private receive(lease: Lease, message: Record<string, unknown>): void {
		if (this.lease !== lease || !message) return;
		if (message.kind === "retired") {
			lease.resolveRetired?.();
			return;
		}
		if (this.closed) return;
		if (message.kind === "ready") {
			clearTimeout(lease.readyTimer);
			lease.resolveReady();
			if (!loggedReady) {
				loggedReady = true;
				this.info(
					`Off-thread reader ready (${lease.url ? "embedded" : "source"} worker)`,
				);
			}
			return;
		}
		if (message.kind === "open-failed") {
			this.fault("open-failed", message.error, lease);
			return;
		}
		if (message.kind !== "result") return;
		const read = this.pending.get(message.id as number);
		if (!read) return;
		this.pending.delete(message.id as number);
		clearTimeout(read.timer);
		if (Number(message.ms) >= SLOW_SQL_STATEMENT_MS)
			this.warn(
				`Slow off-thread SQL: ${Math.round(Number(message.ms))}ms ${read.mode} ${fingerprintSql(read.sql)}`,
			);
		if (message.ok) {
			this.served++;
			read.resolve(read.mode === "all" ? message.rows : (message.row ?? null));
		} else {
			const detail = message.error as {
				message: string;
				name: string;
				code?: string;
			};
			const error =
				detail.code === "SQLITE_BUSY"
					? new OffThreadReaderUnavailableError(detail.message)
					: Object.assign(new Error(detail.message), {
							name: detail.name,
							...(detail.code === undefined ? {} : { code: detail.code }),
						});
			read.reject(error);
		}
	}

	private fault(
		cause: string,
		error: unknown,
		lease?: Lease,
	): OffThreadReaderUnavailableError {
		const unavailable = new OffThreadReaderUnavailableError(
			`off-thread reader ${cause}: ${error instanceof Error ? error.message : String(error)}`,
		);
		if (lease && this.lease !== lease) return unavailable;
		this.warn(unavailable.message);
		this.faults++;
		if (lease) {
			lease.rejectReady(unavailable);
			this.rejectPending(unavailable);
			this.destroy(lease);
		}
		if (this.faults === this.maxSpawns)
			this.warn(
				"falling back to main-thread reads for the rest of this process",
			);
		return unavailable;
	}

	private rejectPending(error: Error): void {
		for (const read of this.pending.values()) {
			clearTimeout(read.timer);
			read.reject(error);
		}
		this.pending.clear();
	}
	private revoke(url: string): void {
		(this.options.revokeObjectURL ?? URL.revokeObjectURL)(url);
	}
	private destroy(lease: Lease): void {
		clearTimeout(lease.readyTimer);
		clearTimeout(lease.retireTimer);
		lease.worker.onmessage = null;
		lease.worker.onerror = null;
		lease.worker.onmessageerror = null;
		lease.worker.terminate();
		if (lease.url) this.revoke(lease.url);
		if (this.lease === lease) this.lease = undefined;
		lease.resolveRetired?.();
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		const error = new OffThreadReaderUnavailableError(
			"off-thread reader closed",
		);
		this.rejectPending(error);
		const lease = this.lease;
		if (!lease) {
			this.closePromise = Promise.resolve();
			return this.closePromise;
		}
		clearTimeout(lease.readyTimer);
		lease.rejectReady(error);
		this.closePromise = new Promise<void>((resolve) => {
			lease.resolveRetired = resolve;
			lease.retireTimer = setTimeout(resolve, 1000);
			try {
				lease.worker.postMessage({ kind: "retire" });
			} catch {
				resolve();
			}
		}).then(() => this.destroy(lease));
		return this.closePromise;
	}
}
