import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Private hop-by-hop credential used only between in-process schedulers and the
 * localhost proxy listener. Public probe/session headers are routing hints, not
 * authorization, and must never grant access to a paused or cooling account.
 *
 * The wire value keeps its old auto-refresh wording: `x-better-ccflare-*`
 * headers are protected names (AGENTS.md).
 */
export const INTERNAL_SCHEDULER_AUTH_HEADER =
	"x-better-ccflare-internal-auto-refresh-token";

// Generated once per process. A restart invalidates every previously observed
// value, and the value is never exported or written to logs/configuration.
const internalSchedulerToken = randomBytes(32).toString("base64url");

/** Stamp a scheduler-owned localhost request with the process credential. */
export function stampInternalSchedulerAuth(headers: Headers): void {
	headers.set(INTERNAL_SCHEDULER_AUTH_HEADER, internalSchedulerToken);
}

/**
 * Validate and consume the credential at proxy ingress. Deletion happens before
 * comparison so invalid values cannot reach metadata, logs, cache staging, or
 * an upstream provider either.
 */
export function consumeInternalSchedulerAuth(headers: Headers): boolean {
	const candidate = headers.get(INTERNAL_SCHEDULER_AUTH_HEADER);
	headers.delete(INTERNAL_SCHEDULER_AUTH_HEADER);
	if (!candidate || candidate.length !== internalSchedulerToken.length) {
		return false;
	}
	return timingSafeEqual(
		Buffer.from(candidate, "utf8"),
		Buffer.from(internalSchedulerToken, "utf8"),
	);
}
