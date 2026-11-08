import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	attachGenerationStartReader,
	readGenerationStart,
} from "@better-ccflare/providers/stream-evidence";
import {
	type AnthropicSemanticPreflightOptions,
	gateAnthropicSsePreCommit,
	gateReadsAreNetworkReads,
} from "../anthropic-semantic-preflight";

// #643: the precommit gate holds a block start (tool_use, hidden thinking)
// until the first meaningful frame, then replays the buffer at once, so the
// collector's own first-token stamp lands at release time. The gate reports
// when the read carrying the first output block actually arrived.

const encoder = new TextEncoder();

function sse(type: string, data: Record<string, unknown>): string {
	return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

const messageStart = sse("message_start", {
	message: {
		model: "claude-test",
		usage: { input_tokens: 1, output_tokens: 0 },
	},
});
const toolStart = sse("content_block_start", {
	index: 0,
	content_block: { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
});
const emptyToolDelta = sse("content_block_delta", {
	index: 0,
	delta: { type: "input_json_delta", partial_json: "" },
});
const toolInputDelta = sse("content_block_delta", {
	index: 0,
	delta: { type: "input_json_delta", partial_json: '{"file_path":"/a"}' },
});
const textStart = (index: number) =>
	sse("content_block_start", {
		index,
		content_block: { type: "text", text: "" },
	});
const textDelta = (index: number, text: string) =>
	sse("content_block_delta", { index, delta: { type: "text_delta", text } });
const fallbackStart = sse("content_block_start", {
	index: 0,
	content_block: {
		type: "fallback",
		from: { model: "claude-a" },
		to: { model: "claude-b" },
	},
});
const blockStop = (index: number) => sse("content_block_stop", { index });
const thinkingStart = sse("content_block_start", {
	index: 0,
	content_block: { type: "thinking", thinking: "" },
});
const thinkingDelta = sse("content_block_delta", {
	index: 0,
	delta: { type: "thinking_delta", thinking: "Let me check." },
});
// Hidden thinking streams only its integrity signature, never thinking text.
const signatureDelta = sse("content_block_delta", {
	index: 0,
	delta: { type: "signature_delta", signature: "opaque" },
});
const messageDelta = sse("message_delta", {
	delta: { stop_reason: "end_turn" },
	usage: { output_tokens: 12 },
});
const messageStop = sse("message_stop", {});

interface TimedRead {
	at: number;
	text: string;
}

const realDateNow = Date.now;
let now = 0;

beforeEach(() => {
	now = 1_700_000_000_000;
	Date.now = () => now;
});

afterEach(() => {
	Date.now = realDateNow;
});

/** One upstream read per entry, each arriving at its own fake-clock time. */
function timedUpstream(
	reads: readonly TimedRead[],
): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				const next = reads[index++];
				if (!next) {
					controller.close();
					return;
				}
				now = next.at;
				controller.enqueue(encoder.encode(next.text));
			},
		},
		// Pull only when a read is pending, so the fake clock moves when the
		// consumer reads, not when the stream pre-fills its queue.
		{ highWaterMark: 0 },
	);
}

async function gateAndDrain(
	upstream: ReadableStream<Uint8Array>,
	options: AnthropicSemanticPreflightOptions = {},
): Promise<ReadableStream<Uint8Array>> {
	const released = await gateAnthropicSsePreCommit(upstream, options);
	await new Response(released).text();
	return released;
}

const T0 = 1_700_000_000_000;

