import { isUsageExhausted } from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import { errorResponse, jsonResponse } from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import {
	chatGptAccountHashOf,
	getRepresentativeUsageSnapshotForProvider,
	isCodexSubscriptionEndpoint,
	resolveCodexEndpoint,
	usageCache,
} from "@better-ccflare/providers";
import {
	hasCodexResetRedeemer,
	redeemCodexResetCreditForAccount,
	refreshCodexUsageForAccount,
} from "@better-ccflare/proxy";
import type {
	RedeemResetErrorBody,
	RedeemResetErrorReason,
} from "@better-ccflare/types";
import {
	type CodexResetRedemptionDeps,
	CodexResetRedemptionService,
	readAvailableCountFromUsage,
} from "../services/codex-reset-redemption";

const log = new Logger("RedeemResetHandler");

const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function reject(
	status: 400 | 404 | 415,
	reason: RedeemResetErrorReason,
	error: string,
): Response {
	const body: RedeemResetErrorBody = { error, reason };
	return jsonResponse(body, status);
}

/**
 * Only `application/json` bodies are accepted (KTD8): a cross-site page can
 * send one only after a CORS preflight, which this server never answers.
 */
function isJsonRequest(req: Request): boolean {
	const mediaType = req.headers.get("content-type")?.split(";")[0];
	return mediaType?.trim().toLowerCase() === "application/json";
}

async function readRequestId(req: Request): Promise<string | null> {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return null;
	}
	const requestId =
		body && typeof body === "object"
			? (body as Record<string, unknown>).requestId
			: undefined;
	return typeof requestId === "string" && UUID_V4.test(requestId)
		? requestId.toLowerCase()
		: null;
}

/** The running server's redeemer, usage reads and clock. */
export function defaultRedemptionDeps(
	dbOps: DatabaseOperations,
): CodexResetRedemptionDeps {
	return {
		dbOps,
		hasRedeemer: hasCodexResetRedeemer,
		readChatGptAccountHash: async (accountId) => {
			const account = await dbOps.getAccount(accountId);
			return account?.access_token
				? chatGptAccountHashOf(account.access_token)
				: null;
		},
		dispatch: redeemCodexResetCreditForAccount,
		refreshUsage: (accountId) =>
			usageCache.refreshNow(accountId, { awaitInFlight: true }),
		refreshUsageManually: async (accountId) =>
			(await refreshCodexUsageForAccount(accountId, { awaitInFlight: true }))
				.success,
		readAvailableCount: (accountId) =>
			readAvailableCountFromUsage(usageCache.get(accountId)),
		hasCapacity: (accountId) => {
			const data = usageCache.get(accountId);
			const snapshot = data
				? getRepresentativeUsageSnapshotForProvider(data, "codex")
				: null;
			return (
				snapshot !== null &&
				!isUsageExhausted(snapshot.utilization, snapshot.resetMs, Date.now())
			);
		},
		releaseCooldown: async (accountId, observedBefore) => {
			if (await dbOps.clearRateLimitObservedBefore(accountId, observedBefore)) {
				log.info(
					`Reset redemption lifted the earlier cooldown on account ${accountId}`,
				);
			}
			usageCache.clearReactiveScopedDepletions(accountId);
		},
		now: () => Date.now(),
	};
}

/**
 * `POST /api/accounts/:id/redeem-reset`: spend one banked Codex reset for the
 * request id the confirmation dialog minted. A paused account may redeem.
 */
export function createAccountRedeemResetHandler(
	dbOps: DatabaseOperations,
	overrides: Partial<CodexResetRedemptionDeps> = {},
) {
	const service = new CodexResetRedemptionService({
		...defaultRedemptionDeps(dbOps),
		...overrides,
	});
	return async (req: Request, accountId: string): Promise<Response> => {
		if (!isJsonRequest(req)) {
			return reject(
				415,
				"unsupported_media_type",
				"Send the request as application/json.",
			);
		}
		const requestId = await readRequestId(req);
		if (!requestId) {
			return reject(
				400,
				"invalid_request",
				"The body needs a UUID v4 requestId.",
			);
		}
		try {
			const account = await dbOps.getAdapter().get<{
				name: string;
				provider: string;
				custom_endpoint: string | null;
			}>("SELECT name, provider, custom_endpoint FROM accounts WHERE id = ?", [
				accountId,
			]);
			if (!account) {
				return reject(404, "account_not_found", "Account not found.");
			}
			if (
				account.provider !== "codex" ||
				!isCodexSubscriptionEndpoint(
					resolveCodexEndpoint(account.custom_endpoint, account.name),
				)
			) {
				return reject(
					400,
					"not_codex",
					"Only Codex subscription accounts hold banked resets.",
				);
			}
			const result = await service.redeem(accountId, requestId);
			return jsonResponse(result.body, result.status);
		} catch (error) {
			log.error(
				`Reset redemption ${requestId} for account ${accountId} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return errorResponse(
				new Error(
					"The redemption could not be completed. Retrying with the same request id is safe.",
				),
			);
		}
	};
}
