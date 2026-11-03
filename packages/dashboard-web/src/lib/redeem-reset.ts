import type {
	CodexResetRedemptionState,
	RedeemResetErrorReason,
	RedeemResetOutcome,
	RedeemResetResponse,
	RedeemResetSpend,
} from "@better-ccflare/types";

/**
 * What the dashboard learned from one redeem attempt. `no_answer` covers an
 * attempt that may or may not have reached the router: a network failure, a
 * timeout, or a 200 whose body the dashboard cannot read.
 */
export type RedeemResetAnswer =
	| { kind: "result"; response: RedeemResetResponse }
	| {
			kind: "error";
			status: number;
			reason: RedeemResetErrorReason | null;
			message: string | null;
			openRequestId: string | null;
	  }
	| { kind: "no_answer" };

// Keyed by every member of each union, so a member added to the shared type
// fails the typecheck here until the dashboard knows about it.
const STATES = new Set<string>(
	Object.keys({
		pending: true,
		unknown: true,
		retryable: true,
		done: true,
		refused: true,
		abandoned: true,
	} satisfies Record<CodexResetRedemptionState, true>),
);
const OUTCOMES = new Set<string>(
	Object.keys({
		reset: true,
		already_redeemed: true,
		nothing_to_reset: true,
		no_credit: true,
		unclear: true,
		retry: true,
		refused: true,
		abandoned: true,
	} satisfies Record<RedeemResetOutcome, true>),
);
const SPENDS = new Set<string>(
	Object.keys({
		spent: true,
		not_spent: true,
		not_confirmed: true,
	} satisfies Record<RedeemResetSpend, true>),
);
const REASONS = new Set<string>(
	Object.keys({
		in_progress: true,
		open_request: true,
		not_applicable: true,
		counts_stale: true,
		request_conflict: true,
		not_sent: true,
		unsupported_media_type: true,
		invalid_request: true,
		not_codex: true,
		account_not_found: true,
	} satisfies Record<RedeemResetErrorReason, true>),
);

// The server's check (packages/http-api/src/handlers/redeem-reset.ts).
const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isCountOrNull(value: unknown): value is number | null {
	return value === null || isCount(value);
}

function readResponse(body: unknown): RedeemResetResponse | null {
	if (typeof body !== "object" || body === null) return null;
	const fields = body as Record<string, unknown>;
	const readable =
		typeof fields.requestId === "string" &&
		typeof fields.accountId === "string" &&
		STATES.has(fields.state as string) &&
		OUTCOMES.has(fields.outcome as string) &&
		isCountOrNull(fields.windowsReset) &&
		(fields.spend === null || SPENDS.has(fields.spend as string)) &&
		isCountOrNull(fields.availableBefore) &&
		isCountOrNull(fields.availableAfter) &&
		isCount(fields.requestedAt) &&
		isCountOrNull(fields.completedAt);
	return readable ? (body as RedeemResetResponse) : null;
}

/** Reads the status and parsed JSON body of one redeem attempt. */
export function parseRedeemResetAnswer(
	status: number,
	body: unknown,
): RedeemResetAnswer {
	if (status === 200) {
		const response = readResponse(body);
		return response ? { kind: "result", response } : { kind: "no_answer" };
	}
	const fields =
		typeof body === "object" && body !== null
			? (body as Record<string, unknown>)
			: {};
	return {
		kind: "error",
		status,
		reason: REASONS.has(fields.reason as string)
			? (fields.reason as RedeemResetErrorReason)
			: null,
		message:
			typeof fields.error === "string" && fields.error.trim() !== ""
				? fields.error
				: null,
		openRequestId:
			typeof fields.openRequestId === "string" &&
			UUID_V4.test(fields.openRequestId)
				? fields.openRequestId
				: null,
	};
}

/**
 * A lower-case UUID v4 for one opening of the confirmation. The bytes come
 * from getRandomValues, which pages served over plain http have;
 * crypto.randomUUID exists only in secure contexts, and the dashboard is
 * often reached over a LAN address.
 */
export function mintRedeemRequestId(
	fill: (bytes: Uint8Array) => unknown = (bytes) =>
		crypto.getRandomValues(bytes),
): string {
	const bytes = new Uint8Array(16);
	fill(bytes);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Longer than the router's worst case: a 10-second call to OpenAI, then a
 * usage refresh that may fall back to a manual one. A timeout reads as "no
 * answer", and a retry with the same request id cannot spend a second reset.
 */
export const REDEEM_RESET_TIMEOUT_MS = 90_000;

export interface RedeemResetTransport {
	fetch: (input: string, init: RequestInit) => Promise<Response>;
	apiKey: string | null;
	/** Called on a 401, so the dashboard can ask for its key again. */
	onUnauthorized: () => void;
	timeoutMs?: number;
}

/**
 * Sends one redeem attempt. It never throws and never retries on its own:
 * only the operator's click sends, and every answer, including no answer,
 * comes back for the dialog to show.
 */
export async function sendRedeemReset(
	accountId: string,
	requestId: string,
	transport: RedeemResetTransport,
): Promise<RedeemResetAnswer> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json",
	};
	if (transport.apiKey) headers["x-api-key"] = transport.apiKey;

	let response: Response;
	try {
		response = await transport.fetch(
			`/api/accounts/${encodeURIComponent(accountId)}/redeem-reset`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({ requestId }),
				signal: AbortSignal.timeout(
					transport.timeoutMs ?? REDEEM_RESET_TIMEOUT_MS,
				),
			},
		);
	} catch {
		return { kind: "no_answer" };
	}
	if (response.status === 401) transport.onUnauthorized();
	const body: unknown = await response.json().catch(() => null);
	return parseRedeemResetAnswer(response.status, body);
}