describe("precommit gate generation start (#643)", () => {
	it("dates a held tool_use block from the read that carried its start", async () => {
		const released = await gateAndDrain(
			timedUpstream([
				{ at: T0 + 1_000, text: messageStart + toolStart + emptyToolDelta },
				{ at: T0 + 6_000, text: toolInputDelta },
				{ at: T0 + 6_100, text: blockStop(0) + messageDelta + messageStop },
			]),
			{ measureGenerationStart: true },
		);

		expect(readGenerationStart(released)).toEqual({ startedAt: T0 + 1_000 });
	});

	it("reports a burst when the whole response arrived in one read", async () => {
		const released = await gateAndDrain(
			timedUpstream([
				{
					at: T0 + 1_000,
					text:
						messageStart +
						textStart(0) +
						textDelta(0, "hi") +
						blockStop(0) +
						messageDelta +
						messageStop,
				},
			]),
			{ measureGenerationStart: true },
		);

		expect(readGenerationStart(released)).toEqual({ burst: true });
	});

	it("measures ordinary streamed text that the gate released at once", async () => {
		const released = await gateAndDrain(
			timedUpstream([
				{
					at: T0 + 1_000,
					text: messageStart + textStart(0) + textDelta(0, "a"),
				},
				{ at: T0 + 3_000, text: textDelta(0, "b") + blockStop(0) },
				{ at: T0 + 3_100, text: messageDelta + messageStop },
			]),
			{ measureGenerationStart: true },
		);

		expect(readGenerationStart(released)).toEqual({ startedAt: T0 + 1_000 });
	});

	it("dates streamed text from its first token, not an early block start", async () => {
		const released = await gateAndDrain(
			timedUpstream([
				{ at: T0 + 1_000, text: messageStart + textStart(0) },
				{ at: T0 + 3_000, text: textDelta(0, "a") },
				{ at: T0 + 3_100, text: blockStop(0) + messageDelta + messageStop },
			]),
			{ measureGenerationStart: true },
		);

		expect(readGenerationStart(released)).toEqual({ startedAt: T0 + 3_000 });
	});

	it("dates visible thinking from its first thinking token", async () => {
		const released = await gateAndDrain(
			timedUpstream([
				{ at: T0 + 1_000, text: messageStart + thinkingStart },
				{ at: T0 + 2_500, text: thinkingDelta },
				{
					at: T0 + 4_000,
					text: blockStop(0) + textStart(1) + textDelta(1, "a"),
				},
				{ at: T0 + 4_100, text: blockStop(1) + messageDelta + messageStop },
			]),
			{ measureGenerationStart: true },
		);

		expect(readGenerationStart(released)).toEqual({ startedAt: T0 + 2_500 });
	});

	it("dates hidden thinking from its block start once the block closes unseen", async () => {
		const released = await gateAndDrain(
			timedUpstream([
				{ at: T0 + 1_000, text: messageStart + thinkingStart },
				{
					at: T0 + 7_000,
					text:
						signatureDelta + blockStop(0) + textStart(1) + textDelta(1, "a"),
				},
				{ at: T0 + 7_100, text: blockStop(1) + messageDelta + messageStop },
			]),
			{ measureGenerationStart: true },
		);

		expect(readGenerationStart(released)).toEqual({ startedAt: T0 + 1_000 });
	});

	it("does not date generation from a server-side fallback seam", async () => {
		const released = await gateAndDrain(
			timedUpstream([
				{ at: T0 + 1_000, text: messageStart + fallbackStart + blockStop(0) },
				{ at: T0 + 2_000, text: textStart(1) + textDelta(1, "a") },
				{ at: T0 + 2_500, text: blockStop(1) + messageDelta + messageStop },
			]),
			{ measureGenerationStart: true },
		);

		expect(readGenerationStart(released)).toEqual({ startedAt: T0 + 2_000 });
	});

	it("forwards a translator's own reading instead of measuring translated reads", async () => {
		const upstream = timedUpstream([
			{ at: T0 + 1_000, text: messageStart + toolStart + emptyToolDelta },
			{ at: T0 + 6_000, text: toolInputDelta + blockStop(0) },
			{ at: T0 + 6_100, text: messageDelta + messageStop },
		]);
		attachGenerationStartReader(upstream, () => ({ startedAt: T0 + 500 }));

		const released = await gateAndDrain(upstream);

		expect(readGenerationStart(released)).toEqual({ startedAt: T0 + 500 });
	});

	it("never self-measures a translated body that carries no reading", async () => {
		const released = await gateAndDrain(
			timedUpstream([
				{ at: T0 + 1_000, text: messageStart + toolStart + emptyToolDelta },
				{ at: T0 + 6_000, text: toolInputDelta + blockStop(0) },
				{ at: T0 + 6_100, text: messageDelta + messageStop },
			]),
		);

		expect(readGenerationStart(released)).toBeNull();
	});
});

describe("gateReadsAreNetworkReads", () => {
	it("is true only for the anthropic passthrough an Anthropic SDK client receives", () => {
		const sdk = new Headers({ "anthropic-version": "2023-06-01" });
		const other = new Headers();

		// Claude OAuth and console accounts both route through provider "anthropic".
		expect(gateReadsAreNetworkReads("anthropic", sdk)).toBe(true);
		// The anthropic provider rewrites the stream line by line for
		// non-SDK clients, so one network read can become many gate reads.
		expect(gateReadsAreNetworkReads("anthropic", other)).toBe(false);
		expect(gateReadsAreNetworkReads("codex", sdk)).toBe(false);
		expect(gateReadsAreNetworkReads("openai-compatible", sdk)).toBe(false);
	});
});
