import { describe, expect, it } from "bun:test";
import type { RequestMeta } from "@better-ccflare/types";
import { parseModelRouteProfiles } from "../model-route-profiles";
import {
	authorizeWebSearchHelper,
	getWebSearchHelperScope,
	isFreshWebSearchHelper,
} from "../websearch-helper-policy";

const fresh = () => ({
	model: "claude-opus-5",
	tools: [{ type: "web_search_20250305", name: "web_search" }],
	messages: [{ role: "user", content: "search for current news" }],
});
const profile = () => {
	const configured = parseModelRouteProfiles(
		JSON.stringify([
			{
				id: "local",
				displayName: "Local",
				accountId: "local-account",
				logicalModel: "claude-opus-5",
				expectedProvider: "openai-compatible",
				expectedPhysicalModel: "chat",
				exclusiveAccount: true,
				webSearchHelper: { accountIds: ["native-a", "native-b"] },
			},
		]),
	)[0];
	if (!configured) throw new Error("Expected configured profile");
	return configured;
};

// These are wire-body failures, not just the broader existing helper preview.
const invalidBodies: [string, unknown][] = [
	[
		"mixed tools",
		{
			...fresh(),
			tools: [...fresh().tools, { name: "shell", input_schema: {} }],
		},
	],
	["unrecognized tool", { ...fresh(), tools: [...fresh().tools, {}] }],
	[
		"multiple messages",
		{ ...fresh(), messages: [...fresh().messages, ...fresh().messages] },
	],
	[
		"assistant history",
		{ ...fresh(), messages: [{ role: "assistant", content: "old" }] },
	],
	[
		"search history",
		{
			...fresh(),
			messages: [
				{
					role: "user",
					content: [{ type: "web_search_tool_result", content: [] }],
				},
			],
		},
	],
	[
		"citations",
		{
			...fresh(),
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "old", citations: [] }],
				},
			],
		},
	],
	[
		"replay",
		{
			...fresh(),
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "old", encrypted_content: "old" }],
				},
			],
		},
	],
	[
		"invalid version",
		{
			...fresh(),
			tools: [{ type: "web_search_20259999", name: "web_search" }],
		},
	],
	[
		"invalid name",
		{ ...fresh(), tools: [{ type: "web_search_20250305", name: "wrong" }] },
	],
	[
		"invalid option",
		{ ...fresh(), tools: [{ ...fresh().tools[0], max_uses: -1 }] },
	],
	[
		"duplicate declarations",
		{ ...fresh(), tools: [...fresh().tools, ...fresh().tools] },
	],
	[
		"incomplete history scan",
		{
			...fresh(),
			messages: [
				{
					role: "user",
					content: Array.from({ length: 16385 }, () => ({
						type: "text",
						text: "query",
					})),
				},
			],
		},
	],
	["malformed message", { ...fresh(), messages: [null] }],
];

describe("fresh standalone WebSearch policy", () => {
	it("accepts text and text-block user messages with supported native options", () => {
		expect(isFreshWebSearchHelper(fresh())).toBe(true);
		expect(
			isFreshWebSearchHelper({
				...fresh(),
				tools: [
					{
						...fresh().tools[0],
						max_uses: 2,
						allowed_domains: ["example.com"],
					},
				],
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: "query",
								cache_control: { type: "ephemeral" },
							},
						],
					},
				],
			}),
		).toBe(true);
	});
	it.each(invalidBodies)("denies %s", (_name, body) => {
		expect(isFreshWebSearchHelper(body)).toBe(false);
	});
	it.each([
		"explicit",
		"inherited",
	] as const)("privately retains %s source constraints without changing metadata", (source) => {
		const meta = {
			forcedAccountId: "local-account",
			routeExpectedProvider: "openai-compatible",
		} as RequestMeta;
		const before = { ...meta };
		const configured = profile();
		authorizeWebSearchHelper(meta, {
			originalEligible: true,
			body: fresh(),
			resolution: {
				kind: "route",
				source,
				profile: configured,
				generation: null,
			},
			publicForceAccount: false,
		});
		const scope = getWebSearchHelperScope(meta);
		expect(scope?.source).toBe(source);
		expect(scope?.profile).toBe(configured);
		expect(scope?.accountIds).toEqual(["native-a", "native-b"]);
		expect(Object.isFrozen(scope)).toBe(true);
		expect(meta).toEqual(before);
		expect(getWebSearchHelperScope({ ...meta })).toBeUndefined();
	});
	it("requires both original and final eligibility and rejects public force and unopted routes", () => {
		const configured = profile();
		for (const override of [
			{ originalEligible: false },
			{ body: invalidBodies[0]?.[1] },
			{ publicForceAccount: true },
			{
				resolution: {
					kind: "route" as const,
					source: "explicit" as const,
					profile: { ...configured, webSearchHelper: undefined },
					generation: null,
				},
			},
		]) {
			const meta = {} as RequestMeta;
			authorizeWebSearchHelper(meta, {
				originalEligible: true,
				body: fresh(),
				resolution: {
					kind: "route",
					source: "explicit",
					profile: configured,
					generation: null,
				},
				publicForceAccount: false,
				...override,
			});
			expect(getWebSearchHelperScope(meta)).toBeUndefined();
		}
	});
});
