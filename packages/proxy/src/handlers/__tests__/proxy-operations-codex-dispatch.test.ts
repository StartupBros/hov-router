import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	setSystemTime,
	spyOn,
} from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_LOGICAL_MODEL_FAMILY_HEADER } from "@better-ccflare/http-common";
import type {
	ProviderAttemptPlan,
	ProviderAttemptPlanContext,
} from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import {
	bindManagedRequest,
	createAcceptedTiming,
	monotonicNowNs,
	registerManagedTerminal,
} from "../../../../../scripts/ccflare-managed-timing.mjs";
import { CACHE_REPLAY_MODEL_HEADER } from "../../cache-transport-staging";
import type { ModelFallbackExecutionPolicy } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

// Source worktrees intentionally exclude generated database worker bundles.
// This harness injects dbOps and never constructs these classes.
const usageCollectorModule = await import("../../usage-collector");
const {
	getProvider,
	isCodexExplicitCacheBreakpointSuppressed,
	resetCodexExplicitBreakpointSuppressionsForTest,
} = await import("@better-ccflare/providers");
const { ForceRouteUnavailableError, selectAccountsForRequest } = await import(
	"../account-selector"
);
const { proxyWithAccount } = await import("../proxy-operations");
const { createRoutingTerminalResponse } = await import("../routing-terminal");
const { RoutingAttemptLedger } = await import("../routing-attempt-ledger");

function makeCodexAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "codex-account",
		name: "codex-ws-test",
		provider: "codex",
		api_key: null,
		refresh_token: "",
		access_token: "test-access-token",
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
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: JSON.stringify({ sonnet: "gpt-5.4" }),
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function makeProxyContext(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(() => Promise.resolve(1)),
			saveRequest: mock(() => Promise.resolve()),
			saveRoutingAttempt: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		config: { getStorePayloads: () => true } as never,
	};
}

function makeRequestBody(): ArrayBuffer {
	return new TextEncoder().encode(
		JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			metadata: {
				user_id:
					"user_11111111-1111-4111-8111-111111111111_account__session_11111111-1111-4111-8111-111111111111",
			},
			tools: [
				{
					name: "Lookup",
					description: "Lookup a value",
					input_schema: { type: "object" },
				},
			],
			max_tokens: 16,
			stream: true,
		}),
	).buffer;
}

function makeConversationRequestBody(
	messages: unknown[],
	sessionId = "11111111-1111-4111-8111-111111111111",
): ArrayBuffer {
	return new TextEncoder().encode(
		JSON.stringify({
			model: "claude-sonnet-4-5",
			messages,
			metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
			tools: [
				{
					name: "Lookup",
					description: "Lookup a value",
					input_schema: { type: "object" },
				},
			],
			max_tokens: 16,
			stream: true,
		}),
	).buffer;
}

function makeRequest(
	body: ArrayBuffer,
	extraHeaders: Record<string, string> = {},
): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: {
			"content-type": "application/json",
			"anthropic-version": "2023-06-01",
			...extraHeaders,
		},
	});
}

function makeRequestMeta(
	id: string,
	overrides: Partial<RequestMeta> = {},
): RequestMeta {
	return {
		id,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		...overrides,
	};
}

function makePolicy(
	deadlineMs = 100,
	options: {
		attemptDeadlineMs?: number;
		isFinalAttempt?: boolean;
		routeAbort?: AbortController;
	} = {},
): ModelFallbackExecutionPolicy {
	const routeAbort = options.routeAbort ?? new AbortController();
	const startedAt = Date.now();
	const deadlineAt = startedAt + deadlineMs;
	const attemptDeadlineAt =
		startedAt + (options.attemptDeadlineMs ?? deadlineMs);
	return {
		routeCandidateId: "codex-ws-route",
		implicitFallbacksEnabled: false,
		forwardModelUnavailableResponse: true,
		isFinalSemanticAttempt: () => options.isFinalAttempt ?? true,
		anthropicPreCommitRescue: {
			activate: () => undefined,
			signal: routeAbort.signal,
			isRescueCommitted: () => false,
			markRescueCommitted: () => undefined,
			isRescueActivated: () => false,
			activatedAt: null,
			requestStartedAt: startedAt,
			commitmentDeadlineAt: deadlineAt,
			getAttemptCommitmentDeadlineAt: (isFinalAttempt) =>
				isFinalAttempt ? deadlineAt : attemptDeadlineAt,
			registerTerminalRecorder: () => undefined,
			registerRequestLifecycle: () => undefined,
			releaseResponseLifecycle: () => undefined,
			reportTerminal: () => undefined,
		},
	};
}

function installUsageCollector(): void {
	spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
		handleStart: mock(() => undefined),
		handleChunk: mock(() => undefined),
		handleEnd: mock(() => Promise.resolve()),
	} as never);
}

function installCountingCodexAttemptPlanner(
	onPlan: (context: ProviderAttemptPlanContext) => void,
): () => void {
	const provider = getProvider("codex");
	if (!provider) throw new Error("Codex provider is not registered");
	const originalCreateAttemptPlan = provider.createAttemptPlan;
	provider.createAttemptPlan = (context) => {
		onPlan(context);
		const candidate: ProviderAttemptPlan = {
			providerName: provider.name,
			targetUrl: provider.buildUrl(
				context.path,
				context.query,
				context.account,
			),
			apiFamily: "codex-responses",
			physicalModel: context.physicalModel,
			capabilityProofKey: context.capabilityProofKey,
			inputReplayMode: context.inputReplayMode,
			outputReplayMode: context.outputReplayMode,
			dataRetryPolicy: { mode: "none", maxAttempts: 0 },
			classifyNoExecution: async () => ({
				decision: "executing_or_ambiguous",
			}),
			cacheReplayModelStrategy:
				provider.cacheReplayModelStrategy ?? "normalized-source",
			prepareHeaders: (headers, accessToken, apiKey) =>
				provider.prepareHeaders(headers, accessToken, apiKey),
			transformRequestBody: (request) =>
				provider.transformRequestBody
					? provider.transformRequestBody(request, context.account)
					: Promise.resolve(request),
			processResponse: (response, requestHeaders) =>
				provider.processResponse(response, context.account, requestHeaders),
			parseRateLimit: (response) => provider.parseRateLimit(response),
			...(provider.isStreamingResponse
				? {
						isStreamingResponse: (response: Response) =>
							provider.isStreamingResponse?.(response) ?? false,
					}
				: {}),
			...(provider.extractTierInfo
				? {
						extractTierInfo: (response: Response) =>
							provider.extractTierInfo?.(response) ?? Promise.resolve(null),
					}
				: {}),
			...(provider.extractUsageInfo
				? {
						extractUsageInfo: (response: Response) =>
							provider.extractUsageInfo?.(response) ?? Promise.resolve(null),
					}
				: {}),
			...(provider.parseUsage
				? {
						parseUsage: (response: Response) =>
							provider.parseUsage?.(response) ?? Promise.resolve(null),
					}
				: {}),
		};
		return candidate;
	};
	return () => {
		if (originalCreateAttemptPlan) {
			provider.createAttemptPlan = originalCreateAttemptPlan;
		} else {
			delete provider.createAttemptPlan;
		}
	};
}

