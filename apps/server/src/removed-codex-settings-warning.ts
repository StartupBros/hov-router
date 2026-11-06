import { PRODUCT_NAME } from "@better-ccflare/core/product-identity";

interface WarningLog {
	warn(message: string): void;
}

/**
 * The environment variables that configured the removed Codex WebSocket
 * transport. Nothing reads them any more.
 */
export const REMOVED_CODEX_WEBSOCKET_ENV_NAMES = [
	"CCFLARE_CODEX_WS_ACCOUNT_IDS",
	"CCFLARE_CODEX_WS_COHORT_IDS",
	"CCFLARE_CODEX_WS_FIRST_EVENT_TIMEOUT_MS",
	"CCFLARE_CODEX_WS_HANDSHAKE_TIMEOUT_MS",
	"CCFLARE_CODEX_WS_IDLE_TTL_MS",
	"CCFLARE_CODEX_WS_MAX_AGE_MS",
	"CCFLARE_CODEX_WS_MAX_GLOBAL",
	"CCFLARE_CODEX_WS_MAX_PER_ACCOUNT",
	"CCFLARE_CODEX_WS_MODELS",
	"CCFLARE_CODEX_WS_OBSERVE_ONLY",
	"CCFLARE_CODEX_WS_PERCENT",
	"CCFLARE_CODEX_WS_TELEMETRY_WARN",
] as const;

/**
 * The percentage that rolled out Codex cache-key continuity. Continuity is now
 * always on, so the setting is ignored.
 */
export const REMOVED_CODEX_CONTINUITY_CANARY_ENV_NAMES = [
	"CCFLARE_CODEX_CACHE_KEY_CONTINUITY_PERCENT",
] as const;

/**
 * The retired Codex cache experiments. Every one was off at 0 (production ran
 * them all at 0), and the code now always behaves as it did at 0.
 */
export const REMOVED_CODEX_CACHE_EXPERIMENT_ENV_NAMES = [
	"CCFLARE_CODEX_CACHE_KEY_SESSION_PERCENT",
	"CCFLARE_CODEX_CACHE_KEY_PREFIX_SHARD_PERCENT",
	"CCFLARE_CODEX_CACHE_PACING_SETTLE_MS",
	"CCFLARE_CODEX_PACING_BYPASS_PERCENT",
	"CCFLARE_CODEX_GPT56_EXPLICIT_CACHE_BREAKPOINT_PERCENT",
] as const;

/** Ignored settings for the removed Codex HTTP turn-state replay. */
export const REMOVED_CODEX_TURN_STATE_ENV_NAMES = [
	"CCFLARE_CODEX_TURN_STATE_PERCENT",
	"CCFLARE_CODEX_TURN_STATE_ACCOUNT_IDS",
	"CCFLARE_CODEX_TURN_STATE_MODELS",
	"CCFLARE_CODEX_TURN_STATE_COHORT_IDS",
	"CCFLARE_CODEX_TURN_STATE_OBSERVE_ONLY",
	"CCFLARE_CODEX_TURN_STATE_MAX_ENTRIES",
	"CCFLARE_CODEX_TURN_STATE_IDLE_TTL_MS",
] as const;

export interface RemovedSettingGroup {
	/** The sentence saying what was removed. */
	readonly removed: string;
	/** The sentence saying how the router behaves now. */
	readonly outcome: string;
	readonly names: readonly string[];
}

/** One group per removed feature; each set group logs one warning line. */
export const REMOVED_CODEX_SETTING_GROUPS: readonly RemovedSettingGroup[] = [
	{
		removed: `The Codex WebSocket transport was removed from ${PRODUCT_NAME}.`,
		outcome: "Codex requests always go over HTTP.",
		names: REMOVED_CODEX_WEBSOCKET_ENV_NAMES,
	},
	{
		removed: `The Codex cache-key continuity canary was removed from ${PRODUCT_NAME}.`,
		outcome:
			"Cache-key continuity is always on; to turn it off, set CCFLARE_CODEX_CACHE_KEY_MODE=session or CCFLARE_CODEX_SINGLE_ORCHESTRATION_ROOT=0.",
		names: REMOVED_CODEX_CONTINUITY_CANARY_ENV_NAMES,
	},
	{
		removed: `The Codex cache experiments (session keys, prefix sharding, pacing settle, pacing bypass and GPT-5.6 explicit breakpoints) were removed from ${PRODUCT_NAME}.`,
		outcome: "Codex requests always get the behavior these settings gave at 0.",
		names: REMOVED_CODEX_CACHE_EXPERIMENT_ENV_NAMES,
	},
	{
		removed: `The Codex HTTP turn-state replay was removed from ${PRODUCT_NAME}.`,
		outcome:
			"Codex requests never replay x-codex-turn-state; a client-sent copy is still dropped.",
		names: REMOVED_CODEX_TURN_STATE_ENV_NAMES,
	},
];

/**
 * Names from `names` that are set to a non-empty value. An empty assignment
 * (`NAME=`) is the usual way to unset one, so it is not reported.
 */
export function readSetEnvNames(
	names: readonly string[],
	env: Record<string, string | undefined>,
): string[] {
	return names.filter((name) => (env[name] ?? "").trim() !== "");
}

/**
 * The startup warning for a group's removed variables that are still set, or
 * null when none are. Only names are printed, never values.
 */
export function buildRemovedSettingsWarning(
	group: RemovedSettingGroup,
	setNames: readonly string[],
): string | null {
	if (setNames.length === 0) return null;
	const noun =
		setNames.length === 1 ? "setting is still set" : "settings are still set";
	return (
		`${group.removed} ${setNames.length} ${noun} and ignored: ${setNames.join(", ")}. ` +
		`${group.outcome} Remove these variables from the environment to silence this warning.`
	);
}

/** Log one warning per removed feature whose variables are still set. */
export function logRemovedCodexSettingsWarnings(
	env: Record<string, string | undefined>,
	log: WarningLog,
): void {
	for (const group of REMOVED_CODEX_SETTING_GROUPS) {
		const warning = buildRemovedSettingsWarning(
			group,
			readSetEnvNames(group.names, env),
		);
		if (warning) log.warn(warning);
	}
}
