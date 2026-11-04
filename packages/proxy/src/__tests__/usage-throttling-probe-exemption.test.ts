/**
 * Usage-throttling and internal-probe markers.
 *
 * A cache-keepalive replay (private credential or process-local probe secret
 * plus `x-better-ccflare-keepalive: true`) is exempt from usage-throttling in
 * proxy.ts's applyUsageThrottling: a throttled-but-healthy account's own
 * synthetic replay must reach the real endpoint instead of getting our own
 * synthetic 529 (createUsageThrottledResponse).
 *
 * The `x-better-ccflare-auto-refresh` marker earns no such exemption, with or
 * without a valid probe secret: it is deleted at ingress and the request is
 * throttled like any client request.
 */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

/**
 * A keepalive replay's response is still logged via the usage collector. Stub
 * it out so the keepalive exemption test doesn't depend on a real, initialized
 * UsageCollector singleton.
 */
function stubUsageCollector() {
	return spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
		handleStart: mock(() => {}),
		handleChunk: mock(() => {}),
		handleEnd: mock(() => Promise.resolve()),
	} as unknown as usageCollectorModule.UsageCollector);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-mb",
		name: "MB",
		provider: "test-provider",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		// Comfortably beyond TOKEN_SAFETY_WINDOW_MS (30 min) so getValidAccessToken
		// returns the access token directly without attempting a network refresh.
		expires_at: Date.now() + 3 * 60 * 60 * 1000,
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

/**
 * A fully-mocked, unregistered provider name ("test-provider") so
 * `getProvider(account.provider)` in proxy-operations.ts resolves to
 * `undefined` and falls back to `ctx.provider` — giving the test full,
 * deterministic control over header prep / response processing without
 * depending on any real provider's upstream-shape assumptions.
 */
function makeContext(account: Account): ProxyContext {
	return {
		strategy: {
			select: (accounts: Account[]) => accounts,
		} as never,
		dbOps: {
			getAllAccounts: mock(async () => [account]),
			getActiveComboForFamily: mock(async () => null),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => true,
			getUsageThrottlingWeeklyEnabled: () => true,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
		} as never,
		provider: {
			name: "test-provider",
			canHandle: () => true,
			buildUrl: () => "https://fake.local/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: undefined,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		// No-op enqueue: background bookkeeping jobs are never invoked, so this
		// test does not need to mock ctx.dbOps.getAdapter/updateAccountUsage/etc.
		asyncWriter: { enqueue: mock(() => {}) } as never,
		internalProbeSecret: "test-secret",
	};
}

function makeThrottledRequest(headers: Record<string, string> = {}): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...headers,
		},
		body: JSON.stringify({
			model: "claude-haiku-4-5",
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 10,
		}),
	});
}

