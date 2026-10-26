import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import {
	buildModelRouteDiscoveryModels,
	listModelRouteDiscoveryModels,
	type ModelRouteDiscoveryDeps,
} from "../model-route-discovery";
import {
	MODEL_ROUTE_PROFILE_MODEL_PREFIX,
	ModelRouteSessionRegistry,
	parseModelRouteProfiles,
} from "../model-route-profiles";

const EXACT_FLOW =
	"One pinned account, no fallback · subagents use the same account";
const POOL_FLOW =
	"Pool of matching accounts, load-balancer order, then error · subagents fall back to normal routing";

const route = (id: string) => `${MODEL_ROUTE_PROFILE_MODEL_PREFIX}${id}`;

function account(
	id: string,
	provider: string,
	overrides: Partial<Account> = {},
): Account {
	return {
		id,
		name: id,
		provider,
		paused: false,
		model_mappings: null,
		model_fallbacks: null,
		custom_endpoint: null,
		...overrides,
	} as Account;
}

// The production shape on 2026-10-26: two catalog-role Codex pools whose
// hand-written labels no longer matched what their catalogs served, two exact
// routes, and one exact route on a paused account.
const PROFILES = [
	{
		id: "pro-primary-sol",
		displayName: "Codex pool: Sonnet-tier (1M)",
		description: "operator-description-secret",
		selection: "capability",
		logicalModel: "claude-sonnet-5",
		expectedProvider: "codex",
		clientContextWindowHint: "1m",
		physicalModelPolicy: "catalog-role",
	},
	{
		id: "grok-primary",
		displayName: "Grok (latest) · grok",
		accountId: "grok-account-id",
		logicalModel: "claude-opus-5",
		expectedProvider: "xai",
	},
	{
		id: "openrouter-fusion",
		displayName: "Fusion · openrouter",
		accountId: "openrouter-account-id",
		logicalModel: "claude-opus-5",
		expectedProvider: "openrouter",
		expectedPhysicalModel: "openrouter/fusion",
	},
	{
		id: "codex-pool-astra",
		displayName: "Codex pool: Opus-tier (1M)",
		selection: "capability",
		logicalModel: "claude-opus-5",
		expectedProvider: "codex",
		clientContextWindowHint: "1m",
		physicalModelPolicy: "catalog-role",
	},
	{
		id: "glm-5-3-flash",
		displayName: "GLM-5.3-Flash (Mac Studio) · ai-gateway-chat",
		accountId: "chat-account-id",
		logicalModel: "claude-sonnet-5",
		expectedProvider: "openai-compatible",
		expectedPhysicalModel: "chat",
		exclusiveAccount: true,
	},
];

function accounts(): Account[] {
	return [
		account("codex-a-id", "codex", { name: "pro-primary" }),
		account("codex-b-id", "codex", { name: "pro-secondary" }),
		account("grok-account-id", "xai", { name: "grok" }),
		account("openrouter-account-id", "openrouter", {
			name: "openrouter",
			paused: true,
			model_mappings: JSON.stringify({ opus: "openrouter/fusion" }),
		}),
		account("chat-account-id", "openai-compatible", {
			name: "ai-gateway-chat",
			model_mappings: JSON.stringify({ sonnet: "chat", opus: "chat" }),
		}),
	];
}

const ROLE_TARGETS: Record<string, Record<string, string>> = {
	"codex-a-id": { sonnet: "gpt-6-astra", opus: "gpt-6.1-sol" },
	"codex-b-id": { sonnet: "gpt-6-astra", opus: "gpt-6.1-sol" },
};
const CODEX_DISPLAY_NAMES: Record<string, string> = {
	"gpt-6-astra": "GPT-6-Astra",
	"gpt-6.1-sol": "GPT-6.1-Sol",
	"gpt-7-nova": "GPT-7 Nova",
};

function deps(
	overrides: Partial<ModelRouteDiscoveryDeps> = {},
): ModelRouteDiscoveryDeps {
	return {
		catalogRoleTarget: (accountId, family) =>
			ROLE_TARGETS[accountId]?.[family] ?? null,
		codexModelDisplayName: (_accountId, model) =>
			CODEX_DISPLAY_NAMES[model] ?? null,
		previewPhysicalModel: (candidate) =>
			candidate.provider === "xai" ? "grok-4.7" : null,
		...overrides,
	};
}

function registry(profiles: readonly object[] = PROFILES) {
	return new ModelRouteSessionRegistry(
		parseModelRouteProfiles(JSON.stringify(profiles)),
	);
}

