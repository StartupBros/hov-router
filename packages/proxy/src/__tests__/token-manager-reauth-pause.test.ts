/** Tests for upstream auth quarantine and terminal refresh handling. */

import { describe, expect, it, mock } from "bun:test";
import {
	OAuthRefreshTokenError,
	TokenRefreshError,
} from "@better-ccflare/core";
import { registerProvider } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import {
	canAttemptStaleTokenRefresh,
	clearAccountRefreshCache,
	clearStaleTokenRefreshState,
	isStaleTokenRefreshCoolingDown,
	isTerminalTokenRefreshFailure,
	pauseAccountForUpstreamAuthFailure,
	refreshAccessTokenSafe,
	tryAcquireStaleTokenRefresh,
	upstreamAuthFailureReason,
} from "../handlers/token-manager";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "test-reauth-provider",
		api_key: null,
		refresh_token: "rt-original",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
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
		auto_refresh_enabled: true,
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

class ReceiverBoundDbOps {
	calls: Array<[string, string, string | undefined]> = [];

	async pauseAccountIfActive(
		accountId: string,
		reason: string,
		expectedRefreshToken?: string,
	): Promise<boolean> {
		this.calls.push([accountId, reason, expectedRefreshToken]);
		return true;
	}
}

describe("upstream auth quarantine and terminal refresh classification", () => {
	it("invokes receiver-bound database pause methods with their owner", async () => {
		const dbOps = new ReceiverBoundDbOps();
		const account = makeAccount({
			provider: "codex",
			refresh_token: "rt-revoked",
		});

		await expect(
			pauseAccountForUpstreamAuthFailure(account, dbOps, "rt-revoked"),
		).resolves.toBe(true);

		expect(dbOps.calls).toEqual([
			[account.id, "oauth_invalid_grant", "rt-revoked"],
		]);
	});

	it("maps OAuth upstream 401s to the re-auth pause reason", async () => {
		const pauseAccountIfActive = mock(async () => true);
		const account = makeAccount({
			provider: "codex",
			refresh_token: "rt-upstream",
		});

		expect(upstreamAuthFailureReason(account)).toBe("oauth_invalid_grant");
		await expect(
			pauseAccountForUpstreamAuthFailure(account, { pauseAccountIfActive }),
		).resolves.toBe(true);
		expect(pauseAccountIfActive).toHaveBeenCalledWith(
			account.id,
			"oauth_invalid_grant",
			"rt-upstream",
			account.created_at,
		);
	});

	it("quarantines API-key upstream 401s without suggesting OAuth re-auth", async () => {
		const pauseAccountIfActive = mock(async () => true);
		const account = makeAccount({
			provider: "openai-compatible",
			refresh_token: "",
			api_key: "sk-test",
		});

		expect(upstreamAuthFailureReason(account)).toBe("auth_failure");
		await expect(
			pauseAccountForUpstreamAuthFailure(account, { pauseAccountIfActive }),
		).resolves.toBe(true);
		expect(pauseAccountIfActive).toHaveBeenCalledWith(
			account.id,
			"auth_failure",
			undefined,
			account.created_at,
		);
	});

	it("treats blank refresh tokens as API-key auth failures", () => {
		expect(
			upstreamAuthFailureReason(makeAccount({ refresh_token: "  " })),
		).toBe("auth_failure");
	});

	it("preserves an explicit null credential snapshot for the quarantine CAS", async () => {
		const pauseAccountIfActive = mock(async () => true);
		const account = makeAccount({
			provider: "openai-compatible",
			refresh_token: null,
		});

		await pauseAccountForUpstreamAuthFailure(
			account,
			{ pauseAccountIfActive },
			null,
		);

		expect(pauseAccountIfActive).toHaveBeenCalledWith(
			account.id,
			"auth_failure",
			null,
			account.created_at,
		);
	});

	it("preserves the exact nonblank refresh token for the pause CAS guard", async () => {
		const pauseAccountIfActive = mock(async () => true);
		const account = makeAccount({
			provider: "anthropic",
			refresh_token: " rt-with-padding ",
		});

		await expect(
			pauseAccountForUpstreamAuthFailure(account, { pauseAccountIfActive }),
		).resolves.toBe(true);
		expect(pauseAccountIfActive).toHaveBeenCalledWith(
			account.id,
			"oauth_invalid_grant",
			" rt-with-padding ",
			account.created_at,
		);
	});

	it("uses the explicit failed credential instead of a newly reauthed token", async () => {
		const pauseAccountIfActive = mock(async () => true);
		const account = makeAccount({
			provider: "anthropic",
			refresh_token: "rt-new-after-reauth",
		});

		await expect(
			pauseAccountForUpstreamAuthFailure(
				account,
				{ pauseAccountIfActive },
				"rt-rejected",
			),
		).resolves.toBe(true);
		expect(pauseAccountIfActive).toHaveBeenCalledWith(
			account.id,
			"oauth_invalid_grant",
			"rt-rejected",
			account.created_at,
		);
	});

	it("does not classify a Qwen refresh token as OAuth", () => {
		expect(
			upstreamAuthFailureReason(
				makeAccount({ provider: "qwen", refresh_token: "rt-qwen" }),
			),
		).toBe("auth_failure");
	});

	it("classifies an xAI refresh token as OAuth", () => {
		expect(
			upstreamAuthFailureReason(
				makeAccount({ provider: "xai", refresh_token: "rt-xai" }),
			),
		).toBe("oauth_invalid_grant");
	});

	it("does not reactively refresh accounts that also expose an API key", () => {
		expect(
			canAttemptStaleTokenRefresh(
				makeAccount({
					provider: "codex",
					refresh_token: "rt-mixed-credential",
					api_key: "sk-mixed-credential",
				}),
			),
		).toBe(false);
		expect(
			canAttemptStaleTokenRefresh(
				makeAccount({
					provider: "codex",
					refresh_token: "rt-oauth-only",
					api_key: null,
				}),
			),
		).toBe(true);
	});

	it("bounds reactive refresh reservations and clears them after reauth", () => {
		clearStaleTokenRefreshState("acc-cooldown");
		expect(tryAcquireStaleTokenRefresh("acc-cooldown", 1_000)).toBe(true);
		expect(tryAcquireStaleTokenRefresh("acc-cooldown", 1_001)).toBe(false);
		expect(isStaleTokenRefreshCoolingDown("acc-cooldown", 1_001)).toBe(true);
		clearStaleTokenRefreshState("acc-cooldown");
		expect(isStaleTokenRefreshCoolingDown("acc-cooldown", 1_001)).toBe(false);
	});

	it("recognizes terminal refresh errors without classifying timeouts as auth", () => {
		expect(
			isTerminalTokenRefreshFailure(new OAuthRefreshTokenError("acc-1")),
		).toBe(true);
		expect(
			isTerminalTokenRefreshFailure(
				new TokenRefreshError("acc-1", new Error("invalid_grant")),
			),
		).toBe(false);
		expect(
			isTerminalTokenRefreshFailure(new Error("fetch failed: ETIMEDOUT")),
		).toBe(false);
	});

	it("recognizes structured OAuth error payloads without object coercion", () => {
		expect(
			isTerminalTokenRefreshFailure({
				error: { code: "invalid_grant", message: "refresh token expired" },
			}),
		).toBe(true);
	});

	it("does not quarantine on an incidental invalid_grant mention in structured prose", () => {
		expect(
			isTerminalTokenRefreshFailure({
				error: { message: "provider mentioned invalid_grant in prose" },
			}),
		).toBe(false);
	});

	it("is safe when a legacy context has no pause operation", async () => {
		const account = makeAccount({ refresh_token: "rt-legacy" });
		await expect(pauseAccountForUpstreamAuthFailure(account, {})).resolves.toBe(
			false,
		);
	});
});

