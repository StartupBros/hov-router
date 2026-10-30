import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileQualityRoutingPolicy } from "@better-ccflare/core";
import {
	AsyncDbWriter,
	DatabaseFactory,
	type DatabaseOperations,
	QualityRouteRepository,
} from "@better-ccflare/database";
import {
	LeastUsedStrategy,
	restoreAffinityPins,
	SessionAffinityStrategy,
} from "@better-ccflare/load-balancer";
import type {
	Account,
	RequestMeta,
	StrategyStore,
} from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import * as operations from "../handlers/proxy-operations";
import { INTERNAL_PROBE_SECRET_HEADER } from "../handlers/proxy-types";
import { RoutingAttemptLedger } from "../handlers/routing-attempt-ledger";
import { handleProxy } from "../proxy";
import { QualityRouteService } from "../quality-route-service";
import {
	getRequestLifecycleCoordinator,
	recordRoutingTerminalRequest,
} from "../routing-terminal-recorder";
import * as usage from "../usage-collector";

const originalFetch = globalThis.fetch;
let db: DatabaseOperations;
let collector: usage.UsageCollector;
let restores: Array<() => void> = [];
let ctx: ProxyContext;

beforeEach(async () => {
	const directory = mkdtempSync(
		join(tmpdir(), "ccflare-cancellation-history-"),
	);
	DatabaseFactory.initialize(join(directory, "history.db"));
	db = DatabaseFactory.getInstance();
	await db
		.getAdapter()
		.run(
			"INSERT INTO accounts (id, name, provider, api_key, created_at) VALUES (?, ?, ?, ?, ?)",
			["cancel-account", "cancel-account", "test-provider", "synthetic-key", 1],
		);
	const writer = new AsyncDbWriter();
	collector = new usage.UsageCollector(
		db,
		writer,
		() => false,
		() => undefined,
	);
	for (const name of ["getUsageCollector", "tryGetUsageCollector"] as const) {
		const spy = spyOn(usage, name).mockReturnValue(collector);
		restores.push(() => spy.mockRestore());
	}
	ctx = {
		strategy: { select: (accounts: Account[]) => accounts },
		dbOps: db,
		runtime: { port: 8080, clientId: "test" },
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getModelScopedCapacityRouting: () => "exhausted",
			getStorePayloads: () => false,
		},
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: () => "https://synthetic.invalid/v1/messages",
			prepareHeaders: (headers: Headers) => new Headers(headers),
			processResponse: async (response: Response) => response,
			isStreamingResponse: (response: Response) =>
				response.headers.get("content-type")?.includes("text/event-stream") ===
				true,
			parseRateLimit: () => ({ isRateLimited: false, resetTime: null }),
		},
		refreshInFlight: new Map(),
		asyncWriter: writer,
	} as unknown as ProxyContext;
});
afterEach(async () => {
	globalThis.fetch = originalFetch;
	for (const restore of restores) restore();
	restores = [];
	collector.dispose();
	await collector.drain();
	await DatabaseFactory.reset();
});

function makeRequest(controller: AbortController): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		signal: controller.signal,
		headers: {
			"content-type": "application/json",
			"x-better-ccflare-account-id": "cancel-account",
			authorization: "Bearer private-credential",
		},
		body: JSON.stringify({
			model: "test-model",
			messages: [{ role: "user", content: "private prompt" }],
			max_tokens: 1,
		}),
	});
}

