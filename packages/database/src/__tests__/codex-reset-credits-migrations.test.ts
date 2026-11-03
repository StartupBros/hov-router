import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../migrations";
import {
	type CodexResetCreditRow,
	CodexResetCreditsRepository,
} from "../repositories/codex-reset-credits.repository";

function addAccount(db: Database, id: string, name: string): void {
	db.prepare(
		`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, last_used, refresh_token_issued_at, custom_endpoint)
		 VALUES (?, ?, 'codex', 'r', 'a', ?, ?, ?, NULL)`,
	).run(id, name, 1000, 1000, 1000);
}

function credit(
	accountId: string,
	creditId: string,
	overrides: Partial<CodexResetCreditRow> = {},
): CodexResetCreditRow {
	return {
		accountId,
		creditId,
		resetType: "codex_rate_limit",
		status: "available",
		grantedAt: 1_000,
		expiresAt: null,
		title: "Reset",
		description: null,
		firstSeenAt: 2_000,
		lastSeenAt: 2_000,
		isBaseline: false,
		waveId: null,
		vanishedAt: null,
		vanishReason: null,
		...overrides,
	};
}

describe("codex reset credit tables", () => {
	let db: Database;
	let repo: CodexResetCreditsRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		ensureSchema(db);
		runMigrations(db);
		repo = new CodexResetCreditsRepository(new BunSqlAdapter(db));
	});

	afterEach(() => db.close());

	it("creates both tables with their keys, cascade and indexes on a fresh schema", () => {
		const pk = (table: string) =>
			(
				db.query(`PRAGMA table_info(${table})`).all() as {
					name: string;
					pk: number;
				}[]
			)
				.filter((c) => c.pk > 0)
				.sort((a, b) => a.pk - b.pk)
				.map((c) => c.name);
		expect(pk("codex_reset_credit_state")).toEqual(["account_id"]);
		expect(pk("codex_reset_credits")).toEqual(["account_id", "credit_id"]);

		const fks = (table: string) =>
			db.query(`PRAGMA foreign_key_list(${table})`).all() as {
				table: string;
				on_delete: string;
			}[];
		expect(fks("codex_reset_credit_state")).toEqual([
			expect.objectContaining({ table: "accounts", on_delete: "CASCADE" }),
		]);
		expect(fks("codex_reset_credits")).toEqual([]);

		const indexes = (
			db.query(`PRAGMA index_list(codex_reset_credits)`).all() as {
				name: string;
			}[]
		).map((i) => i.name);
		expect(indexes).toContain("idx_codex_reset_credits_account_status");
		expect(indexes).toContain("idx_codex_reset_credits_wave");
	});

	it("upgrades a database that lacks the tables and keeps its rows", () => {
		const old = new Database(":memory:");
		ensureSchema(old);
		runMigrations(old);
		old.exec("DROP TABLE codex_reset_credits");
		old.exec("DROP TABLE codex_reset_credit_state");
		addAccount(old, "acc-1", "one");
		runMigrations(old);
		const tables = (
			old
				.query(
					`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'codex_reset_credit%'`,
				)
				.all() as { name: string }[]
		)
			.map((t) => t.name)
			.sort();
		expect(tables).toEqual(["codex_reset_credit_state", "codex_reset_credits"]);
		expect(
			(old.query(`SELECT COUNT(*) AS n FROM accounts`).get() as { n: number })
				.n,
		).toBe(1);
		old.close();
	});

	it("deleting an account removes its state row and keeps its credit rows", async () => {
		addAccount(db, "acc-1", "one");
		await repo.recordCounts("acc-1", {
			availableCount: 1,
			applicableCount: 1,
			countsPresent: true,
			observedAt: 5,
		});
		await repo.insertCreditIfAbsent(credit("acc-1", "c1"));
		db.prepare(`DELETE FROM accounts WHERE id = 'acc-1'`).run();
		expect(await repo.getState("acc-1")).toBeNull();
		expect(
			await repo.listCredits("acc-1", { includeVanished: true }),
		).toHaveLength(1);
	});

	it("insertCreditIfAbsent returns 0 for an existing key and updateSeenCredit changes the status in place", async () => {
		expect(await repo.insertCreditIfAbsent(credit("acc-1", "c1"))).toBe(1);
		expect(await repo.insertCreditIfAbsent(credit("acc-1", "c1"))).toBe(0);
		expect(
			await repo.updateSeenCredit("acc-1", "c1", {
				status: "redeemed",
				resetType: "codex_rate_limit",
				grantedAt: 1_000,
				expiresAt: 9_000,
				title: "Reset",
				description: "d",
				lastSeenAt: 3_000,
			}),
		).toBe(1);
		const rows = await repo.listCredits("acc-1", { includeVanished: true });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			status: "redeemed",
			expiresAt: 9_000,
			firstSeenAt: 2_000,
			lastSeenAt: 3_000,
			isBaseline: false,
		});
		expect(typeof rows[0].grantedAt).toBe("number");
	});

	it("repoints a merged-away account's credit rows to the survivor", () => {
		db.exec(`DROP INDEX IF EXISTS idx_accounts_unique_name_provider_endpoint`);
		addAccount(db, "dup-1", "same");
		addAccount(db, "dup-2", "same");
		db.prepare(`UPDATE accounts SET last_used = 9999 WHERE id = 'dup-1'`).run();
		const ins = db.prepare(
			`INSERT INTO codex_reset_credits (account_id, credit_id, status, first_seen_at, last_seen_at)
			 VALUES (?, ?, 'available', 1, 1)`,
		);
		ins.run("dup-2", "only-on-dup");
		ins.run("dup-2", "shared");
		ins.run("dup-1", "shared");
		runMigrations(db);
		const rows = db
			.query(
				`SELECT account_id, credit_id FROM codex_reset_credits ORDER BY credit_id`,
			)
			.all();
		expect(rows).toEqual([
			{ account_id: "dup-1", credit_id: "only-on-dup" },
			{ account_id: "dup-1", credit_id: "shared" },
		]);
	});
});