describe("handleProxy usage throttling — synthetic probe exemption", () => {
	afterEach(() => {
		usageCache.delete("acc-mb");
	});

	function setThrottled(now: number) {
		const resetAt = new Date(now + 2 * 60 * 60 * 1000).toISOString();
		usageCache.set("acc-mb", {
			five_hour: { utilization: 80, resets_at: resetAt },
			seven_day: { utilization: 10, resets_at: null },
		});
	}

	it("still returns 529 for a normal (non-probe) request when the account is usage-throttled (control)", async () => {
		const account = makeAccount();
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		setThrottled(now);

		const realDateNow = Date.now;
		Date.now = () => now;
		try {
			const request = makeThrottledRequest();
			const response = await handleProxy(
				request,
				new URL(request.url),
				makeContext(account),
			);

			expect(response.status).toBe(529);
			expect(response.headers.get("Retry-After")).toBe("60");
		} finally {
			Date.now = realDateNow;
		}
	});

	it("usage-throttles a request carrying the auto-refresh marker and a valid probe secret", async () => {
		const account = makeAccount();
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		setThrottled(now);

		const realDateNow = Date.now;
		Date.now = () => now;
		try {
			const request = makeThrottledRequest({
				"x-better-ccflare-account-id": account.id,
				"x-better-ccflare-bypass-session": "true",
				"x-better-ccflare-auto-refresh": "true",
				"x-better-ccflare-internal-probe-secret": "test-secret",
			});
			const response = await handleProxy(
				request,
				new URL(request.url),
				makeContext(account),
			);

			expect(response.status).toBe(529);
			expect(response.headers.get("Retry-After")).toBe("60");
		} finally {
			Date.now = realDateNow;
		}
	});

	it("does NOT usage-throttle a cache-keepalive replay probe either", async () => {
		const account = makeAccount();
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		setThrottled(now);

		// A (mocked) UsageCollector must be available for forwardToClient to run.
		const collectorSpy = stubUsageCollector();

		const realDateNow = Date.now;
		Date.now = () => now;
		try {
			const request = makeThrottledRequest({
				"x-better-ccflare-account-id": account.id,
				"x-better-ccflare-bypass-session": "true",
				"x-better-ccflare-keepalive": "true",
				"x-better-ccflare-internal-probe-secret": "test-secret",
			});

			const realFetch = globalThis.fetch;
			globalThis.fetch = mock(
				async () =>
					new Response(JSON.stringify({ type: "message", id: "msg_1" }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			) as unknown as typeof fetch;
			try {
				const response = await handleProxy(
					request,
					new URL(request.url),
					makeContext(account),
				);

				expect(response.status).not.toBe(529);
				expect(response.status).toBe(200);
			} finally {
				globalThis.fetch = realFetch;
			}
		} finally {
			Date.now = realDateNow;
			collectorSpy.mockRestore();
		}
	});

	it("still throttles a forged auto-refresh marker that lacks the internal-probe secret header (issue #335)", async () => {
		const account = makeAccount();
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		setThrottled(now);

		const realDateNow = Date.now;
		Date.now = () => now;
		try {
			// An external client cannot mint x-better-ccflare-internal-probe-secret
			// (process-local, never sent to clients) — without it the marker alone
			// must not grant the throttling exemption.
			const request = makeThrottledRequest({
				"x-better-ccflare-account-id": account.id,
				"x-better-ccflare-bypass-session": "true",
				"x-better-ccflare-auto-refresh": "true",
			});
			const response = await handleProxy(
				request,
				new URL(request.url),
				makeContext(account),
			);

			expect(response.status).toBe(529);
			expect(response.headers.get("Retry-After")).toBe("60");
		} finally {
			Date.now = realDateNow;
		}
	});

	it("still throttles a forged auto-refresh marker sent with a wrong internal-probe secret (issue #335)", async () => {
		const account = makeAccount();
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		setThrottled(now);

		const realDateNow = Date.now;
		Date.now = () => now;
		try {
			const request = makeThrottledRequest({
				"x-better-ccflare-account-id": account.id,
				"x-better-ccflare-bypass-session": "true",
				"x-better-ccflare-auto-refresh": "true",
				"x-better-ccflare-internal-probe-secret": "nope",
			});
			const response = await handleProxy(
				request,
				new URL(request.url),
				makeContext(account),
			);

			expect(response.status).toBe(529);
			expect(response.headers.get("Retry-After")).toBe("60");
		} finally {
			Date.now = realDateNow;
		}
	});

	it("still throttles a forged cache-keepalive marker that lacks the internal-probe secret header (issue #335)", async () => {
		const account = makeAccount();
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		setThrottled(now);

		const realDateNow = Date.now;
		Date.now = () => now;
		try {
			const request = makeThrottledRequest({
				"x-better-ccflare-account-id": account.id,
				"x-better-ccflare-bypass-session": "true",
				"x-better-ccflare-keepalive": "true",
			});
			const response = await handleProxy(
				request,
				new URL(request.url),
				makeContext(account),
			);

			expect(response.status).toBe(529);
			expect(response.headers.get("Retry-After")).toBe("60");
		} finally {
			Date.now = realDateNow;
		}
	});
});
