import { describe, expect, it } from "bun:test";
import { COMMAND_NAME } from "@better-ccflare/core/product-identity";
import type { Account } from "@better-ccflare/types";
import {
	checkAllAccountsHealth,
	formatTokenHealthReport,
	getOAuthErrorMessage,
} from "../token-health-monitor";

const DAY_MS = 24 * 60 * 60 * 1000;
const DASHBOARD =
	"open the dashboard's Accounts page and choose Re-authenticate on the account (under More actions when no button shows)";

function makeAccount(
	name: string,
	provider: string,
	tokenAgeDays: number,
	overrides: Partial<Account> = {},
): Account {
	return {
		id: `${name}-id`,
		name,
		provider,
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: 1,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now() - tokenAgeDays * DAY_MS,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

describe("getOAuthErrorMessage", () => {
	it("keeps the provider's error and points an aged Codex account at the dashboard", () => {
		const message = getOAuthErrorMessage(
			makeAccount("codex-old", "codex", 120),
			"Failed to refresh Codex token for account codex-old: HTTP 401",
		);

		expect(message).toBe(
			`OAuth tokens have expired for account 'codex-old'. To re-authenticate, ${DASHBOARD}. Original error: Failed to refresh Codex token for account codex-old: HTTP 401`,
		);
		expect(message).not.toContain("--reauthenticate");
	});

	it("does not repeat an instruction the provider error already carries", () => {
		const original = `Failed to refresh Codex token for account codex-old: HTTP 401. To re-authenticate, ${DASHBOARD}.`;
		const message = getOAuthErrorMessage(
			makeAccount("codex-old", "codex", 120),
			original,
		);

		expect(message).toBe(
			`OAuth tokens have expired for account 'codex-old'. Original error: ${original}`,
		);
	});

	it("offers the dashboard and the CLI for an aged Anthropic account", () => {
		const message = getOAuthErrorMessage(
			makeAccount("max-1", "anthropic", 89),
			"upstream said no",
		);

		expect(message).toBe(
			`OAuth tokens have expired for account 'max-1'. To re-authenticate, ${DASHBOARD}, or run \`${COMMAND_NAME} --reauthenticate max-1\`. Original error: upstream said no`,
		);
	});

	it("names only the CLI for an Anthropic account with no refresh token", () => {
		const message = getOAuthErrorMessage(
			makeAccount("max-2", "anthropic", 1, { refresh_token: null }),
			"no token",
		);

		expect(message).toBe(
			`OAuth account 'max-2' missing refresh token. To re-authenticate, run \`${COMMAND_NAME} --reauthenticate max-2\`. Original error: no token`,
		);
	});

	it("leaves a healthy account's failure as the provider reported it", () => {
		expect(
			getOAuthErrorMessage(makeAccount("codex-new", "codex", 1), "HTTP 503"),
		).toBe("OAuth token refresh failed for account 'codex-new': HTTP 503");
	});
});

describe("formatTokenHealthReport", () => {
	it("gives each account that needs re-login its own provider's instruction", () => {
		const report = formatTokenHealthReport(
			checkAllAccountsHealth([
				makeAccount("codex-old", "codex", 120),
				makeAccount("max-1", "anthropic", 120),
			]),
		);

		expect(report).toContain(`   🔄 Action required: ${DASHBOARD}`);
		expect(report).toContain(`  codex-old: ${DASHBOARD}`);
		expect(report).toContain(
			`  max-1: ${DASHBOARD}, or run \`${COMMAND_NAME} --reauthenticate max-1\``,
		);
		expect(report).not.toContain("--reauthenticate codex-old");
	});
});