describe("buildModelRouteDiscoveryModels", () => {
	it("names the model each route serves and hides routes that cannot run", () => {
		expect(
			buildModelRouteDiscoveryModels(registry(), accounts(), deps()),
		).toEqual([
			{
				id: route("pro-primary-sol[1m]"),
				display_name: "GPT-6-Astra (1M) · codex pool",
				description: POOL_FLOW,
			},
			{
				id: route("grok-primary"),
				display_name: "grok-4.7 · grok",
				description: EXACT_FLOW,
			},
			{
				id: route("codex-pool-astra[1m]"),
				display_name: "GPT-6.1-Sol (1M) · codex pool",
				description: POOL_FLOW,
			},
			{
				id: route("glm-5-3-flash"),
				display_name: "chat · ai-gateway-chat",
				description: EXACT_FLOW,
			},
		]);
	});

	it("follows a catalog that moves to a new generation with no config edit", () => {
		const moved = deps({
			catalogRoleTarget: (_accountId, family) =>
				family === "opus" ? "gpt-7-nova" : "gpt-6.1-sol",
		});
		const models = buildModelRouteDiscoveryModels(
			registry(),
			accounts(),
			moved,
		);
		expect(
			models.find((model) => model.id === route("codex-pool-astra[1m]"))
				?.display_name,
		).toBe("GPT-7 Nova (1M) · codex pool");
		expect(
			models.find((model) => model.id === route("pro-primary-sol[1m]"))
				?.display_name,
		).toBe("GPT-6.1-Sol (1M) · codex pool");
	});

	it("falls back to the operator label while catalogs are still cold", () => {
		const models = buildModelRouteDiscoveryModels(
			registry(),
			accounts(),
			deps({ catalogRoleTarget: () => null }),
		);
		expect(
			models.find((model) => model.id === route("pro-primary-sol[1m]"))
				?.display_name,
		).toBe("Codex pool: Sonnet-tier (1M)");
	});

	it("lists every distinct model when pool accounts disagree", () => {
		const models = buildModelRouteDiscoveryModels(
			registry(),
			accounts(),
			deps({
				catalogRoleTarget: (accountId) =>
					accountId === "codex-a-id" ? "gpt-6.1-sol" : "gpt-6-astra",
			}),
		);
		expect(
			models.find((model) => model.id === route("codex-pool-astra[1m]"))
				?.display_name,
		).toBe("GPT-6-Astra / GPT-6.1-Sol (1M) · codex pool");
	});

	it("hides a pool once none of its accounts can serve", () => {
		const paused = accounts().map((candidate) =>
			candidate.provider === "codex"
				? { ...candidate, paused: true }
				: candidate,
		);
		const ids = buildModelRouteDiscoveryModels(registry(), paused, deps()).map(
			(model) => model.id,
		);
		expect(ids).toEqual([route("grok-primary"), route("glm-5-3-flash")]);
	});

	it("keeps an account reserved for an exact route out of every pool", () => {
		const reserved = registry([
			PROFILES[3],
			{
				id: "reserved-codex",
				displayName: "Reserved Codex",
				accountId: "codex-reserved-id",
				logicalModel: "claude-opus-5",
				expectedProvider: "codex",
				exclusiveAccount: true,
			},
		]);
		const models = buildModelRouteDiscoveryModels(
			reserved,
			[
				account("codex-a-id", "codex"),
				account("codex-reserved-id", "codex", { name: "reserved" }),
			],
			deps({
				catalogRoleTarget: (accountId) =>
					accountId === "codex-reserved-id" ? "gpt-7-nova" : "gpt-6.1-sol",
				previewPhysicalModel: () => "gpt-7-nova",
			}),
		);
		expect(models.map((model) => model.display_name)).toEqual([
			"GPT-6.1-Sol (1M) · codex pool",
			"GPT-7 Nova · reserved",
		]);
	});

	it("hides an exact route whose account is missing or can never be admitted", () => {
		const mismatched = registry([
			PROFILES[1],
			{
				...PROFILES[4],
				expectedPhysicalModel: "not-what-the-account-maps",
			},
		]);
		expect(
			buildModelRouteDiscoveryModels(
				mismatched,
				accounts().filter((candidate) => candidate.id !== "grok-account-id"),
				deps(),
			),
		).toEqual([]);
	});

	it("labels a Claude model with its display name", () => {
		const claude = registry([
			{
				id: "max-opus",
				displayName: "Max · opus",
				accountId: "max-id",
				logicalModel: "claude-opus-5",
				expectedProvider: "anthropic",
			},
		]);
		expect(
			buildModelRouteDiscoveryModels(
				claude,
				[account("max-id", "anthropic", { name: "max-primary" })],
				deps({ previewPhysicalModel: (_account, logical) => logical }),
			)[0]?.display_name,
		).toBe("Claude Opus 5 · max-primary");
	});

	it("keeps labels on one bounded line and never exposes route internals", () => {
		const models = buildModelRouteDiscoveryModels(
			registry([PROFILES[1]]),
			[
				account("grok-account-id", "xai", {
					name: `grok\r\n<b>${"x".repeat(200)}`,
				}),
			],
			deps(),
		);
		const [model] = models;
		expect(model?.display_name.length).toBeLessThanOrEqual(120);
		expect(model?.display_name).not.toMatch(/[\r\n\t]/);
		expect(model?.display_name.startsWith("grok-4.7 · grok <b>x")).toBe(true);

		const raw = JSON.stringify(
			buildModelRouteDiscoveryModels(registry(), accounts(), deps()),
		);
		for (const secret of [
			"operator-description-secret",
			"codex-a-id",
			"grok-account-id",
			"chat-account-id",
			"catalog-role",
			"claude-sonnet-5",
		]) {
			expect(raw).not.toContain(secret);
		}
	});
});

describe("listModelRouteDiscoveryModels", () => {
	it("serves the static operator rows when the account read fails", async () => {
		const configured = registry();
		const models = await listModelRouteDiscoveryModels(
			configured,
			async () => {
				throw new Error("database unavailable");
			},
			deps(),
		);
		expect(models).toEqual(configured.getDiscoveryModels());
	});

	it("reads accounts once per discovery request", async () => {
		let reads = 0;
		const models = await listModelRouteDiscoveryModels(
			registry(),
			async () => {
				reads += 1;
				return accounts();
			},
			deps(),
		);
		expect(reads).toBe(1);
		expect(models).toHaveLength(4);
	});
});
