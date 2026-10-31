import type { Config, RuntimeConfig } from "@better-ccflare/config";

/**
 * The server's RuntimeConfig, resolved through `config.getRuntime()` so the
 * documented precedence (default, then environment, then config file) applies
 * and nothing is written to the config file on read. `config.get(key,
 * default)` ignores RETRY_ATTEMPTS, RETRY_DELAY_MS, RETRY_BACKOFF and
 * SESSION_DURATION_MS, and persists its default on a miss.
 *
 * The database tuning block is deliberately left out: the server hands that
 * to DatabaseFactory from `getRuntime()` directly.
 */
export function buildServerRuntimeConfig(
	config: Config,
	port: number,
): RuntimeConfig {
	const resolved = config.getRuntime();
	return {
		clientId: resolved.clientId,
		retry: { ...resolved.retry },
		sessionDurationMs: resolved.sessionDurationMs,
		port,
	};
}
