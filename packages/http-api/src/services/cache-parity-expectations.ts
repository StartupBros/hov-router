/**
 * Declared cache-parity policy — the expected default for every lever
 * CacheParityPolicySnapshot reports.
 *
 * This exists so a nonzero lever in the live snapshot never has to be
 * re-investigated from scratch: either it matches this file, or it shows up
 * in the drift report as a deviation that is either acknowledged (owned, by
 * issue number) or not (a real anomaly). See docs/configuration.md "Codex
 * cache parity ownership" for the KEEP/DEFER/RETIRE/REMOVED contract each
 * default below is drawn from.
 */

import type {
	CacheParityDeclaredAcknowledgement,
	CacheParityDriftEntry,
	CacheParityDriftReport,
	CacheParityLeverKey,
	CacheParityPolicySnapshot,
} from "@better-ccflare/types";

/**
 * Declared default for every lever in CacheParityPolicySnapshot (excluding
 * the `explicitBreakpointSuppressedScopes` observed counter — see
 * CacheParityLeverKey). Values mirror docs/configuration.md:
 *
 * - promptCacheKeyEnabled / cacheKeyMode / pacingMs (60s): KEEP — the proven
 *   production controls. pacingMs is recorded as its deployed value
 *   (2026-08-20 plan doc Sources block: `CCFLARE_CACHE_PACING_MS=60000`), not
 *   the env-unset code default, because the ownership table declares it
 *   KEPT ON.
 * - cacheKeyContinuityPercent (100): KEEP — continuity is always on in code,
 *   and the snapshot reports a fixed 100 for one release.
 * - cacheKeySessionPercent, cacheKeyPrefixShardPercent, codexSettleMs,
 *   pacingBypassPercent, explicitBreakpointPercent, webSocketPercent:
 *   REMOVED — the code is gone and the snapshot reports a fixed 0 for one
 *   release.
 * - turnStatePercent: REMOVED — fixed at 0 for one release.
 * - globalKeepaliveTtlMinutes, xaiCacheKeepaliveTtlMinutes: default-off
 *   diagnostic/compatibility surfaces with no parity claim, declared default 0.
 * - turnStateObserveOnly: REMOVED — fixed at false for one release.
 */
export const CACHE_PARITY_DECLARED_DEFAULTS: CacheParityPolicySnapshot = {
	promptCacheKeyEnabled: true,
	cacheKeyMode: "conversation",
	cacheKeySessionPercent: 0,
	cacheKeyContinuityPercent: 100,
	cacheKeyPrefixShardPercent: 0,
	pacingMs: 60_000,
	codexSettleMs: 0,
	pacingBypassPercent: 0,
	explicitBreakpointPercent: 0,
	explicitBreakpointSuppressedScopes: 0,
	turnStatePercent: 0,
	turnStateObserveOnly: false,
	webSocketPercent: 0,
	globalKeepaliveTtlMinutes: 0,
	xaiCacheKeepaliveTtlMinutes: 0,
};

/**
 * Known, owned deviations from CACHE_PARITY_DECLARED_DEFAULTS. A lever
 * listed here reports as an acknowledged deviation in the drift report
 * rather than an unacknowledged anomaly.
 */
export const CACHE_PARITY_ACKNOWLEDGED_DEVIATIONS: Partial<
	Record<CacheParityLeverKey, CacheParityDeclaredAcknowledgement>
> = {};

const DECLARED_LEVER_KEYS: CacheParityLeverKey[] = [
	"promptCacheKeyEnabled",
	"cacheKeyMode",
	"cacheKeySessionPercent",
	"cacheKeyContinuityPercent",
	"cacheKeyPrefixShardPercent",
	"pacingMs",
	"codexSettleMs",
	"pacingBypassPercent",
	"explicitBreakpointPercent",
	"turnStatePercent",
	"turnStateObserveOnly",
	"webSocketPercent",
	"globalKeepaliveTtlMinutes",
	"xaiCacheKeepaliveTtlMinutes",
];

/** Diff a live cache-parity policy snapshot against the declared defaults. */
export function buildCacheParityDriftReport(
	policy: CacheParityPolicySnapshot,
): CacheParityDriftReport {
	const deviations: CacheParityDriftEntry[] = [];
	for (const lever of DECLARED_LEVER_KEYS) {
		const declaredValue = CACHE_PARITY_DECLARED_DEFAULTS[lever];
		const liveValue = policy[lever];
		if (declaredValue === liveValue) continue;
		const acknowledgement = CACHE_PARITY_ACKNOWLEDGED_DEVIATIONS[lever] ?? null;
		deviations.push({
			lever,
			declaredValue,
			liveValue,
			acknowledged: acknowledgement !== null,
			acknowledgement,
		});
	}

	return {
		declaredDefaults: CACHE_PARITY_DECLARED_DEFAULTS,
		deviations,
	};
}
