import { Database } from "bun:sqlite";

type ReaderRequest =
	| { kind: "open"; dbPath: string; busyTimeoutMs: number }
	| {
			kind: "read";
			id: number;
			mode: "all" | "get";
			sql: string;
			params: unknown[];
	  }
	| { kind: "retire" };

let db: Database | undefined;
// SQLite statements run synchronously: messages execute in arrival order.
self.onmessage = (event: MessageEvent<ReaderRequest>) => {
	const message = event.data;
	if (message.kind === "open") {
		try {
			db = new Database(message.dbPath, { readonly: true });
			db.exec(
				`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(message.busyTimeoutMs))}`,
			);
			db.exec("PRAGMA cache_size = -16384");
			// As in vacuum-worker, avoid mapping a multi-GiB file into this worker.
			db.exec("PRAGMA mmap_size = 0");
			db.exec("PRAGMA temp_store = FILE");
			self.postMessage({ kind: "ready" });
		} catch (error) {
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
		db?.close();
		db = undefined;
		self.postMessage({ kind: "retired" });
		self.close();
		return;
	}
	const start = performance.now();
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
