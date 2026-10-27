import { deriveServerToolRequirement } from "@better-ccflare/providers/server-tool-capabilities";
import type { RequestMeta } from "@better-ccflare/types";
import type {
	ModelRouteProfile,
	ModelRouteResolution,
} from "./model-route-profiles";

export interface WebSearchHelperScope {
	/** Original profile constraints remain intact; never an ordinary-route grant. */
	readonly profile: ModelRouteProfile;
	readonly source: "explicit" | "inherited";
	readonly accountIds: readonly string[];
}

const scopes = new WeakMap<RequestMeta, WebSearchHelperScope>();
// Keyed by private authority identity, not request ids or serializable metadata.
// Legitimate candidate clones share this state; independent inbound requests do not.
const execution = new WeakMap<
	WebSearchHelperScope,
	{ lane: string; sent: boolean }
>();

export function getWebSearchHelperAffinityLane(
	meta: RequestMeta,
): string | undefined {
	const scope = scopes.get(meta);
	return scope ? execution.get(scope)?.lane : undefined;
}

export function hasWebSearchHelperDispatched(meta: RequestMeta): boolean {
	const scope = scopes.get(meta);
	return scope ? execution.get(scope)?.sent === true : false;
}

/** Synchronous claim immediately before native fetch; never reset after failure. */
export function claimWebSearchHelperDispatch(meta: RequestMeta): boolean {
	const scope = scopes.get(meta);
	const state = scope && execution.get(scope);
	if (!state || state.sent) return false;
	state.sent = true;
	return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextContent(content: unknown): boolean {
	if (typeof content === "string") return true;
	return (
		Array.isArray(content) &&
		content.length > 0 &&
		content.every(
			(block) =>
				isRecord(block) &&
				block.type === "text" &&
				typeof block.text === "string" &&
				Object.keys(block).every(
					(key) => key === "type" || key === "text" || key === "cache_control",
				),
		)
	);
}

/** Stricter than helper lineage classification: no history, citations or partial scans. */
export function isFreshWebSearchHelper(body: unknown): boolean {
	if (
		!isRecord(body) ||
		!Array.isArray(body.tools) ||
		body.tools.length !== 1 ||
		!Array.isArray(body.messages) ||
		body.messages.length !== 1
	)
		return false;
	const message = body.messages[0];
	if (
		!isRecord(message) ||
		message.role !== "user" ||
		!Object.keys(message).every((key) => key === "role" || key === "content") ||
		!isTextContent(message.content) ||
		(body.system !== undefined && !isTextContent(body.system))
	)
		return false;
	const requirements = deriveServerToolRequirement(body);
	return (
		requirements !== undefined &&
		requirements.declarations?.length === 1 &&
		requirements.declarations[0]?.type === "web_search_20250305" &&
		!requirements.hasClientFunctions &&
		!requirements.invalid?.length &&
		!requirements.unsupported?.length &&
		requirements.replay.input.length === 0 &&
		requirements.replay.output.length === 0
	);
}

/**
 * Called only after final body validation. Original eligibility is captured before
 * interception can mutate the parsed body. This stores authority by object identity,
 * not in serializable/client-mintable metadata. It does not select any account.
 */
export function authorizeWebSearchHelper(
	meta: RequestMeta,
	input: {
		readonly originalEligible: boolean;
		readonly body: unknown;
		readonly resolution: ModelRouteResolution | undefined;
		readonly publicForceAccount: boolean;
	},
): void {
	scopes.delete(meta);
	const resolution = input.resolution;
	if (
		!input.originalEligible ||
		input.publicForceAccount ||
		resolution?.kind !== "route" ||
		!isFreshWebSearchHelper(input.body)
	)
		return;
	const profile = resolution.profile;
	if (
		!profile.webSearchHelper ||
		profile.selection !== undefined ||
		profile.contextWindow !== undefined ||
		profile.maxOutputTokens !== undefined ||
		!profile.accountId
	)
		return;
	const scope = Object.freeze({
		profile,
		source: resolution.source,
		accountIds: profile.webSearchHelper.accountIds,
	});
	scopes.set(meta, scope);
	execution.set(scope, {
		lane: `websearch-helper:${crypto.randomUUID()}`,
		sent: false,
	});
}

/** Internal preparation retains private authority without changing source constraints. */
export function createWebSearchHelperCandidateMeta(
	meta: RequestMeta,
): RequestMeta {
	const scope = scopes.get(meta);
	if (!scope) return meta;
	const candidate = {
		...meta,
		routeExpectedProvider: null,
		routeExpectedPhysicalModel: null,
		routeProfileExpectedPhysicalModel: null,
		routePhysicalModelPolicy: null,
		routeProfilePhysicalModelPolicy: null,
		routeCatalogRoleTargetByAccountId: null,
	};
	scopes.set(candidate, scope);
	return candidate;
}

/** Candidate admission must still enforce provider exclusions and other reservations. */
export function getWebSearchHelperScope(
	meta: RequestMeta,
): WebSearchHelperScope | undefined {
	return scopes.get(meta);
}
