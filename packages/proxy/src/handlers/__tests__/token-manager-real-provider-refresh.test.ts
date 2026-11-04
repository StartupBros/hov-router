/**
 * Request-time token refresh through the REAL Codex, xAI and Qwen providers.
 *
 * Auto-refresh used to refresh these tokens ahead of use. It was removed, so
 * getValidAccessToken is now the only path that refreshes them: when a request
 * finds its token expired, it refreshes before the upstream send. These tests
 * drive the real providers (selected by account.provider) and mock
 * global.fetch, so the provider's own error parsing is exercised end to end
 * without mock.module (which leaks across proxy test files).
 */
import { afterEach, describe, expect, it, mock } from "bun:test";
import { type AuthFailureEvt, authFailureEvents } from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import { getValidAccessToken } from "../token-manager";

const CREATED_AT = 101;

function makeAccount(id: string, provider: string): Account {
	return {
		id,
		name: id,
		provider,
		api_key: null,
		refresh_token: "rt-old",
		access_token: "at-old",
		expires_at: 1,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: CREATED_AT,
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
	};
}

/**
 * A context whose database holds `stored` as the account's durable row.
 * `persistWins: false` makes the rotation CAS lose to a writer that already
 * stored `winner`, which is what the row reads as from then on.
 */
function makeContext(
	stored: Account,
	options: { persistWins?: boolean; winner?: Partial<Account> } = {},
) {
	let current: Account = { ...stored };
	const flagCalls: Array<[string, string, number]> = [];
	const persistCalls: unknown[][] = [];
	const dbOps = {
		getAccount: mock(async (accountId: string) =>
			accountId === current.id ? { ...current } : null,
		),
		updateAccountTokensIfRefreshTokenMatches: mock(
			async (...args: unknown[]) => {
				persistCalls.push(args);
				if (options.persistWins === false) {
					current = { ...current, ...options.winner };
					return false;
				}
				return true;
			},
		),
		updateAccountTokensIfRefreshTokenAbsent: mock(async () => true),
		flagRequiresReauthIfTokenMatches: mock(
			async (
				accountId: string,
				expectedRefreshToken: string,
				expectedCreatedAt: number,
			) => {
				flagCalls.push([accountId, expectedRefreshToken, expectedCreatedAt]);
				return true;
			},
		),
		setRequiresReauth: mock(async () => {}),
	};
	return {
		ctx: {
			dbOps,
			runtime: { port: 8080, clientId: "test-client" },
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		},
		dbOps,
		flagCalls,
		persistCalls,
	};
}

function mockTokenEndpoint(body: unknown, status = 200) {
	const fetchMock = mock(
		async () =>
			new Response(typeof body === "string" ? body : JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			}),
	);
	global.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

const originalFetch = global.fetch;
afterEach(() => {
	global.fetch = originalFetch;
});

