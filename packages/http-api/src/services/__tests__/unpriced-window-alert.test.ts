/**
 * The unpriced_window model_routing_drift alert (#774): a usage window that
 * closes with tokens for a first-party model the catalogue prices but the
 * list-price table could not price. The pure classifier and builder are
 * tested directly; the service test runs against the bundled catalogue
 * (CF_PRICING_OFFLINE) so it never reaches models.dev.
 */
import { Database } from "bun:sqlite";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { EventEmitter } from "node:events";
import type { Config } from "@better-ccflare/config";
import {
	LIST_PRICE_ERAS,
	resetNanoGPTPricingCacheForTest,
	VALUE_PRICING_VERSION,
} from "@better-ccflare/core";
import type { UsageWindow } from "@better-ccflare/database";
import { BunSqlAdapter, ensureSchema } from "@better-ccflare/database";
import {
	AlertService,
	buildDiscordAlertContent,
	buildUnpricedWindowAlert,
	findUnpricedWindowModels,
} from "../alerts";

const DAY_MS = 24 * 60 * 60 * 1000;
const OPUS = "claude-opus-5-5";
/** Well-formed first-party id with no era and no catalogue entry. */
const UNRELEASED = "claude-opus-99";
const OPUS_FIRST_ERA_MS = Math.min(
	...(LIST_PRICE_ERAS[OPUS] ?? []).map((era) => era.sinceMs),
);

function entry(
	tokens: number,
	valueUsd: number | null,
): Record<string, number | null> {
	return {
		requestCount: 1,
		inputTokens: tokens,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		outputTokens: 0,
		valueUsd,
	};
}

function closedWindow(overrides: Partial<UsageWindow> = {}): UsageWindow {
	const startedAt = overrides.startedAt ?? OPUS_FIRST_ERA_MS + 30 * DAY_MS;
	const resetsAt = startedAt + 7 * DAY_MS;
	return {
		id: "closed-window",
		accountId: "acct-1",
		windowKey: "seven_day",
		startedAt,
		resetsAt,
		closedAt: resetsAt,
		grantType: "natural",
		peakUtilization: 100,
		first100At: null,
		valueUsd: 1,
		inputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		outputTokens: 0,
		requestCount: 1,
		modelBreakdown: null,
		unpricedTokens: 0,
		projectionVersion: VALUE_PRICING_VERSION,
		...overrides,
	};
}

describe("findUnpricedWindowModels", () => {
	it("names a first-party model with no list-price era", () => {
		const window = closedWindow({
			modelBreakdown: { [UNRELEASED]: entry(1_000, null) },
		});
		expect(findUnpricedWindowModels(window)).toEqual([
			{ model: UNRELEASED, tokens: 1_000, reason: "no_era" },
		]);
	});

	it("names a window that started before the model's first era", () => {
		const window = closedWindow({
			startedAt: OPUS_FIRST_ERA_MS - 10 * DAY_MS,
			modelBreakdown: { [OPUS]: entry(2_000, null) },
		});
		expect(findUnpricedWindowModels(window)).toEqual([
			{
				model: OPUS,
				tokens: 2_000,
				reason: "before_first_era",
				firstEraSinceMs: OPUS_FIRST_ERA_MS,
			},
		]);
	});

	it("names an era that could not price the window's token mix", () => {
		const window = closedWindow({
			modelBreakdown: { [OPUS]: entry(3_000, null) },
		});
		expect(findUnpricedWindowModels(window)).toEqual([
			{ model: OPUS, tokens: 3_000, reason: "unpriceable" },
		]);
	});

	it("ignores priced entries, empty entries, and ids outside the first-party catalogue sections", () => {
		const window = closedWindow({
			modelBreakdown: {
				"": entry(500, null),
				"claude-bccf-route-codex-pool-astra": entry(9_000, null),
				"claude-bccf-quality-auto": entry(9_000, null),
				"gpt-reserve": entry(9_000, null),
				[OPUS]: entry(4_000, 1.5),
				[UNRELEASED]: entry(0, null),
				"claude-opus-98": "not an entry",
			},
		});
		expect(findUnpricedWindowModels(window)).toEqual([]);
		expect(findUnpricedWindowModels(closedWindow())).toEqual([]);
	});

	it("counts every token kind and lists the largest first", () => {
		const window = closedWindow({
			modelBreakdown: {
				"claude-opus-97": entry(10, null),
				[UNRELEASED]: {
					requestCount: 2,
					inputTokens: 10,
					cacheReadInputTokens: 20,
					cacheCreationInputTokens: 30,
					outputTokens: 40,
					valueUsd: null,
				},
			},
		});
		expect(
			findUnpricedWindowModels(window).map((m) => [m.model, m.tokens]),
		).toEqual([
			[UNRELEASED, 100],
			["claude-opus-97", 10],
		]);
	});
});