describe("proxy startup affinity restore gate", () => {
	const store: StrategyStore = {
		resetAccountSession() {},
		getAccountUtilization: (id) => (id === "cancel-account" ? 90 : 0),
	};

	function deferred<T>() {
		let resolve!: (value: T) => void;
		const promise = new Promise<T>((done) => {
			resolve = done;
		});
		return { promise, resolve };
	}

	function request(model = "claude-opus-4-8"): Request {
		return new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-claude-code-session-id": "restart-gate-client",
			},
			body: JSON.stringify({
				model,
				metadata: { user_id: "restart-gate-client" },
				messages: [{ role: "user", content: "test turn" }],
				max_tokens: 1,
			}),
		});
	}

	async function send(req = request(), apiKeyId?: string): Promise<Response> {
		const response = await handleProxy(req, new URL(req.url), ctx, apiKeyId);
		await response.text();
		await collector.drain();
		return response;
	}

	async function flushRouting(): Promise<void> {
		for (let turn = 0; turn < 20; turn++)
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}

	function history() {
		return {
			summaries: [
				JSON.stringify({
					version: 1,
					processStartedAt: Date.now() - 120_000,
					affinityLane: {
						digest:
							"e87f88d87a47622ec7d24f47498002e6db31dbb942652e5c320490298a3b7924",
						observedAt: Date.now() - 60_000,
						owner: {
							candidateId: "account:cancel-account",
							accountId: "cancel-account",
							assignedAt: Date.now() - 60_000,
							installedBelowBestConfiguredTier: false,
						},
					},
					physicalAttemptCount: 0,
					routeCount: 0,
					attempts: [],
					truncated: false,
					completeness: "complete",
					outputOriginOrdinal: null,
					winnerOrdinal: null,
					nativeStatus: 200,
					wireStatus: 200,
					terminalCause: null,
					cancellationOrigin: null,
				}),
			],
			capReached: false,
		};
	}

	beforeEach(async () => {
		await db
			.getAdapter()
			.run(
				"INSERT INTO accounts (id, name, provider, api_key, created_at) VALUES (?, ?, ?, ?, ?)",
				["fresh-account", "fresh-account", "test-provider", "synthetic-key", 1],
			);
		globalThis.fetch = mock(async (input: string | URL | Request) => {
			if (
				String(input instanceof Request ? input.url : input) !==
				"https://synthetic.invalid/v1/messages"
			)
				throw new Error("External fetch disabled in restore gate test");
			return Response.json({ model: "claude-opus-4-8", content: [] });
		}) as unknown as typeof globalThis.fetch;
	});

	it("holds ordinary selection until the pending restore installs the returning lane's owner", async () => {
		const strategy = new SessionAffinityStrategy();
		strategy.initialize(store);
		ctx.strategy = strategy;
		const select = spyOn(strategy, "select");
		const gate = spyOn(strategy, "affinityRestoreGate");
		const pendingRead = deferred<ReturnType<typeof history>>();
		const reader = spyOn(db, "listAffinityLaneSummariesSince").mockReturnValue(
			pendingRead.promise,
		);
		restores.push(
			() => select.mockRestore(),
			() => gate.mockRestore(),
			() => reader.mockRestore(),
		);
		const restoring = restoreAffinityPins({ strategy, reader: db });
		const response = send();
		try {
			await flushRouting();
			expect(select).not.toHaveBeenCalled();
			expect(globalThis.fetch).not.toHaveBeenCalled();
			expect(gate).toHaveBeenCalledTimes(1);
		} finally {
			pendingRead.resolve(history());
			await restoring;
			await response;
		}
		expect((await response).status).toBe(200);
		expect(select).toHaveBeenCalledTimes(1);
		expect(strategy.getRoutingHealth().affinityRestore?.pinsRestored).toBe(1);
		expect((await db.getRecentRequests())[0].account_used).toBe(
			"cancel-account",
		);
	});

	it("holds quality routing and its direct strategy selection until the restore gate opens", async () => {
		const strategy = new SessionAffinityStrategy();
		strategy.initialize(store);
		ctx.strategy = strategy;
		const policy = compileQualityRoutingPolicy({
			version: 1,
			assignments: [
				{
					line: "claude-opus",
					lane: "opus",
					priority: 0,
					upgrade: "same-line-supported",
				},
			],
			accounts: [
				{
					accountId: "absent-quality-test-account",
					provider: "anthropic",
					lines: ["claude-opus"],
					priority: 0,
				},
			],
			fallbacks: [
				{ from: "fable", to: "astra" },
				{ from: "astra", to: "opus" },
			],
			spendGrants: [],
		});
		ctx.config.getQualityRoutingPolicy = () => policy;
		const service = new QualityRouteService(
			new QualityRouteRepository(db.getAdapter()),
		);
		ctx.qualityRouteService = service;
		const status = spyOn(service, "status");
		const select = spyOn(strategy, "select");
		const gate = spyOn(strategy, "affinityRestoreGate");
		const pendingRead = deferred<ReturnType<typeof history>>();
		const reader = spyOn(db, "listAffinityLaneSummariesSince").mockReturnValue(
			pendingRead.promise,
		);
		restores.push(
			() => status.mockRestore(),
			() => select.mockRestore(),
			() => gate.mockRestore(),
			() => reader.mockRestore(),
		);
		const restoring = restoreAffinityPins({ strategy, reader: db });
		const response = send(
			request("claude-bccf-quality-opus"),
			"restore-test-principal",
		);
		try {
			await flushRouting();
			expect(select).not.toHaveBeenCalled();
			expect(status).not.toHaveBeenCalled();
			expect(gate).toHaveBeenCalledTimes(1);
		} finally {
			pendingRead.resolve(history());
			await restoring;
			await response;
			await service.stop();
		}
		// No enrolled test account is present: real quality routing selects an
		// empty candidate set and refuses locally, without provider traffic.
		expect((await response).status).toBe(503);
		expect(select).toHaveBeenCalledTimes(1);
		expect(select.mock.calls[0][1].affinityLaneKey).toMatch(/^quality-lane_/);
		expect(status).toHaveBeenCalled();
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it.each([
		"completed",
		"never-started",
		"unsupported",
		"hot-reload",
	] as const)("routes with a %s strategy without another history read", async (kind) => {
		const strategy =
			kind === "unsupported"
				? new LeastUsedStrategy()
				: new SessionAffinityStrategy();
		strategy.initialize(store);
		const reader = spyOn(db, "listAffinityLaneSummariesSince")
			.mockResolvedValueOnce(history())
			.mockImplementation(() => new Promise(() => {}));
		const select = spyOn(strategy, "select");
		restores.push(
			() => reader.mockRestore(),
			() => select.mockRestore(),
		);
		if (kind === "completed")
			await restoreAffinityPins({ strategy, reader: db });
		const old = new SessionAffinityStrategy();
		const oldRestore =
			kind === "hot-reload" ? old.beginAffinityRestore() : null;
		ctx.strategy = strategy;
		try {
			expect(ctx.strategy.affinityRestoreGate?.() ?? null).toBeNull();
			let response: Promise<Response>;
			if (kind === "hot-reload") {
				const req = request();
				const body = new TextEncoder().encode(await req.text());
				let releaseBody!: () => void;
				const delayed = new Request(req.url, {
					method: "POST",
					headers: req.headers,
					body: new ReadableStream({
						start(controller) {
							releaseBody = () => {
								controller.enqueue(body);
								controller.close();
							};
						},
					}),
				});
				ctx.strategy = old;
				response = send(delayed);
				// A hot rebuild while the body is pending must be read at routing.
				ctx.strategy = strategy;
				releaseBody();
			} else {
				response = send();
			}
			expect((await response).status).toBe(200);
			expect(select).toHaveBeenCalledTimes(1);
			expect(reader).toHaveBeenCalledTimes(kind === "completed" ? 1 : 0);
			expect((await db.getRecentRequests())[0].account_used).toBe(
				kind === "completed" ? "cancel-account" : "fresh-account",
			);
		} finally {
			oldRestore?.finish({
				state: "abandoned",
				recordsRead: 0,
				pinsRestored: 0,
				durationMs: 0,
				abandonReason: "budget",
			});
		}
	});
});

