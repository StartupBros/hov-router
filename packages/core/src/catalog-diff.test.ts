import { afterEach, describe, expect, it } from "bun:test";
import {
	autoLineNameForModel,
	CATALOG_NEW_MODEL_MAX_AGE_DAYS,
	catalogSectionForModel,
	findCatalogNewModels,
	findEraRateMismatches,
} from "./catalog-diff";
import { CLAUDE_MODEL_IDS } from "./models";
import { type ApiResponse, getBundledPricingCatalog } from "./pricing";
import { LIST_PRICE_ERAS, LONG_CONTEXT_PROMPT_TOKENS } from "./value-pricing";

const NOW = Date.parse("2026-11-10T03:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function catalog(
	sections: Record<string, Record<string, Record<string, unknown>>>,
): ApiResponse {
	const out: ApiResponse = {};
	for (const [section, models] of Object.entries(sections)) {
		out[section] = {
			models: Object.fromEntries(
				Object.entries(models).map(([id, def]) => [
					id,
					{ id, name: id, ...def },
				]),
			),
		};
	}
	return out as ApiResponse;
}

const COST = { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 };

describe("catalogSectionForModel", () => {
	it("maps first-party Claude and GPT ids to the section that prices them", () => {
		expect(catalogSectionForModel("claude-opus-6")).toBe("anthropic");
		expect(catalogSectionForModel("claude-haiku-4-5-20251001")).toBe(
			"anthropic",
		);
		expect(catalogSectionForModel("gpt-6.1-terra")).toBe("openai");
		expect(catalogSectionForModel("gpt-5.5")).toBe("openai");
	});

	it("rejects reseller paths, old naming, aliases and oversize ids", () => {
		expect(catalogSectionForModel("anthropic/claude-opus-6")).toBeNull();
		expect(catalogSectionForModel("claude-3-5-sonnet-20241022")).toBeNull();
		expect(catalogSectionForModel("claude-opus")).toBeNull();
		expect(catalogSectionForModel("gpt-image-2")).toBeNull();
		expect(
			catalogSectionForModel(`claude-opus-6-${"9".repeat(64)}`),
		).toBeNull();
	});
});

describe("autoLineNameForModel", () => {
	it("names claude-<family> and gpt-<variant> lines", () => {
		expect(autoLineNameForModel("claude-fable-5-2")).toBe("claude-fable");
		expect(autoLineNameForModel("gpt-6.1-sol")).toBe("gpt-sol");
		expect(autoLineNameForModel("gpt-6-astra")).toBe("gpt-astra");
	});

	it("has no line for an unsuffixed GPT id", () => {
		expect(autoLineNameForModel("gpt-5.5")).toBeNull();
	});
});

