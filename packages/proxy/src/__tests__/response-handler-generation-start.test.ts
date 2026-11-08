import { describe, expect, it, mock, spyOn } from "bun:test";
import {
	attachGenerationStartReader,
	type GenerationStart,
} from "@better-ccflare/providers/stream-evidence";
import type { ProxyContext } from "../handlers";

// See response-handler-anthropic-terminal-recovery.test.ts for why this file
// spies getUsageCollector instead of stubbing @better-ccflare/database.
const usageCollectorModule = await import("../usage-collector");
const { forwardToClient } = await import("../response-handler");

// #643: the gate or translator measures when generation began; the response
// handler reads that measurement once the stream ends and hands it to the
// usage collector, which owns the tokens-per-second figure.

const encoder = new TextEncoder();
const completeTurn = [
	'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-test","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
	'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
	'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
	'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

function ctx(): ProxyContext {
	return {
		strategy: {},
		dbOps: {},
		runtime: { port: 8080, tlsEnabled: false },
		config: { getStorePayloads: () => true },
		provider: { name: "anthropic", isStreamingResponse: () => true },
		refreshInFlight: new Map<string, Promise<string>>(),
		asyncWriter: {},
	} as unknown as ProxyContext;
}

async function forwardAndCollectEnd(
	reading: GenerationStart | null,
): Promise<Record<string, unknown>> {
	const ends: Array<Record<string, unknown>> = [];
	const collector = {
		handleStart: mock(() => undefined),
		handleChunk: mock(() => undefined),
		handleEnd: mock((message: Record<string, unknown>) => {
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
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(completeTurn));
				controller.close();
			},
		});
		if (reading) attachGenerationStartReader(body, () => reading);

		const response = await forwardToClient(
			{
				requestId: `generation-start-${reading ? "measured" : "none"}`,
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({ "anthropic-version": "2023-06-01" }),
				requestBody: encoder.encode("{}"),
				response: new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx(),
		);
		await response.text();
		await new Promise((resolve) => setTimeout(resolve, 0));
	} finally {
		collectorSpy.mockRestore();
	}

	expect(ends).toHaveLength(1);
	return ends[0] as Record<string, unknown>;
}

describe("response handler generation start (#643)", () => {
	it("hands the upstream reading to the usage collector at stream end", async () => {
		const end = await forwardAndCollectEnd({ startedAt: 1_700_000_000_500 });

		expect(end.generationStart).toEqual({ startedAt: 1_700_000_000_500 });
	});

	it("passes a burst reading through unchanged", async () => {
		const end = await forwardAndCollectEnd({ burst: true });

		expect(end.generationStart).toEqual({ burst: true });
	});

	it("omits the field when nothing measured the stream", async () => {
		const end = await forwardAndCollectEnd(null);

		expect(end).not.toHaveProperty("generationStart");
	});
});
