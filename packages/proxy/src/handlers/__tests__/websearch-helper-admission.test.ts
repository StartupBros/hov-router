import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { sanitizeRequestRoutingAttemptSummary } from "@better-ccflare/types/request";
import * as collectors from "../../usage-collector";
import type { EndMessage } from "../../worker-messages";

const recordedEnds: EndMessage[] = [];
let collectorSpy: ReturnType<typeof spyOn>;
let optionalCollectorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
	recordedEnds.length = 0;
	collectorSpy = spyOn(collectors, "getUsageCollector").mockReturnValue({
		handleStart() {},
		handleChunk() {},
		async handleEnd(message: EndMessage) {
			recordedEnds.push(message);
		},
	} as unknown as collectors.UsageCollector);
	optionalCollectorSpy = spyOn(
		collectors,
		"tryGetUsageCollector",
	).mockImplementation(() => collectors.getUsageCollector());
});
afterEach(() => {
	collectorSpy.mockRestore();
	optionalCollectorSpy.mockRestore();
});

import { SessionAffinityStrategy } from "@better-ccflare/load-balancer";
import {
	deriveServerToolRequirement,
	getProvider,
	usageCache,
} from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { resetDefaultCircuitBreaker } from "../../circuit-breaker";
import {
	ModelRouteSessionRegistry,
	parseModelRouteProfiles,
} from "../../model-route-profiles";
import { handleProxy } from "../../proxy";
import {
	authorizeWebSearchHelper,
	createWebSearchHelperCandidateMeta,
} from "../../websearch-helper-policy";
import {
	deriveAffinityLaneKey,
	selectAccountsForRequest,
} from "../account-selector";
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
			search_profile: "fast",
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
const subscriptionPool = { accounts: "anthropic-subscription" } as const;
function fixture(
	native = account(),
	helper: string[] | typeof subscriptionPool = [id],
) {
	const profiles = parseModelRouteProfiles(
		JSON.stringify([
			{
				id: "local",
				displayName: "Local",
				accountId: "local-account",
				logicalModel: body.model,
				expectedProvider: "openai-compatible",
				expectedPhysicalModel: "chat",
				webSearchHelper: Array.isArray(helper)
					? { accountIds: helper }
					: helper,
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
		config: {
			getStorePayloads: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
		},
		runtime: { port: 8081, clientId: "offline-test" },
		serverToolReplay: { status: "disabled" },
		provider: getProvider("anthropic"),
		modelRouteSessionRegistry: new ModelRouteSessionRegistry(profiles),
		strategy: { select: (accounts: Account[]) => accounts },
		dbOps: {
			getActiveComboForFamily: async () => null,
			getAgentPreference: async () => null,
			getAllAccounts: async () => [native],
			getAccount: async () => native,
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: () => {} },
	} as unknown as ProxyContext;
	return { meta, ctx, native };
}
async function poll(
	spend: unknown = { enabled: false },
	extra?: unknown,
	pollId = id,
	utilization = 10,
) {
	globalThis.fetch = (async () =>
		Response.json({
			five_hour: {
				utilization,
				resets_at: new Date(Date.now() + 3_600_000).toISOString(),
			},
			spend,
			extra_usage: extra,
		})) as typeof fetch;
	usageCache.startPolling(pollId, token, "anthropic", 60_000);
	expect(await usageCache.refreshNow(pollId)).toBe(true);
}
afterEach(() => {
	usageCache.stopPolling(id);
	usageCache.delete(id);
	usageCache.stopPolling("helper-sibling");
	usageCache.delete("helper-sibling");
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
function helperRequest(
	options: {
		stream?: boolean;
		signal?: AbortSignal;
		messages?: unknown[];
	} = {},
) {
	return new Request("http://proxy.local/v1/messages", {
		method: "POST",
		signal: options.signal,
		headers: {
			"content-type": "application/json",
			"x-claude-code-session-id": "helper-session",
		},
		body: JSON.stringify({
			...body,
			model: "claude-bccf-route-local",
			metadata: { user_id: "helper-session" },
			stream: options.stream ?? false,
			messages: options.messages ?? body.messages,
		}),
	});
}
async function wholeHelper(
	ctx: ProxyContext,
	options: Parameters<typeof helperRequest>[0] = {},
) {
	const req = helperRequest(options);
	return handleProxy(req, new URL(req.url), ctx, "key-1");
}
// Refusals on a profile route must not disclose the source pin, the private
// allowlist or the internal admission reason.
async function expectUndisclosedRefusal(response: Response) {
	expect(response.status).toBe(503);
	const text = await response.text();
	expect(JSON.parse(text)).toMatchObject({
		error: { reason: "temporary_unavailable" },
	});
	for (const hidden of [
		"local-account",
		id,
		"helper-sibling",
		"helper_admission_unavailable",
		"anthropic-subscription",
		"api-only",
	])
		expect(text).not.toContain(hidden);
}
async function twoCandidates() {
	await poll();
	await poll({ enabled: false }, undefined, "helper-sibling");
	const { ctx, native, meta } = fixture(account(), [id, "helper-sibling"]);
	const sibling = { ...native, id: "helper-sibling", name: "helper-sibling" };
	ctx.dbOps.getAllAccounts = async () => [native, sibling];
	ctx.dbOps.getAccount = async (accountId) =>
		accountId === id ? native : sibling;
	return { ctx, native, sibling, meta };
}

describe("explicit subscription WebSearch helper selection", () => {
	it.each([
		false,
		true,
	])("preserves native result blocks, citations and options (stream=%s)", async (stream) => {
		await poll();
		const { ctx } = fixture();
		const content = [
			{
				type: "server_tool_use",
				id: "srvtoolu_fixture",
				name: "web_search",
				input: { query: "offline query" },
			},
			{
				type: "web_search_tool_result",
				tool_use_id: "srvtoolu_fixture",
				content: [
					{
						type: "web_search_result",
						title: "Fixture",
						url: "https://example.com",
						encrypted_content: "opaque-fixture",
					},
				],
			},
			{
				type: "text",
				text: "Fixture answer",
				citations: [
					{
						type: "web_search_result_location",
						url: "https://example.com",
						title: "Fixture",
						encrypted_index: "opaque-index",
						cited_text: "Fixture",
					},
				],
			},
		];
		const message = {
			id: "msg_fixture",
			type: "message",
			role: "assistant",
			model: body.model,
			content,
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
		};
		const event = (type: string, data: object) =>
			`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
		const payload = stream
			? event("message_start", {
					message: { ...message, content: [], stop_reason: null },
				}) +
				content
					.map(
						(block, index) =>
							event("content_block_start", { index, content_block: block }) +
							event("content_block_stop", { index }),
					)
					.join("") +
				event("message_delta", {
					delta: { stop_reason: "end_turn" },
					usage: { output_tokens: 1 },
				}) +
				event("message_stop", {})
			: JSON.stringify(message);
		let sends = 0;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			sends++;
			const sent = await (input as Request).clone().json();
			expect(sent.tools).toEqual(body.tools);
			return new Response(payload, {
				headers: {
					"content-type": stream ? "text/event-stream" : "application/json",
				},
			});
		}) as typeof fetch;
		const response = await wholeHelper(ctx, { stream });
		expect(response.status).toBe(200);
		const received = await response.text();
		if (stream) {
			// The existing streaming adapter adds finish_reason to message_delta;
			// search blocks and opaque citation/result fields must remain untouched.
			for (const [index, block] of content.entries())
				expect(received).toContain(
					event("content_block_start", { index, content_block: block }),
				);
			expect(received).toContain(event("message_stop", {}));
		} else expect(received).toBe(payload);
		expect(sends).toBe(1);
	});

	it.each([
		true,
		false,
	])("persists sanitized helper routing evidence (admitted=%s)", async (admitted) => {
		if (admitted) await poll();
		const { ctx } = fixture();
		globalThis.fetch = (async () =>
			Response.json({
				type: "message",
				content: [{ type: "text", text: "offline fixture" }],
				stop_reason: "end_turn",
			})) as typeof fetch;
		const response = await wholeHelper(ctx);
		expect(response.status).toBe(admitted ? 200 : 503);
		await response.text();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(recordedEnds).toHaveLength(1);
		const summary = sanitizeRequestRoutingAttemptSummary(
			JSON.parse(JSON.stringify(recordedEnds[0].routingAttemptSummary)),
		);
		expect(summary).toMatchObject({
			webSearchHelper: {
				sourceProfileId: "local",
				source: "explicit",
				selectedAccountId: admitted ? id : null,
				reason: admitted ? "subscription_admitted" : "subscription_unavailable",
			},
		});
		const serialized = JSON.stringify(summary);
		expect(serialized).not.toContain(token);
		expect(serialized).not.toContain(body.messages[0].content);
		expect(serialized).not.toContain("accountIds");
		const dirty = {
			...summary,
			webSearchHelper: {
				...summary?.webSearchHelper,
				sourceProfileId: "unsafe\nprofile",
				selectedAccountId: "Bearer secret",
				accountIds: ["private-list"],
				query: "secret query",
				credential: token,
			},
		};
		const clean = sanitizeRequestRoutingAttemptSummary(dirty);
		expect(clean?.webSearchHelper).toMatchObject({
			sourceProfileId: null,
			selectedAccountId: null,
		});
		expect(JSON.stringify(clean)).not.toMatch(
			/secret|private-list|fake-helper-oauth/,
		);
	});

	it.each([
		"throw",
		"timeout",
		"cancel",
		"401",
		"429",
		"500",
		"529",
		"empty-json",
		"truncated-json",
		"empty-sse",
		"truncated-sse",
	])("whole proxy sends at most once after %s", async (outcome) => {
		const { ctx } = await twoCandidates();
		const controller = new AbortController();
		let sends = 0;
		globalThis.fetch = (async () => {
			sends++;
			if (outcome === "throw") throw new Error("offline transport failure");
			if (outcome === "timeout")
				throw new DOMException("offline timeout", "TimeoutError");
			if (outcome === "cancel") {
				controller.abort();
				throw new DOMException("offline cancellation", "AbortError");
			}
			if (/^\d+$/.test(outcome))
				return Response.json(
					{
						type: "error",
						error: { type: "overloaded_error", message: "offline failure" },
					},
					{ status: Number(outcome) },
				);
			if (outcome.endsWith("sse"))
				return new Response(
					outcome === "empty-sse"
						? ""
						: 'event: message_start\ndata: {"type":"message_start","message":{"id":"fake","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_delta\ndata: {',
					{ headers: { "content-type": "text/event-stream" } },
				);
			return new Response(
				outcome === "empty-json" ? "" : '{"type":"message",',
				{ headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;
		const response = await wholeHelper(ctx, {
			stream: outcome.endsWith("sse"),
			signal: controller.signal,
		});
		await response.text();
		expect(sends).toBe(1);
		if (outcome === "cancel") expect(response.status).toBe(499);
	});

	it("advances only to an approved sibling when the first candidate is revoked before send", async () => {
		const { ctx, native, sibling } = await twoCandidates();
		const checkedAccounts: string[] = [];
		ctx.dbOps.getAccount = async (accountId) => {
			checkedAccounts.push(accountId);
			return accountId === id ? { ...native, paused: true } : sibling;
		};
		const bearers: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			bearers.push((input as Request).headers.get("authorization") ?? "");
			return Response.json({
				type: "message",
				content: [{ type: "text", text: "fixture" }],
				stop_reason: "end_turn",
			});
		}) as typeof fetch;
		const response = await wholeHelper(ctx);
		expect(response.status).toBe(200);
		await response.text();
		expect(bearers).toHaveLength(1);
		expect(checkedAccounts).toEqual([native.id, sibling.id]);
	});

	it("never spills into ordinary inventory when every approved candidate is revoked before send", async () => {
		const { ctx, native, sibling } = await twoCandidates();
		const outside = { ...native, id: "outside", name: "outside" };
		ctx.dbOps.getAllAccounts = async () => [native, sibling, outside];
		ctx.dbOps.getAccount = async (accountId) => ({
			...(accountId === id ? native : sibling),
			paused: true,
		});
		let sends = 0;
		globalThis.fetch = (async () => {
			sends++;
			return Response.json({});
		}) as typeof fetch;
		await expectUndisclosedRefusal(await wholeHelper(ctx));
		expect(sends).toBe(0);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(recordedEnds).toHaveLength(1);
		expect(
			sanitizeRequestRoutingAttemptSummary(
				JSON.parse(JSON.stringify(recordedEnds[0].routingAttemptSummary)),
			)?.webSearchHelper,
		).toMatchObject({
			reason: "admission_changed",
			selectedAccountId: sibling.id,
		});
	});

	it("claims one send atomically across simultaneous candidate clones", async () => {
		await poll();
		const { ctx, meta, native } = fixture();
		let sends = 0;
		globalThis.fetch = (async () => {
			sends++;
			return Response.json({
				type: "message",
				content: [{ type: "text", text: "fixture" }],
				stop_reason: "end_turn",
			});
		}) as typeof fetch;
		const responses = await Promise.all([
			dispatch(meta, ctx, native),
			dispatch(createWebSearchHelperCandidateMeta(meta), ctx, native),
		]);
		for (const response of responses) {
			if (!(response instanceof Response)) throw new Error("missing response");
			await response.text();
		}
		expect(sends).toBe(1);
	});

	it.each([
		"out-of-list",
		"paused",
	])("refilters malicious strategy output (%s)", async (kind) => {
		await poll();
		const { ctx, meta, native } = fixture();
		ctx.strategy.select = async () => [
			kind === "out-of-list"
				? { ...native, id: "unapproved" }
				: { ...native, paused: true },
		];
		await expect(
			selectAccountsForRequest(meta, ctx, body.model),
		).rejects.toThrow();
	});

	it("refuses an empty approved pool even with ordinary passthrough enabled", async () => {
		const previous = process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
		let sends = 0;
		globalThis.fetch = (async () => {
			sends++;
			return Response.json({});
		}) as typeof fetch;
		try {
			const { ctx } = fixture();
			await expectUndisclosedRefusal(await wholeHelper(ctx));
			expect(sends).toBe(0);
		} finally {
			if (previous === undefined)
				delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
			else process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = previous;
		}
	});

	it("does not grant a fresh exception to subsequent assistant history", async () => {
		await poll();
		const { ctx } = fixture();
		let sends = 0;
		globalThis.fetch = (async () => {
			sends++;
			return Response.json({});
		}) as typeof fetch;
		const response = await wholeHelper(ctx, {
			messages: [
				...body.messages,
				{ role: "assistant", content: "prior response" },
				{ role: "user", content: "continue" },
			],
		});
		expect(response.ok).toBe(false);
		expect(sends).toBe(0);
	});

	it.each([
		["root-first", "success"],
		["helper-first", "success"],
		["root-first", "failure"],
		["helper-first", "failure"],
		["root-first", "cancel"],
		["helper-first", "cancel"],
	])("preserves root binding and child home with concurrent completion (%s, %s)", async (order, outcome) => {
		await poll();
		const { ctx, native } = fixture();
		const local = {
			...native,
			id: "local-account",
			name: "local-account",
			provider: "openai-compatible",
			api_key: "fake-local",
			refresh_token: null,
			custom_endpoint: "https://local.invalid",
			model_mappings: JSON.stringify({ sonnet: "chat" }),
		};
		ctx.dbOps.getAllAccounts = async () => [local, native];
		ctx.dbOps.getAccount = async (accountId) =>
			accountId === id ? native : local;
		const strategy = new SessionAffinityStrategy();
		strategy.initialize({
			resetAccountSession() {},
			async resumeAccount() {
				return { resumed: false, pauseReason: null };
			},
			getAccountUtilization() {
				return 0;
			},
		});
		ctx.strategy = strategy;
		const sentHosts: string[] = [];
		const helperAbort = new AbortController();
		let releaseRoot = () => {};
		let releaseHelper = () => {};
		let arrivedRoot = () => {};
		let arrivedHelper = () => {};
		const rootGate = new Promise<void>((resolve) => {
			releaseRoot = resolve;
		});
		const helperGate = new Promise<void>((resolve) => {
			releaseHelper = resolve;
		});
		const rootArrived = new Promise<void>((resolve) => {
			arrivedRoot = resolve;
		});
		const helperArrived = new Promise<void>((resolve) => {
			arrivedHelper = resolve;
		});
		let gate = false;
		let rootInventoryHeld = false;
		ctx.dbOps.getAllAccounts = async () => {
			if (gate && !rootInventoryHeld) {
				rootInventoryHeld = true;
				arrivedRoot();
				await rootGate;
			}
			return [local, native];
		};
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const host = new URL((input as Request).url).hostname;
			sentHosts.push(host);
			if (host === "local.invalid") {
				return Response.json({
					id: "local",
					object: "chat.completion",
					model: "chat",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "local fixture" },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				});
			}
			if (gate) {
				arrivedHelper();
				await helperGate;
				if (outcome === "failure") throw new Error("offline helper failed");
				if (outcome === "cancel") {
					helperAbort.abort();
					throw new DOMException("offline cancellation", "AbortError");
				}
			}
			return Response.json({
				type: "message",
				content: [{ type: "text", text: "fixture" }],
				stop_reason: "end_turn",
			});
		}) as typeof fetch;
		const inference = async (child = false) => {
			const request = new Request("http://proxy.local/v1/messages", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-claude-code-session-id": "helper-session",
					...(child ? { "x-claude-code-agent-id": "child" } : {}),
				},
				body: JSON.stringify({
					model: child ? body.model : "claude-bccf-route-local",
					max_tokens: 32,
					messages: body.messages,
					metadata: { user_id: "helper-session" },
				}),
			});
			const response = await handleProxy(
				request,
				new URL(request.url),
				ctx,
				"key-1",
			);
			expect(response.status).toBe(200);
			await response.text();
		};
		await inference();
		await inference(true);
		// Exact pins bypass ordinary strategy selection. Seed historical ordinary
		// owners explicitly so this checks state preservation, not an empty map.
		const rootMeta = {
			...fixture().meta,
			clientSessionId: "helper-session",
			routeLineage: { kind: "root", childHomeKey: null },
		} as RequestMeta;
		rootMeta.affinityLaneKey = deriveAffinityLaneKey(rootMeta, body.model);
		const childMeta = {
			...rootMeta,
			routeLineage: { kind: "descendant", childHomeKey: "child-home" },
		} as RequestMeta;
		childMeta.affinityLaneKey = deriveAffinityLaneKey(childMeta, body.model);
		expect(
			strategy.commitAffinityOwner(rootMeta, {
				candidateId: "account:local-account",
				accountId: "local-account",
			}),
		).toBe(true);
		expect(
			strategy.commitAffinityOwner(childMeta, {
				candidateId: "account:local-account",
				accountId: "local-account",
			}),
		).toBe(true);
		const affinity = structuredClone(
			(strategy as unknown as { affinity: Map<string, unknown> }).affinity,
		);
		expect(affinity.size).toBeGreaterThan(0);
		const registry = ctx.modelRouteSessionRegistry;
		if (!registry) throw new Error("missing route registry");
		const bindingInput = {
			callerIdentity: "api-key-id:key-1",
			sessionId: "helper-session",
			requestModel: body.model,
			isSubagent: true,
		};
		const binding = registry.resolve(bindingInput, null, {
			touchInheritedBinding: false,
		});
		expect(binding.kind).toBe("route");
		gate = true;
		const root = inference();
		await rootArrived;
		const helper = wholeHelper(ctx, { signal: helperAbort.signal }).then(
			async (response) => {
				expect(response.status).toBe(
					outcome === "success" ? 200 : outcome === "cancel" ? 499 : 502,
				);
				await response.text();
			},
		);
		await helperArrived;
		if (order === "root-first") {
			releaseRoot();
			await root;
			releaseHelper();
			await helper;
		} else {
			releaseHelper();
			await helper;
			releaseRoot();
			await root;
		}
		for (const [key, value] of affinity)
			expect(
				(
					strategy as unknown as { affinity: Map<string, unknown> }
				).affinity.get(key),
			).toEqual(value);
		expect(
			registry.resolve(bindingInput, null, { touchInheritedBinding: false }),
		).toEqual(binding);
		gate = false;
		sentHosts.length = 0;
		await inference();
		await inference(true);
		expect(sentHosts).toEqual(["local.invalid", "local.invalid"]);
	});

	it("shares one physical send budget with legitimate candidate clones", async () => {
		await poll();
		const { meta, ctx, native } = fixture();
		let sends = 0;
		globalThis.fetch = (async () => {
			sends++;
			return Response.json({
				type: "message",
				content: [{ type: "text", text: "fixture" }],
				stop_reason: "pause_turn",
			});
		}) as typeof fetch;
		const first = await dispatch(meta, ctx, native);
		if (!(first instanceof Response)) throw new Error("missing response");
		expect((await first.json()).stop_reason).toBe("pause_turn");
		await dispatch(createWebSearchHelperCandidateMeta(meta), ctx, native);
		expect(sends).toBe(1);
	});

	it("keeps primed root and child affinity unchanged after whole-proxy helper success", async () => {
		await poll();
		const { meta, ctx } = fixture();
		const strategy = new SessionAffinityStrategy();
		strategy.initialize({
			resetAccountSession() {},
			async resumeAccount() {
				return { resumed: false, pauseReason: null };
			},
			getAccountUtilization() {
				return 0;
			},
		});
		ctx.strategy = strategy;
		const root = {
			...meta,
			clientSessionId: "helper-session",
			routeLineage: { kind: "root", childHomeKey: null },
		} as RequestMeta;
		root.affinityLaneKey = deriveAffinityLaneKey(root, body.model);
		const child = {
			...root,
			routeLineage: { kind: "descendant", childHomeKey: "child-home" },
		} as RequestMeta;
		child.affinityLaneKey = deriveAffinityLaneKey(child, body.model);
		strategy.commitAffinityOwner(root, {
			candidateId: "account:local-account",
			accountId: "local-account",
		});
		strategy.commitAffinityOwner(child, {
			candidateId: "account:local-account",
			accountId: "local-account",
		});
		const beforeRoot = strategy.snapshotAffinityOwner(root);
		const beforeChild = strategy.snapshotAffinityOwner(child);
		expect(beforeRoot?.accountId).toBe("local-account");
		expect(beforeChild?.accountId).toBe("local-account");
		globalThis.fetch = (async () =>
			Response.json({
				type: "message",
				content: [{ type: "text", text: "fixture" }],
				stop_reason: "end_turn",
			})) as typeof fetch;
		const request = new Request("http://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-claude-code-session-id": "helper-session",
			},
			body: JSON.stringify({
				...body,
				model: "claude-bccf-route-local",
				metadata: { user_id: "helper-session" },
			}),
		});
		const response = await handleProxy(
			request,
			new URL(request.url),
			ctx,
			"key-1",
		);
		expect(response.status).toBe(200);
		await response.text();
		expect(strategy.snapshotAffinityOwner(root)).toEqual(beforeRoot);
		expect(strategy.snapshotAffinityOwner(child)).toEqual(beforeChild);
	});

	it("keeps one private helper affinity lane per client session", async () => {
		await poll();
		const { ctx } = fixture();
		const strategy = new SessionAffinityStrategy();
		strategy.initialize({
			resetAccountSession() {},
			async resumeAccount() {
				return { resumed: false, pauseReason: null };
			},
			getAccountUtilization() {
				return 0;
			},
		});
		ctx.strategy = strategy;
		const affinity = (strategy as unknown as { affinity: Map<string, unknown> })
			.affinity;
		globalThis.fetch = (async () =>
			Response.json({
				type: "message",
				content: [{ type: "text", text: "fixture" }],
				stop_reason: "end_turn",
			})) as typeof fetch;
		const helperIn = async (sessionId?: string) => {
			const request = new Request("http://proxy.local/v1/messages", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(sessionId ? { "x-claude-code-session-id": sessionId } : {}),
				},
				body: JSON.stringify({
					...body,
					model: "claude-bccf-route-local",
					...(sessionId ? { metadata: { user_id: sessionId } } : {}),
				}),
			});
			const response = await handleProxy(
				request,
				new URL(request.url),
				ctx,
				"key-1",
			);
			expect(response.status).toBe(200);
			await response.text();
		};
		// Per-request lanes would add one shared-map entry per search and evict
		// ordinary session homes long before their TTL.
		for (let search = 0; search < 3; search++) await helperIn("helper-session");
		const sessionLanes = [...affinity.keys()];
		expect(sessionLanes).toHaveLength(1);
		expect(sessionLanes[0]).not.toContain("helper-session");
		await helperIn("other-session");
		expect(affinity.size).toBe(2);
		// Like any sessionless request, a sessionless helper has no lane to keep.
		await helperIn();
		await helperIn();
		expect(affinity.size).toBe(2);
	});

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

describe("subscription pool WebSearch helper selection", () => {
	// The source pin and an API-key Anthropic account sit in the same inventory:
	// the pool is every native subscription account, never every account.
	function poolInventory(
		ctx: ProxyContext,
		native: Account,
		sibling: Account = {
			...account(),
			id: "helper-sibling",
			name: "helper-sibling",
		},
	) {
		const source = {
			...account(),
			id: "local-account",
			name: "local-account",
			provider: "openai-compatible",
			access_token: null,
			refresh_token: null,
			api_key: "fake-local-key",
			custom_endpoint: "http://local.example",
		} as Account;
		const apiOnly = {
			...account(),
			id: "api-only",
			name: "api-only",
			api_key: "fake-key",
			refresh_token: null,
		} as Account;
		const inventory = [source, apiOnly, native, sibling];
		ctx.dbOps.getAllAccounts = async () => inventory;
		ctx.dbOps.getAccount = async (accountId) =>
			inventory.find((candidate) => candidate.id === accountId) ?? null;
		return { sibling };
	}
	const selectedIds = async (meta: RequestMeta, ctx: ProxyContext) =>
		(await selectAccountsForRequest(meta, ctx, body.model)).map((a) => a.id);

	it("admits every subscription account in the strategy's order", async () => {
		await poll();
		await poll({ enabled: false }, undefined, "helper-sibling");
		const { meta, ctx, native } = fixture(account(), subscriptionPool);
		const { sibling } = poolInventory(ctx, native);
		ctx.strategy.select = (accounts: Account[]) => [...accounts].reverse();
		expect(await selectedIds(meta, ctx)).toEqual([sibling.id, native.id]);
		expect(meta.forcedAccountId).toBe("local-account");
		expect(meta.routeExpectedPhysicalModel).toBe("chat");
	});

	it.each([
		"exhausted",
		"spending",
		"rate-limited",
		"paused",
		"custom-endpoint",
	])("moves past a %s subscription account", async (kind) => {
		await poll(
			{ enabled: kind === "spending" },
			undefined,
			id,
			kind === "exhausted" ? 100 : 10,
		);
		await poll({ enabled: false }, undefined, "helper-sibling");
		const { meta, ctx } = fixture(account(), subscriptionPool);
		const native = {
			...account(),
			paused: kind === "paused",
			rate_limited_until: kind === "rate-limited" ? Date.now() + 60_000 : null,
			custom_endpoint:
				kind === "custom-endpoint" ? "https://other.example" : null,
		};
		const { sibling } = poolInventory(ctx, native);
		expect(await selectedIds(meta, ctx)).toEqual([sibling.id]);
	});

	it("refuses without sending or spilling when every subscription account is exhausted", async () => {
		await poll({ enabled: false }, undefined, id, 100);
		await poll({ enabled: false }, undefined, "helper-sibling", 100);
		const previous = process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
		let sends = 0;
		globalThis.fetch = (async () => {
			sends++;
			return Response.json({});
		}) as typeof fetch;
		try {
			const { ctx, native } = fixture(account(), subscriptionPool);
			poolInventory(ctx, native);
			await expectUndisclosedRefusal(await wholeHelper(ctx));
			expect(sends).toBe(0);
		} finally {
			if (previous === undefined)
				delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
			else process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = previous;
		}
	});

	it("never borrows an account another profile reserves", async () => {
		await poll();
		await poll({ enabled: false }, undefined, "helper-sibling");
		const { meta, ctx, native } = fixture(account(), subscriptionPool);
		const { sibling } = poolInventory(ctx, native);
		const registry = ctx.modelRouteSessionRegistry;
		if (!registry) throw new Error("incomplete fixture");
		ctx.modelRouteSessionRegistry = new ModelRouteSessionRegistry([
			...registry.getProfiles(),
			...parseModelRouteProfiles(
				JSON.stringify([
					{
						id: "reserved",
						displayName: "Reserved",
						accountId: id,
						logicalModel: body.model,
						exclusiveAccount: true,
					},
				]),
			),
		]);
		expect(await selectedIds(meta, ctx)).toEqual([sibling.id]);
	});

	it.each([
		429, 529,
	])("forwards an upstream %d once and cools that account down for the next search", async (status) => {
		await poll();
		await poll({ enabled: false }, undefined, "helper-sibling");
		const { meta, ctx, native } = fixture(account(), subscriptionPool);
		const { sibling } = poolInventory(ctx, native);
		const writes: (() => Promise<unknown>)[] = [];
		ctx.asyncWriter.enqueue = (job: () => Promise<unknown>) => {
			writes.push(job);
		};
		const marked: string[] = [];
		ctx.dbOps.markAccountRateLimited = async (accountId, until) => {
			marked.push(accountId);
			if (accountId === native.id) native.rate_limited_until = until;
			return { consecutiveRateLimits: 1, applied: true };
		};
		ctx.dbOps.updateAccountUsage = async () => {};
		ctx.dbOps.updateAccountRateLimitMeta = async () => {};
		let sends = 0;
		globalThis.fetch = (async () => {
			sends++;
			return Response.json(
				{
					type: "error",
					error: {
						type: status === 429 ? "rate_limit_error" : "overloaded_error",
						message: "offline",
					},
				},
				{
					status,
					headers: {
						"retry-after": "60",
						"anthropic-ratelimit-unified-status": "rejected",
						"anthropic-ratelimit-unified-reset": String(
							Math.floor(Date.now() / 1000) + 60,
						),
					},
				},
			);
		}) as typeof fetch;
		try {
			const response = await wholeHelper(ctx);
			await response.text();
			expect(response.status).toBe(status);
			expect(sends).toBe(1);
			for (const write of writes) await write();
			expect(marked).toEqual([native.id]);
			expect(await selectedIds(meta, ctx)).toEqual([sibling.id]);
		} finally {
			resetDefaultCircuitBreaker();
		}
	});
});
