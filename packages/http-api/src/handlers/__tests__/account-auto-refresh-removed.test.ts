/**
 * Auto-refresh was removed. For one release the endpoint keeps answering: it
 * can turn the stored setting off but never on, and every account read reports
 * autoRefreshEnabled false whatever the column holds.
 *
 * These run the real handlers against a real in-memory database.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import { DatabaseOperations } from "@better-ccflare/database";
import { toAccountResponse } from "@better-ccflare/types";
import {
	createAccountAutoRefreshHandler,
	createAccountsListHandler,
} from "../accounts";

const config = {
	getUsageThrottlingFiveHourEnabled: () => false,
	getUsageThrottlingWeeklyEnabled: () => false,
} as unknown as Config;

let dbOps: DatabaseOperations;

beforeEach(() => {
	dbOps = new DatabaseOperations(":memory:", { walMode: false });
});

afterEach(async () => {
	await dbOps.close();
});

async function insertAccount(
	id: string,
	provider: string,
	autoRefreshEnabled: 0 | 1,
): Promise<void> {
	await dbOps.getAdapter().run(
		`INSERT INTO accounts
			(id, name, provider, refresh_token, access_token, expires_at, created_at, auto_refresh_enabled)
		 VALUES (?, ?, ?, 'rt-fixture', 'at-fixture', ?, ?, ?)`,
		[
			id,
			id,
			provider,
			Date.now() + 60 * 60 * 1000,
			Date.now(),
			autoRefreshEnabled,
		],
	);
}

async function storedValue(id: string): Promise<number> {
	const row = await dbOps
		.getAdapter()
		.get<{ auto_refresh_enabled: number }>(
			"SELECT auto_refresh_enabled FROM accounts WHERE id = ?",
			[id],
		);
	if (!row) throw new Error(`account ${id} not found`);
	return row.auto_refresh_enabled;
}

async function post(
	id: string,
	body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await createAccountAutoRefreshHandler(dbOps)(
		new Request(`http://localhost/api/accounts/${id}/auto-refresh`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		id,
	);
	return {
		status: response.status,
		body: (await response.json()) as Record<string, unknown>,
	};
}

describe("POST /api/accounts/:id/auto-refresh after the removal", () => {
	it("answers success to a turn-on, stores nothing, and the account still reads false", async () => {
		await insertAccount("acct-off", "anthropic", 0);
		await insertAccount("acct-on", "anthropic", 1);

		for (const id of ["acct-off", "acct-on"]) {
			const res = await post(id, { enabled: true });
			expect(res.status).toBe(200);
			expect(res.body.success).toBe(true);
			expect(res.body.autoRefreshEnabled).toBe(false);
			expect(String(res.body.message)).toContain("Auto-refresh was removed");
		}
		expect(await storedValue("acct-off")).toBe(0);
		expect(await storedValue("acct-on")).toBe(1);

		const list = await createAccountsListHandler(dbOps, config)();
		const accounts = (await list.json()) as Array<{
			id: string;
			autoRefreshEnabled: boolean;
		}>;
		expect(
			accounts
				.filter((account) => account.id.startsWith("acct-"))
				.map((account) => [account.id, account.autoRefreshEnabled]),
		).toEqual([
			["acct-off", false],
			["acct-on", false],
		]);
	});

	it("clears a stored value when turned off with false or 0, and says so", async () => {
		await insertAccount("acct-false", "anthropic", 1);
		await insertAccount("acct-zero", "codex", 1);

		const byFalse = await post("acct-false", { enabled: false });
		const byZero = await post("acct-zero", { enabled: 0 });

		for (const res of [byFalse, byZero]) {
			expect(res.status).toBe(200);
			expect(res.body.autoRefreshEnabled).toBe(false);
			expect(String(res.body.message)).toContain("stored setting was cleared");
		}
		expect(await storedValue("acct-false")).toBe(0);
		expect(await storedValue("acct-zero")).toBe(0);
	});

	it("says nothing was cleared when the stored value was already off", async () => {
		await insertAccount("acct-off", "anthropic", 0);

		const res = await post("acct-off", { enabled: false });

		expect(res.status).toBe(200);
		expect(String(res.body.message)).not.toContain(
			"stored setting was cleared",
		);
		expect(await storedValue("acct-off")).toBe(0);
	});

	it("lets an account of any provider turn it off", async () => {
		await insertAccount("acct-compatible", "openai-compatible", 1);

		const res = await post("acct-compatible", { enabled: false });

		expect(res.status).toBe(200);
		expect(await storedValue("acct-compatible")).toBe(0);
	});

	it("answers 400 to a missing or invalid enabled value and 404 to an unknown account", async () => {
		await insertAccount("acct-on", "anthropic", 1);

		for (const body of [
			{},
			{ enabled: "yes" },
			{ enabled: 2 },
			{ enabled: null },
		]) {
			expect((await post("acct-on", body)).status).toBe(400);
		}
		expect(await storedValue("acct-on")).toBe(1);
		expect((await post("no-such-account", { enabled: false })).status).toBe(
			404,
		);
	});
});

describe("account read mappers after the removal", () => {
	it("report autoRefreshEnabled false for an account whose stored value is on", async () => {
		await insertAccount("acct-on", "anthropic", 1);
		const account = (await dbOps.getAllAccounts()).find(
			(candidate) => candidate.id === "acct-on",
		);
		if (!account) throw new Error("account not read back");

		expect(account.auto_refresh_enabled).toBe(true);
		expect(toAccountResponse(account).autoRefreshEnabled).toBe(false);
	});
});
