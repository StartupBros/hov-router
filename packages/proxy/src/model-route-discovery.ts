import { getModelDisplayName, getModelFamily } from "@better-ccflare/core";
import { previewAccountPhysicalModel } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import {
	getCodexCatalogRoleTarget,
	getKnownCodexModels,
} from "./codex-model-catalog";
import { getRouteProfileConstraintViolation } from "./handlers/account-selector";
import type {
	ModelRouteProfile,
	ModelRouteSessionRegistry,
} from "./model-route-profiles";
import { describeModelRouteProfileFlow } from "./model-route-profiles";

const MAX_DISPLAY_NAME_LENGTH = 120;

export interface ModelRouteDiscoveryModel {
	readonly id: string;
	readonly display_name: string;
	readonly description: string;
}

/** In-memory lookups only: discovery never refreshes catalogs or calls providers. */
export interface ModelRouteDiscoveryDeps {
	readonly catalogRoleTarget: (
		accountId: string,
		family: NonNullable<ReturnType<typeof getModelFamily>>,
	) => string | null;
	readonly codexModelDisplayName: (
		accountId: string,
		model: string,
	) => string | null;
	readonly previewPhysicalModel: (
		account: Account,
		logicalModel: string,
	) => string | null;
}

const DEFAULT_DEPS: ModelRouteDiscoveryDeps = {
	catalogRoleTarget: getCodexCatalogRoleTarget,
	codexModelDisplayName: (accountId, model) =>
		getKnownCodexModels(accountId)?.models.find((entry) => entry.id === model)
			?.displayName ?? null,
	previewPhysicalModel: (account, logicalModel) =>
		previewAccountPhysicalModel(account, logicalModel),
};

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function clip(value: string): string {
	return value.length <= MAX_DISPLAY_NAME_LENGTH
		? value
		: `${value.slice(0, MAX_DISPLAY_NAME_LENGTH - 1).trimEnd()}…`;
}

/**
 * An account belongs to a route when the selector's own constraint would admit
 * it. A cold catalog is not a rejection: role targets publish shortly after a
 * restart, and hiding the row meanwhile would strand clients that start then.
 */
function admits(profile: ModelRouteProfile, account: Account): boolean {
	if (account.paused) return false;
	const violation = getRouteProfileConstraintViolation(
		account,
		{
			routeProfileId: profile.id,
			routeProfileSelection: profile.selection ?? null,
			routeProfileLogicalModel: profile.logicalModel,
			routeExpectedProvider: profile.expectedProvider ?? null,
			routeExpectedPhysicalModel: profile.expectedPhysicalModel ?? null,
			routeProfileExpectedPhysicalModel: profile.expectedPhysicalModel ?? null,
			routePhysicalModelPolicy: profile.physicalModelPolicy ?? null,
			routeCatalogRoleTargetByAccountId: null,
		},
		profile.logicalModel,
	);
	return violation === null || violation === "catalog_role_unavailable";
}

function servedModel(
	profile: ModelRouteProfile,
	account: Account,
	deps: ModelRouteDiscoveryDeps,
): string | null {
	if (profile.physicalModelPolicy === "catalog-role") {
		const family = getModelFamily(profile.logicalModel);
		return family ? deps.catalogRoleTarget(account.id, family) : null;
	}
	return (
		profile.expectedPhysicalModel ??
		deps.previewPhysicalModel(account, profile.logicalModel)
	);
}

function servedModelLabel(
	profile: ModelRouteProfile,
	account: Account,
	deps: ModelRouteDiscoveryDeps,
): string | null {
	const model = servedModel(profile, account, deps);
	if (!model) return null;
	const vendorName =
		account.provider === "codex"
			? deps.codexModelDisplayName(account.id, model)
			: null;
	return oneLine(vendorName || getModelDisplayName(model)) || null;
}

/**
 * Picker rows named after what each route serves right now, so a catalog
 * reorder, a new model generation or a remapped account relabels the picker
 * with no config edit. Routes no account can serve are left out. The operator
 * `displayName` is only the fallback while the served model is unknown.
 */
export function buildModelRouteDiscoveryModels(
	registry: ModelRouteSessionRegistry,
	accounts: readonly Account[],
	deps: ModelRouteDiscoveryDeps = DEFAULT_DEPS,
): ModelRouteDiscoveryModel[] {
	const models: ModelRouteDiscoveryModel[] = [];
	for (const profile of registry.getProfiles()) {
		const pooled = profile.selection === "capability";
		const members = accounts.filter(
			(account) =>
				(pooled
					? !registry.isProfileOnlyAccount(account.id)
					: account.id === profile.accountId) && admits(profile, account),
		);
		if (members.length === 0) continue;

		const served = [
			...new Set(
				members
					.map((account) => servedModelLabel(profile, account, deps))
					.filter((label): label is string => label !== null),
			),
		].sort();
		const where = pooled
			? `${profile.expectedProvider ?? "account"} pool`
			: oneLine(members[0]?.name ?? "");
		const context = profile.clientContextWindowHint === "1m" ? " (1M)" : "";
		models.push({
			id: profile.discoveryModelId,
			display_name:
				served.length > 0
					? clip(`${served.join(" / ")}${context} · ${where}`)
					: profile.displayName,
			description: describeModelRouteProfileFlow(profile),
		});
	}
	return models;
}

/**
 * One local account read per discovery request. If it fails, the static
 * operator rows are better than no picker at all.
 */
export async function listModelRouteDiscoveryModels(
	registry: ModelRouteSessionRegistry,
	loadAccounts: () => Promise<readonly Account[]>,
	deps: ModelRouteDiscoveryDeps = DEFAULT_DEPS,
): Promise<ModelRouteDiscoveryModel[]> {
	let accounts: readonly Account[];
	try {
		accounts = await loadAccounts();
	} catch {
		return [...registry.getDiscoveryModels()];
	}
	return buildModelRouteDiscoveryModels(registry, accounts, deps);
}
