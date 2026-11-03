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
