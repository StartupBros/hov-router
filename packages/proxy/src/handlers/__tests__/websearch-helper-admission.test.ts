import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as collectors from "../../usage-collector";

let collectorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
	collectorSpy = spyOn(collectors, "getUsageCollector").mockReturnValue({
		handleStart() {},
		handleChunk() {},
		async handleEnd() {},
	} as unknown as collectors.UsageCollector);
});
afterEach(() => collectorSpy.mockRestore());

import {
	deriveServerToolRequirement,
	getProvider,
	usageCache,
} from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import {
	ModelRouteSessionRegistry,
	parseModelRouteProfiles,
} from "../../model-route-profiles";
import { authorizeWebSearchHelper } from "../../websearch-helper-policy";
import { selectAccountsForRequest } from "../account-selector";
import { proxyUnauthenticated, proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

const originalFetch = globalThis.fetch;
const id = "helper-native";
const token = "fake-helper-oauth";
const body = {
	model: "claude-sonnet-4-5",
	max_tokens: 200,
	messages: [{ role: "user", content: "Find a reference" }],
	tools: [
		{
			type: "web_search_20250305",
			name: "web_search",
			max_uses: 1,
			allowed_domains: ["example.com"],
		},
	],
};
function account(): Account {
	return {
		id,
		name: id,
		provider: "anthropic",
		api_key: null,
		refresh_token: "fake-refresh",
		access_token: token,
		expires_at: Date.now() + 3_600_000,
		created_at: 1,
		paused: false,
		rate_limited_until: null,
		custom_endpoint: null,
		model_mappings: null,
		priority: 0,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
	} as Account;
}
function fixture(native = account()) {
	const profiles = parseModelRouteProfiles(
		JSON.stringify([
			{
				id: "local",
				displayName: "Local",
				accountId: "local-account",
				logicalModel: body.model,
				expectedProvider: "openai-compatible",
				expectedPhysicalModel: "chat",
				webSearchHelper: { accountIds: [id] },
			},
		]),
	);
	const profile = profiles[0];
	const meta = {
		id: "helper-request",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		originalModel: body.model,
		forcedAccountId: "local-account",
		routeProfileId: profile.id,
		routeExpectedProvider: "openai-compatible",
		routeExpectedPhysicalModel: "chat",
		serverToolRequirements: deriveServerToolRequirement(body),
	} as RequestMeta;
	authorizeWebSearchHelper(meta, {
		originalEligible: true,
		body,
		resolution: { kind: "route", profile, source: "explicit" } as never,
		publicForceAccount: false,
	});
	const ctx = {
		config: { getStorePayloads: () => false },
		runtime: { port: 8081, clientId: "offline-test" },
		serverToolReplay: { status: "disabled" },
		provider: getProvider("anthropic"),
		modelRouteSessionRegistry: new ModelRouteSessionRegistry(profiles),
		strategy: { select: (accounts: Account[]) => accounts },
		dbOps: {
			getAllAccounts: async () => [native],
			getAccount: async () => native,
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: () => {} },
	} as unknown as ProxyContext;
	return { meta, ctx, native };
}
async function poll(spend: unknown = { enabled: false }, extra?: unknown) {
	globalThis.fetch = (async () =>
		Response.json({
			five_hour: {
				utilization: 10,
				resets_at: new Date(Date.now() + 3_600_000).toISOString(),
			},
			spend,
			extra_usage: extra,
		})) as typeof fetch;
	usageCache.startPolling(id, token, "anthropic", 60_000);
	expect(await usageCache.refreshNow(id)).toBe(true);
}
afterEach(() => {
	usageCache.stopPolling(id);
	usageCache.delete(id);
	globalThis.fetch = originalFetch;
});
async function dispatch(meta: RequestMeta, ctx: ProxyContext, native: Account) {
	const buffer = new TextEncoder().encode(
		JSON.stringify({ ...body, model: "chat" }),
	).buffer;
	const request = new Request("http://proxy.local/v1/messages?beta=true", {
		method: "POST",
		body: buffer,
		headers: { "content-type": "application/json" },
	});
	return proxyWithAccount(
		request,
		new URL(request.url),
		native,
		meta,
		buffer,
		() => undefined,
		0,
		ctx,
	);
}
describe("explicit subscription WebSearch helper selection", () => {
	it("dispatches through native preparation with the logical model, not the local chat pin", async () => {
		await poll();
		const { meta, ctx } = fixture();
		const selected = await selectAccountsForRequest(meta, ctx, body.model);
		const sends: Request[] = [];
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const request =
				input instanceof Request ? input : new Request(input, init);
			sends.push(request);
			return Response.json({
				id: "fake",
				type: "message",
				role: "assistant",
				content: [
					{
						type: "server_tool_use",
						id: "srvtoolu_fake",
						name: "web_search",
						input: { query: "offline fixture" },
					},
					{
						type: "web_search_tool_result",
						tool_use_id: "srvtoolu_fake",
						content: [
							{
								type: "web_search_result",
								url: "https://example.com",
								title: "Offline fixture",
								encrypted_content: "fake",
							},
						],
					},
					{
						type: "text",
						text: "offline fixture",
						citations: [
							{
								type: "web_search_result_location",
								url: "https://example.com",
								title: "Offline fixture",
								cited_text: "fixture",
								encrypted_index: "fake",
							},
						],
					},
				],
				model: body.model,
				stop_reason: "end_turn",
				usage: { input_tokens: 1, output_tokens: 1 },
			});
		}) as typeof fetch;
		const response = await dispatch(meta, ctx, selected[0]);
		if (!(response instanceof Response)) throw new Error("missing response");
		const result = await response.json();
		expect(result.content[1].type).toBe("web_search_tool_result");
		expect(result.content[2].citations[0].url).toBe("https://example.com");
		expect(sends).toHaveLength(1);
		expect(new URL(sends[0].url).hostname).toBe("api.anthropic.com");
		const sentBody = await sends[0].json();
		expect(sentBody.model).toBe(body.model);
		expect(sentBody.tools).toEqual(body.tools);
		expect(new URL(sends[0].url).searchParams.get("beta")).toBe("true");
	});
	it("selects only poll-owned OAuth allowlist candidates without clearing source constraints", async () => {
		await poll();
		const { meta, ctx } = fixture();
		expect(
			(await selectAccountsForRequest(meta, ctx, body.model)).map((a) => a.id),
		).toEqual([id]);
		expect(meta.forcedAccountId).toBe("local-account");
		expect(meta.routeExpectedPhysicalModel).toBe("chat");
	});
	it.each([
		"usage",
		"credential",
		"endpoint",
		"generation",
		"policy",
	])("revocation during asynchronous preparation (%s) produces zero sends", async (kind) => {
		await poll();
		const { meta, ctx, native } = fixture();
		const selected = await selectAccountsForRequest(meta, ctx, body.model);
		let sends = 0;
		globalThis.fetch = (async () => {
			sends++;
			return Response.json({});
		}) as typeof fetch;
		const pending = dispatch(meta, ctx, selected[0]);
		if (kind === "usage") usageCache.set(id, { spend: { enabled: true } });
		if (kind === "credential")
			ctx.dbOps.getAccount = async () => ({
				...native,
				access_token: "replacement",
			});
		if (kind === "endpoint")
			ctx.dbOps.getAccount = async () => ({
				...native,
				custom_endpoint: "https://other.example",
			});
		if (kind === "generation")
			ctx.dbOps.getAccount = async () => ({ ...native, created_at: 2 });
		if (kind === "policy")
			ctx.modelRouteSessionRegistry = new ModelRouteSessionRegistry([]);
		await expect(pending).rejects.toThrow();
		expect(sends).toBe(0);
	});
	it("preserves provider exclusions and other profiles' exclusive reservations", async () => {
		await poll();
		const { meta, ctx } = fixture();
		if (!meta.headers || !ctx.modelRouteSessionRegistry)
			throw new Error("incomplete fixture");
		meta.headers.set("x-better-ccflare-exclude-providers", "anthropic");
		await expect(
			selectAccountsForRequest(meta, ctx, body.model),
		).rejects.toThrow();
		meta.headers.delete("x-better-ccflare-exclude-providers");
		const existing = ctx.modelRouteSessionRegistry.getProfiles();
		const reserved = parseModelRouteProfiles(
			JSON.stringify([
				{
					id: "reserved",
					displayName: "Reserved",
					accountId: id,
					logicalModel: body.model,
					exclusiveAccount: true,
				},
			]),
		);
		ctx.modelRouteSessionRegistry = new ModelRouteSessionRegistry([
			...existing,
			...reserved,
		]);
		await expect(
			selectAccountsForRequest(meta, ctx, body.model),
		).rejects.toThrow();
	});
	it("refuses API-only accounts even with poll evidence", async () => {
		await poll();
		const { meta, ctx } = fixture({
			...account(),
			api_key: "fake-key",
			refresh_token: null,
		});
		await expect(
			selectAccountsForRequest(meta, ctx, body.model),
		).rejects.toThrow();
	});
	it.each([
		true,
		null,
		undefined,
	])("refuses modern spend enabled=%s despite a disabled legacy mirror", async (enabled) => {
		await poll({ enabled }, { is_enabled: false });
		const { meta, ctx } = fixture();
		await expect(
			selectAccountsForRequest(meta, ctx, body.model),
		).rejects.toThrow();
	});
	it.each([
		179_999, 180_000, -1,
	])("selection freshness boundary at %s ms", async (age) => {
		await poll();
		const snapshot = usageCache.getSnapshot(id);
		if (!snapshot) throw new Error("missing poll snapshot");
		const { meta, ctx } = fixture();
		const clock = spyOn(Date, "now").mockReturnValue(snapshot.observedAt + age);
		try {
			if (age === 179_999)
				expect(
					(await selectAccountsForRequest(meta, ctx, body.model)).map(
						(a) => a.id,
					),
				).toEqual([id]);
			else
				await expect(
					selectAccountsForRequest(meta, ctx, body.model),
				).rejects.toThrow();
		} finally {
			clock.mockRestore();
		}
	});
	it("accepts disabled legacy spending only when the modern block is absent", async () => {
		globalThis.fetch = (async () =>
			Response.json({
				five_hour: {
					utilization: 10,
					resets_at: new Date(Date.now() + 3_600_000).toISOString(),
				},
				extra_usage: { is_enabled: false },
			})) as typeof fetch;
		usageCache.startPolling(id, token, "anthropic", 60_000);
		expect(await usageCache.refreshNow(id)).toBe(true);
		const { meta, ctx } = fixture();
		expect(
			(await selectAccountsForRequest(meta, ctx, body.model)).map((a) => a.id),
		).toEqual([id]);
	});
	it.each([
		100,
		-1,
		null,
	])("rejects exhausted or malformed relevant allowance %s", async (utilization) => {
		globalThis.fetch = (async () =>
			Response.json({
				five_hour: {
					utilization,
					resets_at: new Date(Date.now() + 3_600_000).toISOString(),
				},
				spend: { enabled: false },
			})) as typeof fetch;
		usageCache.startPolling(id, token, "anthropic", 60_000);
		expect(await usageCache.refreshNow(id)).toBe(true);
		const { meta, ctx } = fixture();
		await expect(
			selectAccountsForRequest(meta, ctx, body.model),
		).rejects.toThrow();
	});
	it("never sends an authorized helper through unauthenticated passthrough", async () => {
		const { meta, ctx } = fixture();
		let sends = 0;
		globalThis.fetch = (async () => {
			sends++;
			return Response.json({});
		}) as typeof fetch;
		const buffer = new TextEncoder().encode(JSON.stringify(body)).buffer;
		const req = new Request("http://proxy.local/v1/messages", {
			method: "POST",
			body: buffer,
		});
		await expect(
			proxyUnauthenticated(
				req,
				new URL(req.url),
				meta,
				buffer,
				() => undefined,
				ctx,
			),
		).rejects.toThrow();
		expect(sends).toBe(0);
	});
	it("refuses passive usage rather than falling into the global pool", async () => {
		usageCache.set(id, {
			five_hour: {
				utilization: 10,
				resets_at: new Date(Date.now() + 3_600_000).toISOString(),
			},
			spend: { enabled: false },
		});
		const { meta, ctx } = fixture();
		await expect(
			selectAccountsForRequest(meta, ctx, body.model),
		).rejects.toThrow();
	});
});