describe("getValidAccessToken refreshes an expired token before the send", () => {
	for (const provider of ["codex", "xai"] as const) {
		it(`refreshes an expired ${provider} token through the provider and persists the rotation`, async () => {
			const account = makeAccount(`${provider}-expired`, provider);
			const { ctx, persistCalls } = makeContext(account);
			const fetchMock = mockTokenEndpoint({
				access_token: "fresh-access",
				refresh_token: "fresh-refresh",
				expires_in: 3600,
			});

			await expect(getValidAccessToken(account, ctx as never)).resolves.toBe(
				"fresh-access",
			);

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(persistCalls).toEqual([
				[
					account.id,
					"rt-old",
					"fresh-access",
					expect.any(Number),
					"fresh-refresh",
					CREATED_AT,
				],
			]);
			expect(account.access_token).toBe("fresh-access");
			expect(account.refresh_token).toBe("fresh-refresh");
		});
	}

	it("returns a token that is still valid without calling the provider", async () => {
		const account = makeAccount("codex-valid", "codex");
		account.access_token = "still-valid";
		account.expires_at = Date.now() + 3_600_000;
		const { ctx } = makeContext(account);
		const fetchMock = mockTokenEndpoint({ access_token: "unused" });

		await expect(getValidAccessToken(account, ctx as never)).resolves.toBe(
			"still-valid",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("getValidAccessToken when the rotation write loses its CAS", () => {
	for (const provider of ["codex", "xai"] as const) {
		it(`serves the authoritative ${provider} token another writer stored`, async () => {
			const account = makeAccount(`${provider}-cas-loser`, provider);
			const { ctx, persistCalls } = makeContext(account, {
				persistWins: false,
				winner: {
					refresh_token: "winner-refresh",
					access_token: "authoritative-access",
					expires_at: Date.now() + 3_600_000,
				},
			});
			mockTokenEndpoint({
				access_token: "losing-access",
				refresh_token: "losing-refresh",
				expires_in: 3600,
			});

			await expect(getValidAccessToken(account, ctx as never)).resolves.toBe(
				"authoritative-access",
			);

			expect(persistCalls).toHaveLength(1);
			expect(account.access_token).toBe("authoritative-access");
			expect(account.refresh_token).toBe("winner-refresh");
		});
	}
});

describe("getValidAccessToken generation fence", () => {
	for (const provider of ["qwen", "xai", "codex"] as const) {
		it(`does not quarantine or persist over replacement generation B when ${provider} fails for A`, async () => {
			const stale = makeAccount(`${provider}-stale-generation`, provider);
			const replacement = {
				...stale,
				created_at: 202,
				refresh_token: "refresh-b",
				access_token: "access-b",
				expires_at: Date.now() + 3_600_000,
			};
			const { ctx, flagCalls, persistCalls } = makeContext(replacement);
			mockTokenEndpoint({ error: "invalid_grant" }, 400);

			await expect(
				getValidAccessToken(stale, ctx as never),
			).rejects.toBeDefined();

			expect(flagCalls).toHaveLength(0);
			expect(persistCalls).toHaveLength(0);
		});
	}
});

describe("getValidAccessToken definitive auth failure", () => {
	it("flags an xAI account whose refresh returns invalid_grant and emits the event", async () => {
		const account = makeAccount("xai-dead", "xai");
		const { ctx, flagCalls } = makeContext(account);
		mockTokenEndpoint(
			{
				error: "invalid_grant",
				error_description: "Refresh token is invalid or has been revoked.",
			},
			401,
		);
		const emitted: AuthFailureEvt[] = [];
		authFailureEvents.once("event", (event) => emitted.push(event));

		await expect(getValidAccessToken(account, ctx as never)).rejects.toThrow();

		expect(flagCalls).toEqual([["xai-dead", "rt-old", CREATED_AT]]);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toMatchObject({
			accountId: "xai-dead",
			provider: "xai",
			reason: "invalid_grant",
		});
	});

	it("flags a Codex account whose refresh returns refresh_token_reused", async () => {
		const account = makeAccount("codex-dead", "codex");
		const { ctx, flagCalls } = makeContext(account);
		mockTokenEndpoint({ error: "refresh_token_reused" }, 400);
		const emitted: AuthFailureEvt[] = [];
		authFailureEvents.once("event", (event) => emitted.push(event));

		await expect(getValidAccessToken(account, ctx as never)).rejects.toThrow();

		expect(flagCalls).toEqual([["codex-dead", "rt-old", CREATED_AT]]);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.reason).toBe("refresh_token_reused");
	});

	it("does not flag a Codex refresh that fails with a transient 503", async () => {
		const account = makeAccount("codex-transient", "codex");
		const { ctx, flagCalls } = makeContext(account);
		mockTokenEndpoint("Service Unavailable", 503);
		let emittedCount = 0;
		const listener = () => {
			emittedCount++;
		};
		authFailureEvents.on("event", listener);

		try {
			await expect(
				getValidAccessToken(account, ctx as never),
			).rejects.toThrow();
		} finally {
			authFailureEvents.off("event", listener);
		}

		expect(flagCalls).toHaveLength(0);
		expect(emittedCount).toBe(0);
	});
});
