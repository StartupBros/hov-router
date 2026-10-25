import { PRODUCT_NAME } from "@better-ccflare/core/product-identity";
import { HttpError } from "@better-ccflare/http-common";

/** Show the "may be restarting" copy once the startup check has waited this long. */
export const STARTUP_SLOW_NOTICE_MS = 5_000;

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 15_000;

/** Result of the dashboard's startup request. */
export type StartupCheckOutcome =
	| { kind: "ready"; authRequired: boolean }
	| { kind: "auth_required"; message: string | null }
	| { kind: "unreachable"; message: string };

/**
 * 401 and 403 are the router's answer about the key. Anything else (a timeout,
 * a 5xx, a network failure) means the router did not answer, for example while
 * a deploy swaps the backend and the guard holds new requests.
 */
export function isKeyRejection(error: unknown): error is HttpError {
	return (
		error instanceof HttpError && (error.status === 401 || error.status === 403)
	);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function runStartupCheck(
	getStats: () => Promise<unknown>,
	hasStoredKey: () => boolean,
): Promise<StartupCheckOutcome> {
	try {
		await getStats();
		return { kind: "ready", authRequired: hasStoredKey() };
	} catch (error) {
		if (isKeyRejection(error)) {
			return {
				kind: "auth_required",
				message: error.status === 403 ? error.message : null,
			};
		}
		return { kind: "unreachable", message: errorText(error) };
	}
}

/** Error text for the API key dialog after a failed sign-in attempt. */
export function authenticateErrorMessage(error: unknown): string {
	if (isKeyRejection(error)) return error.message || "Invalid API key";
	return `Can't reach ${PRODUCT_NAME} right now (${errorText(error)}). It may be restarting; try again in a moment.`;
}

/** Delay before the next automatic retry after `failures` failed checks (0-based). */
export function startupRetryDelayMs(failures: number): number {
	return Math.min(RETRY_BASE_MS * 2 ** failures, RETRY_MAX_MS);
}
