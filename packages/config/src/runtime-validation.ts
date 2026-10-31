import { Logger } from "@better-ccflare/logger";

const log = new Logger("Config");

/**
 * Bounds for the upstream retry family: `retry_attempts`, `retry_delay_ms`
 * and `retry_backoff`.
 *
 * Applied to the resolved values after both the environment and the config
 * file have had their say, so one pass covers both sources. It also catches
 * what neither parse site does: `parseInt("abc", 10)` is `NaN` and
 * `typeof NaN === "number"`, so both paths admit it.
 *
 * Out-of-range values are clamped with a warning rather than rejected: this
 * runs at startup, where the only stronger response is refusing to boot, and
 * a bad tuning number must not take the proxy down. Clamping moves a value to
 * the nearest legal point in the direction it was heading (a negative becomes
 * 0, not the default), so it cannot turn "no retries" into "most retries".
 * `NaN` has no direction and keeps the default.
 */
export const RETRY_BOUNDS = {
	attempts: { min: 0, max: 10 },
	delayMs: { min: 0, max: 30_000 },
	backoff: { min: 1, max: 5 },
} as const;

type RetryRuntime = { attempts: number; delayMs: number; backoff: number };

const FIELDS = [
	{
		field: "attempts",
		fileKey: "retry_attempts",
		envKey: "RETRY_ATTEMPTS",
		integer: true,
	},
	{
		field: "delayMs",
		fileKey: "retry_delay_ms",
		envKey: "RETRY_DELAY_MS",
		integer: true,
	},
	{
		field: "backoff",
		fileKey: "retry_backoff",
		envKey: "RETRY_BACKOFF",
		integer: false,
	},
] as const;

/**
 * Warnings already emitted. `getRuntime()` is called per request by some
 * handlers, so an unconditional warning would repeat for the life of the
 * process. The key includes the values, so correcting a bad value to a
 * different bad value warns again.
 */
const warned = new Set<string>();

function warnOnce(dedupeKey: string, message: string): void {
	if (warned.has(dedupeKey)) return;
	warned.add(dedupeKey);
	log.warn(message);
}

/** Test seam: forget what has been warned about. */
export function resetRuntimeWarningsForTest(): void {
	warned.clear();
}

/** Clamps `retry` in place and returns the adjustments made. */
export function validateRuntimeRetry(
	retry: RetryRuntime,
	defaults: RetryRuntime,
): Array<{ key: string; received: number; applied: number; reason: string }> {
	const adjustments: Array<{
		key: string;
		received: number;
		applied: number;
		reason: string;
	}> = [];

	for (const { field, fileKey, envKey, integer } of FIELDS) {
		const bounds = RETRY_BOUNDS[field];
		const received = retry[field];
		const key = `${fileKey} (${envKey})`;

		if (typeof received !== "number" || Number.isNaN(received)) {
			retry[field] = defaults[field];
			adjustments.push({
				key,
				received: Number.NaN,
				applied: defaults[field],
				reason: "not a number",
			});
			warnOnce(
				`${key}:nan:${defaults[field]}`,
				`${key} is not a number; applying the default ${defaults[field]}. ` +
					`Set a number between ${bounds.min} and ${bounds.max}.`,
			);
			continue;
		}

		let applied = received;
		const reasons: string[] = [];

		// Floor, not round: rounding 1.6 up would be more aggressive than the
		// value the operator wrote.
		if (integer && !Number.isInteger(applied)) {
			applied = Math.floor(applied);
			reasons.push("truncated to a whole number");
		}

		if (applied < bounds.min) {
			applied = bounds.min;
			reasons.push(`raised to the minimum ${bounds.min}`);
		} else if (applied > bounds.max) {
			applied = bounds.max;
			reasons.push(`lowered to the maximum ${bounds.max}`);
		}

		if (applied === received) continue;

		retry[field] = applied;
		adjustments.push({
			key,
			received,
			applied,
			reason: reasons.join(", "),
		});
		warnOnce(
			`${key}:${received}:${applied}`,
			`${key} was ${received}, ${reasons.join(", ")}: applying ${applied}. ` +
				`The accepted range is ${bounds.min} to ${bounds.max}.`,
		);
	}

	return adjustments;
}
