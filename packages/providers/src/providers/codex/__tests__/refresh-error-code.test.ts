import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	MAX_OAUTH_ERROR_INPUT_LENGTH,
	OAuthRefreshTokenError,
} from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import { CodexProvider } from "../provider";

function codexAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "codex-1",
		name: "codex-test",
		provider: "codex",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "expired-access-token",
		expires_at: 1,
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

describe("CodexProvider.refreshToken preserves the OAuth error code", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("keeps invalid_grant when only error_description is human-readable", async () => {
		const provider = new CodexProvider();
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						error: "invalid_grant",
						error_description: "The refresh token has expired.",
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;

		let thrown: Error | null = null;
		try {
			await provider.refreshToken(codexAccount(), "test-client");
		} catch (error) {
			thrown = error as Error;
		}

		expect(thrown?.message).toContain("invalid_grant");
	});

	it("carries the refresh_token_reused marker verbatim on token rotation reuse", async () => {
		const provider = new CodexProvider();
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ error: "refresh_token_reused" }), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;

		let thrown: Error | null = null;
		try {
			await provider.refreshToken(codexAccount(), "test-client");
		} catch (error) {
			thrown = error as Error;
		}

		// The reused case must keep the machine marker so detection fires; the
		// friendly re-auth hint alone ("token was reused") would not match.
		expect(thrown?.message).toContain("refresh_token_reused");
	});

	it("does not classify refresh_token_reused from a truncated response", async () => {
		const provider = new CodexProvider();
		const prefix = JSON.stringify({
			error: "refresh_token_reused",
			error_description: "credential-like-description-must-not-leak",
		});
		const body = `${prefix}${" ".repeat(MAX_OAUTH_ERROR_INPUT_LENGTH - prefix.length)}trailing-data`;
		globalThis.fetch = mock(
			async () =>
				new Response(body, {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;

		let thrown: unknown;
		try {
			await provider.refreshToken(codexAccount(), "test-client");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect(thrown).not.toBeInstanceOf(OAuthRefreshTokenError);
		expect((thrown as Error).message).not.toContain("refresh_token_reused");
		expect((thrown as Error).message).not.toContain(
			"credential-like-description-must-not-leak",
		);
	});

	it("classifies an exact non-JSON invalid_grant body as terminal", async () => {
		const provider = new CodexProvider();
		globalThis.fetch = mock(
			async () =>
				new Response(" \r\ninvalid_grant\u0000\t ", {
					status: 400,
					statusText: "Bad Request",
				}),
		) as unknown as typeof fetch;

		await expect(
			provider.refreshToken(codexAccount(), "test-client"),
		).rejects.toBeInstanceOf(OAuthRefreshTokenError);
	});

	it("classifies a nested structured invalid_grant response as terminal", async () => {
		const provider = new CodexProvider();
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							code: "invalid_grant",
							message: "The refresh token has expired.",
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;

		await expect(
			provider.refreshToken(codexAccount(), "test-client"),
		).rejects.toBeInstanceOf(OAuthRefreshTokenError);
	});

	it("classifies a nested type-based invalid_grant response as terminal", async () => {
		const provider = new CodexProvider();
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						error: { type: "invalid_grant", message: "expired" },
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;

		await expect(
			provider.refreshToken(codexAccount(), "test-client"),
		).rejects.toBeInstanceOf(OAuthRefreshTokenError);
	});

	it("does not classify an incidental invalid_grant mention as terminal", async () => {
		const provider = new CodexProvider();
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						error: { message: "provider mentioned invalid_grant in prose" },
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;

		await expect(
			provider.refreshToken(codexAccount(), "test-client"),
		).rejects.not.toBeInstanceOf(OAuthRefreshTokenError);
	});
});

describe("CodexProvider.refreshToken treats a refused refresh as needing re-login", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function respondWith(response: unknown) {
		globalThis.fetch = mock(async () => response) as unknown as typeof fetch;
	}

	async function refreshError(
		response: unknown,
		overrides: Partial<Account> = {},
	): Promise<Error> {
		respondWith(response);
		try {
			await new CodexProvider().refreshToken(
				codexAccount(overrides),
				"test-client",
			);
		} catch (error) {
			return error as Error;
		}
		throw new Error("expected refreshToken to throw");
	}

	function json(body: unknown, status: number) {
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	}

	it("pauses a 401 that carries no code, as the Codex CLI does", async () => {
		const error = await refreshError(
			new Response("Unauthorized", { status: 401 }),
		);
		expect(error).toBeInstanceOf(OAuthRefreshTokenError);
		expect((error as OAuthRefreshTokenError).oauthErrorCode).toBe(
			"invalid_grant",
		);
		expect(error.message).toContain(
			"Failed to refresh Codex token for account codex-test: HTTP 401.",
		);
	});

	it("pauses a 401 with an empty body", async () => {
		const error = await refreshError(new Response("", { status: 401 }));
		expect(error).toBeInstanceOf(OAuthRefreshTokenError);
	});

	it("pauses a 401 with an unlisted code and logs that code", async () => {
		const error = await refreshError(
			json(
				{
					error: { code: "token_revoked", message: "The grant was withdrawn" },
				},
				401,
			),
		);
		expect(error).toBeInstanceOf(OAuthRefreshTokenError);
		expect((error as OAuthRefreshTokenError).oauthErrorCode).toBe(
			"invalid_grant",
		);
		expect(error.message).toContain("HTTP 401 token_revoked.");
		expect(error.message).not.toContain("withdrawn");
	});

	for (const status of [400, 401]) {
		for (const code of ["refresh_token_expired", "refresh_token_invalidated"]) {
			it(`pauses HTTP ${status} ${code}, flat and nested, keeping the code`, async () => {
				for (const body of [{ error: code }, { error: { code } }]) {
					const error = await refreshError(json(body, status));
					expect(error).toBeInstanceOf(OAuthRefreshTokenError);
					expect((error as OAuthRefreshTokenError).oauthErrorCode).toBe(code);
					expect(error.message).toContain(`HTTP ${status} ${code}`);
				}
			});
		}
	}

	for (const body of [
		{ error: "invalid_client" },
		{ error: { code: "unauthorized_client" } },
		{ error: "something", code: "invalid_client" },
	]) {
		it(`does not pause a 401 that rejects the client: ${JSON.stringify(body)}`, async () => {
			const error = await refreshError(json(body, 401));
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(OAuthRefreshTokenError);
		});
	}

	it("lets a listed refresh-token code win over a client-rejection field", async () => {
		const error = await refreshError(
			json({ error: "refresh_token_reused", code: "invalid_client" }, 401),
		);
		expect(error).toBeInstanceOf(OAuthRefreshTokenError);
		expect((error as OAuthRefreshTokenError).oauthErrorCode).toBe(
			"refresh_token_reused",
		);
	});

	it("does not pause a truncated 401 or log anything from it", async () => {
		const prefix = JSON.stringify({ error: "token_revoked" });
		const body = `${prefix}${" ".repeat(MAX_OAUTH_ERROR_INPUT_LENGTH)}x`;
		const error = await refreshError(new Response(body, { status: 401 }));
		expect(error).not.toBeInstanceOf(OAuthRefreshTokenError);
		expect(error.message).toBe(
			"Failed to refresh Codex token for account codex-test: HTTP 401",
		);
	});

	it("does not pause a 401 whose body cannot be read", async () => {
		const error = await refreshError({
			ok: false,
			status: 401,
			statusText: "Unauthorized",
			headers: new Headers(),
			body: {
				getReader() {
					throw new TypeError("body already used");
				},
			},
		});
		expect(error).not.toBeInstanceOf(OAuthRefreshTokenError);
		expect(error.message).toBe(
			"Failed to refresh Codex token for account codex-test: HTTP 401",
		);
	});

	it("does not pause a 401 whose body stream fails midway", async () => {
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(new Error("connection reset"));
			},
		});
		const error = await refreshError(new Response(body, { status: 401 }));
		expect(error).not.toBeInstanceOf(OAuthRefreshTokenError);
	});

	for (const status of [403, 429, 500, 503]) {
		it(`does not pause HTTP ${status} without a listed code`, async () => {
			const error = await refreshError(
				json({ error: "temporarily_unavailable" }, status),
			);
			expect(error).not.toBeInstanceOf(OAuthRefreshTokenError);
			expect(error.message).toContain(`HTTP ${status} temporarily_unavailable`);
		});
	}

	it("never logs the description, even when it echoes the refresh token", async () => {
		const error = await refreshError(
			json(
				{
					error: "invalid_grant",
					error_description: "rt_secretvalue123 was revoked",
				},
				401,
			),
			{ refresh_token: "rt_secretvalue123" },
		);
		expect(error).toBeInstanceOf(OAuthRefreshTokenError);
		expect(error.message).not.toContain("rt_secretvalue123");
		expect(error.message).not.toContain("was revoked");
	});

	it("drops a code-shaped value that is part of the refresh token", async () => {
		for (const echoed of ["leaked_token_value", "token_value"]) {
			const error = await refreshError(json({ error: echoed }, 401), {
				refresh_token: "leaked_token_value",
			});
			expect(error).toBeInstanceOf(OAuthRefreshTokenError);
			expect(error.message).not.toContain(echoed);
			expect(error.message).toContain("HTTP 401.");
		}
	});

	it("tells the operator to re-authenticate from the dashboard", async () => {
		const error = await refreshError(
			json({ error: "refresh_token_reused" }, 400),
		);
		expect(error.message).toContain(
			"To re-authenticate, open the dashboard's Accounts page and choose Re-authenticate",
		);
		expect(error.message).not.toContain("--reauthenticate");
	});
});
