/**
 * A non-streaming reply's token usage reaches its request row through one
 * writer, the usage collector. The response processor used to write the same
 * row a second time, from the provider's own usage parser. On OpenAI-format
 * providers that parser read OpenAI field names from a body the provider had
 * already converted to Anthropic shape, found none, and its COALESCE UPDATE
 * stored zeros over the collector's counts whenever it landed second.
 * Refs #801.
 */
import { afterAll, expect, it, mock, spyOn } from "bun:test";
import "@better-ccflare/core";
import { AsyncDbWriter, DatabaseOperations } from "@better-ccflare/database";
import {
	AnthropicProvider,
	OpenAICompatibleProvider,
} from "@better-ccflare/providers";
import type { Account, RequestResponse } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import type { StartMessage } from "../worker-messages";

// Isolate the pricing catalogue: these fixtures must never fetch models.dev.
const actualCore = await import("@better-ccflare/core");
mock.module("@better-ccflare/core", () => ({
	...actualCore,
	isModelPriced: async () => false,
	estimateCostUSD: async () => 0,
}));
afterAll(() => mock.module("@better-ccflare/core", () => actualCore));
const usageCollectorModule = await import("../usage-collector");
const { UsageCollector } = usageCollectorModule;
const { updateAccountMetadata } = await import(
	"../handlers/response-processor"
);
const { forwardToClient } = await import("../response-handler");

interface UsageRow {
	model: string | null;
	input_tokens: number | null;
	cache_read_input_tokens: number | null;
	cache_creation_input_tokens: number | null;
	output_tokens: number | null;
	total_tokens: number | null;
	cost_usd: number | null;
}

const USAGE_COLUMNS =
	"model, input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens, total_tokens, cost_usd";

function openDb(): DatabaseOperations {
	// Always this fixture's own SQLite database, even with an ambient
	// DATABASE_URL.
	const ambientUrl = process.env.DATABASE_URL;
	try {
		delete process.env.DATABASE_URL;
		return new DatabaseOperations(":memory:", { cacheSize: -2048 });
	} finally {
		if (ambientUrl === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = ambientUrl;
	}
}

function makeAccount(provider: string): Account {
	return {
		id: "acct-usage",
		name: "Usage fixture",
		provider,
		created_at: 1,
	} as Account;
}

function startMessage(providerName: string, response: Response): StartMessage {
	return {
		type: "start",
		messageId: "m1",
		requestId: "r1",
		accountId: "acct-usage",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		requestHeaders: {},
		requestBody: null,
		project: null,
		responseStatus: response.status,
		responseHeaders: Object.fromEntries(response.headers.entries()),
		isStream: false,
		providerName,
		accountBillingType: null,
		accountAutoPauseOnOverageEnabled: null,
		accountName: null,
		agentUsed: null,
		comboName: null,
		apiKeyId: null,
		apiKeyName: null,
		retryAttempt: 0,
		failoverAttempts: 0,
	};
}

/**
 * Store one non-streaming reply through every writer the proxy runs for it,
 * in the order that zeroed rows in production: the collector's save first,
 * then the response processor's account-metadata pass. `upstream` is what
 * the provider's endpoint returned; the provider's own processResponse
 * produces the body both writers see, as it does in the proxy.
 */
async function storeThroughEveryWriter(
	providerName: string,
	provider: AnthropicProvider | OpenAICompatibleProvider,
	upstream: Response,
): Promise<UsageRow> {
	const db = openDb();
	const writer = new AsyncDbWriter();
	const collector = new UsageCollector(
		db,
		writer,
		() => false,
		() => {},
	);
	try {
		await db
			.getAdapter()
			.run(
				"INSERT INTO accounts (id, name, provider, created_at) VALUES ('acct-usage', 'Usage fixture', ?, 1)",
				[providerName],
			);
		const account = makeAccount(providerName);
		const processed = await provider.processResponse(upstream, account);
		const collectorCopy = processed.clone();

		collector.handleStart(startMessage(providerName, processed));
		await collector.handleEnd({
			type: "end",
			requestId: "r1",
			success: true,
			responseBody: Buffer.from(await collectorCopy.arrayBuffer()).toString(
				"base64",
			),
		});
		await collector.drain();

		// Every async call the response processor makes on the provider is
		// awaited below, so a usage write it queues is in the writer before the
		// final flush. Waiting on those calls, not on time, keeps the order fixed.
		const providerCalls: Promise<unknown>[] = [];
		const observedProvider = new Proxy(provider, {
			get(target, property, receiver) {
				const value = Reflect.get(target, property, receiver);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					const result = value.apply(target, args);
					if (result instanceof Promise) providerCalls.push(result);
					return result;
				};
			},
		});
		updateAccountMetadata(
			account,
			processed,
			{
				provider: observedProvider,
				dbOps: db,
				asyncWriter: writer,
				config: { getCodexFiveHourWindowEnabled: () => false },
			} as unknown as ProxyContext,
			"r1",
		);
		await Promise.allSettled(providerCalls);
		await writer.dispose();

		const row = await db
			.getAdapter()
			.get<UsageRow>(`SELECT ${USAGE_COLUMNS} FROM requests WHERE id = 'r1'`);
		expect(row).not.toBeNull();
		return row as UsageRow;
	} finally {
		collector.dispose();
		await writer.dispose();
		await db.close();
	}
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json", ...headers },
	});
}

