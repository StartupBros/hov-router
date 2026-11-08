import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateAnthropicSsePreCommit } from "../../../../proxy/src/anthropic-semantic-preflight";
import { readGenerationStart } from "../../utils/stream-evidence";
import { CodexProvider } from "./provider";
import { CODEX_TRACE_DIR_ENV } from "./trace";

// #643: the translator emits a reasoning block only at output_item.done and a
// function call's arguments as one delta at done, so downstream frames start
// late. The first response.output_item.added marks when generation began.

const enc = new TextEncoder();
const frame = (name: string, data: Record<string, unknown>) =>
	`event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;

const created = frame("response.created", {
	response: { id: "resp_1", model: "gpt-test" },
});
const reasoningAdded = frame("response.output_item.added", {
	output_index: 0,
	item: { type: "reasoning", id: "rs_1" },
});
const reasoningDone = frame("response.output_item.done", {
	output_index: 0,
	item: { type: "reasoning", id: "rs_1", encrypted_content: "opaque" },
});
const messageAdded = frame("response.output_item.added", {
	output_index: 1,
	item: { type: "message", id: "msg_1", role: "assistant", content: [] },
});
const partAdded = frame("response.content_part.added", {
	output_index: 1,
	content_index: 0,
	part: { type: "output_text", text: "" },
});
const textDelta = frame("response.output_text.delta", {
	output_index: 1,
	content_index: 0,
	delta: "hello",
});
const completed = frame("response.completed", {
	response: { usage: { input_tokens: 3, output_tokens: 40 } },
});

const T0 = 1_700_000_000_000;
const realDateNow = Date.now;
let now = T0;
let traceDir: string;
let previousTraceDir: string | undefined;

beforeEach(() => {
	now = T0;
	Date.now = () => now;
	traceDir = mkdtempSync(join(tmpdir(), "codex-generation-start-"));
	previousTraceDir = process.env[CODEX_TRACE_DIR_ENV];
	process.env[CODEX_TRACE_DIR_ENV] = traceDir;
});

afterEach(() => {
	Date.now = realDateNow;
	if (previousTraceDir === undefined) delete process.env[CODEX_TRACE_DIR_ENV];
	else process.env[CODEX_TRACE_DIR_ENV] = previousTraceDir;
	rmSync(traceDir, { recursive: true, force: true });
});

/** One raw upstream read per entry, each arriving at its own fake-clock time. */
function timedUpstream(
	reads: ReadonlyArray<{ at: number; text: string }>,
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
				controller.enqueue(enc.encode(next.text));
			},
		},
		// Pull only when a read is pending, so the fake clock moves when the
		// consumer reads, not when the stream pre-fills its queue.
		{ highWaterMark: 0 },
	);
}

async function translate(
	reads: ReadonlyArray<{ at: number; text: string }>,
): Promise<ReadableStream<Uint8Array>> {
	const response = await new CodexProvider().processResponse(
		new Response(timedUpstream(reads), {
			headers: { "content-type": "text/event-stream" },
		}),
		null,
	);
	if (!response.body) throw new Error("Expected a translated stream");
	return response.body;
}

describe("Codex translator generation start (#643)", () => {
	it("dates generation from the read that carried the first output item", async () => {
		const body = await translate([
			{ at: T0 + 1_000, text: created + reasoningAdded },
			{ at: T0 + 5_000, text: reasoningDone + messageAdded + partAdded },
			{ at: T0 + 5_200, text: textDelta + completed },
		]);
		await new Response(body).text();

		expect(readGenerationStart(body)).toEqual({ startedAt: T0 + 1_000 });
	});

	it("reports a burst when every output item arrived in one read", async () => {
		const body = await translate([
			{ at: T0 + 1_000, text: created },
			{
				at: T0 + 4_000,
				text:
					reasoningAdded +
					reasoningDone +
					messageAdded +
					partAdded +
					textDelta +
					completed,
			},
		]);
		await new Response(body).text();

		expect(readGenerationStart(body)).toEqual({ burst: true });
	});

	it("reports nothing for a response that produced no output item", async () => {
		const body = await translate([
			{ at: T0 + 1_000, text: created },
			{ at: T0 + 2_000, text: completed },
		]);
		await new Response(body).text();

		expect(readGenerationStart(body)).toBeNull();
	});

	it("survives the precommit gate, which forwards it instead of measuring", async () => {
		const body = await translate([
			{ at: T0 + 1_000, text: created + reasoningAdded },
			{ at: T0 + 5_000, text: reasoningDone + messageAdded + partAdded },
			{ at: T0 + 5_200, text: textDelta + completed },
		]);
		const released = await gateAnthropicSsePreCommit(body);
		await new Response(released).text();

		expect(readGenerationStart(released)).toEqual({ startedAt: T0 + 1_000 });
	});
});
