import type { Config, RuntimeConfig } from "@better-ccflare/config";
import { TIME_CONSTANTS } from "@better-ccflare/core";
import {
	type ModelRouteProfile,
	ModelRouteSessionRegistry,
} from "@better-ccflare/proxy";

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

/**
 * TTL for model route session pins. A session duration of 0 turns session
 * stickiness off for the load-balancing strategy and cache affinity, but a
 * route pin that expired at once would make every route profile unusable,
 * and the registry rejects a TTL that is not positive. Those cases use the
 * default session duration instead, which is also the registry's own default.
 */
export function modelRouteSessionTtlMs(sessionDurationMs: number): number {
	return Number.isFinite(sessionDurationMs) && sessionDurationMs > 0
		? sessionDurationMs
		: TIME_CONSTANTS.SESSION_DURATION_DEFAULT;
}

/** The server's model route session registry, with a TTL it accepts. */
export function createModelRouteSessionRegistry(
	profiles: readonly ModelRouteProfile[],
	sessionDurationMs: number,
): ModelRouteSessionRegistry {
	return new ModelRouteSessionRegistry(profiles, {
		ttlMs: modelRouteSessionTtlMs(sessionDurationMs),
	});
}
