import { expect, spyOn, test } from "bun:test";
import { DatabaseOperations } from "../database-operations";

test("retirement clears only its heartbeat and is idempotent", async () => {
	const db = new DatabaseOperations(":memory:");
	try {
		await db.initializeAsync();
		const adapter = db.getAdapter();
		await adapter.run(
			"INSERT INTO instance_heartbeats SELECT 'peer', hostname, pid, started_at, last_heartbeat, node_version, db_dialect FROM instance_heartbeats LIMIT 1",
		);
		expect(
			(await adapter.query("SELECT * FROM instance_heartbeats")).length,
		).toBe(2);
		await db.retireInstanceHeartbeat();
		await db.retireInstanceHeartbeat();
		expect(
			(
				await adapter.query<{ instance_id: string }>(
					"SELECT instance_id FROM instance_heartbeats",
				)
			).map((r) => r.instance_id),
		).toEqual(["peer"]);
	} finally {
		await db.close();
	}
});

for (const kind of ["reject", "hang"] as const) {
	test(`retirement bounds and logs a ${kind}ing heartbeat stop`, async () => {
		const db = new DatabaseOperations(":memory:");
		const warn = spyOn(console, "warn");
		// Fault injection at the owned stop boundary; never a provider request.
		(db as unknown as { heartbeatStop: () => Promise<void> }).heartbeatStop =
			() =>
				kind === "reject"
					? Promise.reject(new Error("planted stop failure"))
					: new Promise(() => {});
		const start = Date.now();
		try {
			await db.retireInstanceHeartbeat();
			expect(Date.now() - start).toBeLessThan(1500);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
			await db.close();
		}
	});
}

test("heartbeat deletion never blocks listener handoff on a SQLite writer lock", async () => {
	const { Database } = await import("bun:sqlite");
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = mkdtempSync(join(tmpdir(), "heartbeat-lock-"));
	const file = join(dir, "test.db");
	const db = new DatabaseOperations(file, { busyTimeoutMs: 1800 });
	await db.initializeAsync();
	const writer = new Database(file);
	writer.run("BEGIN IMMEDIATE");
	try {
		const start = Date.now();
		await db.retireInstanceHeartbeat();
		expect(Date.now() - start).toBeLessThan(1500);
		expect(
			db.getAdapter().getSQLiteDb().query("PRAGMA busy_timeout").get(),
		).toEqual({ timeout: 1800 });
	} finally {
		writer.run("ROLLBACK");
		writer.close();
		await db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
