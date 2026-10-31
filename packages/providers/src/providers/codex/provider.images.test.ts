/**
 * Images on the Codex path. Anthropic image blocks, in a user turn or inside a
 * tool_result (Read of a PNG, a browser screenshot), must reach Codex as
 * Responses input_image items in source order. Results without images keep
 * their historical joined-string form so existing conversations replay
 * byte-identically and keep their cached prefix.
 */
import { describe, expect, test } from "bun:test";
import { CodexProvider } from "./provider";

type Item = Record<string, unknown>;

async function transform(messages: unknown[]): Promise<Item[]> {
	const provider = new CodexProvider();
	const req = new Request("https://example.com/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages,
		}),
	});
	const out = await provider.transformRequestBody(req, undefined);
	return ((await out.json()) as { input: Item[] }).input;
}

const png = (data: string) => ({
	type: "image",
	source: { type: "base64", media_type: "image/png", data },
});

const withToolResult = (result: Record<string, unknown>) => [
	{ role: "user", content: "look" },
	{
		role: "assistant",
		content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
	},
	{
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "t1", ...result }],
	},
];

const outputOf = (input: Item[]) =>
	input.find((it) => it.type === "function_call_output")?.output;

describe("Codex transform: text-only conversations are unchanged", () => {
	test("a text-only conversation with a tool result serializes to the pinned input", async () => {
		const input = await transform([
			{ role: "user", content: "look" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "reading" },
					{ type: "tool_use", id: "t1", name: "Read", input: { path: "a" } },
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: [
							{ type: "text", text: "a" },
							{ type: "text", text: "b" },
						],
					},
					{ type: "text", text: "thanks" },
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						is_error: true,
						content: "boom",
					},
				],
			},
		]);
		expect(JSON.stringify(input)).toBe(PINNED_TEXT_ONLY_INPUT);
	});
});

describe("Codex transform: images in tool results", () => {
	test("text and image keep their order as input_text / input_image", async () => {
		const input = await transform(
			withToolResult({
				content: [
					{ type: "text", text: "before" },
					png("QUJD"),
					{ type: "text", text: "after" },
				],
			}),
		);
		expect(outputOf(input)).toEqual([
			{ type: "input_text", text: "before" },
			{
				type: "input_image",
				image_url: "data:image/png;base64,QUJD",
				detail: "high",
			},
			{ type: "input_text", text: "after" },
		]);
	});

	test("text-only result keeps the joined-string form", async () => {
		const input = await transform(
			withToolResult({
				content: [
					{ type: "text", text: "a" },
					{ type: "text", text: "b" },
				],
			}),
		);
		expect(outputOf(input)).toBe("a\nb");
	});

	test("is_error with an image leads with a tool-error marker", async () => {
		const input = await transform(
			withToolResult({ is_error: true, content: [png("QUJD")] }),
		);
		expect(outputOf(input)).toEqual([
			{ type: "input_text", text: "[tool error]" },
			{
				type: "input_image",
				image_url: "data:image/png;base64,QUJD",
				detail: "high",
			},
		]);
	});

	test("is_error text-only keeps the string prefix", async () => {
		const input = await transform(
			withToolResult({
				is_error: true,
				content: [{ type: "text", text: "boom" }],
			}),
		);
		expect(outputOf(input)).toBe("[tool error] boom");
	});

	test("image without a convertible source degrades to a text marker", async () => {
		const input = await transform(
			withToolResult({
				content: [
					{ type: "image", source: { type: "file", file_id: "file_1" } },
				],
			}),
		);
		expect(outputOf(input)).toBe(
			"[image content omitted: source not supported by Codex]",
		);
	});
});

describe("Codex transform: images in user messages", () => {
	test("attached image becomes input_image inside the user message, in order", async () => {
		const input = await transform([
			{
				role: "user",
				content: [{ type: "text", text: "what is this?" }, png("WFla")],
			},
		]);
		const user = input.filter((it) => it.role === "user");
		expect(user).toHaveLength(1);
		expect(user[0]?.content).toEqual([
			{ type: "input_text", text: "what is this?" },
			{
				type: "input_image",
				image_url: "data:image/png;base64,WFla",
				detail: "high",
			},
		]);
	});

	test("url image source passes through unchanged", async () => {
		const input = await transform([
			{
				role: "user",
				content: [
					{
						type: "image",
						source: { type: "url", url: "https://example.com/a.png" },
					},
				],
			},
		]);
		expect(input.find((it) => it.role === "user")?.content).toEqual([
			{
				type: "input_image",
				image_url: "https://example.com/a.png",
				detail: "high",
			},
		]);
	});

	test("non-image media type is not sent as input_image", async () => {
		const input = await transform([
			{
				role: "user",
				content: [
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "application/pdf",
							data: "QUJD",
						},
					},
				],
			},
		]);
		expect(input.find((it) => it.role === "user")?.content).toEqual([
			{
				type: "input_text",
				text: "[image content omitted: source not supported by Codex]",
			},
		]);
	});
});

// Captured from the provider before images were converted.
const PINNED_TEXT_ONLY_INPUT =
	'[{"role":"user","content":[{"type":"input_text","text":"look"}]},{"role":"assistant","content":[{"type":"output_text","text":"reading"}]},{"type":"function_call","call_id":"t1","name":"Read","arguments":"{\\"path\\":\\"a\\"}","status":"completed"},{"type":"function_call_output","call_id":"t1","output":"a\\nb","status":"completed"},{"role":"user","content":[{"type":"input_text","text":"thanks"}]},{"type":"function_call_output","call_id":"t1","output":"[tool error] boom","status":"completed"}]';
