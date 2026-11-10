import { PRODUCT_NAME } from "@better-ccflare/core/product-identity";

/**
 * API endpoints removed in 5.0.0, answered with 410 Gone.
 *
 * APIRouter.handleRequest returns null for an unmatched /api/* path, and
 * server.ts then hands the request to the inference proxy, whose Anthropic
 * provider accepts every path. Without this answer, a stale script calling a
 * removed endpoint would be forwarded upstream on a real account. Every
 * method on these paths gets the 410, since none of them is served any more.
 *
 * Each removal is listed in docs/hov-router-migration.md.
 */
interface RemovedEndpoint {
	/** The path as documented, with :id for the account segment. */
	endpoint: string;
	/** The method and path that replaces it, or null when nothing does. */
	replacement: string | null;
	/** One sentence on what to do instead. */
	advice: string;
}

const REMOVED_IN = "5.0.0";

const EXACT = new Map<string, RemovedEndpoint>([
	[
		"/api/config/model",
		{
			endpoint: "/api/config/model",
			replacement: null,
			advice:
				"The Default Agent Model setting did nothing and is gone; set per-agent models on the Agents tab.",
		},
	],
	[
		"/api/system/info",
		{
			endpoint: "/api/system/info",
			replacement: null,
			advice: "GET /health reports the running version and build SHA.",
		},
	],
	[
		"/api/workspaces",
		{
			endpoint: "/api/workspaces",
			replacement: "GET /api/agents",
			advice:
				"GET /api/agents returns the workspaces; count workspaceAgents by workspace for per-workspace totals.",
		},
	],
]);

const ACCOUNT_ACTIONS = new Map<string, RemovedEndpoint>([
	[
		"auto-refresh",
		{
			endpoint: "/api/accounts/:id/auto-refresh",
			replacement: null,
			advice:
				"Auto-refresh was removed in 4.0.0; a stored value is ignored and needs no clearing.",
		},
	],
	[
		"model-fallbacks",
		{
			endpoint: "/api/accounts/:id/model-fallbacks",
			replacement: "POST /api/accounts/:id/model-mappings",
			advice:
				"Send fallbacks as array values in POST /api/accounts/:id/model-mappings.",
		},
	],
]);

/** The removed endpoint this path names, or undefined if it names none. */
export function findRemovedEndpoint(path: string): RemovedEndpoint | undefined {
	const exact = EXACT.get(path);
	if (exact) return exact;
	// Match the last segment under /api/accounts/, as the removed handlers'
	// path.endsWith() dispatch did, so no form they answered falls through.
	if (!path.startsWith("/api/accounts/")) return undefined;
	return ACCOUNT_ACTIONS.get(path.slice(path.lastIndexOf("/") + 1));
}

/** A 410 response for a removed endpoint. */
export function removedEndpointResponse(removed: RemovedEndpoint): Response {
	return Response.json(
		{
			error: "Gone",
			endpoint: removed.endpoint,
			removedIn: REMOVED_IN,
			replacement: removed.replacement,
			message: `${removed.endpoint} was removed in ${PRODUCT_NAME} ${REMOVED_IN}. ${removed.advice}`,
		},
		{ status: 410, headers: { "Cache-Control": "no-store" } },
	);
}