describe("proxy affinity lane export wiring", () => {
	it.each([
		"ordinary",
		"profile",
		"client-fallback",
		"child-home",
	] as const)("records replacement strategy state at finalize for %s lanes", async (kind) => {
		const original = new SessionAffinityStrategy();
		const replacement = new SessionAffinityStrategy();
		ctx.strategy = original;
		const exportSpy = spyOn(replacement, "exportAffinityLaneRecord");
		restores.push(() => exportSpy.mockRestore());
		let routedMeta: RequestMeta | undefined;
		globalThis.fetch = mock(async (input: string | URL | Request) => {
			if (
				String(input instanceof Request ? input.url : input) !==
				"https://synthetic.invalid/v1/messages"
			)
				throw new Error("External fetch disabled in affinity test");
			return Response.json({ model: "test-model", content: [] });
		}) as unknown as typeof globalThis.fetch;
		const proxyWithAccount = operations.proxyWithAccount;
		const operationSpy = spyOn(
			operations,
			"proxyWithAccount",
		).mockImplementation(async (...args) => {
			const meta = args[3];
			routedMeta = meta;
			meta.clientSessionId = "restart-wiring-client";
			meta.affinityLaneKey =
				kind === "client-fallback"
					? null
					: JSON.stringify([
							kind === "ordinary"
								? "routing-lane-v1"
								: kind === "profile"
									? "routing-lane-profile-v1"
									: "routing-lane-profile-child-v1",
							"test-session",
							"test-model",
						]);
			original.commitAffinityOwner(meta, {
				candidateId: "account:old-owner",
				accountId: "old-owner",
			});
			replacement.commitAffinityOwner(meta, {
				candidateId: "account:cancel-account",
				accountId: "cancel-account",
			});
			// The coordinator was bound before routing. Swap the live context now.
			ctx.strategy = replacement;
			return proxyWithAccount(...args);
		});
		restores.push(() => operationSpy.mockRestore());
		const request = makeRequest(new AbortController());
		const response = await handleProxy(request, new URL(request.url), ctx);
		expect(response.status).toBe(200);
		await response.text();
		await collector.drain();
		const rows = await db.getRecentRequests();
		expect(rows).toHaveLength(1);
		const row = await db
			.getAdapter()
			.get<{ routing_attempt_summary: string }>(
				"SELECT routing_attempt_summary FROM requests WHERE id = ?",
				[rows[0].id],
			);
		const summary = JSON.parse(row?.routing_attempt_summary ?? "null");
		expect(summary).not.toBeNull();
		expect(
			replacement.snapshotAffinityOwner(routedMeta as RequestMeta),
		).toEqual({
			candidateId: "account:cancel-account",
			accountId: "cancel-account",
		});
		if (kind === "child-home") {
			expect(summary.affinityLane).toBeUndefined();
			expect(exportSpy).not.toHaveBeenCalled();
		} else {
			expect(exportSpy).toHaveBeenCalledTimes(1);
			expect(summary.affinityLane).toMatchObject({
				digest: expect.stringMatching(/^[a-f0-9]{64}$/),
				owner: {
					candidateId: "account:cancel-account",
					accountId: "cancel-account",
					installedBelowBestConfiguredTier: false,
				},
			});
		}
	});
});