const OPENAI_COMPLETION = {
	id: "chatcmpl-usage",
	object: "chat.completion",
	created: 1,
	model: "chat",
	choices: [
		{
			index: 0,
			message: { role: "assistant", content: "hi" },
			finish_reason: "stop",
		},
	],
	usage: { prompt_tokens: 1200, completion_tokens: 129, total_tokens: 1329 },
};

it("keeps an OpenAI-format reply's token counts after every writer has run", async () => {
	const row = await storeThroughEveryWriter(
		"openai-compatible",
		new OpenAICompatibleProvider(),
		jsonResponse(OPENAI_COMPLETION),
	);

	expect(row.model).toBe("chat");
	expect(row.input_tokens).toBe(1200);
	expect(row.output_tokens).toBe(129);
	expect(row.total_tokens).toBe(1329);
});

it("keeps an Anthropic reply's usage and its billed cost after every writer has run", async () => {
	const row = await storeThroughEveryWriter(
		"anthropic",
		new AnthropicProvider(),
		jsonResponse(
			{
				id: "msg_usage",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-5",
				content: [{ type: "text", text: "hi" }],
				stop_reason: "end_turn",
				usage: {
					input_tokens: 1000,
					cache_read_input_tokens: 200,
					cache_creation_input_tokens: 10,
					output_tokens: 50,
				},
			},
			{ "anthropic-billing-cost": "0.0025" },
		),
	);

	expect(row.model).toBe("claude-sonnet-5");
	expect(row.input_tokens).toBe(1000);
	expect(row.cache_read_input_tokens).toBe(200);
	expect(row.cache_creation_input_tokens).toBe(10);
	expect(row.output_tokens).toBe(50);
	expect(row.total_tokens).toBe(1260);
	// The cost Anthropic billed wins over the catalogue estimate (0 here).
	expect(row.cost_usd).toBe(0.0025);
});

it("stores a converted OpenAI-format reply's usage through the real client-forwarding path", async () => {
	const db = openDb();
	let complete!: (summary: RequestResponse) => void;
	const summarized = new Promise<RequestResponse>((resolve) => {
		complete = resolve;
	});
	const collector = new UsageCollector(
		db,
		new AsyncDbWriter(),
		() => false,
		complete,
	);
	const spy = spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue(
		collector,
	);
	const reportCandidateFailure = mock(() => {});
	const reportCandidateSuccess = mock(() => {});
	try {
		const adapter = db.getAdapter();
		await adapter.run(
			"INSERT INTO accounts (id, name, provider, created_at) VALUES ('acct-usage', 'Usage fixture', 'openai-compatible', 1)",
		);
		const account = makeAccount("openai-compatible");
		const processed = await new OpenAICompatibleProvider().processResponse(
			jsonResponse(OPENAI_COMPLETION),
			account,
		);
		const clientResponse = await forwardToClient(
			{
				requestId: "r1",
				method: "POST",
				path: "/v1/messages",
				account,
				attemptedModel: "chat",
				requestHeaders: new Headers(),
				requestBody: null,
				response: processed,
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			{
				strategy: { reportCandidateFailure, reportCandidateSuccess },
				dbOps: db,
				runtime: { port: 8080, tlsEnabled: false },
				config: { getStorePayloads: () => false },
				provider: {
					name: "openai-compatible",
					isStreamingResponse: () => false,
				},
				refreshInFlight: new Map(),
				asyncWriter: {},
			} as unknown as ProxyContext,
		);
		const delivered = JSON.parse(await clientResponse.text()) as {
			usage?: { input_tokens?: number; output_tokens?: number };
		};
		expect(delivered.usage).toEqual({
			input_tokens: 1200,
			output_tokens: 129,
		});
		await summarized;
		await collector.drain();

		const row = await adapter.get<UsageRow>(
			`SELECT ${USAGE_COLUMNS} FROM requests WHERE id = 'r1'`,
		);
		expect(row?.model).toBe("chat");
		expect(row?.input_tokens).toBe(1200);
		expect(row?.output_tokens).toBe(129);
		expect(row?.total_tokens).toBe(1329);
	} finally {
		spy.mockRestore();
		collector.dispose();
		await collector.drain();
		await db.close();
	}
});
