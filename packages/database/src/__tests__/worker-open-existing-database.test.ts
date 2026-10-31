/**
 * Maintenance workers open the database the main connection owns and never
 * create one (#668). On 10-28 the production file was deleted under the
 * running backend; a default-flag open in the incremental-vacuum worker
 * created an empty file at the path, and the vacuum kind then refused with a
 * misleading "auto_vacuum=0" while the backend wrote to the deleted original.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseOperations } from "../database-operations";

type WorkerResult = { ok: boolean; error?: string };

function roundTrip(
	workerFile: string,
	message: unknown,
): Promise<WorkerResult> {
	const worker = new Worker(new URL(workerFile, import.meta.url).href);
	return new Promise<WorkerResult>((resolve, reject) => {
		worker.onmessage = (event: MessageEvent) => resolve(event.data);
		worker.onerror = (event: ErrorEvent) =>
			reject(new Error(event.message ?? "worker error"));
		worker.postMessage(message);
	}).finally(() => worker.terminate());
}

const CASES = [
	{
		workerFile: "../incremental-vacuum-worker.ts",
		message: { kind: "vacuum", pages: 1, synchronous: "NORMAL" },
	},
	{
		workerFile: "../incremental-vacuum-worker.ts",
		message: { kind: "optimize" },
	},
	{
		workerFile: "../vacuum-worker.ts",
		message: { kind: "compact", busyTimeoutMs: 100 },
	},
] as const;

describe("maintenance workers open an existing database only (#668)", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccflare-open-existing-"));
		dbPath = path.join(tmpDir, "test.db");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	for (const { workerFile, message } of CASES) {
		it(`kind "${message.kind}" refuses a missing file and creates nothing`, async () => {
			const result = await roundTrip(workerFile, { ...message, dbPath });

			expect(result.ok).toBe(false);
			expect(result.error).toContain(`database file missing at ${dbPath}`);
			expect(fs.readdirSync(tmpDir)).toEqual([]);
		});

		it(`kind "${message.kind}" still runs on an existing database`, async () => {
			await new DatabaseOperations(dbPath).close();

			const result = await roundTrip(workerFile, { ...message, dbPath });

			expect(result).toMatchObject({ ok: true });
		});
	}
});
