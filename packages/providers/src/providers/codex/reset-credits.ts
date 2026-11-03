import {
	buildCodexWhamHeaders,
	extractChatGptAccountId,
	getCodexResetCreditsEndpoint,
	nonNegativeIntegerOrNull,
} from "./api-usage";
import { resolveCodexClientIdentity } from "./client-identity";

const REQUEST_TIMEOUT_MS = 5_000;

export interface CodexResetCredit {
	id: string;
	resetType: string | null;
	status: string; // OpenAI's raw string
	grantedAt: number | null; // epoch ms
	expiresAt: number | null; // epoch ms
	title: string | null;
	description: string | null;
}

export type CodexResetCreditListResult =
	| {
			ok: true;
			credits: CodexResetCredit[];
			availableCount: number | null;
			chatgptAccountId: string | null;
	  }
	| {
			ok: false;
			reason: "http" | "timeout" | "network" | "invalid_body";
			status: number | null;
	  };

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function epochMsOrNull(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

/**
 * Read the account's banked reset credit list. Never throws; a non-2xx answer
 * reports only its status, never the response body.
 */
export async function fetchCodexResetCredits(
	accessToken: string,
	options: {
		fetchImpl?: typeof fetch;
		signal?: AbortSignal;
		timeoutMs?: number;
	} = {},
): Promise<CodexResetCreditListResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const chatgptAccountId = extractChatGptAccountId(accessToken);
	const headers = buildCodexWhamHeaders(
		accessToken,
		chatgptAccountId,
		resolveCodexClientIdentity().userAgent,
	);

	// One deadline covers the request and the body read.
	const controller = new AbortController();
	let timedOut = false;
	const timeoutId = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
	const abort = () => controller.abort();
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) controller.abort();

	try {
		const response = await fetchImpl(getCodexResetCreditsEndpoint(), {
			method: "GET",
			headers,
			signal: controller.signal,
		});
		if (!response.ok) {
			try {
				await response.body?.cancel();
			} catch {
				// Best-effort: the body is never used.
			}
			return { ok: false, reason: "http", status: response.status };
		}

		let body: unknown;
		try {
			body = await response.json();
		} catch (error) {
			if (timedOut) return { ok: false, reason: "timeout", status: null };
			if (controller.signal.aborted) throw error;
			return { ok: false, reason: "invalid_body", status: null };
		}
		const record =
			body && typeof body === "object"
				? (body as Record<string, unknown>)
				: null;
		if (!record || !Array.isArray(record.credits)) {
			return { ok: false, reason: "invalid_body", status: null };
		}

		const credits: CodexResetCredit[] = [];
		for (const entry of record.credits) {
			if (!entry || typeof entry !== "object") continue;
			const item = entry as Record<string, unknown>;
			if (typeof item.id !== "string") continue;
			credits.push({
				id: item.id,
				resetType: stringOrNull(item.reset_type),
				status: typeof item.status === "string" ? item.status : "",
				grantedAt: epochMsOrNull(item.granted_at),
				expiresAt: epochMsOrNull(item.expires_at),
				title: stringOrNull(item.title),
				description: stringOrNull(item.description),
			});
		}
		return {
			ok: true,
			credits,
			availableCount: nonNegativeIntegerOrNull(record.available_count),
			chatgptAccountId,
		};
	} catch {
		return {
			ok: false,
			reason: timedOut ? "timeout" : "network",
			status: null,
		};
	} finally {
		clearTimeout(timeoutId);
		options.signal?.removeEventListener("abort", abort);
	}
}

const CONSUME_TIMEOUT_MS = 10_000;

/** The answers the Codex client understands; each one settles the request. */
const SETTLED_CONSUME_CODES = new Set([
	"reset",
	"already_redeemed",
	"nothing_to_reset",
	"no_credit",
]);

/** A code is stored only in this shape, so OpenAI text never reaches a page. */
const SAFE_CODE = /^[a-z_]{1,64}$/;

