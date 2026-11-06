import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { observeCachePacing } from "../cache-pacing";
import type { ProxyContext } from "../handlers";
import { handleProxy } from "../proxy";

// Seam tests for handleProxy's selectAccountsForRequest catch site: a
// force-routed request whose forced account is unavailable must get the typed
// 503 force_route_unavailable response, not an uncaught throw, and must
// release the pacing leader slot it took before selection. Only
// selectAccountsForRequest itself is unit-tested in account-selector.test.ts,
// so this exercises handleProxy end-to-end through real cache pacing rather
// than mocking it away.

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "forced-account",
		name: "forced-account",
		provider: "test-provider" as Account["provider"],
		api_key: "test-key",
		refresh_token: "",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 0,
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

const CACHE_PACING_MS_ENV = "CCFLARE_CACHE_PACING_MS";
const originalCachePacingMs = process.env[CACHE_PACING_MS_ENV];

beforeEach(() => {
	// Pacing on, so a request with an identifiable session/model pair takes a
	// leader slot before selection.
	process.env[CACHE_PACING_MS_ENV] = "5000";
});

afterEach(() => {
	if (originalCachePacingMs === undefined)
		delete process.env[CACHE_PACING_MS_ENV];
	else process.env[CACHE_PACING_MS_ENV] = originalCachePacingMs;
});

describe("handleProxy: force-route fail-closed at the select call site (P2)", () => {
	it("returns the typed 503 force_route_unavailable response and releases the pacing leader slot when the forced account does not exist", async () => {
		let getAllAccountsCalls = 0;
		const getAllAccounts = mock(async () => {
			getAllAccountsCalls++;
			return [];
		});

		const ctx = {
			strategy: { select: mock(() => []) },
			dbOps: {
				getAllAccounts,
				getActiveComboForFamily: mock(async () => null),
				getAgentPreference: mock(async () => null),
			},
			runtime: { port: 8080, clientId: "test" },
			config: {
				getUsageThrottlingFiveHourEnabled: () => false,
				getUsageThrottlingWeeklyEnabled: () => false,
				getSystemPromptCacheTtl1h: () => false,
				getAgentFrontmatterModelFallback: () => false,
				getStorePayloads: () => false,
			},
			provider: {
				name: "test-provider",
				canHandle: () => true,
				buildUrl: (_path: string, _search: string, account: Account) =>
					`https://upstream.test/${account.id}`,
				prepareHeaders: (headers: Headers) => new Headers(headers),
				processResponse: async (response: Response) => response,
				parseRateLimit: () => ({
					isRateLimited: false,
					resetTime: null,
				}),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => undefined) },
		} as unknown as ProxyContext;

		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-account-id": "missing-account",
			},
			body: JSON.stringify({
				model: "claude-fable-4-5",
				messages: [{ role: "user", content: "hello" }],
				metadata: { user_id: "control-session-1" },
				max_tokens: 16,
			}),
		});

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(getAllAccountsCalls).toBe(1);
		expect(response.status).toBe(503);
		expect(response.headers.get("x-better-ccflare-force-route")).toBe(
			"unavailable",
		);
		const parsed = (await response.json()) as {
			error: { type: string; account_id: string; reason: string };
		};
		expect(parsed.error.type).toBe("force_route_unavailable");
		expect(parsed.error.account_id).toBe("missing-account");
		expect(parsed.error.reason).toBe("not_found");

		// Pacing takes the leader slot for this session/model key before the
		// select call that threw. The 503 catch must release it (finishPacing);
		// a dangling leader would make the next request for the same key wait
		// as a follower instead of leading.
		const followUp = await observeCachePacing({
			sessionKey: "control-session-1",
			model: "claude-fable-4-5",
		});
		expect(followUp?.role).toBe("leader");
	});
});

describe("handleProxy: cache pacing precedes account selection", () => {
	it("holds a follower before it selects, then selects once the leader releases", async () => {
		let getAllAccountsCalls = 0;
		const getAllAccounts = mock(async () => {
			getAllAccountsCalls++;
			return [];
		});
		const ctx = {
			strategy: { select: mock(() => []) },
			dbOps: {
				getAllAccounts,
				getActiveComboForFamily: mock(async () => null),
				getAgentPreference: mock(async () => null),
			},
			runtime: { port: 8080, clientId: "test" },
			config: {
				getUsageThrottlingFiveHourEnabled: () => false,
				getUsageThrottlingWeeklyEnabled: () => false,
				getSystemPromptCacheTtl1h: () => false,
				getAgentFrontmatterModelFallback: () => false,
				getStorePayloads: () => false,
			},
			provider: {
				name: "test-provider",
				canHandle: () => true,
				buildUrl: (_path: string, _search: string, account: Account) =>
					`https://upstream.test/${account.id}`,
				prepareHeaders: (headers: Headers) => new Headers(headers),
				processResponse: async (response: Response) => response,
				parseRateLimit: () => ({
					isRateLimited: false,
					resetTime: null,
				}),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => undefined) },
		} as unknown as ProxyContext;

		const leader = await observeCachePacing({
			sessionKey: "ordering-session-1",
			model: "claude-fable-4-5",
		});
		expect(leader?.role).toBe("leader");

		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-account-id": "missing-account",
			},
			body: JSON.stringify({
				model: "claude-fable-4-5",
				messages: [{ role: "user", content: "hello" }],
				metadata: { user_id: "ordering-session-1" },
				max_tokens: 16,
			}),
		});
		const pending = handleProxy(request, new URL(request.url), ctx);

		// The follower is parked on the leader's slot: routing has not run.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(getAllAccountsCalls).toBe(0);

		leader?.slot?.abandon();
		const response = await pending;
		expect(getAllAccountsCalls).toBe(1);
		expect(response.status).toBe(503);
	});
});

