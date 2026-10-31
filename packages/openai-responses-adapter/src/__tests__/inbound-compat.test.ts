import { describe, expect, test } from "bun:test";
import { flattenToolHistory, parseBase64DataUrl } from "../inbound-compat";
import { translateRequestToAnthropic } from "../request-translator";
import type { ResponseItem, TranslatableRequest } from "../types";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";

function blockTypes(messages: Array<{ content: unknown }>): string[] {
	return messages.flatMap((message) =>
		typeof message.content === "string"
			? ["string"]
			: (message.content as Array<{ type: string }>).map((b) => b.type),
	);
}

const RESPONSES_HISTORY: ResponseItem[] = [
	{
		type: "message",
		role: "user",
		content: [{ type: "input_text", text: "What is the weather?" }],
	},
	{
		type: "function_call",
		call_id: "call_w",
		name: "weather",
		arguments: '{"city":"Valletta"}',
	},
	{ type: "function_call_output", call_id: "call_w", output: "22C and sunny" },
];

describe("Responses translation of tool history", () => {
	test("without tools, history reaches Anthropic as text only", () => {
		const req: TranslatableRequest = {
			model: "claude-sonnet-5",
			input: RESPONSES_HISTORY,
		};
		const body = translateRequestToAnthropic(req);
		expect(body.tools).toBeUndefined();
		expect(blockTypes(body.messages)).toEqual(["text", "text", "text"]);
		expect(body.messages[1].content).toEqual([
			{
				type: "text",
				text: '[Tool call weather (id call_w) with arguments {"city":"Valletta"}]',
			},
		]);
		expect(body.messages[2].content).toEqual([
			{ type: "text", text: "[Tool result for call call_w]\n22C and sunny" },
		]);
	});

	test("with tools, the translated body is unchanged (pinned)", () => {
		const req: TranslatableRequest = {
			model: "claude-sonnet-5",
			input: RESPONSES_HISTORY,
			tools: [{ type: "function", name: "weather", parameters: {} }],
		};
		const body = translateRequestToAnthropic(req);
		expect(blockTypes(body.messages)).toEqual([
			"text",
			"tool_use",
			"tool_result",
		]);
		expect(JSON.stringify(body.messages)).toBe(PINNED_TOOLS_PRESENT_MESSAGES);
	});

	test("an input_image data URL with parameters and line breaks is accepted", () => {
		const req: TranslatableRequest = {
			model: "claude-sonnet-5",
			input: [
				{
					type: "message",
					role: "user",
					content: [
						{
							type: "input_image",
							image_url: `data:image/png;name=a.png;base64,${PNG.slice(0, 30)}\r\n${PNG.slice(30)}`,
						},
					],
				},
			],
		};
		const body = translateRequestToAnthropic(req);
		expect(body.messages[0].content).toEqual([
			{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: PNG },
			},
		]);
	});
});

// Captured from the translator before inbound-compat was wired in.
const PINNED_TOOLS_PRESENT_MESSAGES =
	'[{"role":"user","content":[{"type":"text","text":"What is the weather?"}]},{"role":"assistant","content":[{"type":"tool_use","id":"call_w","name":"weather","input":{"city":"Valletta"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_w","content":"22C and sunny"}]}]';

describe("parseBase64DataUrl", () => {
	test("the plain form parses unchanged", () => {
		expect(parseBase64DataUrl(`data:image/png;base64,${PNG}`)).toEqual({
			mediaType: "image/png",
			data: PNG,
		});
	});

	test("RFC 2397 parameters before ;base64 are dropped from the media type", () => {
		expect(
			parseBase64DataUrl(
				`data:image/png;charset=binary;name=pixel.png;base64,${PNG}`,
			),
		).toEqual({ mediaType: "image/png", data: PNG });
	});

	test("a payload wrapped every 76 columns has its line breaks removed", () => {
		const wrapped = `${PNG.slice(0, 20)}\n${PNG.slice(20, 40)}\r\n${PNG.slice(40)}\n`;
		expect(parseBase64DataUrl(`data:image/png;base64,${wrapped}`)).toEqual({
			mediaType: "image/png",
			data: PNG,
		});
	});

	test("the media type is lowercased, because Anthropic's enum is", () => {
		expect(parseBase64DataUrl(`data:IMAGE/PNG;BASE64,${PNG}`)).toEqual({
			mediaType: "image/png",
			data: PNG,
		});
	});

	test("a parameter that is not key=value is refused", () => {
		expect(parseBase64DataUrl(`data:image/png;oops;base64,${PNG}`)).toBeNull();
	});

	test("a data URL without ;base64 is refused", () => {
		expect(parseBase64DataUrl("data:image/png,notbase64")).toBeNull();
	});

	test("an empty payload is refused, whitespace included", () => {
		expect(parseBase64DataUrl("data:image/png;base64,")).toBeNull();
		expect(parseBase64DataUrl("data:image/png;base64, \n ")).toBeNull();
	});

	test("a non-data URL is not a data URL", () => {
		expect(parseBase64DataUrl("https://example.com/a.png")).toBeNull();
	});
});

describe("flattenToolHistory", () => {
	test("tool_use and tool_result become text, everything else passes through", () => {
		const image = {
			type: "image",
			source: { type: "base64", media_type: "image/png", data: PNG },
		};
		const out = flattenToolHistory([
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Checking." },
					{ type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } },
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_1",
						content: "found",
						is_error: true,
					},
					{
						type: "tool_result",
						tool_use_id: "call_2",
						content: [{ type: "text", text: "" }, image],
					},
					{ type: "tool_result", tool_use_id: "call_3", content: "" },
				],
			},
		]);
		expect(out as unknown[]).toEqual([
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Checking." },
					{
						type: "text",
						text: '[Tool call lookup (id call_1) with arguments {"q":"x"}]',
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "[Tool result for call call_1, reported as an error]\nfound",
					},
					{ type: "text", text: "[Tool result for call call_2]" },
					image,
					{ type: "text", text: "[Tool result for call call_3] (empty)" },
				],
			},
		]);
	});

	test("a text part whose text is not a string is dropped, not read", () => {
		const out = flattenToolHistory([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_9",
						content: [{ type: "text", text: 5 as unknown as string }],
					},
				],
			},
		]);
		expect(out[0].content as unknown[]).toEqual([
			{ type: "text", text: "[Tool result for call call_9] (empty)" },
		]);
	});

	test("a message with no tool block is returned as the same object", () => {
		const message = {
			role: "user",
			content: [{ type: "text", text: "plain" }],
		};
		expect(flattenToolHistory([message])[0]).toBe(message);
	});
});