describe("canonical history for caller cancellation before forwarding", () => {
	it("records an unattempted cancellation once with no invented account or physical attempt and sanitized headers", async () => {
		const requestMeta = {
			id: crypto.randomUUID(),
			timestamp: Date.now(),
			method: "POST",
			path: "/v1/messages",
		} as RequestMeta;
		getRequestLifecycleCoordinator(requestMeta).bindRoutingObservation(
			new RoutingAttemptLedger(),
			(status) => status,
		);
		const startSpy = spyOn(collector, "handleStart");
		restores.push(() => startSpy.mockRestore());
		const fetch = mock(async () => {
			throw new Error("No provider or pricing calls permitted");
		});
		globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
		const options = {
			collector,
			requestMeta,
			requestHeaders: new Headers({
				authorization: "Bearer private-credential",
				"x-api-key": "private-api-key",
			}),
			response: new Response(null, { status: 499 }),
			providerName: "anthropic",
			terminalKind: "client_cancelled",
			upstreamAttempts: 0,
		};
		await Promise.all([
			recordRoutingTerminalRequest(options),
			recordRoutingTerminalRequest(options),
		]);
		await collector.drain();
		expect(fetch).not.toHaveBeenCalled();
		expect(startSpy).toHaveBeenCalledTimes(1);
		const headers = JSON.stringify(startSpy.mock.calls[0][0].requestHeaders);
		expect(headers).not.toContain("private-credential");
		expect(headers).not.toContain("private-api-key");
		const rows = await db.getRecentRequests();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: requestMeta.id,
			account_used: null,
			status_code: 499,
			success: false,
		});
		const row = await db
			.getAdapter()
			.get<{ routing_attempt_summary: string }>(
				"SELECT routing_attempt_summary FROM requests WHERE id=?",
				[requestMeta.id],
			);
		expect(JSON.parse(row?.routing_attempt_summary)).toMatchObject({
			physicalAttemptCount: 0,
			attempts: [],
			winnerOrdinal: null,
			terminalCause: "client_cancelled",
		});
	});
	it("keeps authenticated auto-refresh cancellation out of request history", async () => {
		const controller = new AbortController();
		ctx.internalProbeSecret = "synthetic-internal-secret";
		const request = makeRequest(controller);
		request.headers.set(INTERNAL_PROBE_SECRET_HEADER, ctx.internalProbeSecret);
		request.headers.set("x-better-ccflare-auto-refresh", "true");
		globalThis.fetch = mock(async () => {
			controller.abort();
			throw new DOMException("synthetic disconnect", "AbortError");
		}) as unknown as typeof globalThis.fetch;
		const response = await handleProxy(request, new URL(request.url), ctx);
		expect(response.status).toBe(499);
		await collector.drain();
		expect(await db.getRecentRequests()).toEqual([]);
	});

	it("keeps telemetry failure fail-open on a caller cancellation", async () => {
		const controller = new AbortController();
		const request = makeRequest(controller);
		const endSpy = spyOn(collector, "handleEnd").mockRejectedValue(
			new Error("synthetic telemetry failure"),
		);
		restores.push(() => endSpy.mockRestore());
		globalThis.fetch = mock(async () => {
			controller.abort();
			throw new DOMException("synthetic disconnect", "AbortError");
		}) as unknown as typeof globalThis.fetch;
		const response = await handleProxy(request, new URL(request.url), ctx);
		expect(response.status).toBe(499);
		expect(endSpy).toHaveBeenCalledTimes(1);
	});

	it("returns 499 before pending cancellation telemetry settles", async () => {
		const controller = new AbortController();
		const request = makeRequest(controller);
		const end = collector.handleEnd.bind(collector);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let pendingEnd: Promise<void> | undefined;
		const endSpy = spyOn(collector, "handleEnd").mockImplementation(
			(message) => {
				pendingEnd = gate.then(() => end(message));
				return pendingEnd;
			},
		);
		restores.push(() => endSpy.mockRestore());
		const fetch = mock(async () => {
			controller.abort();
			throw new DOMException("synthetic disconnect", "AbortError");
		});
		globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const response = handleProxy(request, new URL(request.url), ctx);
		try {
			const result = await Promise.race([
				response,
				new Promise<null>((resolve) => {
					timeout = setTimeout(() => resolve(null), 250);
				}),
			]);
			expect(result?.status).toBe(499);
			expect(endSpy).toHaveBeenCalledTimes(1);
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(await db.getRecentRequests()).toEqual([]);
		} finally {
			clearTimeout(timeout);
			release();
			await response;
			await pendingEnd;
			await collector.drain();
		}
		const rows = await db.getRecentRequests();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			status_code: 499,
			success: false,
			account_used: "cancel-account",
		});
		expect(await db.getRequestPayload(rows[0].id)).toBeNull();
	});

	it("does not log an internally discarded candidate as caller cancellation", async () => {
		const controller = new AbortController();
		globalThis.fetch = mock(async () =>
			Response.json({ content: [] }),
		) as unknown as typeof globalThis.fetch;
		const proxyWithAccount = operations.proxyWithAccount;
		const operationSpy = spyOn(
			operations,
			"proxyWithAccount",
		).mockImplementation(async (...args) => {
			const result = await proxyWithAccount(...args);
			expect(operations.isPreparedProxyAccountResponse(result)).toBe(true);
			if (operations.isPreparedProxyAccountResponse(result))
				await result.discard("synthetic internal loser");
			return new Response(null, { status: 499 });
		});
		restores.push(() => operationSpy.mockRestore());
		const request = makeRequest(controller);
		await handleProxy(request, new URL(request.url), ctx);
		expect(controller.signal.aborted).toBe(false);
		await collector.drain();
		expect(await db.getRecentRequests()).toEqual([]);
	});

	it.each([
		"started",
		"finalizing",
		"streaming",
	] as const)("preserves a %s collector when caller cancellation follows response ownership", async (phase) => {
		const controller = new AbortController();
		const startSpy = spyOn(collector, "handleStart");
		const end = collector.handleEnd.bind(collector);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let pendingEnd: Promise<void> | undefined;
		const endSpy = spyOn(collector, "handleEnd").mockImplementation(
			(message) => {
				pendingEnd = gate.then(() => end(message));
				return pendingEnd;
			},
		);
		restores.push(
			() => startSpy.mockRestore(),
			() => endSpy.mockRestore(),
		);
		globalThis.fetch = mock(async (input: string | URL | Request) => {
			if (
				String(input instanceof Request ? input.url : input) !==
				"https://synthetic.invalid/v1/messages"
			)
				throw new Error("External fetch disabled in integration test");
			if (phase === "streaming") {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(stream) {
							stream.enqueue(
								new TextEncoder().encode(
									'event: message_start\ndata: {"type":"message_start","message":{"id":"synthetic","model":"test-model","usage":{"input_tokens":17,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":3}}\n\n',
								),
							);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			return Response.json({
				model: "test-model",
				content: [],
				usage: { input_tokens: 17, output_tokens: 3 },
			});
		}) as unknown as typeof globalThis.fetch;
		const proxyWithAccount = operations.proxyWithAccount;
		const operationSpy = spyOn(
			operations,
			"proxyWithAccount",
		).mockImplementation(async (...args) => {
			const result = await proxyWithAccount(...args);
			expect(operations.isPreparedProxyAccountResponse(result)).toBe(true);
			if (operations.isPreparedProxyAccountResponse(result)) {
				const commit = result.commit;
				result.commit = async () => {
					const response = await commit();
					if (phase === "finalizing") await response.text();
					expect(getRequestLifecycleCoordinator(args[3]).state).toBe(
						phase === "finalizing" ? "finalized" : "started",
					);
					if (phase !== "streaming") controller.abort();
					return response;
				};
			}
			return result;
		});
		restores.push(() => operationSpy.mockRestore());
		const request = makeRequest(controller);
		try {
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(startSpy).toHaveBeenCalledTimes(1);
			if (phase !== "finalizing") {
				expect(endSpy).not.toHaveBeenCalled();
				if (phase === "streaming") {
					const reader = response.body?.getReader();
					const chunk = await reader.read();
					expect(chunk.done).toBe(false);
					expect(new TextDecoder().decode(chunk.value)).toContain(
						"message_start",
					);
					controller.abort();
					release();
					await reader.cancel();
				} else await response.body?.cancel();
			}
			await Promise.resolve();
			expect(endSpy).toHaveBeenCalledTimes(1);
		} finally {
			release();
		}
		await pendingEnd;
		await collector.drain();
		const rows = await db.getRecentRequests();
		expect(rows).toHaveLength(1);
		expect(rows[0].status_code).toBe(200);
		expect(rows[0].success).toBe(phase === "finalizing");
		if (phase !== "started") {
			const row = await db
				.getAdapter()
				.get<Record<string, unknown>>(
					"SELECT input_tokens, output_tokens FROM requests WHERE id=?",
					[rows[0].id],
				);
			expect(row).toEqual({ input_tokens: 17, output_tokens: 3 });
		}
	});

	it.each([
		"fetch",
		"prepared",
	] as const)("persists one failed request on %s cancellation, without failover or account penalty", async (phase) => {
		const controller = new AbortController();
		let originalRequestId: string | undefined;
		let discarded = 0;
		const proxyWithAccount = operations.proxyWithAccount;
		const operationSpy = spyOn(
			operations,
			"proxyWithAccount",
		).mockImplementation(async (...args) => {
			originalRequestId = args[3].id;
			const result = await proxyWithAccount(...args);
			if (phase === "prepared") {
				expect(operations.isPreparedProxyAccountResponse(result)).toBe(true);
				if (operations.isPreparedProxyAccountResponse(result)) {
					const discard = result.discard;
					result.discard = async (reason) => {
						discarded++;
						await discard(reason);
					};
					controller.abort();
				}
			}
			return result;
		});
		restores.push(() => operationSpy.mockRestore());
		const fetch = mock(async () => {
			if (phase === "fetch") {
				controller.abort();
				throw new DOMException("synthetic caller disconnect", "AbortError");
			}
			return Response.json({
				model: "test-model",
				content: [],
				usage: { input_tokens: 100, output_tokens: 50 },
			});
		});
		globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			signal: controller.signal,
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-account-id": "cancel-account",
			},
			body: JSON.stringify({
				model: "test-model",
				messages: [{ role: "user", content: "private prompt" }],
				max_tokens: 1,
			}),
		});
		const response = await handleProxy(request, new URL(request.url), ctx);
		expect(response.status).toBe(499);
		expect(fetch).toHaveBeenCalledTimes(1);
		await collector.drain();
		const rows = await db.getRecentRequests();
		expect(rows).toHaveLength(1);
		expect(originalRequestId).toBeDefined();
		expect(rows[0]).toMatchObject({
			id: originalRequestId,
			account_used: "cancel-account",
			status_code: 499,
			success: false,
		});
		expect(discarded).toBe(phase === "prepared" ? 1 : 0);
		const persisted = await db
			.getAdapter()
			.get<Record<string, unknown>>("SELECT * FROM requests WHERE id=?", [
				originalRequestId,
			]);
		expect(persisted).toMatchObject({
			error_message: "client_cancelled",
			stream_terminal_state: "client_cancelled",
			input_tokens: null,
			output_tokens: null,
			cost_usd: null,
			routed_provider: "anthropic",
			routed_model: "test-model",
		});
		const summary = JSON.parse(persisted?.routing_attempt_summary as string);
		expect(summary).toMatchObject({
			physicalAttemptCount: 1,
			winnerOrdinal: null,
			nativeStatus: 499,
			terminalCause: "client_cancelled",
			cancellationOrigin: "unknown",
		});
		expect(summary.attempts).toHaveLength(1);
		expect(summary.attempts[0]).toMatchObject({
			accountId: "cancel-account",
			outcome: "cancelled",
			cause: "client_cancelled",
		});
		expect(await db.getRequestPayload(rows[0].id)).toBeNull();
		const account = await db.getAccount("cancel-account");
		expect(account?.paused).toBe(false);
		expect(account?.rate_limited_until).toBeNull();
	});
});