describe("refreshAccessTokenSafe — pause-for-reauth at the chokepoint", () => {
	function makeCtx(account: Account, pauseResult = true) {
		const pauseAccountIfActive = mock(async () => pauseResult);
		const ctx = {
			dbOps: {
				pauseAccountIfActive,
				getAccount: mock(async (accountId: string) =>
					accountId === account.id ? account : null,
				),
				updateAccountTokens: mock(async () => {}),
			},
			asyncWriter: { enqueue: (fn: () => unknown) => fn() },
			refreshInFlight: new Map<string, Promise<string>>(),
			runtime: { clientId: "test-client" },
			provider: undefined,
		};
		return { ctx, pauseAccountIfActive };
	}

	it("pauses the account for reauth when the provider throws OAuthRefreshTokenError", async () => {
		registerProvider({
			name: "test-reauth-provider",
			canHandle: () => true,
			refreshToken: async () => {
				throw new OAuthRefreshTokenError("acc-1", "revoked");
			},
		} as never);

		const account = makeAccount();
		const { ctx, pauseAccountIfActive } = makeCtx(account, true);

		await expect(
			refreshAccessTokenSafe(account, ctx as never),
		).rejects.toThrow();

		expect(pauseAccountIfActive).toHaveBeenCalledTimes(1);
		expect(pauseAccountIfActive.mock.calls[0][0]).toBe("acc-1");
		expect(pauseAccountIfActive.mock.calls[0][1]).toBe("oauth_invalid_grant");
		expect(pauseAccountIfActive.mock.calls[0][2]).toBe("rt-original");

		clearAccountRefreshCache(account.id);
	});

	it("retains terminal classification when the health wrapper hides the provider marker", async () => {
		registerProvider({
			name: "test-reauth-provider-expired",
			canHandle: () => true,
			refreshToken: async () => {
				throw new OAuthRefreshTokenError("acc-expired", "invalid_grant");
			},
		} as never);

		const account = makeAccount({
			id: "acc-expired",
			provider: "test-reauth-provider-expired",
			refresh_token_issued_at: Date.now() - 366 * 24 * 60 * 60 * 1000,
		});
		const { ctx, pauseAccountIfActive } = makeCtx(account, true);
		let thrown: unknown;
		try {
			await refreshAccessTokenSafe(account, ctx as never);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(TokenRefreshError);
		expect(isTerminalTokenRefreshFailure(thrown)).toBe(true);
		expect(pauseAccountIfActive).toHaveBeenCalledWith(
			account.id,
			"oauth_invalid_grant",
			"rt-original",
			account.created_at,
		);
		clearAccountRefreshCache(account.id);
	});

	it("does not quarantine after concurrent reauth replaces the refresh token", async () => {
		const providerName = "test-reauth-token-snapshot-provider";
		registerProvider({
			name: providerName,
			canHandle: () => true,
			refreshToken: async (providerAccount: Account) => {
				expect(providerAccount.refresh_token).toBe("rt-original");
				// Simulate a successful reauth racing the stale refresh failure.
				account.refresh_token = "rt-new-after-reauth";
				throw new OAuthRefreshTokenError(account.id, "revoked");
			},
		} as never);

		const account = makeAccount({ provider: providerName });
		const { ctx, pauseAccountIfActive } = makeCtx(account, true);
		await expect(
			refreshAccessTokenSafe(account, ctx as never),
		).rejects.toThrow();

		// The provider received the original credential, but a successful reauth
		// replaced it before that failure completed. The old token must not
		// quarantine the new credential generation.
		expect(account.refresh_token).toBe("rt-new-after-reauth");
		expect(pauseAccountIfActive).not.toHaveBeenCalled();
		clearAccountRefreshCache(account.id);
	});

	it("does NOT pause the account on a transient network refresh failure", async () => {
		registerProvider({
			name: "test-reauth-provider",
			canHandle: () => true,
			refreshToken: async () => {
				throw new Error("fetch failed: ETIMEDOUT");
			},
		} as never);

		const account = makeAccount({ id: "acc-transient" });
		const { ctx, pauseAccountIfActive } = makeCtx(account, true);

		await expect(
			refreshAccessTokenSafe(account, ctx as never),
		).rejects.toThrow();

		expect(pauseAccountIfActive).not.toHaveBeenCalled();

		clearAccountRefreshCache(account.id);
	});

	it("does not pause on provider prose that mentions invalid_grant", async () => {
		registerProvider({
			name: "test-reauth-provider-prose",
			canHandle: () => true,
			refreshToken: async () => {
				throw new Error(
					JSON.stringify({
						error: { message: "provider mentioned invalid_grant in prose" },
					}),
				);
			},
		} as never);

		const account = makeAccount({
			id: "acc-prose",
			provider: "test-reauth-provider-prose",
		});
		const { ctx, pauseAccountIfActive } = makeCtx(account, true);
		await expect(
			refreshAccessTokenSafe(account, ctx as never),
		).rejects.toThrow();
		expect(pauseAccountIfActive).not.toHaveBeenCalled();
		clearAccountRefreshCache(account.id);
	});
});