async function runProxy(
	request: Request,
	body: ArrayBuffer,
	policy: ModelFallbackExecutionPolicy,
	requestId: string,
	account = makeCodexAccount(),
	requestMetaOverrides: Partial<RequestMeta> = {},
	comboModel?: string,
	routingAttemptLedger?: InstanceType<typeof RoutingAttemptLedger>,
	proxyContext = makeProxyContext(),
): Promise<Response | null> {
	return proxyWithAccount(
		request,
		new URL(request.url),
		account,
		makeRequestMeta(requestId, requestMetaOverrides),
		body,
		() => undefined,
		0,
		proxyContext,
		comboModel,
		undefined,
		undefined,
		undefined,
		false,
		undefined,
		routingAttemptLedger,
		policy,
	);
}

function makeGpt56RequestBody(): ArrayBuffer {
	return new TextEncoder().encode(
		JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "stable cached prefix",
							cache_control: { type: "ephemeral" },
						},
					],
				},
				{ role: "user", content: "current turn" },
			],
			metadata: {
				user_id: JSON.stringify({
					session_id: "11111111-1111-4111-8111-111111111111",
				}),
			},
			max_tokens: 16,
			stream: true,
		}),
	).buffer;
}

function breakpointRejectionResponse(
	message = "Unknown field: prompt_cache_breakpoint is not supported for this model",
): Response {
	return new Response(JSON.stringify({ error: { message } }), {
		status: 400,
		headers: { "content-type": "application/json" },
	});
}

function readRequestTrace(
	dir: string,
	requestId: string,
): Record<string, unknown> {
	for (const file of readdirSync(dir).filter((name) =>
		name.endsWith(".jsonl"),
	)) {
		for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
			if (!line.trim()) continue;
			const trace = JSON.parse(line) as Record<string, unknown>;
			if (trace.phase === "request" && trace.request_id === requestId) {
				return trace;
			}
		}
	}
	throw new Error(`missing request trace for ${requestId}`);
}