// ── U5 canary contract: forced-route fail-closed for paused and missing accounts ─
//
// KTD6: The canary requires an unpause window because a paused account is
// unavailable, and exact-account routing fails closed on unavailable accounts.
// A forced canary to a paused or missing Vercel account must return the typed
// 503 force_route_unavailable response instead of silently selecting another
// account — the canary must not escape to a different account on failure.
//
// ALL fixtures are constructed (not observed from live traffic).

describe("U5 canary: forced route to a paused or missing Vercel account fails closed (constructed)", () => {
	it("returns the typed 503 force_route_unavailable for a paused Vercel catch-all account", async () => {
		const vercel = makeAccount({
			id: "vercel-catchall",
			name: "vercel-catchall",
			paused: true,
			pause_reason: "manual",
			custom_endpoint: "https://ai-gateway.vercel.sh/v1",
			model_mappings: JSON.stringify({
				opus: ["zai/glm-5.2-fast", "zai/glm-5.2"],
				sonnet: ["zai/glm-5.2-fast", "zai/glm-5.2"],
			}),
		});

		const ctx = {
			strategy: { select: mock(() => []) },
			dbOps: {
				getAllAccounts: mock(async () => [vercel]),
				getActiveComboForFamily: mock(async () => null),
				getAgentPreference: mock(async () => null),
			},
			runtime: { port: 8080, clientId: "test" },
			config: {
				getUsageThrottlingFiveHourEnabled: () => false,
				getUsageThrottlingWeeklyEnabled: () => false,
				getSystemPromptCacheTtl1h: () => false,
				getAgentFrontmatterModelFallback: () => false,
				getStorePayloads: () => false,
			},
			provider: {
				name: "openai-compatible",
				canHandle: () => true,
				buildUrl: (_path: string, _search: string, account: Account) =>
					`https://upstream.test/${account.id}`,
				prepareHeaders: (headers: Headers) => new Headers(headers),
				processResponse: async (response: Response) => response,
				parseRateLimit: () => ({
					isRateLimited: false,
					resetTime: null,
				}),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => undefined) },
		} as unknown as ProxyContext;

		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-account-id": "vercel-catchall",
			},
			body: JSON.stringify({
				model: "claude-opus-4-8",
				messages: [{ role: "user", content: "canary" }],
				max_tokens: 16,
			}),
		});

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(503);
		expect(response.headers.get("x-better-ccflare-force-route")).toBe(
			"unavailable",
		);
		const parsed = (await response.json()) as {
			error: { type: string; account_id: string; reason: string };
		};
		expect(parsed.error.type).toBe("force_route_unavailable");
		expect(parsed.error.account_id).toBe("vercel-catchall");
		expect(parsed.error.reason).toBe("paused");
		// A manual pause lasts until an operator resumes the account.
		expect(response.headers.get("x-should-retry")).toBe("false");
	});

	it("returns the typed 503 force_route_unavailable for a missing Vercel account (not found)", async () => {
		const ctx = {
			strategy: { select: mock(() => []) },
			dbOps: {
				getAllAccounts: mock(async () => []),
				getActiveComboForFamily: mock(async () => null),
				getAgentPreference: mock(async () => null),
			},
			runtime: { port: 8080, clientId: "test" },
			config: {
				getUsageThrottlingFiveHourEnabled: () => false,
				getUsageThrottlingWeeklyEnabled: () => false,
				getSystemPromptCacheTtl1h: () => false,
				getAgentFrontmatterModelFallback: () => false,
				getStorePayloads: () => false,
			},
			provider: {
				name: "openai-compatible",
				canHandle: () => true,
				buildUrl: (_path: string, _search: string, _account: Account) =>
					`https://upstream.test/vercel-catchall`,
				prepareHeaders: (headers: Headers) => new Headers(headers),
				processResponse: async (response: Response) => response,
				parseRateLimit: () => ({
					isRateLimited: false,
					resetTime: null,
				}),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => undefined) },
		} as unknown as ProxyContext;

		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-account-id": "vercel-catchall-deleted",
			},
			body: JSON.stringify({
				model: "claude-opus-4-8",
				messages: [{ role: "user", content: "canary" }],
				max_tokens: 16,
			}),
		});

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(503);
		expect(response.headers.get("x-better-ccflare-force-route")).toBe(
			"unavailable",
		);
		const parsed = (await response.json()) as {
			error: { type: string; account_id: string; reason: string };
		};
		expect(parsed.error.type).toBe("force_route_unavailable");
		expect(parsed.error.account_id).toBe("vercel-catchall-deleted");
		expect(parsed.error.reason).toBe("not_found");
		expect(response.headers.get("x-should-retry")).toBe("false");
	});
});

