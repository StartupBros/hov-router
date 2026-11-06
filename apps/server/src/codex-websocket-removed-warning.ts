import { PRODUCT_NAME } from "@better-ccflare/core/product-identity";

interface WarningLog {
	warn(message: string): void;
}

/**
 * The environment variables that configured the removed Codex WebSocket
 * transport. Nothing reads them any more; they are listed only so a startup
 * warning can name the ones an install still sets.
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
 * Names of the removed variables that are set to a non-empty value. An empty
 * assignment (`NAME=`) is the usual way to unset one, so it is not reported.
 */
export function readSetCodexWebSocketEnvNames(
	env: Record<string, string | undefined>,
): string[] {
	return REMOVED_CODEX_WEBSOCKET_ENV_NAMES.filter(
		(name) => (env[name] ?? "").trim() !== "",
	);
}

/**
 * The startup warning for removed variables that are still set, or null when
 * none are. Only names are printed, never values.
 */
export function buildCodexWebSocketRemovedWarning(
	names: readonly string[],
): string | null {
	if (names.length === 0) return null;
	const noun =
		names.length === 1 ? "setting is still set" : "settings are still set";
	return (
		`The Codex WebSocket transport was removed from ${PRODUCT_NAME}. ${names.length} ${noun} and ignored: ${names.join(", ")}. ` +
		"Codex requests always go over HTTP. Remove these variables from the environment to silence this warning."
	);
}

/** Log the warning once at startup. */
export function logCodexWebSocketRemovedWarning(
	env: Record<string, string | undefined>,
	log: WarningLog,
): void {
	const warning = buildCodexWebSocketRemovedWarning(
		readSetCodexWebSocketEnvNames(env),
	);
	if (warning) log.warn(warning);
}
