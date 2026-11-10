/**
 * Catalogue-derived model_routing_drift alerts (#774): a models.dev load is
 * diffed against the shipped tables, so a new model or a disagreeing
 * list-price era is reported when the catalogue learns of it, not when
 * unpriced usage is noticed weeks later.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@better-ccflare/config";
import {
	CLAUDE_MODEL_IDS,
	LIST_PRICE_ERAS,
	type PricingCatalog,
	resetNanoGPTPricingCacheForTest,
	VALUE_PRICING_VERSION,
	warmPricingCatalog,
} from "@better-ccflare/core";
import { BunSqlAdapter, ensureSchema } from "@better-ccflare/database";
import type { AlertEvent } from "@better-ccflare/types";
import {
	AlertService,
	buildDiscordAlertContent,
	buildPricingCatalogAlerts,
} from "../alerts";

const NOW = Date.parse("2026-11-10T03:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const RECENT = new Date(NOW - 2 * DAY).toISOString().slice(0, 10);
const DISK_CACHE_PATH = join(tmpdir(), "better-ccflare", "models.dev.json");

function makeConfig(): Config {
	const store = new Map<string, string | number | boolean>();
	return Object.assign(new EventEmitter(), {
		getAlertDailySpendUsd: () => 0,
		getAlertTokensPerHour: () => 0,
		getAlertRequestTokens: () => 0,
		getAlertUsageWindowThresholdPercent: () => 0,
		getAlertAnomalyEnabled: () => false,
		getAlertAnomalyIntervalMinutes: () => 15,
		getAlertAnomalyBaselineWindowMinutes: () => 1440,
		getAlertAnomalyLoopMinRequests: () => 10,
		getAlertCooldownMinutes: () => 60,
		getAlertWebhookUrl: () => "",
		get: (key: string, defaultValue?: string | number | boolean) => {
			if (store.has(key)) return store.get(key);
			if (defaultValue !== undefined) {
				store.set(key, defaultValue);
				return defaultValue;
			}
			return undefined;
		},
		set: (key: string, value: string | number | boolean) => {
			store.set(key, value);
		},
	}) as unknown as Config;
}

const catalogWith = (
	sections: Record<string, Record<string, Record<string, unknown>>>,
): PricingCatalog =>
	Object.fromEntries(
		Object.entries(sections).map(([section, models]) => [
			section,
			{
				models: Object.fromEntries(
					Object.entries(models).map(([id, def]) => [
						id,
						{ id, name: id, ...def },
					]),
				),
			},
		]),
	) as PricingCatalog;

const NEW_MODELS = catalogWith({
	anthropic: {
		"claude-opus-6": {
			release_date: RECENT,
			cost: { input: 5, output: 25, cache_read: 0.25, cache_write: 6.25 },
		},
		[CLAUDE_MODEL_IDS.FABLE_5_2]: {
			release_date: RECENT,
			cost: { input: 8, output: 40, cache_read: 0.2, cache_write: 10 },
		},
	},
});

const AUTO_LINES = { "claude-fable": [CLAUDE_MODEL_IDS.FABLE_5_1] };

describe("buildPricingCatalogAlerts", () => {
	const SYNTHETIC = "claude-zeta-9";
	afterEach(() => {
		delete LIST_PRICE_ERAS[SYNTHETIC];
	});

	it("raises one alert per catalogue gap with a content-addressed id", () => {
		const alerts = buildPricingCatalogAlerts(NEW_MODELS, NOW, AUTO_LINES);
		expect(alerts.map((a) => [a.id, a.severity])).toEqual([
			[
				`model_routing_drift:catalog_new_model:${CLAUDE_MODEL_IDS.FABLE_5_2.length}:${CLAUDE_MODEL_IDS.FABLE_5_2}:auto_line`,
				"info",
			],
			["model_routing_drift:catalog_new_model:13:claude-opus-6:era", "warning"],
			[
				"model_routing_drift:catalog_new_model:13:claude-opus-6:registry",
				"warning",
			],
		]);
		for (const alert of alerts) {
			expect(alert.type).toBe("model_routing_drift");
			expect(alert.classification).toEqual({ reason: "catalog_new_model" });
			expect(alert.timestamp).toBe(NOW);
			expect(alert.account).toBeNull();
		}
		const [autoLine, era, registry] = alerts as [
			AlertEvent,
			AlertEvent,
			AlertEvent,
		];
		expect(autoLine.model).toBe(CLAUDE_MODEL_IDS.FABLE_5_2);
		expect(autoLine.message).toContain("claude-fable");
		expect(autoLine.message).toContain(CLAUDE_MODEL_IDS.FABLE_5_1);
		expect(era.message).toContain("$5 input");
		expect(era.message).toContain("LIST_PRICE_ERAS");
		expect(registry.message).toContain("CLAUDE_MODEL_IDS");
		expect(registry.message).toContain(RECENT);
	});

	it("raises an era-rate mismatch keyed by pricing version and catalogue rates", () => {
		LIST_PRICE_ERAS[SYNTHETIC] = [
			{
				sinceMs: Date.parse("2026-06-01T00:00:00Z"),
				inputPerM: 2,
				cacheReadPerM: 0.2,
				cacheCreationPerM: 2.5,
				outputPerM: 10,
			},
		];
		const catalog = catalogWith({
			anthropic: {
				[SYNTHETIC]: {
					cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
				},
			},
		});
		const alerts = buildPricingCatalogAlerts(catalog, NOW, {});
		expect(alerts).toHaveLength(1);
		const [alert] = alerts as [AlertEvent];
		const fingerprint = "cache_read=0.1";
		expect(alert.id).toBe(
			`model_routing_drift:era_rate_mismatch:13:${SYNTHETIC}:${VALUE_PRICING_VERSION.length}:${VALUE_PRICING_VERSION}:${fingerprint.length}:${fingerprint}`,
		);
		expect(alert.severity).toBe("warning");
		expect(alert.classification).toEqual({ reason: "era_rate_mismatch" });
		expect(alert.message).toContain("cache read");
		expect(alert.message).toContain("$0.2");
		expect(alert.message).toContain("$0.1");
	});

	it("is silent for a catalogue that matches the shipped tables", () => {
		expect(
			buildPricingCatalogAlerts(
				catalogWith({
					anthropic: {
						[CLAUDE_MODEL_IDS.FABLE_5_1]: { release_date: RECENT },
					},
				}),
				NOW,
				AUTO_LINES,
			),
		).toEqual([]);
	});
});

describe("catalogue alert Discord wording", () => {
	it("names each catalogue gap and the rate mismatch in its own terms", () => {
		const [autoLine, era, registry] = buildPricingCatalogAlerts(
			NEW_MODELS,
			NOW,
			AUTO_LINES,
		) as [AlertEvent, AlertEvent, AlertEvent];
		expect(buildDiscordAlertContent(registry)).toContain(
			"A newly released model is missing from the bundled catalog.",
		);
		expect(buildDiscordAlertContent(era)).toContain(
			"A newly released model has no list-price era.",
		);
		expect(buildDiscordAlertContent(autoLine)).toContain(
			"A newly released model is outside its approved Auto line.",
		);

		// Legacy rows carry no classification; the id still names the reason.
		const { classification: _drop, ...legacy } = era;
		expect(buildDiscordAlertContent(legacy)).toContain(
			"A newly released model has no list-price era.",
		);

		const mismatch: AlertEvent = {
			...era,
			id: "model_routing_drift:era_rate_mismatch:13:claude-zeta-9:12:2026-11-10.1:14:cache_read=0.1",
			classification: { reason: "era_rate_mismatch" },
		};
		expect(buildDiscordAlertContent(mismatch)).toContain(
			"A list-price era disagrees with the models.dev catalog.",
		);
	});
});

describe("AlertService pricing catalogue watch", () => {
	let sqlite: Database;
	let service: AlertService;
	let originalFetch: typeof global.fetch;

	const serveCatalogue = (catalogue: unknown) => {
		global.fetch = vi.fn((input: string | URL | Request) =>
			Promise.resolve({
				ok: true,
				json: async () =>
					String(input) === "https://models.dev/api.json"
						? catalogue
						: { object: "list", data: [] },
			} as Response),
		) as unknown as typeof global.fetch;
	};

	beforeEach(async () => {
		originalFetch = global.fetch;
		resetNanoGPTPricingCacheForTest();
		await rm(DISK_CACHE_PATH, { force: true });
		sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
	});

	afterEach(async () => {
		await service.stop();
		global.fetch = originalFetch;
		resetNanoGPTPricingCacheForTest();
		await rm(DISK_CACHE_PATH, { force: true });
		sqlite.close();
	});

	const freshOpus = {
		anthropic: {
			models: {
				"claude-opus-6": {
					id: "claude-opus-6",
					name: "Claude Opus 6",
					release_date: new Date(Date.now() - DAY).toISOString().slice(0, 10),
					cost: { input: 5, output: 25, cache_read: 0.25 },
				},
			},
		},
	};

	it("evaluates the catalogue on its first load and reports each gap once", async () => {
		serveCatalogue(freshOpus);
		service.watchPricingCatalog();
		await service.pricingCatalogSettled();
		const ids = (await service.listAlerts()).map((a) => a.id).sort();
		// The real Auto lines include claude-opus, which does not list it yet.
		expect(ids).toEqual([
			"model_routing_drift:catalog_new_model:13:claude-opus-6:auto_line",
			"model_routing_drift:catalog_new_model:13:claude-opus-6:era",
			"model_routing_drift:catalog_new_model:13:claude-opus-6:registry",
		]);

		// The next refresh restates those gaps, which add no rows, and lists one
		// more model, whose gaps do: the watch evaluates every load.
		serveCatalogue({
			anthropic: {
				models: {
					...freshOpus.anthropic.models,
					"claude-sonnet-6": {
						...freshOpus.anthropic.models["claude-opus-6"],
						id: "claude-sonnet-6",
						name: "Claude Sonnet 6",
					},
				},
			},
		});
		resetNanoGPTPricingCacheForTest();
		await warmPricingCatalog();
		await service.pricingCatalogSettled();
		expect((await service.listAlerts()).map((a) => a.id).sort()).toEqual([
			...ids,
			"model_routing_drift:catalog_new_model:15:claude-sonnet-6:auto_line",
			"model_routing_drift:catalog_new_model:15:claude-sonnet-6:era",
			"model_routing_drift:catalog_new_model:15:claude-sonnet-6:registry",
		]);
	});

	it("evaluates a catalogue that loaded before the watch started", async () => {
		serveCatalogue(freshOpus);
		await warmPricingCatalog();
		service.watchPricingCatalog();
		await service.pricingCatalogSettled();
		expect(await service.listAlerts()).toHaveLength(3);
	});

	it("ignores the bundled fallback, which only restates this build", async () => {
		global.fetch = vi.fn(() =>
			Promise.reject(new Error("offline")),
		) as unknown as typeof global.fetch;
		service.watchPricingCatalog();
		await warmPricingCatalog();
		await service.pricingCatalogSettled();
		expect(await service.listAlerts()).toEqual([]);
	});

	it("stops evaluating after stop()", async () => {
		serveCatalogue({});
		service.watchPricingCatalog();
		await service.pricingCatalogSettled();
		await service.stop();
		serveCatalogue(freshOpus);
		resetNanoGPTPricingCacheForTest();
		await warmPricingCatalog();
		await service.pricingCatalogSettled();
		expect(await service.listAlerts()).toEqual([]);
	});
});
