import { describe, expect, it, mock, spyOn } from "bun:test";
import { logBus } from "@better-ccflare/logger";
import type { LogEvent } from "@better-ccflare/types";
import { forwardToClient } from "../response-handler";
import * as usageCollectorModule from "../usage-collector";

describe("forwardToClient non-streaming upstream error observability", () => {
	it("logs bounded 403 error metadata while preserving the response body and status", async () => {
		const body = JSON.stringify({
			type: "error",
			error: {
				type: "permission_error",
				code: "login_required",
				message: "private prompt/account detail",
			},
		});
		const starts: unknown[] = [];
		const ends: unknown[] = [];
		const collector = {
			handleStart: mock((message: unknown) => {
				starts.push(message);
			}),
			handleChunk: mock(),
			handleEnd: mock((message: unknown) => {
				ends.push(message);
				return Promise.resolve();
			}),
		};
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue(
			collector as unknown as usageCollectorModule.UsageCollector,
		);
		const events: LogEvent[] = [];
		const onLog = (event: LogEvent): void => events.push(event);
		logBus.on("log", onLog);

		try {
			const response = await forwardToClient(
				{
					requestId: "req-upstream-403-observation",
					method: "POST",
					path: "/v1/messages",
					account: null,
					requestHeaders: new Headers({
						"content-type": "application/json",
					}),
					requestBody: new TextEncoder().encode("{}"),
					response: new Response(body, {
						status: 403,
						headers: { "content-type": "application/json" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				{
					strategy: {},
					dbOps: {},
					runtime: { port: 8080, tlsEnabled: false },
					config: { getStorePayloads: () => false },
					provider: {
						name: "openai-compatible",
						isStreamingResponse: () => false,
					},
					refreshInFlight: new Map<string, Promise<string>>(),
					asyncWriter: {},
				} as unknown as import("../handlers").ProxyContext,
			);

			expect(response.status).toBe(403);
			expect(await response.text()).toBe(body);

			// The tee's close callback is asynchronous relative to response.text().
			await new Promise((resolve) => setTimeout(resolve, 0));
			const observation = events.find(
				(event) => event.msg === "upstream_non_stream_403",
			);
			expect(observation).toBeDefined();
			expect(observation?.data).toEqual({
				requestId: "req-upstream-403-observation",
				provider: "openai-compatible",
				accountId: null,
				errorType: "permission_error",
				errorCode: "login_required",
				upstreamStatus: 403,
			});
			expect(JSON.stringify(observation)).not.toContain("private prompt");
			expect(starts).toHaveLength(1);
			expect(ends).toHaveLength(1);
			// #756: the failed row records why it failed, never the message text.
			expect(ends[0]).toMatchObject({
				success: false,
				error: "upstream_http_403 type=permission_error code=login_required",
			});
			expect((ends[0] as { error?: string }).error ?? "").not.toContain(
				"private prompt",
			);
		} finally {
			logBus.off("log", onLog);
			collectorSpy.mockRestore();
		}
	});

	it("emits one status-only observation when a non-streaming 403 body errors mid-read", async () => {
		const encoder = new TextEncoder();
		const partialBody = encoder.encode('{"error":{"type":"permission_error"');
		const upstreamError = new Error("upstream body interrupted");
		let firstPull = true;
		const events: LogEvent[] = [];
		const onLog = (event: LogEvent): void => events.push(event);
		logBus.on("log", onLog);
		const collector = {
			handleStart: mock(),
			handleChunk: mock(),
			handleEnd: mock(() => Promise.resolve()),
		};
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue(
			collector as unknown as usageCollectorModule.UsageCollector,
		);

		try {
			const response = await forwardToClient(
				{
					requestId: "req-upstream-403-incomplete",
					method: "POST",
					path: "/v1/messages",
					account: null,
					requestHeaders: new Headers({
						"content-type": "application/json",
					}),
					requestBody: encoder.encode("{}"),
					response: new Response(
						new ReadableStream<Uint8Array>({
							pull(controller) {
								if (firstPull) {
									firstPull = false;
									controller.enqueue(partialBody);
									return;
								}
								controller.error(upstreamError);
							},
						}),
						{
							status: 403,
							headers: { "content-type": "application/json" },
						},
					),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				{
					strategy: {},
					dbOps: {},
					runtime: { port: 8080, tlsEnabled: false },
					config: { getStorePayloads: () => false },
					provider: {
						name: "openai-compatible",
						isStreamingResponse: () => false,
					},
					refreshInFlight: new Map<string, Promise<string>>(),
					asyncWriter: {},
				} as unknown as import("../handlers").ProxyContext,
			);

			const reader = response.body?.getReader();
			expect(reader).toBeDefined();
			await expect(reader?.read()).resolves.toMatchObject({ done: false });
			await expect(reader?.read()).rejects.toThrow("upstream body interrupted");
			await new Promise((resolve) => setTimeout(resolve, 0));

			const observations = events.filter(
				(event) => event.msg === "upstream_non_stream_403",
			);
			expect(observations).toHaveLength(1);
			expect(observations[0]?.data).toEqual({
				requestId: "req-upstream-403-incomplete",
				provider: "openai-compatible",
				accountId: null,
				upstreamStatus: 403,
			});
			expect(JSON.stringify(observations[0])).not.toContain("body interrupted");
			expect(JSON.stringify(observations[0])).not.toContain("bodyTruncated");
		} finally {
			logBus.off("log", onLog);
			collectorSpy.mockRestore();
		}
	});

	async function endsForNonStreaming(
		requestId: string,
		upstream: Response,
	): Promise<{ ends: unknown[]; clientBody: string; status: number }> {
		const ends: unknown[] = [];
		const collector = {
			handleStart: mock(),
			handleChunk: mock(),
			handleEnd: mock((message: unknown) => {
				ends.push(message);
				return Promise.resolve();
			}),
		};
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue(
			collector as unknown as usageCollectorModule.UsageCollector,
		);
		try {
			const response = await forwardToClient(
				{
					requestId,
					method: "POST",
					path: "/v1/messages",
					account: null,
					requestHeaders: new Headers({
						"content-type": "application/json",
					}),
					requestBody: new TextEncoder().encode("{}"),
					response: upstream,
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				{
					strategy: {},
					dbOps: {},
					runtime: { port: 8080, tlsEnabled: false },
					config: { getStorePayloads: () => false },
					provider: {
						name: "openai-compatible",
						isStreamingResponse: () => false,
					},
					refreshInFlight: new Map<string, Promise<string>>(),
					asyncWriter: {},
				} as unknown as import("../handlers").ProxyContext,
			);
			const clientBody = await response.text();
			await new Promise((resolve) => setTimeout(resolve, 0));
			return { ends, clientBody, status: response.status };
		} finally {
			collectorSpy.mockRestore();
		}
	}

	it("records the upstream status as the cause of a plain-text 500", async () => {
		const { ends, clientBody, status } = await endsForNonStreaming(
			"req-upstream-500-plain",
			new Response("Internal Server Error", {
				status: 500,
				headers: { "content-type": "text/plain" },
			}),
		);
		expect(status).toBe(500);
		expect(clientBody).toBe("Internal Server Error");
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({
			success: false,
			error: "upstream_http_500",
		});
	});

	it("records the upstream status when a failed response has no body", async () => {
		const { ends, status } = await endsForNonStreaming(
			"req-upstream-502-empty",
			new Response(null, { status: 502 }),
		);
		expect(status).toBe(502);
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({
			success: false,
			error: "upstream_http_502",
		});
	});

	it("leaves a successful non-streaming response without an error", async () => {
		const { ends } = await endsForNonStreaming(
			"req-upstream-200",
			new Response(JSON.stringify({ type: "message" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({ success: true });
		expect(ends[0]).not.toHaveProperty("error");
	});

	it("keeps midstream Anthropic error telemetry bounded and separate from client bytes", async () => {
		const upstreamBody =
			'event: error\ndata: {"type":"error","error":{"type":"permission_error","code":"login_required","status":403,"message":"private stream detail"}}\n\n';
		const encoder = new TextEncoder();
		const events: LogEvent[] = [];
		const onLog = (event: LogEvent): void => events.push(event);
		logBus.on("log", onLog);
		const collector = {
			handleStart: mock(),
			handleChunk: mock(),
			handleEnd: mock(() => Promise.resolve()),
		};
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue(
			collector as unknown as usageCollectorModule.UsageCollector,
		);

		try {
			const response = await forwardToClient(
				{
					requestId: "req-midstream-403-observation",
					method: "POST",
					path: "/v1/messages",
					account: null,
					requestHeaders: new Headers({
						"anthropic-version": "2023-06-01",
					}),
					requestBody: encoder.encode("{}"),
					response: new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(encoder.encode(upstreamBody));
								controller.close();
							},
						}),
						{
							status: 200,
							headers: { "content-type": "text/event-stream" },
						},
					),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				{
					strategy: {},
					dbOps: {},
					runtime: { port: 8080, tlsEnabled: false },
					config: { getStorePayloads: () => false },
					provider: {
						name: "anthropic",
						isStreamingResponse: () => true,
					},
					refreshInFlight: new Map<string, Promise<string>>(),
					asyncWriter: {},
				} as unknown as import("../handlers").ProxyContext,
			);

			expect(response.status).toBe(200);
			expect(await response.text()).toBe(upstreamBody);
			await new Promise((resolve) => setTimeout(resolve, 0));
			const outcome = events.find(
				(event) => event.msg === "anthropic_stream_terminal_outcome",
			);
			expect(outcome).toBeDefined();
			expect(outcome?.data).toMatchObject({
				requestId: "req-midstream-403-observation",
				status: "midstream_error",
				errorType: "permission_error",
				errorCode: "login_required",
				upstreamStatus: "403",
			});
			expect(JSON.stringify(outcome)).not.toContain("private stream detail");
		} finally {
			logBus.off("log", onLog);
			collectorSpy.mockRestore();
		}
	});
});
