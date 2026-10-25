import type { DatabaseOperations } from "@better-ccflare/database";
import { jsonResponse } from "@better-ccflare/http-common";
import type { RecentErrorGroup } from "@better-ccflare/types";
import { createTtlCache } from "../utils/ttl-cache";

async function loadStats(
	dbOps: DatabaseOperations,
	sinceDays: number,
	errorsHours: number,
) {
	const statsRepository = dbOps.getStatsRepository();
	const now = Date.now();
	const sinceMs = now - sinceDays * 24 * 60 * 60 * 1000;
	const errorsSinceMs = now - errorsHours * 60 * 60 * 1000;
	const [stats, activeAccounts, accountsWithStats, recentErrors, topModels] =
		await Promise.all([
			statsRepository.getAggregatedStats(sinceMs),
			statsRepository.getActiveAccountCount(),
			// Account and model counts intentionally retain their lifetime scope.
			statsRepository.getAccountStats(10, true),
			statsRepository.getRecentErrorGroups(errorsSinceMs, 50),
			statsRepository.getTopModels(),
		]);
	return {
		totalRequests: stats.totalRequests,
		successRate:
			stats.totalRequests > 0
				? Math.round((stats.successfulRequests / stats.totalRequests) * 100)
				: 0,
		activeAccounts,
		avgResponseTime: Math.round(stats.avgResponseTime || 0),
		totalTokens: stats.totalTokens,
		totalCostUsd: stats.totalCostUsd,
		topModels,
		avgTokensPerSecond: stats.avgTokensPerSecond,
		accounts: accountsWithStats,
		recentErrors,
	};
}

type Stats = Awaited<ReturnType<typeof loadStats>>;
type RecentErrors = { recentErrors: RecentErrorGroup[] };
type Cache<T> = ReturnType<typeof createTtlCache<T>>;
const caches = new WeakMap<DatabaseOperations, Cache<Stats>>();
const recentErrorCaches = new WeakMap<
	DatabaseOperations,
	Cache<RecentErrors>
>();

/** One cache/subscription per database, regardless of how many routers use it. */
function getCache<T>(
	store: WeakMap<DatabaseOperations, Cache<T>>,
	dbOps: DatabaseOperations,
): Cache<T> {
	let cache = store.get(dbOps);
	if (!cache) {
		cache = createTtlCache<T>(10_000);
		dbOps.onRequestsDeleted(cache.clear);
		store.set(dbOps, cache);
	}
	return cache;
}

/** Error window in hours: defaults to 24, capped at 365 days. */
function parseErrorsHours(url: URL): number {
	const raw = Number(url.searchParams.get("errorsSinceHours") ?? 24);
	return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 8760) : 24;
}

/** Create a stats handler. */
export function createStatsHandler(dbOps: DatabaseOperations) {
	return async (url: URL): Promise<Response> => {
		// Parse optional ?since=<days> query parameter (default: 30, max: 365).
		const sinceRaw = Number(url.searchParams.get("since") ?? 30);
		const sinceDays =
			Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.min(sinceRaw, 365) : 30;
		const errorsHours = parseErrorsHours(url);
		const stats = await getCache(caches, dbOps).get(
			`${sinceDays}:${errorsHours}`,
			() => loadStats(dbOps, sinceDays, errorsHours),
		);
		return jsonResponse(stats);
	};
}

/**
 * Create the recent-errors handler. Same error groups and window as
 * GET /api/stats, without its lifetime account and model scans, which hold
 * the router's only thread for seconds on a large database.
 */
export function createRecentErrorsHandler(dbOps: DatabaseOperations) {
	return async (url: URL): Promise<Response> => {
		const errorsHours = parseErrorsHours(url);
		const body = await getCache(recentErrorCaches, dbOps).get(
			String(errorsHours),
			async () => ({
				recentErrors: await dbOps
					.getStatsRepository()
					.getRecentErrorGroups(Date.now() - errorsHours * 60 * 60 * 1000, 50),
			}),
		);
		return jsonResponse(body);
	};
}

/** Create a stats reset handler. */
export function createStatsResetHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		await dbOps.resetStatistics();
		return jsonResponse({
			success: true,
			message: "Statistics reset successfully",
		});
	};
}