export interface CodexResetConsumeRequest {
	redeemRequestId: string;
	/** Sent as `credit_id`; null omits the key, as the Codex client does. */
	creditId: string | null;
}

/**
 * What one consume call learned. `answered` is any 2xx; its code is null when
 * the body was not JSON or the code had an unexpected shape. Bodies of other
 * answers are never read.
 */
export type CodexResetConsumeResult =
	| {
			kind: "answered";
			status: number;
			code: string | null;
			windowsReset: number | null;
	  }
	| { kind: "http"; status: number }
	| { kind: "timeout" }
	| { kind: "network" };

/**
 * Spend one banked reset credit. Never throws and never logs: a fetch error
 * can carry the token or the ChatGPT account id in its message.
 */
export async function consumeCodexResetCredit(
	accessToken: string,
	request: CodexResetConsumeRequest,
	options: {
		fetchImpl?: typeof fetch;
		signal?: AbortSignal;
		timeoutMs?: number;
	} = {},
): Promise<CodexResetConsumeResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const headers = {
		...buildCodexWhamHeaders(
			accessToken,
			extractChatGptAccountId(accessToken),
			resolveCodexClientIdentity().userAgent,
		),
		"Content-Type": "application/json",
	};
	const body: Record<string, string> = {
		redeem_request_id: request.redeemRequestId,
	};
	if (request.creditId != null) body.credit_id = request.creditId;

	const controller = new AbortController();
	let timedOut = false;
	const timeoutId = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, options.timeoutMs ?? CONSUME_TIMEOUT_MS);
	const abort = () => controller.abort();
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) controller.abort();

	try {
		const response = await fetchImpl(
			`${getCodexResetCreditsEndpoint()}/consume`,
			{
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			},
		);
		if (!response.ok) {
			try {
				await response.body?.cancel();
			} catch {
				// Best-effort: the body is never used.
			}
			return { kind: "http", status: response.status };
		}

		let parsed: unknown;
		try {
			parsed = await response.json();
		} catch {
			if (timedOut) return { kind: "timeout" };
			if (controller.signal.aborted) return { kind: "network" };
			return {
				kind: "answered",
				status: response.status,
				code: null,
				windowsReset: null,
			};
		}
		const record =
			parsed && typeof parsed === "object"
				? (parsed as Record<string, unknown>)
				: {};
		const code =
			typeof record.code === "string" && SAFE_CODE.test(record.code)
				? record.code
				: null;
		return {
			kind: "answered",
			status: response.status,
			code,
			windowsReset:
				record.windows_reset === undefined
					? 0
					: nonNegativeIntegerOrNull(record.windows_reset),
		};
	} catch {
		return { kind: timedOut ? "timeout" : "network" };
	} finally {
		clearTimeout(timeoutId);
		options.signal?.removeEventListener("abort", abort);
	}
}

export interface CodexResetConsumeClassification {
	state: "done" | "unknown" | "retryable" | "refused";
	code: string | null;
	windowsReset: number | null;
	httpStatus: number | null;
}

/** Maps one consume result to the stored row state (KTD10). */
export function classifyCodexResetConsume(
	result: CodexResetConsumeResult,
): CodexResetConsumeClassification {
	switch (result.kind) {
		case "answered": {
			const settled =
				result.code !== null && SETTLED_CONSUME_CODES.has(result.code);
			return {
				state: settled ? "done" : "unknown",
				code: result.code,
				windowsReset: settled ? result.windowsReset : null,
				httpStatus: result.status,
			};
		}
		case "http": {
			const { status } = result;
			const state =
				status === 401 || status === 429
					? "retryable"
					: status >= 400 && status < 500
						? "refused"
						: "unknown";
			return { state, code: null, windowsReset: null, httpStatus: status };
		}
		case "timeout":
		case "network":
			return {
				state: "unknown",
				code: null,
				windowsReset: null,
				httpStatus: null,
			};
	}
}
