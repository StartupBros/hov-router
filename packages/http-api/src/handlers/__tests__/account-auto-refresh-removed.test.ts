/**
 * Auto-refresh was removed in 4.0.0, and 5.0.0 drops the autoRefreshEnabled
 * field from account responses. The auto_refresh_enabled column stays and is
 * never read for output; a stored value that is on must not reappear.
 *
 * These run the real handlers against a real in-memory database. The 410 for
 * the removed toggle endpoint is covered in router-removed-endpoints.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import { DatabaseOperations } from "@better-ccflare/database";
import { toAccountResponse } from "@better-ccflare/types";
import { createAccountsListHandler } from "../accounts";

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
	storedAutoRefresh: 0 | 1,
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
			storedAutoRefresh,
		],
	);
}

describe("account responses after the auto-refresh removal", () => {
	it("GET /api/accounts has no autoRefreshEnabled key, whatever the column holds", async () => {
		await insertAccount("acct-off", "anthropic", 0);
		await insertAccount("acct-on", "codex", 1);

		const list = await createAccountsListHandler(dbOps, config)();
		expect(list.status).toBe(200);
		const accounts = (await list.json()) as Array<Record<string, unknown>>;
		const fixtures = accounts.filter((account) =>
			String(account.id).startsWith("acct-"),
		);

		expect(fixtures.map((account) => account.id).sort()).toEqual([
			"acct-off",
			"acct-on",
		]);
		for (const account of fixtures) {
			expect(account).toHaveProperty("autoFallbackEnabled");
			expect(account).not.toHaveProperty("autoRefreshEnabled");
		}
	});

	it("toAccountResponse has no autoRefreshEnabled key for an account whose stored value is on", async () => {
		await insertAccount("acct-on", "anthropic", 1);
		const account = (await dbOps.getAllAccounts()).find(
			(candidate) => candidate.id === "acct-on",
		);
		if (!account) throw new Error("account not read back");

		expect(account.auto_refresh_enabled).toBe(true);
		const response = toAccountResponse(account);
		expect(response).toHaveProperty("autoFallbackEnabled");
		expect(response).not.toHaveProperty("autoRefreshEnabled");
	});
});
