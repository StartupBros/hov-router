/**
 * Compares a loaded models.dev catalogue with what this build ships, so a
 * model release or a price change is reported when the catalogue learns of
 * it rather than when someone notices unpriced usage weeks later (#774).
 *
 * Two checks, both pure:
 *
 * - `findCatalogNewModels`: a recently released first-party model (by the
 *   catalogue's own `release_date`) that is missing from CLAUDE_MODEL_IDS,
 *   from LIST_PRICE_ERAS, or from the approved Auto line its name belongs to.
 * - `findEraRateMismatches`: a list-price era whose rates disagree with the
 *   model's own first-party catalogue section.
 *
 * Only the first-party sections are read (`anthropic` for `claude-*`,
 * `openai` for `gpt-*`): resellers list the same ids at their own rates, and
 * the era table was verified against the first-party sections (see the note
 * at the top of LIST_PRICE_ERAS).
 */

import { CLAUDE_MODEL_IDS } from "./models";
import type { ApiResponse, ModelCost, ModelCostTier } from "./pricing";
import {
	LIST_PRICE_ERAS,
	LONG_CONTEXT_PROMPT_TOKENS,
	selectListPriceEra,
} from "./value-pricing";

export type CatalogSection = "anthropic" | "openai";

/** Matches `claude-<family>-<version...>`, the naming used since Claude 4. */
const CLAUDE_CATALOG_ID_RE = /^claude-([a-z]+)-\d[a-z0-9.-]*$/;
const GPT_CATALOG_ID_RE = /^gpt-\d[a-z0-9.-]*$/;
const MAX_CATALOG_ID_LENGTH = 64;

/** How far back a catalogue `release_date` still counts as a new release. */
export const CATALOG_NEW_MODEL_MAX_AGE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const RATE_TOLERANCE = 1e-9;

/** The catalogue section that publishes a first-party model's own rates. */
export function catalogSectionForModel(modelId: string): CatalogSection | null {
	if (modelId.length > MAX_CATALOG_ID_LENGTH) return null;
	if (CLAUDE_CATALOG_ID_RE.test(modelId)) return "anthropic";
	if (GPT_CATALOG_ID_RE.test(modelId)) return "openai";
	return null;
}

/**
 * The Auto line a model's name places it in (`claude-<family>` or
 * `gpt-<variant>`), whether or not that line exists. `null` for a GPT id with
 * no trailing variant word, such as `gpt-5.5`.
 */
export function autoLineNameForModel(modelId: string): string | null {
	const section = catalogSectionForModel(modelId);
	if (section === "anthropic") {
		const family = CLAUDE_CATALOG_ID_RE.exec(modelId)?.[1];
		return family ? `claude-${family}` : null;
	}
	if (section === "openai") {
		const variant = modelId.split("-").at(-1);
		return variant && /^[a-z]+$/.test(variant) ? `gpt-${variant}` : null;
	}
	return null;
}

/** Which shipped table is missing a newly released model. */
export type CatalogGapKind = "registry" | "era" | "auto_line";

export interface CatalogModelGap {
	modelId: string;
	section: CatalogSection;
	/** The catalogue's `release_date`, YYYY-MM-DD. */
	releaseDate: string;
	gap: CatalogGapKind;
	/** `auto_line` only: the line and the identities it supports today. */
	autoLine?: string;
	autoLineModels?: readonly string[];
}

export interface FindCatalogNewModelsOptions {
	nowMs: number;
	/** Defaults to CATALOG_NEW_MODEL_MAX_AGE_DAYS. */
	maxAgeDays?: number;
	/**
	 * Approved Auto lines and their supported identities, oldest to newest.
	 * A line absent from this map is not checked. Passed in because the
	 * identities live in @better-ccflare/providers, which core cannot import.
	 */
	autoLines?: Readonly<Record<string, readonly string[]>>;
}

function parseReleaseDay(value: unknown): number | null {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return null;
	}
	const ms = Date.parse(`${value}T00:00:00Z`);
	return Number.isFinite(ms) ? ms : null;
}

/**
 * Recently released first-party models that a shipped table does not know.
 * A model with no exact `release_date` is never reported: the date gate is
 * what keeps years of old catalogue ids from alerting on first run.
 * Sorted by model id, then gap.
 */