describe("CodexResetCreditsRepository bookkeeping", () => {
	let db: Database;
	let repo: CodexResetCreditsRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		ensureSchema(db);
		runMigrations(db);
		addAccount(db, "acc-1", "one");
		repo = new CodexResetCreditsRepository(new BunSqlAdapter(db));
	});

	afterEach(() => db.close());

	it("recordCounts leaves list bookkeeping alone and recordListSuccess leaves counts alone", async () => {
		await repo.recordListSuccess("acc-1", {
			at: 100,
			listedAvailableCount: 4,
			listedApplicableCount: 3,
			chatgptAccountHash: "h",
			baselineAt: 100,
		});
		await repo.recordCounts("acc-1", {
			availableCount: 2,
			applicableCount: 1,
			countsPresent: true,
			observedAt: 200,
		});
		let state = await repo.getState("acc-1");
		expect(state).toMatchObject({
			availableCount: 2,
			applicableCount: 1,
			countsPresent: true,
			countsObservedAt: 200,
			listedAvailableCount: 4,
			listedApplicableCount: 3,
			lastListSuccessAt: 100,
			lastListAttemptAt: 100,
			chatgptAccountHash: "h",
			baselineAt: 100,
			updatedAt: expect.any(Number),
		});

		// a later success with a null baseline keeps the earlier baseline
		await repo.recordListSuccess("acc-1", {
			at: 300,
			listedAvailableCount: 5,
			listedApplicableCount: 5,
			chatgptAccountHash: "h",
			baselineAt: null,
		});
		state = await repo.getState("acc-1");
		expect(state).toMatchObject({
			availableCount: 2,
			applicableCount: 1,
			countsObservedAt: 200,
			listedAvailableCount: 5,
			baselineAt: 100,
			lastListSuccessAt: 300,
			listFailingSince: null,
		});
		expect(await repo.listAllStates()).toHaveLength(1);
	});

	it("recordListFailure keeps the earliest failing-since until a success clears it", async () => {
		await repo.recordListFailure("acc-1", 10);
		await repo.recordListFailure("acc-1", 20);
		let state = await repo.getState("acc-1");
		expect(state).toMatchObject({
			listFailingSince: 10,
			lastListAttemptAt: 20,
		});
		await repo.recordListSuccess("acc-1", {
			at: 30,
			listedAvailableCount: 0,
			listedApplicableCount: 0,
			chatgptAccountHash: null,
			baselineAt: null,
		});
		state = await repo.getState("acc-1");
		expect(state?.listFailingSince).toBeNull();
	});

	it("markVanished skips already-vanished rows and listings honour includeVanished", async () => {
		await repo.insertCreditIfAbsent(credit("acc-1", "a"));
		await repo.insertCreditIfAbsent(credit("acc-1", "b"));
		expect(await repo.markVanished("acc-1", [], 50, "expired")).toBe(0);
		expect(await repo.markVanished("acc-1", ["a"], 50, "expired")).toBe(1);
		expect(
			await repo.markVanished("acc-1", ["a", "b"], 60, "redeemed_elsewhere"),
		).toBe(1);
		const all = await repo.listCredits("acc-1", { includeVanished: true });
		expect(all.find((r) => r.creditId === "a")).toMatchObject({
			vanishedAt: 50,
			vanishReason: "expired",
		});
		expect(all.find((r) => r.creditId === "b")).toMatchObject({
			vanishedAt: 60,
			vanishReason: "redeemed_elsewhere",
		});
		expect(await repo.listCredits("acc-1", { includeVanished: false })).toEqual(
			[],
		);
		await repo.insertCreditIfAbsent(credit("acc-1", "c"));
		expect((await repo.listLiveCredits()).map((r) => r.creditId)).toEqual([
			"c",
		]);
	});

	it("findWaveIdNearGrant returns the nearest wave inside the window and null outside it", async () => {
		await repo.insertCreditIfAbsent(
			credit("acc-1", "w1", { grantedAt: 1_000, waveId: "wave-a" }),
		);
		await repo.insertCreditIfAbsent(
			credit("acc-1", "w2", { grantedAt: 5_000, waveId: "wave-b" }),
		);
		await repo.insertCreditIfAbsent(
			credit("acc-1", "nowave", { grantedAt: 3_000, waveId: null }),
		);
		expect(await repo.findWaveIdNearGrant(4_000, 2_000)).toBe("wave-b");
		expect(await repo.findWaveIdNearGrant(1_500, 2_000)).toBe("wave-a");
		expect(await repo.findWaveIdNearGrant(20_000, 2_000)).toBeNull();
	});
});
