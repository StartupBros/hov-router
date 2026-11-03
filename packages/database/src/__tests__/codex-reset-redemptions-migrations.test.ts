import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../migrations";
import { CodexResetRedemptionsRepository } from "../repositories/codex-reset-redemptions.repository";

function addAccount(db: Database, id: string, name: string): void {
	db.prepare(
		`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, last_used, refresh_token_issued_at, custom_endpoint)
		 VALUES (?, ?, 'codex', 'r', 'a', ?, ?, ?, NULL)`,
	).run(id, name, 1000, 1000, 1000);
}

const pending = (
	requestId: string,
	accountId = "acc-1",
	creditId: string | null = "credit-a",
) => ({
	requestId,
	accountId,
	creditId,
	availableBefore: 2,
	at: 10_000,
});

describe("codex_reset_redemptions table", () => {
	let db: Database;
	let repo: CodexResetRedemptionsRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		ensureSchema(db);
		runMigrations(db);
		repo = new CodexResetRedemptionsRepository(new BunSqlAdapter(db));
	});

	afterEach(() => db.close());

	it("creates the table keyed by request id, with no foreign key and the open-row index", () => {
		const cols = db
			.query(`PRAGMA table_info(codex_reset_redemptions)`)
			.all() as { name: string; pk: number }[];
		expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual([
			"request_id",
		]);
		expect(cols.map((c) => c.name)).toEqual(
			expect.arrayContaining([
				"account_id",
				"credit_id",
				"state",
				"code",
				"windows_reset",
				"http_status",
				"available_before",
				"available_after",
				"requested_at",
				"attempted_at",
				"completed_at",
				"attempts",
			]),
		);
		expect(
			db.query(`PRAGMA foreign_key_list(codex_reset_redemptions)`).all(),
		).toEqual([]);
		const index = db
			.query(
				`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_codex_reset_redemptions_open_account'`,
			)
			.get() as { sql: string } | null;
		expect(index?.sql).toContain("UNIQUE");
		expect(index?.sql).toContain("'pending', 'unknown', 'retryable'");
	});

	it("upgrades a database that lacks the table and keeps its rows", () => {
		const old = new Database(":memory:");
		ensureSchema(old);
		runMigrations(old);
		old.exec("DROP TABLE codex_reset_redemptions");
		addAccount(old, "acc-1", "one");
		runMigrations(old);
		expect(
			old
				.query(
					`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_reset_redemptions'`,
				)
				.get(),
		).toEqual({ name: "codex_reset_redemptions" });
		expect(
			(old.query(`SELECT COUNT(*) AS n FROM accounts`).get() as { n: number })
				.n,
		).toBe(1);
		old.close();
	});

	it("rejects a state outside the known set", () => {
		expect(() =>
			db
				.prepare(
					`INSERT INTO codex_reset_redemptions (request_id, account_id, state, requested_at, attempted_at)
					 VALUES ('r', 'acc-1', 'bogus', 1, 1)`,
				)
				.run(),
		).toThrow();
	});

	it("inserts a pending row once and returns the existing row for the same request", async () => {
		const first = await repo.insertPending(pending("req-1"));
		expect(first.result).toBe("created");
		expect(first.row).toMatchObject({
			requestId: "req-1",
			accountId: "acc-1",
			creditId: "credit-a",
			state: "pending",
			availableBefore: 2,
			requestedAt: 10_000,
			attemptedAt: 10_000,
			completedAt: null,
			attempts: 1,
		});

		const again = await repo.insertPending({
			...pending("req-1"),
			availableBefore: 1,
			at: 20_000,
		});
		expect(again.result).toBe("exists");
		expect(again.row?.availableBefore).toBe(2);
		expect(again.row?.requestedAt).toBe(10_000);
	});

	it("reports the same request id with a different account or credit as a conflict", async () => {
		await repo.insertPending(pending("req-1"));
		expect((await repo.insertPending(pending("req-1", "acc-2"))).result).toBe(
			"conflict",
		);
		expect(
			(await repo.insertPending(pending("req-1", "acc-1", "credit-b"))).result,
		).toBe("conflict");
		expect(
			(await repo.insertPending(pending("req-1", "acc-1", null))).result,
		).toBe("conflict");
	});

	it("lets one of two request ids for one account open a row; the other loses", async () => {
		const [a, b] = await Promise.all([
			repo.insertPending(pending("req-a")),
			repo.insertPending(pending("req-b")),
		]);
		const results = [a.result, b.result].sort();
		expect(results).toEqual(["created", "lost"]);
		const loser = a.result === "lost" ? a : b;
		const winner = a.result === "created" ? a : b;
		expect(loser.row?.requestId).toBe(winner.row?.requestId);
		const open = db
			.query(
				`SELECT COUNT(*) AS n FROM codex_reset_redemptions WHERE account_id = 'acc-1'`,
			)
			.get() as { n: number };
		expect(open.n).toBe(1);
	});

	it("finds the account's open row in pending, unknown or retryable, and none once it closes", async () => {
		await repo.insertPending(pending("req-1"));
		expect((await repo.findOpenForAccount("acc-1"))?.requestId).toBe("req-1");

		for (const state of ["unknown", "retryable"] as const) {
			const row = await repo.findByRequestId("req-1");
			expect(
				await repo.recordOutcome("req-1", {
					attemptedAt: row?.attemptedAt ?? 0,
					state,
					code: null,
					windowsReset: null,
					httpStatus: state === "retryable" ? 429 : 502,
					at: 11_000,
				}),
			).toBe(1);
			expect((await repo.findOpenForAccount("acc-1"))?.state).toBe(state);
			expect(
				await repo.claimResend("req-1", {
					expectedState: state,
					expectedAttemptedAt: row?.attemptedAt ?? 0,
					at: (row?.attemptedAt ?? 0) + 1,
				}),
			).toBe(1);
		}

		const row = await repo.findByRequestId("req-1");
		expect(row).toMatchObject({ state: "pending", attempts: 3 });
		expect(
			await repo.recordOutcome("req-1", {
				attemptedAt: row?.attemptedAt ?? 0,
				state: "done",
				code: "reset",
				windowsReset: 2,
				httpStatus: 200,
				at: 12_000,
			}),
		).toBe(1);
		expect(await repo.findOpenForAccount("acc-1")).toBeNull();
		expect(await repo.findByRequestId("req-1")).toMatchObject({
			state: "done",
			code: "reset",
			windowsReset: 2,
			httpStatus: 200,
			completedAt: 12_000,
		});
		expect((await repo.insertPending(pending("req-2"))).result).toBe("created");
	});

	it("refuses to move a row out of done and refuses a stale attempt's outcome", async () => {
		await repo.insertPending(pending("req-1"));
		const row = await repo.findByRequestId("req-1");
		const attemptedAt = row?.attemptedAt ?? 0;
		expect(
			await repo.recordOutcome("req-1", {
				attemptedAt: attemptedAt + 5,
				state: "done",
				code: "reset",
				windowsReset: 1,
				httpStatus: 200,
				at: 12_000,
			}),
		).toBe(0);
		await repo.recordOutcome("req-1", {
			attemptedAt,
			state: "done",
			code: "reset",
			windowsReset: 1,
			httpStatus: 200,
			at: 12_000,
		});
		expect(
			await repo.recordOutcome("req-1", {
				attemptedAt,
				state: "refused",
				code: null,
				windowsReset: null,
				httpStatus: 403,
				at: 13_000,
			}),
		).toBe(0);
		expect(
			await repo.claimResend("req-1", {
				expectedState: "done",
				expectedAttemptedAt: attemptedAt,
				at: 14_000,
			}),
		).toBe(0);
		expect((await repo.findByRequestId("req-1"))?.state).toBe("done");
	});

	it("lets only one of two resend claims on the same row win", async () => {
		await repo.insertPending(pending("req-1"));
		const row = await repo.findByRequestId("req-1");
		await repo.recordOutcome("req-1", {
			attemptedAt: row?.attemptedAt ?? 0,
			state: "unknown",
			code: null,
			windowsReset: null,
			httpStatus: null,
			at: 11_000,
		});
		const claim = () =>
			repo.claimResend("req-1", {
				expectedState: "unknown",
				expectedAttemptedAt: row?.attemptedAt ?? 0,
				at: 20_000,
			});
		const changes = await Promise.all([claim(), claim()]);
		expect(changes.sort()).toEqual([0, 1]);
	});

	it("records the count after only on a done row and never touches the count before", async () => {
		await repo.insertPending(pending("req-1"));
		expect(await repo.recordAvailableAfter("req-1", 1)).toBe(0);
		const row = await repo.findByRequestId("req-1");
		await repo.recordOutcome("req-1", {
			attemptedAt: row?.attemptedAt ?? 0,
			state: "done",
			code: "reset",
			windowsReset: 1,
			httpStatus: 200,
			at: 12_000,
		});
		expect(await repo.recordAvailableAfter("req-1", 1)).toBe(1);
		expect(await repo.findByRequestId("req-1")).toMatchObject({
			availableBefore: 2,
			availableAfter: 1,
		});
	});

	it("names the credits the router redeemed", async () => {
		const done = async (
			requestId: string,
			creditId: string | null,
			code: string,
			state: "done" | "refused" = "done",
		) => {
			await repo.insertPending(pending(requestId, "acc-1", creditId));
			const row = await repo.findByRequestId(requestId);
			await repo.recordOutcome(requestId, {
				attemptedAt: row?.attemptedAt ?? 0,
				state,
				code: state === "done" ? code : null,
				windowsReset: null,
				httpStatus: state === "done" ? 200 : 403,
				at: 12_000,
			});
		};
		await done("r1", "c-reset", "reset");
		await done("r2", "c-already", "already_redeemed");
		await done("r3", "c-nothing", "nothing_to_reset");
		await done("r4", "c-refused", "", "refused");
		await done("r5", null, "reset");
		await repo.insertPending(pending("r6", "acc-1", "c-open"));
		expect(
			(
				await repo.findRouterRedeemedCreditIds("acc-1", [
					"c-reset",
					"c-already",
					"c-nothing",
					"c-refused",
					"c-open",
					"c-unknown",
				])
			).sort(),
		).toEqual(["c-already", "c-reset"]);
		expect(await repo.findRouterRedeemedCreditIds("acc-1", [])).toEqual([]);
		expect(
			await repo.findRouterRedeemedCreditIds("acc-2", ["c-reset"]),
		).toEqual([]);
	});

	it("repoints a merged-away account's redemptions and abandons the open row that would collide", () => {
		db.exec(`DROP INDEX IF EXISTS idx_accounts_unique_name_provider_endpoint`);
		addAccount(db, "dup-1", "same");
		addAccount(db, "dup-2", "same");
		addAccount(db, "dup-3", "same");
		db.prepare(`UPDATE accounts SET last_used = 9999 WHERE id = 'dup-2'`).run();
		const ins = db.prepare(
			`INSERT INTO codex_reset_redemptions (request_id, account_id, credit_id, state, requested_at, attempted_at)
			 VALUES (?, ?, 'c', ?, 1, 1)`,
		);
		ins.run("closed-on-1", "dup-1", "done");
		ins.run("open-on-1", "dup-1", "unknown");
		ins.run("open-on-3", "dup-3", "retryable");
		runMigrations(db);
		const rows = db
			.query(
				`SELECT request_id, account_id, state FROM codex_reset_redemptions ORDER BY request_id`,
			)
			.all();
		expect(rows).toEqual([
			{ request_id: "closed-on-1", account_id: "dup-2", state: "done" },
			{ request_id: "open-on-1", account_id: "dup-2", state: "unknown" },
			{ request_id: "open-on-3", account_id: "dup-2", state: "abandoned" },
		]);
		const abandoned = db
			.query(
				`SELECT completed_at FROM codex_reset_redemptions WHERE request_id = 'open-on-3'`,
			)
			.get() as { completed_at: number | null };
		expect(abandoned.completed_at).not.toBeNull();
	});

	it("keeps the survivor's own open row and abandons every merged-away open row", () => {
		db.exec(`DROP INDEX IF EXISTS idx_accounts_unique_name_provider_endpoint`);
		addAccount(db, "dup-1", "same");
		addAccount(db, "dup-2", "same");
		db.prepare(`UPDATE accounts SET last_used = 9999 WHERE id = 'dup-2'`).run();
		const ins = db.prepare(
			`INSERT INTO codex_reset_redemptions (request_id, account_id, credit_id, state, requested_at, attempted_at)
			 VALUES (?, ?, 'c', ?, 1, 1)`,
		);
		ins.run("open-on-survivor", "dup-2", "pending");
		ins.run("open-on-1", "dup-1", "pending");
		runMigrations(db);
		expect(
			db
				.query(
					`SELECT request_id, account_id, state FROM codex_reset_redemptions ORDER BY request_id`,
				)
				.all(),
		).toEqual([
			{ request_id: "open-on-1", account_id: "dup-2", state: "abandoned" },
			{
				request_id: "open-on-survivor",
				account_id: "dup-2",
				state: "pending",
			},
		]);
	});
});