describe("proxyWithAccount: Codex attempt dispatch boundary", () => {
	let originalFetch: typeof globalThis.fetch;
	let originalPromptCacheKey: string | undefined;
	let originalCacheKeyMode: string | undefined;
	let originalPrefixShardPercent: string | undefined;
	let originalAnthropicPrecommitTimeout: string | undefined;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		originalPromptCacheKey = process.env.CCFLARE_CODEX_PROMPT_CACHE_KEY;
		originalCacheKeyMode = process.env.CCFLARE_CODEX_CACHE_KEY_MODE;
		originalPrefixShardPercent =
			process.env.CCFLARE_CODEX_CACHE_KEY_PREFIX_SHARD_PERCENT;
		originalAnthropicPrecommitTimeout =
			process.env.CCFLARE_ANTHROPIC_PRECOMMIT_TIMEOUT_MS;
		process.env.CCFLARE_CODEX_PROMPT_CACHE_KEY = "1";
	});

	afterEach(() => {
		setSystemTime();
		globalThis.fetch = originalFetch;
		if (originalPromptCacheKey === undefined) {
			delete process.env.CCFLARE_CODEX_PROMPT_CACHE_KEY;
		} else {
			process.env.CCFLARE_CODEX_PROMPT_CACHE_KEY = originalPromptCacheKey;
		}
		if (originalCacheKeyMode === undefined) {
			delete process.env.CCFLARE_CODEX_CACHE_KEY_MODE;
		} else {
			process.env.CCFLARE_CODEX_CACHE_KEY_MODE = originalCacheKeyMode;
		}
		if (originalPrefixShardPercent === undefined) {
			delete process.env.CCFLARE_CODEX_CACHE_KEY_PREFIX_SHARD_PERCENT;
		} else {
			process.env.CCFLARE_CODEX_CACHE_KEY_PREFIX_SHARD_PERCENT =
				originalPrefixShardPercent;
		}
		if (originalAnthropicPrecommitTimeout === undefined) {
			delete process.env.CCFLARE_ANTHROPIC_PRECOMMIT_TIMEOUT_MS;
		} else {
			process.env.CCFLARE_ANTHROPIC_PRECOMMIT_TIMEOUT_MS =
				originalAnthropicPrecommitTimeout;
		}
		mock.restore();
	});

	it("keeps ordinary Codex requests on one coherent plan and observes each HTTP dispatch", async () => {
		installUsageCollector();
		const codex = getProvider("codex");
		const anthropic = getProvider("anthropic");
		if (!codex || !anthropic) throw new Error("Providers are not registered");
		const proxyContext = { ...makeProxyContext(), provider: anthropic };
		const observeResponse = mock((response: Response) => response);
		const observeError = mock(() => undefined);
		const observeDispatched = mock((_transport: string) => undefined);
		const observeUpstream = spyOn(codex, "observeUpstream").mockResolvedValue({
			response: observeResponse,
			error: observeError,
			dispatched: observeDispatched,
		});
		const plannedModels: Array<string | null> = [];
		const restorePlanner = installCountingCodexAttemptPlanner((context) => {
			plannedModels.push(context.physicalModel);
		});
		let httpCalls = 0;
		globalThis.fetch = mock(async () => {
			httpCalls++;
			return new Response(
				[
					'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_http","model":"gpt-5.4"}}\n\n',
					'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"http"}\n\n',
					'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_http","model":"gpt-5.4","status":"completed","usage":{"input_tokens":2,"output_tokens":1,"input_tokens_details":{"cached_tokens":0}}}}\n\n',
					"data: [DONE]\n\n",
				].join(""),
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			);
		});

		try {
			for (const index of [0, 1]) {
				const body = makeRequestBody();
				const response = await runProxy(
					makeRequest(body),
					body,
					makePolicy(1_000),
					`codex-plan-transport-${index}`,
					undefined,
					undefined,
					undefined,
					undefined,
					proxyContext,
				);
				expect(response?.status).toBe(200);
				expect(await response?.text()).toContain("http");
			}
		} finally {
			restorePlanner();
		}

		// The Codex custom planner is proof-only. Ordinary proof-null requests keep
		// the legacy plan.
		expect(plannedModels).toEqual([]);
		expect(httpCalls).toBe(2);
		// Every physical send shares the bounded observation and reports its
		// dispatch through the physical-send callback, not the response SSE.
		expect(observeUpstream).toHaveBeenCalledTimes(2);
		expect(observeResponse).toHaveBeenCalledTimes(2);
		expect(
			observeDispatched.mock.calls.map(([transport]) => transport),
		).toEqual(["http", "http"]);
		expect(observeError).not.toHaveBeenCalled();
		const [wireRequest, observationContext] = observeUpstream.mock.calls[1];
		expect(await wireRequest.clone().json()).toMatchObject({
			model: "gpt-5.4",
		});
		expect(observationContext).toMatchObject({
			requestId: "codex-plan-transport-1",
			account: { id: "codex-account", provider: "codex" },
			nativeResponses: false,
		});
	});

	it("final HTTP gate runs after asynchronous quality preparation and before dispatch observation", async () => {
		installUsageCollector();
		const codex = getProvider("codex");
		if (!codex) throw new Error("Codex provider is not registered");
		const dispatched = mock((_transport: string) => undefined);
		spyOn(codex, "observeUpstream").mockResolvedValue({
			dispatched,
			response: (response) => response,
			error: () => {},
		});
		const http = mock(
			async () => new Response("must never send", { status: 500 }),
		);
		globalThis.fetch = http as never;
		const deadline = Date.now() + 1_000;
		const policy: ModelFallbackExecutionPolicy = {
			...makePolicy(30_000),
			nativeQuotaAdmission: () => Date.now() < deadline,
			qualityAttempt: {
				beforeDispatch: async () => {
					await Promise.resolve();
					setSystemTime(deadline + 1);
				},
				assertDispatch: () => {},
				observeResponse: () => {},
				complete: () => {},
			} as never,
		};
		const body = makeRequestBody();
		await runProxy(
			makeRequest(body),
			body,
			policy,
			"quality-preparation-final-gate",
		);
		expect(http).not.toHaveBeenCalled();
		expect(dispatched).not.toHaveBeenCalled();
	});

	it("aborts a Codex attempt when its commitment budget expires before dispatch", async () => {
		installUsageCollector();
		const provider = getProvider("codex") as
			| (NonNullable<ReturnType<typeof getProvider>> & {
					abortTurnStateAttempt(attemptId: string | null | undefined): void;
			  })
			| undefined;
		if (!provider) throw new Error("Codex provider is not registered");
		const originalAbortAttempt = provider.abortTurnStateAttempt;
		const abortedAttemptIds: Array<string | null | undefined> = [];
		provider.abortTurnStateAttempt = (attemptId) => {
			abortedAttemptIds.push(attemptId);
			originalAbortAttempt.call(provider, attemptId);
		};
		const httpAttempt = mock(async () =>
			Promise.resolve(new Response("must not dispatch", { status: 500 })),
		);
		globalThis.fetch = httpAttempt as never;

		try {
			const body = makeRequestBody();
			const response = await runProxy(
				makeRequest(body),
				body,
				makePolicy(0),
				"codex-zero-commitment-budget",
			);
			expect(response).toBeNull();
		} finally {
			provider.abortTurnStateAttempt = originalAbortAttempt;
		}

		expect(httpAttempt).not.toHaveBeenCalled();
		expect(abortedAttemptIds).toHaveLength(1);
		expect(abortedAttemptIds[0]).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	it("restores the previous Codex route stamp when an attempt is abandoned pre-dispatch", async () => {
		installUsageCollector();
		const httpAttempt = mock(async () =>
			Promise.resolve(new Response("must not dispatch", { status: 500 })),
		);
		globalThis.fetch = httpAttempt as never;

		const body = makeRequestBody();
		const request = makeRequest(body);
		const meta = makeRequestMeta("codex-stamp-rollback", {
			codexTransportAttemptOrdinal: 1,
			codexLastAttemptAccountId: "codex-previous-account",
			codexLastAttemptModel: "gpt-5.4",
		});

		const response = await proxyWithAccount(
			request,
			new URL(request.url),
			makeCodexAccount(),
			meta,
			body,
			() => undefined,
			0,
			makeProxyContext(),
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			undefined,
			makePolicy(0),
		);

		expect(response).toBeNull();
		expect(httpAttempt).not.toHaveBeenCalled();
		// The attempt stamped itself as the request's last route before its body was
		// transformed, then died before dispatch. Left stamped, the first attempt
		// that actually reaches the wire compares itself against a route that never
		// sent and reads as an account or model fallback.
		expect(meta.codexLastAttemptAccountId).toBe("codex-previous-account");
		expect(meta.codexLastAttemptModel).toBe("gpt-5.4");
	});

	it("releases a Codex attempt whose transport fails after dispatch", async () => {
		installUsageCollector();
		const provider = getProvider("codex") as
			| (NonNullable<ReturnType<typeof getProvider>> & {
					abortTurnStateAttempt(attemptId: string | null | undefined): void;
					releaseDispatchedTurnStateAttempt(
						attemptId: string | null | undefined,
					): void;
			  })
			| undefined;
		if (!provider) throw new Error("Codex provider is not registered");
		const originalAbort = provider.abortTurnStateAttempt;
		const originalRelease = provider.releaseDispatchedTurnStateAttempt;
		const aborted: Array<string | null | undefined> = [];
		const released: Array<string | null | undefined> = [];
		provider.abortTurnStateAttempt = (attemptId) => {
			aborted.push(attemptId);
			originalAbort.call(provider, attemptId);
		};
		provider.releaseDispatchedTurnStateAttempt = (attemptId) => {
			released.push(attemptId);
			originalRelease?.call(provider, attemptId);
		};
		globalThis.fetch = mock(async () => {
			throw new Error("socket hang up");
		}) as never;

		try {
			const body = makeRequestBody();
			await runProxy(
				makeRequest(body),
				body,
				makePolicy(5_000),
				"codex-post-dispatch-failure",
			).catch(() => undefined);
		} finally {
			provider.abortTurnStateAttempt = originalAbort;
			provider.releaseDispatchedTurnStateAttempt = originalRelease;
		}

		// The send really happened, so no "never sent" tombstone may be written --
		// but the attempt must still be released. Left registered it keeps its
		// logical request's lease held, and every later turn on the scope is
		// suppressed until the attempt TTL expires.
		expect(aborted).toHaveLength(0);
		expect(released).toHaveLength(1);
		expect(released[0]).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	it("treats the first dispatched Codex send as initial after a pre-dispatch abort", async () => {
		installUsageCollector();
		const provider = getProvider("codex");
		if (!provider?.transformRequestBody) {
			throw new Error("Codex provider transformation is unavailable");
		}
		// The cause never reaches the wire -- the transport sanitizer strips every
		// x-better-ccflare-* header -- so observe it where it is actually consumed.
		const causes: Array<string | null> = [];
		const originalTransformRequestBody = provider.transformRequestBody;
		provider.transformRequestBody = async (request, account) => {
			causes.push(request.headers.get("x-better-ccflare-attempt-cause"));
			return originalTransformRequestBody.call(provider, request, account);
		};
		globalThis.fetch = mock(async () => {
			return new Response(
				[
					'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_initial","model":"gpt-5.4"}}\n\n',
					'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_initial","model":"gpt-5.4","status":"completed","usage":{"input_tokens":2,"output_tokens":1,"input_tokens_details":{"cached_tokens":0}}}}\n\n',
					"data: [DONE]\n\n",
				].join(""),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as never;

		// One logical request, two route candidates sharing its metadata. The first
		// is abandoned before dispatch; the second is the first send that actually
		// happens, so it is this request's initial attempt, not a fallback from a
		// route that never reached upstream.
		const body = makeRequestBody();
		const meta = makeRequestMeta("codex-initial-after-abort");
		try {
			const abandoned = await proxyWithAccount(
				makeRequest(body),
				new URL(makeRequest(body).url),
				makeCodexAccount(),
				meta,
				body,
				() => undefined,
				0,
				makeProxyContext(),
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				undefined,
				undefined,
				makePolicy(0),
			);
			expect(abandoned).toBeNull();

			await proxyWithAccount(
				makeRequest(body),
				new URL(makeRequest(body).url),
				makeCodexAccount(),
				meta,
				body,
				() => undefined,
				0,
				makeProxyContext(),
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				undefined,
				undefined,
				makePolicy(5_000),
			);
		} finally {
			provider.transformRequestBody = originalTransformRequestBody;
		}

		// The abandoned candidate incremented the attempt ordinal, which must not be
		// mistaken for evidence that a route already went out.
		expect(causes.at(-1)).toBe("initial");
	});

	it("replays only the provider-owned Codex turn state upstream", async () => {
		installUsageCollector();
		const provider = getProvider("codex");
		if (!provider?.transformRequestBody) {
			throw new Error("Codex provider transformation is unavailable");
		}
		const originalTransformRequestBody = provider.transformRequestBody;
		provider.transformRequestBody = async (request, account) => {
			const transformed = await originalTransformRequestBody.call(
				provider,
				request,
				account,
			);
			const headers = new Headers(transformed.headers);
			headers.set("x-codex-turn-state", "trusted-provider-turn-state");
			return new Request(transformed, { headers });
		};

		const upstreamTurnStates: Array<string | null> = [];
		globalThis.fetch = mock(async (request: Request) => {
			upstreamTurnStates.push(request.headers.get("x-codex-turn-state"));
			return new Response(
				[
					'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_http_turn_state","model":"gpt-5.4"}}\n\n',
					'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"http"}\n\n',
					'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_http_turn_state","model":"gpt-5.4","status":"completed","usage":{"input_tokens":2,"output_tokens":1,"input_tokens_details":{"cached_tokens":0}}}}\n\n',
					"data: [DONE]\n\n",
				].join(""),
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			);
		});

		try {
			const body = makeRequestBody();
			const response = await runProxy(
				makeRequest(body, {
					"x-codex-turn-state": "client-controlled-turn-state",
				}),
				body,
				makePolicy(1_000),
				"codex-http-turn-state-only",
			);
			expect(response?.status).toBe(200);
			expect(await response?.text()).toContain("http");
		} finally {
			provider.transformRequestBody = originalTransformRequestBody;
		}

		expect(upstreamTurnStates).toEqual(["trusted-provider-turn-state"]);
	});

	it("stamps a same-account model fallback before its request is transformed", async () => {
		installUsageCollector();
		const provider = getProvider("codex");
		if (!provider?.transformRequestBody) {
			throw new Error("Codex provider transformation is unavailable");
		}
		// The Codex provider registers each attempt's turn-state context during the
		// transform, reading the attempt identity the proxy stamped into these
		// headers. Capture what every transform actually observes.
		const transformedAttempts: Array<{
			attemptId: string | null;
			cause: string | null;
		}> = [];
		const originalTransformRequestBody = provider.transformRequestBody;
		provider.transformRequestBody = async (request, account) => {
			transformedAttempts.push({
				attemptId: request.headers.get("x-better-ccflare-attempt-id"),
				cause: request.headers.get("x-better-ccflare-attempt-cause"),
			});
			return originalTransformRequestBody.call(provider, request, account);
		};

		const upstreamModels: string[] = [];
		globalThis.fetch = mock(async (request: Request) => {
			const body = (await request.clone().json()) as { model?: string };
			upstreamModels.push(body.model ?? "");
			if (upstreamModels.length === 1) {
				return new Response(
					JSON.stringify({
						error: {
							code: "model_not_found",
							message: "The model gpt-5.4 does not exist",
						},
					}),
					{ status: 404, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(
				[
					'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_fallback","model":"gpt-5.4-codex"}}\n\n',
					'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"fallback"}\n\n',
					'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_fallback","model":"gpt-5.4-codex","status":"completed","usage":{"input_tokens":2,"output_tokens":1,"input_tokens_details":{"cached_tokens":0}}}}\n\n',
					"data: [DONE]\n\n",
				].join(""),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});

		try {
			const body = makeRequestBody();
			await runProxy(
				makeRequest(body),
				body,
				// Deliberately not `makePolicy`: that policy forwards a
				// model-unavailable response instead of falling back in place, which
				// is the path under test here.
				{ routeCandidateId: "codex-model-fallback-route" },
				"codex-model-fallback-attempt-stamp",
				makeCodexAccount({
					model_fallbacks: JSON.stringify({ sonnet: "gpt-5.4-codex" }),
				}),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("UsageCollector not initialized")) throw error;
		} finally {
			provider.transformRequestBody = originalTransformRequestBody;
		}

		expect(upstreamModels).toEqual(["gpt-5.4", "gpt-5.4-codex"]);
		expect(transformedAttempts).toHaveLength(2);
		expect(transformedAttempts[0]?.cause).toBe("initial");
		expect(transformedAttempts[0]?.attemptId).toBeTruthy();
		// The fallback must reach the transform already stamped. Stamping it
		// afterwards registered the attempt under an identity its response never
		// carries, and hid the route change behind the default `initial` cause.
		expect(transformedAttempts[1]?.cause).toBe("model_fallback");
		expect(transformedAttempts[1]?.attemptId).toBeTruthy();
		expect(transformedAttempts[1]?.attemptId).not.toBe(
			transformedAttempts[0]?.attemptId,
		);
	});

	it("classifies a Codex re-entry as a retry only when account and model both hold", async () => {
		installUsageCollector();
		const provider = getProvider("codex");
		if (!provider?.transformRequestBody) {
			throw new Error("Codex provider transformation is unavailable");
		}
		const causes: Array<string | null> = [];
		const originalTransformRequestBody = provider.transformRequestBody;
		provider.transformRequestBody = async (request, account) => {
			causes.push(request.headers.get("x-better-ccflare-attempt-cause"));
			return originalTransformRequestBody.call(provider, request, account);
		};
		globalThis.fetch = mock(
			async () =>
				new Response(
					[
						'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_reentry","model":"gpt-5.4"}}\n\n',
						'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
						'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_reentry","model":"gpt-5.4","status":"completed","usage":{"input_tokens":2,"output_tokens":1,"input_tokens_details":{"cached_tokens":0}}}}\n\n',
						"data: [DONE]\n\n",
					].join(""),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
		);

		const account = makeCodexAccount();
		try {
			// A second physical send on the same account and model: the bounded 401
			// retry after a credential refresh looks exactly like this. Its turn
			// state is still valid, so it must not be classified as a route change.
			const sameAccountBody = makeRequestBody();
			await runProxy(
				makeRequest(sameAccountBody),
				sameAccountBody,
				makePolicy(5_000),
				"codex-reentry-same-account",
				account,
				{
					codexTransportAttemptOrdinal: 1,
					codexLastAttemptAccountId: account.id,
					codexLastAttemptModel: "gpt-5.4",
				},
			);
			// Same account, different physical model: a deferred cross-family
			// fallback re-enters exactly like this. The route changed, so turn state
			// must be invalidated rather than replayed.
			const sameAccountOtherModelBody = makeRequestBody();
			await runProxy(
				makeRequest(sameAccountOtherModelBody),
				sameAccountOtherModelBody,
				makePolicy(5_000),
				"codex-reentry-same-account-other-model",
				account,
				{
					codexTransportAttemptOrdinal: 1,
					codexLastAttemptAccountId: account.id,
					codexLastAttemptModel: "gpt-5.4-codex",
				},
			);
			const otherAccountBody = makeRequestBody();
			await runProxy(
				makeRequest(otherAccountBody),
				otherAccountBody,
				makePolicy(5_000),
				"codex-reentry-other-account",
				account,
				{
					codexTransportAttemptOrdinal: 1,
					codexLastAttemptAccountId: "codex-some-other-account",
					codexLastAttemptModel: "gpt-5.4",
				},
			);
		} finally {
			provider.transformRequestBody = originalTransformRequestBody;
		}

		expect(causes).toEqual([
			"other_retry",
			"model_fallback",
			"account_failover",
		]);
	});

	it("absolute accepted clock vetoes the real HTTP boundary before dispatch", async () => {
		installUsageCollector();
		const codex = getProvider("codex");
		if (!codex) throw new Error("Codex provider is not registered");
		const body = makeRequestBody(),
			controller = new AbortController();
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body,
			headers: {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
			},
			signal: controller.signal,
		});
		bindManagedRequest(
			req,
			createAcceptedTiming(monotonicNowNs(), "2000"),
			(error) => controller.abort(error),
		);
		const fetchMock = mock(async () => new Response("unexpected HTTP send"));
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const causes: string[] = [];
		spyOn(codex, "observeUpstream").mockImplementation(async () => {
			// Observation runs after attempt preparation and before the final HTTP
			// gate. The absolute contract expires here without an idle/header timer
			// firing, so only that gate can fence the send. Expire relative to this
			// host's boot-time clock. Acceptance at boot with the default cap is
			// still live on a CI VM younger than 24 minutes.
			bindManagedRequest(
				req,
				createAcceptedTiming(monotonicNowNs() - 2_000_000_000n, "1000"),
				(error) => controller.abort(error),
			);
			registerManagedTerminal(req, (cause) => causes.push(cause));
			return undefined;
		});
		await runProxy(
			req,
			body,
			makePolicy(1000),
			"managed-expired-http",
			undefined,
			{ originalModel: "claude-sonnet-4-5" },
		).catch(() => null);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(causes).toEqual(["accepted_request_deadline"]);
		expect(controller.signal.aborted).toBe(true);
	});

	it("keeps Fable effort through an Opus-overridden request without leaking the carrier", async () => {
		installUsageCollector();
		let observedHttpRequest: Request | null = null;
		globalThis.fetch = mock(async (request: Request) => {
			observedHttpRequest = request.clone();
			return new Response(
				[
					'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_ok","model":"gpt-5.6-sol"}}\n\n',
					'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
					'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_ok","model":"gpt-5.6-sol","status":"completed","usage":{"input_tokens":10,"output_tokens":1,"input_tokens_details":{"cached_tokens":0}}}}\n\n',
					"data: [DONE]\n\n",
				].join(""),
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			);
		});

		const body = new TextEncoder().encode(
			JSON.stringify({
				model: "claude-fable-5",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 16,
				stream: true,
			}),
		).buffer;
		const response = await runProxy(
			makeRequest(body),
			body,
			makePolicy(1_000),
			"codex-fable-opus-override",
			makeCodexAccount({
				model_mappings: JSON.stringify({
					fable: "gpt-5.6-sol",
					opus: "gpt-5.6-sol",
				}),
			}),
			{
				originalModel: "claude-fable-5",
				appliedModel: "claude-fable-5",
			},
			"claude-opus-5",
		);
		expect(response?.status).toBe(200);
		await response?.text();

		expect(observedHttpRequest).not.toBeNull();
		const httpRequest = observedHttpRequest as unknown as Request;
		const payload = (await httpRequest.clone().json()) as {
			model?: string;
			reasoning?: { effort?: string };
		};
		expect(payload.model).toBe("gpt-5.6-sol");
		expect(payload.reasoning).toEqual({ effort: "xhigh" });
		expect(
			httpRequest.headers.get(CODEX_LOGICAL_MODEL_FAMILY_HEADER),
		).toBeNull();
	});

	it("aborts a non-final HTTP attempt at its private attempt deadline", async () => {
		installUsageCollector();
		let httpCalls = 0;
		globalThis.fetch = mock(async (input) => {
			httpCalls++;
			const signal = input instanceof Request ? input.signal : undefined;
			await new Promise<never>((_resolve, reject) => {
				const rejectFromAbort = () => reject(signal?.reason);
				signal?.addEventListener("abort", rejectFromAbort, { once: true });
				if (signal?.aborted) rejectFromAbort();
			});
		});

		const body = makeRequestBody();
		const request = makeRequest(body);
		const startedAt = Date.now();
		const response = await runProxy(
			request,
			body,
			makePolicy(350, { attemptDeadlineMs: 90, isFinalAttempt: false }),
			"codex-http-attempt-deadline",
		);
		const elapsedMs = Date.now() - startedAt;

		expect(httpCalls).toBe(1);
		expect(elapsedMs).toBeGreaterThanOrEqual(60);
		expect(elapsedMs).toBeLessThan(250);
		expect(response).toBeNull();
	});
});

describe("proxyWithAccount: GPT-5.6 explicit breakpoint compatibility retry", () => {
	let originalFetch: typeof globalThis.fetch;
	let originalPercent: string | undefined;
	let originalCacheKeyMode: string | undefined;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		originalPercent =
			process.env.CCFLARE_CODEX_GPT56_EXPLICIT_CACHE_BREAKPOINT_PERCENT;
		originalCacheKeyMode = process.env.CCFLARE_CODEX_CACHE_KEY_MODE;
		process.env.CCFLARE_CODEX_GPT56_EXPLICIT_CACHE_BREAKPOINT_PERCENT = "100";
		process.env.CCFLARE_CODEX_PROMPT_CACHE_KEY = "1";
		resetCodexExplicitBreakpointSuppressionsForTest();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		if (originalPercent === undefined) {
			delete process.env.CCFLARE_CODEX_GPT56_EXPLICIT_CACHE_BREAKPOINT_PERCENT;
		} else {
			process.env.CCFLARE_CODEX_GPT56_EXPLICIT_CACHE_BREAKPOINT_PERCENT =
				originalPercent;
		}
		delete process.env.CCFLARE_CODEX_PROMPT_CACHE_KEY;
		if (originalCacheKeyMode === undefined) {
			delete process.env.CCFLARE_CODEX_CACHE_KEY_MODE;
		} else {
			process.env.CCFLARE_CODEX_CACHE_KEY_MODE = originalCacheKeyMode;
		}
		delete process.env.CCFLARE_CODEX_TRACE_DIR;
		resetCodexExplicitBreakpointSuppressionsForTest();
		mock.restore();
	});

	it("gates and traces the breakpoint from the trusted cache-replay physical model", async () => {
		installUsageCollector();
		for (const testCase of [
			{
				name: "demotion",
				mappedModel: "gpt-5.6-sol",
				physicalModel: "gpt-5.5",
				expectsBreakpoint: false,
				expectedCanary: "ineligible",
				expectedAction: "skip_non_gpt56",
			},
			{
				name: "promotion",
				mappedModel: "gpt-5.5",
				physicalModel: "gpt-5.6-sol",
				expectsBreakpoint: true,
				expectedCanary: "treatment",
				expectedAction: "placed_source_marker",
			},
		] as const) {
			const traceDir = mkdtempSync(join(tmpdir(), "codex-breakpoint-replay-"));
			try {
				process.env.CCFLARE_CODEX_TRACE_DIR = traceDir;
				const outbound: Array<{
					body: Record<string, unknown>;
					finalModelHeader: string | null;
				}> = [];
				globalThis.fetch = mock(async (request: Request) => {
					outbound.push({
						body: (await request.clone().json()) as Record<string, unknown>,
						finalModelHeader: request.headers.get(
							"x-better-ccflare-final-model",
						),
					});
					return new Response(
						JSON.stringify({
							id: `response-${testCase.name}`,
							model: testCase.physicalModel,
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				});

				const account = makeCodexAccount({
					id: `codex-replay-${testCase.name}`,
					name: `codex-replay-${testCase.name}`,
					model_mappings: JSON.stringify({ sonnet: testCase.mappedModel }),
				});
				const body = makeGpt56RequestBody();
				const requestId = `codex-breakpoint-replay-${testCase.name}`;
				const response = await runProxy(
					makeRequest(body, {
						[CACHE_REPLAY_MODEL_HEADER]: testCase.physicalModel,
					}),
					body,
					makePolicy(1_000),
					requestId,
					account,
				);

				expect(response?.status).toBe(200);
				expect(outbound).toHaveLength(1);
				expect(outbound[0]?.body.model).toBe(testCase.physicalModel);
				expect(outbound[0]?.finalModelHeader).toBeNull();
				expect(
					JSON.stringify(outbound[0]?.body).includes("prompt_cache_breakpoint"),
				).toBe(testCase.expectsBreakpoint);

				const trace = readRequestTrace(traceDir, requestId);
				expect(trace.model_out).toBe(testCase.physicalModel);
				expect(trace.explicit_breakpoint_canary).toBe(testCase.expectedCanary);
				expect(trace.explicit_breakpoint_action).toBe(testCase.expectedAction);
			} finally {
				delete process.env.CCFLARE_CODEX_TRACE_DIR;
				rmSync(traceDir, { recursive: true, force: true });
			}
		}
	});

	it("retries one pre-content 400 without the marker and suppresses that account/model", async () => {
		installUsageCollector();
		const codex = getProvider("codex");
		const anthropic = getProvider("anthropic");
		if (!codex || !anthropic) throw new Error("Providers are not registered");
		const proxyContext = { ...makeProxyContext(), provider: anthropic };
		const observedBodies: unknown[] = [];
		const observedStatuses: number[] = [];
		const observeUpstream = spyOn(codex, "observeUpstream").mockImplementation(
			async (request) => {
				observedBodies.push(await request.clone().json());
				return {
					response: (response) => {
						observedStatuses.push(response.status);
						return response;
					},
					error: () => undefined,
				};
			},
		);
		process.env.CCFLARE_CODEX_CACHE_KEY_MODE = "session";
		const outbound: Array<Record<string, unknown>> = [];
		const httpReservedHeaderNames: string[][] = [];
		globalThis.fetch = mock(async (request: Request) => {
			httpReservedHeaderNames.push(
				[...request.headers.keys()].filter((name) =>
					name.startsWith("x-better-ccflare-"),
				),
			);
			outbound.push((await request.clone().json()) as Record<string, unknown>);
			if (outbound.length === 1) {
				return new Response(
					JSON.stringify({
						error: {
							message:
								"Unknown field: prompt_cache_breakpoint is not supported for this model",
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(
				[
					'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_ok","model":"gpt-5.6-sol"}}\n\n',
					'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
					'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_ok","model":"gpt-5.6-sol","status":"completed","usage":{"input_tokens":10,"output_tokens":1,"input_tokens_details":{"cached_tokens":0,"cache_write_tokens":0}}}}\n\n',
					"data: [DONE]\n\n",
				].join(""),
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			);
		});

		const account = makeCodexAccount({
			model_mappings: JSON.stringify({ sonnet: "gpt-5.6-sol" }),
		});
		const body = makeConversationRequestBody([
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "stable cached prefix",
						cache_control: { type: "ephemeral" },
					},
				],
			},
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-lineage-breakpoint-retry",
						name: "Lookup",
						input: { value: "retry" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-lineage-breakpoint-retry",
						content: "retry result",
					},
				],
			},
		]);
		const response = await runProxy(
			makeRequest(body),
			body,
			makePolicy(1_000),
			"codex-breakpoint-400",
			account,
			undefined,
			undefined,
			undefined,
			proxyContext,
		);

		expect(outbound).toHaveLength(2);
		// Both physical HTTP attempts use the selected provider's observer,
		// including the repaired wire body produced by the compatibility retry.
		expect(observeUpstream).toHaveBeenCalledTimes(2);
		expect(observedBodies).toEqual(outbound);
		expect(observedStatuses).toEqual([400, 200]);
		expect(httpReservedHeaderNames).toEqual([[], []]);
		expect(response?.status).toBe(200);
		expect(JSON.stringify(outbound[0])).toContain("prompt_cache_breakpoint");
		expect(JSON.stringify(outbound[1])).not.toContain(
			"prompt_cache_breakpoint",
		);
		expect(outbound[1]?.prompt_cache_key).toBe(outbound[0]?.prompt_cache_key);
		const firstWithoutMarker = structuredClone(outbound[0]);
		for (const item of firstWithoutMarker.input as Array<
			Record<string, unknown>
		>) {
			if (!Array.isArray(item.content)) continue;
			for (const block of item.content as Array<Record<string, unknown>>) {
				delete block.prompt_cache_breakpoint;
			}
		}
		expect(outbound[1]?.input).toEqual(firstWithoutMarker.input);
		expect(outbound[1]?.tools).toEqual(outbound[0]?.tools);
		expect(
			isCodexExplicitCacheBreakpointSuppressed(account.id, "gpt-5.6-sol"),
		).toBeTrue();

		// The learned suppression keeps the marker off the next turn on this
		// account/model without another rejection.
		const followUp = await runProxy(
			makeRequest(body),
			body,
			makePolicy(1_000),
			"codex-breakpoint-400-follow-up",
			account,
			undefined,
			undefined,
			undefined,
			proxyContext,
		);
		expect(followUp?.status).toBe(200);
		expect(outbound).toHaveLength(3);
		expect(JSON.stringify(outbound[2])).not.toContain(
			"prompt_cache_breakpoint",
		);
	});

	it("never retries a generic 400 or a prompt literal without an injected marker", async () => {
		installUsageCollector();
		process.env.CCFLARE_CODEX_GPT56_EXPLICIT_CACHE_BREAKPOINT_PERCENT = "0";
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls++;
			return breakpointRejectionResponse();
		});
		const parsed = JSON.parse(
			new TextDecoder().decode(makeGpt56RequestBody()),
		) as Record<string, unknown>;
		const messages = parsed.messages as Array<Record<string, unknown>>;
		messages[0] = {
			role: "user",
			content:
				'The string "prompt_cache_breakpoint" is only ordinary prompt text.',
		};
		const body = new TextEncoder().encode(JSON.stringify(parsed)).buffer;
		const account = makeCodexAccount({
			model_mappings: JSON.stringify({ sonnet: "gpt-5.6-sol" }),
		});
		const response = await runProxy(
			makeRequest(body),
			body,
			makePolicy(1_000),
			"codex-breakpoint-prompt-literal",
			account,
		);
		expect(calls).toBe(1);
		expect(response?.status).toBe(400);

		calls = 0;
		globalThis.fetch = mock(async () => {
			calls++;
			return new Response(
				JSON.stringify({ error: { message: "unrelated invalid parameter" } }),
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		});
		process.env.CCFLARE_CODEX_GPT56_EXPLICIT_CACHE_BREAKPOINT_PERCENT = "100";
		const genericBody = makeGpt56RequestBody();
		const generic = await runProxy(
			makeRequest(genericBody),
			genericBody,
			makePolicy(1_000),
			"codex-breakpoint-generic-400",
			account,
		);
		expect(calls).toBe(1);
		expect(generic?.status).toBe(400);
	});

	it("bounds an exact compatibility rejection to one retry", async () => {
		installUsageCollector();
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls++;
			return breakpointRejectionResponse();
		});
		const account = makeCodexAccount({
			model_mappings: JSON.stringify({ sonnet: "gpt-5.6-sol" }),
		});
		const body = makeGpt56RequestBody();
		const response = await runProxy(
			makeRequest(body),
			body,
			makePolicy(1_000),
			"codex-breakpoint-second-400",
			account,
		);
		expect(calls).toBe(2);
		expect(response?.status).toBe(400);
	});
});

describe("proxyWithAccount: verified Codex 429 recovery provenance", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		mock.restore();
	});

	it("awaits a verified exhausted x-codex window reset before terminal and follow-up selection consume the cooldown", async () => {
		const resetSeconds = Math.floor(Date.now() / 1000) + 120;
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ error: { message: "rate limited" } }), {
					status: 429,
					headers: {
						"content-type": "application/json",
						"x-codex-primary-used-percent": "100",
						"x-codex-primary-window-minutes": "300",
						"x-codex-primary-reset-at": String(resetSeconds),
					},
				}),
		);

		const account = makeCodexAccount();
		const persistedAccount = { ...account };
		let releasePersist!: (value: number) => void;
		let markStarted!: () => void;
		const markStartedPromise = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const persistPromise = new Promise<number>((resolve) => {
			releasePersist = resolve;
		});
		const ctx = makeProxyContext();
		ctx.asyncWriter = {
			enqueue: mock((job: () => void | Promise<void>) => {
				void job();
			}),
		} as never;
		ctx.dbOps.markAccountRateLimited = mock(
			async (_accountId: string, until: number, reason: string) => {
				markStarted();
				await persistPromise;
				persistedAccount.rate_limited_until = until;
				persistedAccount.rate_limited_reason = reason as never;
				persistedAccount.rate_limited_at = Date.now();
				persistedAccount.consecutive_rate_limits = 1;
				return 1;
			},
		) as never;

		const bodyBuffer = makeRequestBody();
		const proxyPromise = proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta("codex-verified-reset"),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);
		await markStartedPromise;

		const stateBeforePersist = await Promise.race([
			proxyPromise.then(() => "settled" as const),
			new Promise<"pending">((resolve) =>
				setTimeout(() => resolve("pending"), 10),
			),
		]);
		expect(stateBeforePersist).toBe("pending");

		releasePersist(1);
		expect(await proxyPromise).toBeNull();
		expect(ctx.dbOps.markAccountRateLimited).toHaveBeenCalledWith(
			account.id,
			expect.any(Number),
			"upstream_429_with_reset",
			// Upstream v3.5.44 added the incrementStreak parameter. A real
			// upstream 429 with a reset is genuine quota exhaustion, so the
			// consecutive-rate-limit streak must advance (unlike a 529
			// overload, which passes false).
			true,
		);
		expect(account.rate_limited_until).toBeGreaterThan(Date.now());
		expect(account.rate_limited_reason).toBe("upstream_429_with_reset");
		expect(ctx.dbOps.saveRoutingAttempt).toHaveBeenCalledWith(
			expect.objectContaining({
				parentRequestId: "codex-verified-reset",
				accountId: account.id,
				attemptedModel: "gpt-5.4",
				modelFamily: null,
				statusCode: 429,
				reason: "upstream_429_with_reset",
				scope: "account",
				accountBenched: true,
				routeSuppressed: false,
				circuitCounted: false,
			}),
		);
		expect(ctx.dbOps.saveRequest).not.toHaveBeenCalled();
		expect(persistedAccount.rate_limited_until).toBeGreaterThan(Date.now());

		const terminal = createRoutingTerminalResponse({
			source: "attempts",
			accounts: [account],
			capacityContext: null,
			rateLimitOutcomes: [],
			upstreamAttempts: 1,
		});
		expect(terminal.kind).toBe("pool_exhausted");
		expect(terminal.response.headers.get("retry-after")).not.toBeNull();
		expect(terminal.response.headers.get("x-better-ccflare-pool-status")).toBe(
			"exhausted",
		);
		expect(
			terminal.response.headers.get("x-better-ccflare-recovery-scope"),
		).toBe("pool");

		const followUpCtx = makeProxyContext();
		followUpCtx.dbOps.getAllAccounts = mock(async () => [
			persistedAccount,
		]) as never;
		const followUpMeta = makeRequestMeta("codex-immediate-follow-up", {
			headers: new Headers({
				"x-better-ccflare-account-id": persistedAccount.id,
			}),
		});
		await expect(
			selectAccountsForRequest(followUpMeta, followUpCtx),
		).rejects.toBeInstanceOf(ForceRouteUnavailableError);
	});

	it("keeps a reset-less Codex 429 unverified and non-retryable", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ error: { message: "rate limited" } }), {
					status: 429,
					headers: { "content-type": "application/json" },
				}),
		);
		const ctx = makeProxyContext();
		const persistedAccount = makeCodexAccount();
		ctx.asyncWriter = {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never;
		ctx.dbOps.markAccountRateLimited = mock(
			async (_accountId: string, until: number, reason: string) => {
				persistedAccount.rate_limited_until = until;
				persistedAccount.rate_limited_reason = reason as never;
				return 1;
			},
		) as never;
		const bodyBuffer = makeRequestBody();

		expect(
			await proxyWithAccount(
				makeRequest(bodyBuffer),
				new URL("https://proxy.local/v1/messages"),
				persistedAccount,
				makeRequestMeta("codex-resetless"),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
			),
		).toBeNull();
		expect(persistedAccount.rate_limited_reason).toBe("model_fallback_429");

		const terminal = createRoutingTerminalResponse({
			source: "attempts",
			accounts: [persistedAccount],
			capacityContext: null,
			rateLimitOutcomes: [],
			upstreamAttempts: 1,
		});
		expect(terminal.kind).toBe("route_unavailable");
		expect(terminal.response.headers.get("retry-after")).toBeNull();
		expect(
			terminal.response.headers.get("x-better-ccflare-pool-status"),
		).toBeNull();
	});
});
