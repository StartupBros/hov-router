/**
 * The auto-refresh marker earns no exemption from request accounting or cache
 * staging; only the cache-keepalive marker is synthetic.
 *   1. cache-transport-staging.ts — keepalive skips cacheBodyStore staging,
 *      the auto-refresh marker is an ordinary request
 *   2. response-handler.ts        — a request carrying the auto-refresh marker
 *      and the probe secret still reaches usageCollector.handleStart
 *   3. proxy.ts                   — the pool-exhausted path still records a
 *      request carrying the auto-refresh marker and the private credential
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { Account } from "@better-ccflare/types";
import { cacheBodyStore } from "../cache-body-store";
import {
	applyCacheBodyStagingPolicy,
	getCacheBodyStagingAction,
} from "../cache-transport-staging";
import { stampInternalAutoRefreshAuth } from "../internal-probe-auth";
import * as usageCollectorModule from "../usage-collector";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "",
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
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Site 1: cache-body staging policy in proxy-operations.ts
//
// Exercise the production policy/action seam with the real cacheBodyStore.
// Avoid mocking cache-body-store because that poisons Bun's module registry and
// breaks cache-body-store.test.ts when the files share a test process.
// ---------------------------------------------------------------------------

describe("proxy-operations — cache-body staging policy", () => {
	const cacheableBody = new TextEncoder().encode(
		JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "hello",
							cache_control: { type: "ephemeral" },
						},
					],
				},
			],
		}),
	).buffer;

	beforeEach(() => {
		cacheBodyStore.setEnabled(false);
		cacheBodyStore.setEnabled(true);
	});

	afterEach(() => {
		cacheBodyStore.setEnabled(false);
	});

	it("stages ordinary non-Codex requests", () => {
		expect(getCacheBodyStagingAction(new Headers(), "anthropic")).toBe("stage");

		const action = applyCacheBodyStagingPolicy({
			requestId: "req-anthropic",
			accountId: "account-anthropic",
			providerName: "anthropic",
			body: cacheableBody,
			headers: new Headers({ "content-type": "application/json" }),
			path: "/v1/messages",
		});
		cacheBodyStore.onSummary("req-anthropic", 12);

		expect(action).toBe("stage");
		expect(
			cacheBodyStore.getLastCachedRequest("account-anthropic"),
		).not.toBeNull();
	});

	it("preserves truthy keepalive-header semantics", () => {
		expect(
			getCacheBodyStagingAction(
				new Headers({ "x-better-ccflare-keepalive": "1" }),
				"anthropic",
			),
		).toBe("skip");
		expect(
			getCacheBodyStagingAction(
				new Headers({ "x-better-ccflare-keepalive": "" }),
				"anthropic",
			),
		).toBe("stage");
		expect(
			getCacheBodyStagingAction(
				new Headers({ "x-better-ccflare-keepalive": "true" }),
				"codex",
			),
		).toBe("discard");
	});

	it("stages a request carrying the auto-refresh marker like any other", () => {
		for (const value of ["true", "false", "1"]) {
			expect(
				getCacheBodyStagingAction(
					new Headers({ "x-better-ccflare-auto-refresh": value }),
					"anthropic",
				),
			).toBe("stage");
		}
	});

	it("discards an Anthropic staged entry when the same request fails over to Codex", () => {
		expect(
			applyCacheBodyStagingPolicy({
				requestId: "req-failover",
				accountId: "account-anthropic",
				providerName: "anthropic",
				body: cacheableBody,
				headers: new Headers(),
				path: "/v1/messages",
			}),
		).toBe("stage");

		expect(
			applyCacheBodyStagingPolicy({
				requestId: "req-failover",
				accountId: "account-codex",
				providerName: "codex",
				body: cacheableBody,
				headers: new Headers(),
				path: "/v1/messages",
			}),
		).toBe("discard");

		cacheBodyStore.onSummary("req-failover", 12);
		expect(cacheBodyStore.getLastCachedRequest("account-anthropic")).toBeNull();
		expect(cacheBodyStore.getLastCachedRequest("account-codex")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Site 2: shouldProcessRequest in response-handler.ts
// ---------------------------------------------------------------------------

describe("response-handler — shouldProcessRequest keeps requests carrying the auto-refresh marker", () => {
	function createMockCollector() {
		const handleStart = mock(() => {});
		const handleChunk = mock(() => {});
		const handleEnd = mock(() => Promise.resolve());
		const collector = { handleStart, handleChunk, handleEnd };
		const spy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue(
			collector as unknown as usageCollectorModule.UsageCollector,
		);
		return { collector, handleStart, spy };
	}

	it("calls usageCollector.handleStart for a request carrying the auto-refresh marker and the probe secret", async () => {
		const { handleStart } = createMockCollector();
		const { forwardToClient } = await import("../response-handler");

		const account = makeAccount();

		const ctx = {
			provider: {
				name: "anthropic",
				isStreamingResponse: () => false,
			} as never,
			config: { getStorePayloads: () => false } as never,
			internalProbeSecret: "test-secret",
		};

		const response = new Response(JSON.stringify({ type: "message" }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});

		const requestHeaders = new Headers({
			"x-better-ccflare-auto-refresh": "true",
			"x-better-ccflare-internal-probe-secret": "test-secret",
		});

		await forwardToClient(
			{
				requestId: "req-probe",
				method: "POST",
				path: "/v1/messages",
				account,
				requestHeaders,
				requestBody: null,
				response,
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx as never,
		);

		expect(handleStart).toHaveBeenCalled();
	});

	it("calls usageCollector.handleStart for normal (non-probe) requests", async () => {
		const { handleStart } = createMockCollector();
		const { forwardToClient } = await import("../response-handler");

		const account = makeAccount();

		const ctx = {
			provider: {
				name: "anthropic",
				isStreamingResponse: () => false,
			} as never,
			config: { getStorePayloads: () => false } as never,
		};

		const response = new Response(JSON.stringify({ type: "message" }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});

		// No auto-refresh header
		const requestHeaders = new Headers();

		await forwardToClient(
			{
				requestId: "req-normal",
				method: "POST",
				path: "/v1/messages",
				account,
				requestHeaders,
				requestBody: null,
				response,
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx as never,
		);

		// At minimum a "start" call should have happened
		expect(handleStart).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Site 3: pool-exhausted path in proxy.ts
// ---------------------------------------------------------------------------

describe("proxy.ts — pool-exhausted path records requests carrying the auto-refresh marker", () => {
	let savedPassthrough: string | undefined;

	beforeEach(() => {
		savedPassthrough = process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
		delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	});

	afterEach(() => {
		if (savedPassthrough === undefined) {
			delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
		} else {
			process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = savedPassthrough;
		}
	});

	function createMockCollector() {
		const handleStart = mock(() => {});
		const handleEnd = mock(() => Promise.resolve());
		const collector = { handleStart, handleEnd, handleChunk: mock(() => {}) };
		const spy = spyOn(
			usageCollectorModule,
			"tryGetUsageCollector",
		).mockReturnValue(
			collector as unknown as usageCollectorModule.UsageCollector,
		);
		return { collector, handleStart, handleEnd, spy };
	}

	it("calls usageCollector when pool is exhausted and the request carries the auto-refresh marker plus a private credential", async () => {
		const { handleStart, handleEnd } = createMockCollector();
		const { handleProxy } = await import("../proxy");

		const ctx = {
			strategy: {
				select: () => [],
			} as never,
			dbOps: {
				getAllAccounts: mock(async () => []),
				getActiveComboForFamily: mock(async () => null),
			} as never,
			runtime: { port: 8080, clientId: "test" } as never,
			config: {
				getUsageThrottlingFiveHourEnabled: () => false,
				getUsageThrottlingWeeklyEnabled: () => false,
				getSystemPromptCacheTtl1h: () => false,
				getAgentFrontmatterModelFallback: () => false,
			} as never,
			provider: {
				name: "anthropic",
				canHandle: () => true,
			} as never,
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) } as never,
			internalProbeSecret: "test-secret",
		};

		const probeHeaders = new Headers({
			"Content-Type": "application/json",
			"x-better-ccflare-auto-refresh": "true",
		});
		stampInternalAutoRefreshAuth(probeHeaders);
		const probeRequest = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: probeHeaders,
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 10,
			}),
		});

		const response = await handleProxy(
			probeRequest,
			new URL("https://proxy.local/v1/messages"),
			ctx as never,
		);

		expect(response.status).toBe(503);

		// The marker earns nothing: the request is recorded like any other.
		expect(handleStart).toHaveBeenCalled();
		expect(handleEnd).toHaveBeenCalled();
	});

	it("calls usageCollector when pool is exhausted and the request carries no marker", async () => {
		const { handleStart } = createMockCollector();
		const { handleProxy } = await import("../proxy");

		const ctx = {
			strategy: {
				select: () => [],
			} as never,
			dbOps: {
				getAllAccounts: mock(async () => []),
				getActiveComboForFamily: mock(async () => null),
			} as never,
			runtime: { port: 8080, clientId: "test" } as never,
			config: {
				getUsageThrottlingFiveHourEnabled: () => false,
				getUsageThrottlingWeeklyEnabled: () => false,
				getSystemPromptCacheTtl1h: () => false,
				getAgentFrontmatterModelFallback: () => false,
			} as never,
			provider: {
				name: "anthropic",
				canHandle: () => true,
			} as never,
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) } as never,
		};

		const normalRequest = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 10,
			}),
		});

		const response = await handleProxy(
			normalRequest,
			new URL("https://proxy.local/v1/messages"),
			ctx as never,
		);

		expect(response.status).toBe(503);

		// Normal requests MUST be logged
		expect(handleStart).toHaveBeenCalled();
	});
});
