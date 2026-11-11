import { describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import { reauthenticateAccount } from "../account";

function dbOpsWith(provider: string) {
	return {
		getAdapter: () => ({
			get: async () => ({
				id: "account-1",
				provider,
				priority: 0,
				custom_endpoint: null,
				api_key: null,
			}),
		}),
	};
}

describe("reauthenticateAccount for a provider the CLI cannot sign in", () => {
	it("sends a Codex account to the dashboard instead of failing bare", async () => {
		const result = await reauthenticateAccount(
			dbOpsWith("codex") as never,
			{} as Config,
			"work-1",
		);

		expect(result.success).toBe(false);
		expect(result.message).toBe(
			"Account 'work-1' (codex) cannot be re-authenticated from the CLI. To re-authenticate, open the dashboard's Accounts page and choose Re-authenticate on the account (under More actions when no button shows).",
		);
	});

	it("tells an API-key provider to remove and re-add the account", async () => {
		const result = await reauthenticateAccount(
			dbOpsWith("openrouter") as never,
			{} as Config,
			"router-1",
		);

		expect(result.success).toBe(false);
		expect(result.message).toBe(
			"Account 'router-1' (openrouter) cannot be re-authenticated from the CLI. To re-authenticate, remove the account and add it again.",
		);
	});
});