export function findCatalogNewModels(
	catalog: ApiResponse,
	options: FindCatalogNewModelsOptions,
): CatalogModelGap[] {
	const maxAgeMs =
		(options.maxAgeDays ?? CATALOG_NEW_MODEL_MAX_AGE_DAYS) * DAY_MS;
	const registered = new Set<string>(Object.values(CLAUDE_MODEL_IDS));
	const found = new Map<string, CatalogModelGap>();
	const add = (gap: CatalogModelGap) => {
		found.set(`${gap.modelId}\u0000${gap.gap}`, gap);
	};

	for (const section of ["anthropic", "openai"] as const) {
		const models = catalog?.[section]?.models;
		if (!models || typeof models !== "object") continue;
		for (const [key, def] of Object.entries(models)) {
			const modelId = typeof def?.id === "string" && def.id ? def.id : key;
			if (catalogSectionForModel(modelId) !== section) continue;
			const output = def?.modalities?.output;
			if (Array.isArray(output) && !output.includes("text")) continue;
			const releaseMs = parseReleaseDay(def?.release_date);
			if (releaseMs === null || options.nowMs - releaseMs > maxAgeMs) continue;
			const releaseDate = def.release_date as string;
			const base = { modelId, section, releaseDate };

			if (section === "anthropic" && !registered.has(modelId)) {
				add({ ...base, gap: "registry" });
			}
			if (!LIST_PRICE_ERAS[modelId]?.length) {
				add({ ...base, gap: "era" });
			}
			const line = autoLineNameForModel(modelId);
			const lineModels = line ? options.autoLines?.[line] : undefined;
			if (line && lineModels && !lineModels.includes(modelId)) {
				add({
					...base,
					gap: "auto_line",
					autoLine: line,
					autoLineModels: [...lineModels],
				});
			}
		}
	}

	return [...found.values()].sort(
		(a, b) => a.modelId.localeCompare(b.modelId) || a.gap.localeCompare(b.gap),
	);
}

export type EraRateField =
	| "input"
	| "output"
	| "cache_read"
	| "cache_write"
	| "long_context_input"
	| "long_context_output"
	| "long_context_cache_read"
	| "long_context_cache_write"
	/** The catalogue's smallest tier size, when no tier sits at the era's threshold. */
	| "long_context_threshold";

export interface EraRateFieldMismatch {
	field: EraRateField;
	/** Dollars per 1M tokens, or tokens for `long_context_threshold`. */
	catalogValue: number;
	eraValue: number;
}

export interface EraRateMismatch {
	modelId: string;
	section: CatalogSection;
	/** `sinceMs` of the era in effect at the evaluated instant. */
	eraSinceMs: number;
	fields: EraRateFieldMismatch[];
}

function isRate(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function sameRate(a: number, b: number): boolean {
	return (
		Math.abs(a - b) <= RATE_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b))
	);
}

/**
 * Eras whose rates disagree with the model's first-party catalogue entry at
 * `nowMs`. A field is compared only when both sides state it: a catalogue
 * without `cache_write`, or an era without `cacheCreationPerM`, is not a
 * mismatch. Long-context rates are compared only when the era has them, so
 * a catalogue tier the ledger does not model (OpenAI's 272k tier) stays
 * silent. Sorted by model id.
 */
export function findEraRateMismatches(
	catalog: ApiResponse,
	nowMs: number,
): EraRateMismatch[] {
	const mismatches: EraRateMismatch[] = [];
	for (const modelId of Object.keys(LIST_PRICE_ERAS).sort()) {
		const section = catalogSectionForModel(modelId);
		if (!section) continue;
		const cost: ModelCost | undefined =
			catalog?.[section]?.models?.[modelId]?.cost;
		if (!cost || typeof cost !== "object") continue;
		const era = selectListPriceEra(modelId, nowMs);
		if (!era) continue;

		const fields: EraRateFieldMismatch[] = [];
		const compare = (
			field: EraRateField,
			catalogValue: unknown,
			eraValue: number | undefined,
		) => {
			if (!isRate(catalogValue) || eraValue === undefined) return;
			if (!sameRate(catalogValue, eraValue)) {
				fields.push({ field, catalogValue, eraValue });
			}
		};
		compare("input", cost.input, era.inputPerM);
		compare("output", cost.output, era.outputPerM);
		compare("cache_read", cost.cache_read, era.cacheReadPerM);
		compare("cache_write", cost.cache_write, era.cacheCreationPerM);

		if (era.longContext) {
			const tiers = (Array.isArray(cost.tiers) ? cost.tiers : []).filter(
				(tier): tier is ModelCostTier => isRate(tier?.tier?.size),
			);
			const tier = tiers.find(
				(candidate) => candidate.tier.size === LONG_CONTEXT_PROMPT_TOKENS,
			);
			if (tier) {
				compare("long_context_input", tier.input, era.longContext.inputPerM);
				compare("long_context_output", tier.output, era.longContext.outputPerM);
				compare(
					"long_context_cache_read",
					tier.cache_read,
					era.longContext.cacheReadPerM,
				);
				compare(
					"long_context_cache_write",
					tier.cache_write,
					era.longContext.cacheCreationPerM,
				);
			} else if (tiers.length > 0) {
				fields.push({
					field: "long_context_threshold",
					catalogValue: Math.min(...tiers.map((t) => t.tier.size)),
					eraValue: LONG_CONTEXT_PROMPT_TOKENS,
				});
			}
		}

		if (fields.length > 0) {
			mismatches.push({ modelId, section, eraSinceMs: era.sinceMs, fields });
		}
	}
	return mismatches;
}
