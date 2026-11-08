import { describe, expect, it } from "bun:test";
import {
	ANTHROPIC_SSE_FRAME_KINDS,
	classifyAnthropicSseFrame,
	createAnthropicSseFrameKindCounts,
	incrementAnthropicSseFrameKindCount,
} from "../anthropic-sse-frame-classifier";

describe("classifyAnthropicSseFrame protocol activity", () => {
	it("reports content block boundaries, never for a fallback seam's start (#643)", () => {
		const blockStart = (contentBlock: Record<string, unknown>) =>
			classifyAnthropicSseFrame(
				`event: content_block_start\ndata: ${JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: contentBlock,
				})}\n\n`,
			);

		// A tool call's start carries its name, so generation has begun.
		for (const type of ["tool_use", "server_tool_use"]) {
			expect(blockStart({ type, id: "t", name: "Read", input: {} })).toEqual({
				kind: "structural",
				validProtocolActivity: true,
				contentBlock: "tool_use_start",
			});
		}
		// Text and thinking starts can arrive before the block's first token.
		for (const block of [
			{ type: "text", text: "" },
			{ type: "thinking", thinking: "" },
		]) {
			expect(blockStart(block)).toEqual({
				kind: "structural",
				validProtocolActivity: true,
				contentBlock: "start",
			});
		}
		expect(
			blockStart({
				type: "fallback",
				from: { model: "a" },
				to: { model: "b" },
			}),
		).toEqual({ kind: "structural", validProtocolActivity: true });
		expect(
			classifyAnthropicSseFrame(
				'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
			),
		).toEqual({
			kind: "structural",
			validProtocolActivity: true,
			contentBlock: "stop",
		});
	});

	it("accepts only complete parsed protocol events as idle-refresh evidence", () => {
		for (const frame of [
			'event: ping\ndata: {"type":"ping"}\n\n',
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":null},"usage":{"output_tokens":2}}\n\n',
		]) {
			expect(classifyAnthropicSseFrame(frame).validProtocolActivity).toBeTrue();
		}

		for (const frame of [
			": keepalive\n\n",
			"event: ping\n\n",
			"event: future_event\ndata: {not-json}\n\n",
			'event: message_start\ndata: {"type":"message_start"}\n\n',
		]) {
			expect(
				classifyAnthropicSseFrame(frame).validProtocolActivity,
			).toBeUndefined();
		}
	});

	it("uses fixed sanitized keys and saturates counters", () => {
		const counts = createAnthropicSseFrameKindCounts();
		expect(Object.keys(counts)).toEqual([...ANTHROPIC_SSE_FRAME_KINDS]);

		counts.unknown = Number.MAX_SAFE_INTEGER;
		incrementAnthropicSseFrameKindCount(counts, "unknown");
		expect(counts.unknown).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("treats signature_delta as structural integrity metadata", () => {
		const frame =
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"opaque-integrity-metadata"}}\n\n';

		expect(classifyAnthropicSseFrame(frame)).toEqual({
			kind: "structural",
			validProtocolActivity: true,
		});
	});

	it("retains only allowlisted unsupported-parameter identifiers", () => {
		for (const [message, unsupportedParameter] of [
			["Unsupported parameter: max_tool_calls", "max_tool_calls"],
			["Unsupported parameter: 'tool_choice'.", "tool_choice"],
			['Unsupported parameter: "include.0"', "include.0"],
		] as const) {
			const frame = `event: error\ndata: ${JSON.stringify({
				type: "error",
				error: { type: "api_error", message },
			})}\n\n`;
			expect(classifyAnthropicSseFrame(frame)).toEqual({
				kind: "error",
				validProtocolActivity: true,
				errorType: "api_error",
				transientErrorType: "api_error",
				unsupportedParameter,
			});
		}

		const privateMessage = "private prompt text must not escape";
		const privateFrame = `event: error\ndata: ${JSON.stringify({
			type: "error",
			error: { type: "api_error", message: privateMessage },
		})}\n\n`;
		const classification = classifyAnthropicSseFrame(privateFrame);
		expect(classification).not.toHaveProperty("unsupportedParameter");
		expect(JSON.stringify(classification)).not.toContain(privateMessage);
	});

	it("retains only bounded error code and parameter identifiers", () => {
		const privateMessage = "private backend details must not escape";
		const frame = `event: error\ndata: ${JSON.stringify({
			type: "error",
			error: {
				type: "api_error",
				code: "invalid_tool_choice",
				param: "tool_choice",
				message: privateMessage,
			},
		})}\n\n`;

		const classification = classifyAnthropicSseFrame(frame);
		expect(classification).toMatchObject({
			errorCode: "invalid_tool_choice",
			errorParameter: "tool_choice",
		});
		expect(JSON.stringify(classification)).not.toContain(privateMessage);
	});
});