describe("findCatalogNewModels", () => {
	const recent = isoDay(NOW - 3 * DAY);

	it("flags a fresh unregistered Claude model as missing from the registry and the era table", () => {
		const gaps = findCatalogNewModels(
			catalog({
				anthropic: { "claude-opus-6": { release_date: recent, cost: COST } },
			}),
			{ nowMs: NOW },
		);
		expect(gaps.map((g) => [g.modelId, g.gap])).toEqual([
			["claude-opus-6", "era"],
			["claude-opus-6", "registry"],
		]);
		expect(gaps[0]).toMatchObject({
			section: "anthropic",
			releaseDate: recent,
		});
	});

	it("flags a registered model outside its approved Auto line", () => {
		const gaps = findCatalogNewModels(
			catalog({
				anthropic: {
					[CLAUDE_MODEL_IDS.FABLE_5_2]: { release_date: recent, cost: COST },
				},
			}),
			{
				nowMs: NOW,
				autoLines: { "claude-fable": [CLAUDE_MODEL_IDS.FABLE_5_1] },
			},
		);
		expect(gaps).toEqual([
			{
				modelId: CLAUDE_MODEL_IDS.FABLE_5_2,
				section: "anthropic",
				releaseDate: recent,
				gap: "auto_line",
				autoLine: "claude-fable",
				autoLineModels: [CLAUDE_MODEL_IDS.FABLE_5_1],
			},
		]);
	});

	it("is silent for a model that is registered, priced and in its line", () => {
		const gaps = findCatalogNewModels(
			catalog({
				anthropic: {
					[CLAUDE_MODEL_IDS.FABLE_5_1]: { release_date: recent, cost: COST },
				},
			}),
			{
				nowMs: NOW,
				autoLines: { "claude-fable": [CLAUDE_MODEL_IDS.FABLE_5_1] },
			},
		);
		expect(gaps).toEqual([]);
	});

	it("flags only the missing era for a fresh GPT model with no Auto line", () => {
		const gaps = findCatalogNewModels(
			catalog({
				openai: { "gpt-6.1-terra": { release_date: recent, cost: COST } },
			}),
			{ nowMs: NOW, autoLines: { "gpt-sol": ["gpt-6.1-sol"] } },
		);
		expect(gaps.map((g) => [g.modelId, g.gap])).toEqual([
			["gpt-6.1-terra", "era"],
		]);
	});

	it("flags a fresh GPT model outside an existing Auto line", () => {
		const gaps = findCatalogNewModels(
			catalog({ openai: { "gpt-7-sol": { release_date: recent } } }),
			{ nowMs: NOW, autoLines: { "gpt-sol": ["gpt-6.1-sol"] } },
		);
		expect(gaps.map((g) => g.gap)).toEqual(["auto_line", "era"]);
	});

	it("ignores models released before the window, or with no exact release day", () => {
		const old = isoDay(NOW - (CATALOG_NEW_MODEL_MAX_AGE_DAYS + 1) * DAY);
		const gaps = findCatalogNewModels(
			catalog({
				anthropic: {
					"claude-opus-6": { release_date: old },
					"claude-sonnet-6": { release_date: "2026-11" },
					"claude-haiku-6": {},
				},
			}),
			{ nowMs: NOW },
		);
		expect(gaps).toEqual([]);
	});

	it("reads only the first-party sections and text-output models", () => {
		const gaps = findCatalogNewModels(
			catalog({
				openrouter: { "claude-opus-6": { release_date: recent } },
				anthropic: {
					"claude-3-7-sonnet-20270101": { release_date: recent },
				},
				openai: {
					"gpt-7-image": {
						release_date: recent,
						modalities: { input: ["text"], output: ["image"] },
					},
				},
			}),
			{ nowMs: NOW },
		);
		expect(gaps).toEqual([]);
	});

	it("uses the entry's own id over its map key", () => {
		const data: ApiResponse = {
			anthropic: {
				models: {
					alias: { id: "claude-opus-6", name: "x", release_date: recent },
				},
			},
		};
		expect(
			findCatalogNewModels(data, { nowMs: NOW }).map((g) => g.modelId),
		).toEqual(["claude-opus-6", "claude-opus-6"]);
	});
});

