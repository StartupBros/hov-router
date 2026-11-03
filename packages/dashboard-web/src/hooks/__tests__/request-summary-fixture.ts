import type { RequestSummary } from "../../api";

/**
 * Complete request-summary fixture: every required field of the real type is
 * present, so tests never need a cast. Overrides are spread last.
 */
export function makeRequestSummary(
	overrides: Partial<RequestSummary> = {},
): RequestSummary {
	return {
		id: "request-1",
		timestamp: new Date(1).toISOString(),
		method: "POST",
		path: "/v1/messages",
		accountUsed: null,
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTimeMs: null,
		failoverAttempts: 0,
		...overrides,
	};
}
