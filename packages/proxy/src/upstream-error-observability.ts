/**
 * Privacy-safe, bounded metadata for an upstream error response.
 *
 * This module intentionally does not retain or return provider messages, body
 * text, headers, account names, or request content. The response handler uses
 * it for the 403 diagnostic log and for the cause it records on a failed
 * request row; callers keep the original response bytes and status untouched.
 */

export const MAX_UPSTREAM_ERROR_OBSERVATION_BYTES = 64 * 1024;

const SAFE_ERROR_TYPE = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;
const SAFE_ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface UpstreamErrorTelemetry {
	errorType?: string;
	errorCode?: string;
	/** HTTP status received from the upstream transport. */
	upstreamStatus: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeType(value: unknown): string | undefined {
	return typeof value === "string" && SAFE_ERROR_TYPE.test(value)
		? value
		: undefined;
}

function safeCode(value: unknown): string | undefined {
	return typeof value === "string" && SAFE_ERROR_CODE.test(value)
		? value
		: undefined;
}

function boundedBodyText(body: string | Uint8Array): string | undefined {
	if (typeof body === "string") {
		const bytes = new TextEncoder().encode(body);
		if (bytes.byteLength > MAX_UPSTREAM_ERROR_OBSERVATION_BYTES)
			return undefined;
		return body;
	}
	if (body.byteLength > MAX_UPSTREAM_ERROR_OBSERVATION_BYTES) return undefined;
	try {
		return new TextDecoder().decode(body);
	} catch {
		return undefined;
	}
}

/**
 * Extract only safe categorical fields from a bounded JSON error envelope.
 * Provider messages, unsafe identifiers and oversized bodies yield nothing.
 */
function parseUpstreamErrorFields(
	body: string | Uint8Array | null | undefined,
): { errorType?: string; errorCode?: string } {
	const text = body == null ? undefined : boundedBodyText(body);
	if (text === undefined) return {};
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isRecord(parsed)) return {};
		// Anthropic/Codex error envelopes use { error: { ... } }; a few
		// OpenAI-compatible endpoints return the same fields at the root.
		const hasNestedError = isRecord(parsed.error);
		const nested: Record<string, unknown> = hasNestedError
			? (parsed.error as Record<string, unknown>)
			: parsed;
		let errorType = safeType(nested.type);
		// A root `{type:"error"}` is the envelope discriminator, not a
		// useful provider error type. Do not turn that generic wrapper into
		// misleading telemetry when the nested object is absent.
		if (!hasNestedError && errorType === "error") errorType = undefined;
		const errorCode = safeCode(nested.code);
		return {
			...(errorType ? { errorType } : {}),
			...(errorCode ? { errorCode } : {}),
		};
	} catch {
		// A plain-text or malformed provider error still yields its status.
		// Never log a parse error or body prefix.
		return {};
	}
}

/**
 * Status-only metadata for a non-streaming 403 diagnostic log line.
 *
 * A 403 always returns a status-only record, even when the body is empty or
 * non-JSON. This makes an authorization denial observable without guessing at
 * a provider code. Other statuses return null because this log is scoped to
 * non-streaming 403 diagnostics.
 */
export function extractUpstreamErrorTelemetry(
	body: string | Uint8Array | null | undefined,
	upstreamStatus: number,
): UpstreamErrorTelemetry | null {
	if (upstreamStatus !== 403) return null;
	return { ...parseUpstreamErrorFields(body), upstreamStatus };
}

/**
 * The stored cause of a failed, forwarded upstream response (#756):
 * `upstream_http_<status>`, then ` type=<type>` and ` code=<code>` when the
 * bounded body carries safe values. It never includes message text, so the
 * request row's `error_message` keeps the same privacy contract as the 403
 * log above.
 */
export function describeUpstreamFailure(
	body: string | Uint8Array | null | undefined,
	upstreamStatus: number,
): string {
	const { errorType, errorCode } = parseUpstreamErrorFields(body);
	return [
		`upstream_http_${upstreamStatus}`,
		...(errorType ? [`type=${errorType}`] : []),
		...(errorCode ? [`code=${errorCode}`] : []),
	].join(" ");
}