describe("buildUnpricedWindowAlert", () => {
	it("builds a warning keyed by model and projection version", () => {
		const window = closedWindow({
			startedAt: OPUS_FIRST_ERA_MS - 10 * DAY_MS,
			modelBreakdown: { [OPUS]: entry(2_000, null) },
		});
		const [unpriced] = findUnpricedWindowModels(window);
		const alert = buildUnpricedWindowAlert(
			window,
			"Primary account",
			unpriced,
			123,
		);
		expect(alert).toMatchObject({
			id: `model_routing_drift:unpriced_window:${OPUS.length}:${OPUS}:${VALUE_PRICING_VERSION.length}:${VALUE_PRICING_VERSION}`,
			timestamp: 123,
			type: "model_routing_drift",
			severity: "warning",
			classification: { reason: "unpriced_window" },
			account: "Primary account",
			model: OPUS,
		});
		expect(alert.message).toContain("Primary account's seven_day usage window");
		expect(alert.message).toContain("2,000 claude-opus-5-5 tokens");
		expect(alert.message).toContain(
			`first list-price era starts ${new Date(OPUS_FIRST_ERA_MS).toISOString().slice(0, 10)}`,
		);
		expect(buildDiscordAlertContent(alert)).toContain(
			"A closed usage window has tokens the list-price table could not price.",
		);
	});

	it("falls back to the current pricing version for a window without one", () => {
		const window = closedWindow({
			projectionVersion: null,
			modelBreakdown: { [UNRELEASED]: entry(1, null) },
		});
		const [unpriced] = findUnpricedWindowModels(window);
		const alert = buildUnpricedWindowAlert(window, "acct-1", unpriced, 1);
		expect(alert.id).toEndWith(
			`:${VALUE_PRICING_VERSION.length}:${VALUE_PRICING_VERSION}`,
		);
		expect(alert.message).toContain("LIST_PRICE_ERAS has no era");
	});
});

function makeConfig(): Config {
	return Object.assign(new EventEmitter(), {
		getAlertDailySpendUsd: () => 0,
		getAlertTokensPerHour: () => 0,
		getAlertRequestTokens: () => 0,
		getAlertUsageWindowThresholdPercent: () => 90,
		getAlertAnomalyEnabled: () => false,
		getAlertAnomalyIntervalMinutes: () => 15,
		getAlertAnomalyBaselineWindowMinutes: () => 60,
		getAlertAnomalyLoopMinRequests: () => 25,
		getAlertCooldownMinutes: () => 60,
		getAlertWebhookUrl: () => "",
		get: (_key: string, defaultValue?: string | number | boolean) =>
			defaultValue,
		set: () => {},
	}) as unknown as Config;
}

describe("AlertService.evaluateClosedWindowPricing", () => {
	let previousOffline: string | undefined;
	let previousFetch: typeof fetch;
	let sqlite: Database;
	let service: AlertService;

	// The bundled catalogue answers: CF_PRICING_OFFLINE skips models.dev, and
	// the rejecting fetch keeps the NanoGPT merge (which ignores that flag)
	// off the network too.
	beforeAll(() => {
		previousOffline = process.env.CF_PRICING_OFFLINE;
		process.env.CF_PRICING_OFFLINE = "1";
		resetNanoGPTPricingCacheForTest();
		previousFetch = globalThis.fetch;
		globalThis.fetch = (() =>
			Promise.reject(new Error("offline test"))) as unknown as typeof fetch;
	});

	afterAll(() => {
		globalThis.fetch = previousFetch;
		resetNanoGPTPricingCacheForTest();
		if (previousOffline === undefined) delete process.env.CF_PRICING_OFFLINE;
		else process.env.CF_PRICING_OFFLINE = previousOffline;
	});

	beforeEach(() => {
		sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
	});

	afterEach(() => {
		sqlite.close();
	});

	const earlyWindow = (overrides: Partial<UsageWindow> = {}) =>
		closedWindow({
			startedAt: OPUS_FIRST_ERA_MS - 10 * DAY_MS,
			modelBreakdown: {
				[OPUS]: entry(2_000, null),
				[UNRELEASED]: entry(5_000, null),
			},
			...overrides,
		});

	it("alerts for a model the catalogue prices and skips one it does not", async () => {
		await service.evaluateClosedWindowPricing(earlyWindow(), "Primary account");

		const alerts = await service.listAlerts();
		expect(alerts.map((alert) => alert.model)).toEqual([OPUS]);
		expect(alerts[0]?.account).toBe("Primary account");
	});

	it("alerts once per model and pricing version across windows and accounts", async () => {
		await service.evaluateClosedWindowPricing(earlyWindow(), "Primary account");
		await service.evaluateClosedWindowPricing(
			earlyWindow({ id: "other-window", accountId: "acct-2" }),
			"Secondary account",
		);
		expect(await service.listAlerts()).toHaveLength(1);

		await service.evaluateClosedWindowPricing(
			earlyWindow({ id: "next-version", projectionVersion: "next" }),
			"Primary account",
		);
		expect(await service.listAlerts()).toHaveLength(2);
	});

	it("does nothing for a fully priced window", async () => {
		await service.evaluateClosedWindowPricing(
			closedWindow({ modelBreakdown: { [OPUS]: entry(2_000, 3) } }),
			"Primary account",
		);
		expect(await service.listAlerts()).toHaveLength(0);
	});
});