describe("findEraRateMismatches", () => {
	const SYNTHETIC = "claude-zeta-9";
	afterEach(() => {
		delete LIST_PRICE_ERAS[SYNTHETIC];
	});

	it("finds no mismatch between the bundled table and the era table", () => {
		// The bundled anthropic section is this build's own price sheet; an era
		// that disagrees with it is a typo in one of the two.
		expect(findEraRateMismatches(getBundledPricingCatalog(), NOW)).toEqual([]);
	});

	it("reports each base rate that differs from the first-party section", () => {
		LIST_PRICE_ERAS[SYNTHETIC] = [
			{
				sinceMs: Date.parse("2026-06-01T00:00:00Z"),
				inputPerM: 2,
				cacheReadPerM: 0.2,
				cacheCreationPerM: 2.5,
				outputPerM: 10,
			},
		];
		const mismatches = findEraRateMismatches(
			catalog({
				anthropic: {
					[SYNTHETIC]: {
						cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 3 },
					},
				},
				openrouter: { [SYNTHETIC]: { cost: { input: 99, output: 99 } } },
			}),
			NOW,
		);
		expect(mismatches).toEqual([
			{
				modelId: SYNTHETIC,
				section: "anthropic",
				eraSinceMs: Date.parse("2026-06-01T00:00:00Z"),
				fields: [
					{ field: "cache_read", catalogValue: 0.1, eraValue: 0.2 },
					{ field: "cache_write", catalogValue: 3, eraValue: 2.5 },
				],
			},
		]);
	});

	it("skips fields the era or the catalogue does not state", () => {
		LIST_PRICE_ERAS[SYNTHETIC] = [
			{
				sinceMs: Date.parse("2026-06-01T00:00:00Z"),
				inputPerM: 2,
				cacheReadPerM: 0.2,
				outputPerM: 10,
			},
		];
		expect(
			findEraRateMismatches(
				catalog({
					anthropic: {
						[SYNTHETIC]: { cost: { input: 2, output: 10, cache_write: 9 } },
					},
				}),
				NOW,
			),
		).toEqual([]);
	});

	it("is silent when the first-party section has no priced entry", () => {
		LIST_PRICE_ERAS[SYNTHETIC] = [
			{
				sinceMs: Date.parse("2026-06-01T00:00:00Z"),
				inputPerM: 2,
				cacheReadPerM: 0.2,
				outputPerM: 10,
			},
		];
		expect(
			findEraRateMismatches(catalog({ anthropic: { [SYNTHETIC]: {} } }), NOW),
		).toEqual([]);
		expect(findEraRateMismatches({}, NOW)).toEqual([]);
	});

	it("compares the era in effect at nowMs", () => {
		LIST_PRICE_ERAS[SYNTHETIC] = [
			{
				sinceMs: Date.parse("2026-06-01T00:00:00Z"),
				inputPerM: 2,
				cacheReadPerM: 0.2,
				outputPerM: 10,
			},
			{
				sinceMs: Date.parse("2026-11-01T00:00:00Z"),
				inputPerM: 3,
				cacheReadPerM: 0.3,
				outputPerM: 15,
			},
		];
		const data = catalog({
			anthropic: {
				[SYNTHETIC]: { cost: { input: 3, output: 15, cache_read: 0.3 } },
			},
		});
		expect(findEraRateMismatches(data, NOW)).toEqual([]);
		expect(
			findEraRateMismatches(
				data,
				Date.parse("2026-10-01T00:00:00Z"),
			)[0]?.fields.map((f) => f.field),
		).toEqual(["input", "output", "cache_read"]);
	});

	it("checks the long-context tier only when the era prices one", () => {
		LIST_PRICE_ERAS[SYNTHETIC] = [
			{
				sinceMs: Date.parse("2026-06-01T00:00:00Z"),
				inputPerM: 1,
				cacheReadPerM: 0.1,
				outputPerM: 5,
				longContext: {
					inputPerM: 2,
					cacheReadPerM: 0.2,
					cacheCreationPerM: 2.5,
					outputPerM: 10,
				},
			},
		];
		const withTier = (size: number, input: number) =>
			catalog({
				anthropic: {
					[SYNTHETIC]: {
						cost: {
							input: 1,
							output: 5,
							cache_read: 0.1,
							tiers: [
								{
									input,
									output: 10,
									cache_read: 0.2,
									cache_write: 2.5,
									tier: { type: "context", size },
								},
							],
						},
					},
				},
			});
		expect(
			findEraRateMismatches(withTier(LONG_CONTEXT_PROMPT_TOKENS, 2), NOW),
		).toEqual([]);
		expect(
			findEraRateMismatches(withTier(LONG_CONTEXT_PROMPT_TOKENS, 4), NOW)[0]
				?.fields,
		).toEqual([{ field: "long_context_input", catalogValue: 4, eraValue: 2 }]);
		expect(findEraRateMismatches(withTier(200_000, 2), NOW)[0]?.fields).toEqual(
			[
				{
					field: "long_context_threshold",
					catalogValue: 200_000,
					eraValue: LONG_CONTEXT_PROMPT_TOKENS,
				},
			],
		);
	});

	it("ignores a catalogue tier when the era has no long-context rates", () => {
		LIST_PRICE_ERAS[SYNTHETIC] = [
			{
				sinceMs: Date.parse("2026-06-01T00:00:00Z"),
				inputPerM: 1,
				cacheReadPerM: 0.1,
				outputPerM: 5,
			},
		];
		expect(
			findEraRateMismatches(
				catalog({
					anthropic: {
						[SYNTHETIC]: {
							cost: {
								input: 1,
								output: 5,
								cache_read: 0.1,
								tiers: [
									{
										input: 2,
										output: 10,
										tier: { type: "context", size: 272_000 },
									},
								],
							},
						},
					},
				}),
				NOW,
			),
		).toEqual([]);
	});
});