// A force-route 503 is final for one request, but a client such as Claude Code
// retries a 503 about ten times before showing it. `x-should-retry: false`
// stops that only when a retry cannot succeed: a pause an operator must lift,
// or a missing account. Pauses and limits that clear on their own keep the
// client's default retry behavior.
describe("handleProxy: force-route 503 retry instruction", () => {
	function makeCtx(accounts: Account[]): ProxyContext {
		return {
			strategy: { select: mock(() => []) },
			dbOps: {
				getAllAccounts: mock(async () => accounts),
				getActiveComboForFamily: mock(async () => null),
				getAgentPreference: mock(async () => null),
			},
			runtime: { port: 8080, clientId: "test" },
			config: {
				getUsageThrottlingFiveHourEnabled: () => false,
				getUsageThrottlingWeeklyEnabled: () => false,
				getSystemPromptCacheTtl1h: () => false,
				getAgentFrontmatterModelFallback: () => false,
				getStorePayloads: () => false,
			},
			provider: {
				name: "test-provider",
				canHandle: () => true,
				buildUrl: (_path: string, _search: string, account: Account) =>
					`https://upstream.test/${account.id}`,
				prepareHeaders: (headers: Headers) => new Headers(headers),
				processResponse: async (response: Response) => response,
				parseRateLimit: () => ({
					isRateLimited: false,
					resetTime: null,
				}),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => undefined) },
		} as unknown as ProxyContext;
	}

	async function forceRoute(account: Account): Promise<Response> {
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-account-id": account.id,
			},
			body: JSON.stringify({
				model: "claude-opus-4-8",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 16,
			}),
		});
		return handleProxy(request, new URL(request.url), makeCtx([account]));
	}

	it.each([
		["manual", { paused: true, pause_reason: "manual" }],
		[
			"needs reauthentication",
			{ paused: true, pause_reason: "oauth_invalid_grant" },
		],
		// Nothing lifts a failure-threshold pause on its own since the
		// auto-refresh scheduler was removed (Refs #718); it waits for an operator.
		["failure-threshold", { paused: true, pause_reason: "failure_threshold" }],
	] as const)("tells the client not to retry a %s pause", async (_label, state) => {
		const response = await forceRoute(makeAccount(state));

		expect(response.status).toBe(503);
		expect(response.headers.get("x-should-retry")).toBe("false");
		expect(response.headers.get("x-better-ccflare-force-route")).toBe(
			"unavailable",
		);
		const parsed = (await response.json()) as {
			error: { type: string; reason: string; message: string };
		};
		expect(parsed.error.type).toBe("force_route_unavailable");
		expect(parsed.error.reason).toBe("paused");
		expect(parsed.error.message).toContain("Retrying will not help");
	});

	it.each([
		["overage", { paused: true, pause_reason: "overage" }],
		["peak-hours", { paused: true, pause_reason: "peak_hours" }],
		["rate-limit-window", { paused: true, pause_reason: "rate_limit_window" }],
		["unattributed", { paused: true, pause_reason: null }],
	] as const)("leaves retrying to the client for a %s pause", async (_label, state) => {
		const response = await forceRoute(makeAccount(state));

		expect(response.status).toBe(503);
		expect(response.headers.get("x-should-retry")).toBeNull();
		const parsed = (await response.json()) as {
			error: { reason: string; message: string };
		};
		expect(parsed.error.reason).toBe("paused");
		expect(parsed.error.message).not.toContain("Retrying will not help");
	});

	it("leaves retrying to the client for a rate-limited account", async () => {
		const response = await forceRoute(
			makeAccount({ rate_limited_until: Date.now() + 60_000 }),
		);

		expect(response.status).toBe(503);
		expect(response.headers.get("x-should-retry")).toBeNull();
		const parsed = (await response.json()) as { error: { reason: string } };
		expect(parsed.error.reason).toBe("rate_limited_or_unavailable");
	});
});
