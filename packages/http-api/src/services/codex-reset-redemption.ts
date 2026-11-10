import type {
	CodexResetCreditRow,
	CodexResetRedemptionRow,
	DatabaseOperations,
} from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import {
	type CodexResetConsumeRequest,
	classifyCodexResetConsume,
} from "@better-ccflare/providers";
import type { CodexResetRedeemDispatch } from "@better-ccflare/proxy";
import type {
	RedeemResetErrorBody,
	RedeemResetErrorReason,
	RedeemResetOutcome,
	RedeemResetResponse,
	RedeemResetSpend,
} from "@better-ccflare/types";
import {
	assessBankedResets,
	readResetCreditCounts,
} from "./codex-reset-credits";

const log = new Logger("CodexResetRedemption");

/** A `pending` attempt younger than this is still being sent (KTD8). */
const IN_PROGRESS_MS = 60_000;

const SETTLED_OUTCOMES: ReadonlySet<string> = new Set<RedeemResetOutcome>([
	"reset",
	"already_redeemed",
	"nothing_to_reset",
	"no_credit",
]);

export interface CodexResetRedemptionDeps {
	dbOps: Pick<
		DatabaseOperations,
		"getCodexResetRedemptionsRepository" | "getCodexResetCreditsRepository"
	>;
	/** Whether a server in this process registered its redeemer. */
	hasRedeemer(): boolean;
	/** The hashed ChatGPT account the stored token names, or null when none. */
	readChatGptAccountHash(accountId: string): Promise<string | null>;
	/** Sends only while the token still names `expectedChatGptAccountHash`. */
	dispatch(
		accountId: string,
		request: CodexResetConsumeRequest,
		expectedChatGptAccountHash: string | null,
	): Promise<CodexResetRedeemDispatch>;
	/** A polled usage read that starts after the call; false when none landed. */
	refreshUsage(accountId: string): Promise<boolean>;
	/** The manual Codex usage read, tried when the polled one fails (KTD11). */
	refreshUsageManually(accountId: string): Promise<boolean>;
	/** The available count in the usage just read, or null when it has none. */
	readAvailableCount(accountId: string): number | null;
	/** Whether the usage just read shows the account has room to serve. */
	hasCapacity(accountId: string): boolean;
	/**
	 * Lift a rate-limit cooldown observed before `observedBefore`; a limit
	 * seen later stays. Pauses are untouched.
	 */
	releaseCooldown(accountId: string, observedBefore: number): Promise<void>;
	now(): number;
}

/** Outcomes after which OpenAI reports the account's limits as cleared. */
const RESET_CODES: ReadonlySet<string | null> = new Set([
	"reset",
	"already_redeemed",
]);

export type RedeemResetServiceResult =
	| { status: 200; body: RedeemResetResponse }
	| { status: 409 | 503; body: RedeemResetErrorBody };

type ServiceErrorReason = Extract<
	RedeemResetErrorReason,
	| "in_progress"
	| "open_request"
	| "none_held"
	| "counts_stale"
	| "request_conflict"
	| "not_sent"
>;

const ERROR_TEXT: Record<ServiceErrorReason, string> = {
	in_progress: "This redemption is being sent right now.",
	open_request: "Another redemption is still open on this account.",
	none_held: "OpenAI reports no banked reset held on this account.",
	counts_stale:
		"The reset counts are too old to rely on. Refresh usage and try again.",
	request_conflict: "This request id was already used for another account.",
	not_sent: "Nothing was sent to OpenAI. Try again.",
};

function refuse(
	status: 409 | 503,
	reason: ServiceErrorReason,
	extra: Pick<RedeemResetErrorBody, "openRequestId" | "requestId"> = {},
): RedeemResetServiceResult {
	return { status, body: { error: ERROR_TEXT[reason], reason, ...extra } };
}

/**
 * The credit a new redemption names (KTD10): the soonest-expiring available
 * credit, credits that never expire last, ties broken by credit id.
 */
export function chooseRedeemCreditId(
	credits: CodexResetCreditRow[],
): string | null {
	let best: CodexResetCreditRow | null = null;
	for (const credit of credits) {
		if (credit.vanishedAt != null || credit.status !== "available") continue;
		if (best === null || redeemsBefore(credit, best)) best = credit;
	}
	return best?.creditId ?? null;
}

function redeemsBefore(a: CodexResetCreditRow, b: CodexResetCreditRow) {
	if (a.expiresAt !== b.expiresAt) {
		if (a.expiresAt == null) return false;
		if (b.expiresAt == null) return true;
		return a.expiresAt < b.expiresAt;
	}
	return a.creditId < b.creditId;
}

/** The available count a usage read carries, or null when it carries none. */
export function readAvailableCountFromUsage(data: unknown): number | null {
	const counts = readResetCreditCounts(data);
	return counts.present ? counts.availableCount : null;
}

function outcomeOf(row: CodexResetRedemptionRow): RedeemResetOutcome {
	switch (row.state) {
		case "done":
			return row.code !== null && SETTLED_OUTCOMES.has(row.code)
				? (row.code as RedeemResetOutcome)
				: "unclear";
		case "retryable":
			return "retry";
		case "refused":
			return "refused";
		case "abandoned":
			return row.code === "account_changed" ? "account_changed" : "abandoned";
		default:
			return "unclear";
	}
}

/**
 * KTD11: the count decides. A count that fell means a credit was spent. A
 * count that held means none was, except after OpenAI reported a reset,
 * when the count may simply not show the spend yet.
 */
function spendOf(row: CodexResetRedemptionRow): RedeemResetSpend | null {
	if (row.state !== "done") return null;
	if (row.availableBefore === null || row.availableAfter === null) {
		return "not_confirmed";
	}
	if (row.availableAfter < row.availableBefore) return "spent";
	return row.code === "nothing_to_reset" || row.code === "no_credit"
		? "not_spent"
		: "not_confirmed";
}

/** The endpoint's answer, built from the stored row only (KTD10). */
export function toRedeemResetResponse(
	row: CodexResetRedemptionRow,
): RedeemResetResponse {
	return {
		requestId: row.requestId,
		accountId: row.accountId,
		state: row.state,
		outcome: outcomeOf(row),
		windowsReset: row.windowsReset,
		spend: spendOf(row),
		availableBefore: row.availableBefore,
		availableAfter: row.availableAfter,
		requestedAt: row.requestedAt,
		completedAt: row.completedAt,
	};
}

function ok(row: CodexResetRedemptionRow): RedeemResetServiceResult {
	return { status: 200, body: toRedeemResetResponse(row) };
}

function isClosed(row: CodexResetRedemptionRow): boolean {
	return (
		row.state === "done" || row.state === "refused" || row.state === "abandoned"
	);
}

/**
 * Redeems one banked reset per request id under KTD8's table. Every answer
 * is built from the stored row; nothing OpenAI returned is passed through.
 */
export class CodexResetRedemptionService {
	constructor(private readonly deps: CodexResetRedemptionDeps) {}

	private get redemptions() {
		return this.deps.dbOps.getCodexResetRedemptionsRepository();
	}

	/** The caller has already checked the account exists and is Codex. */
	async redeem(
		accountId: string,
		requestId: string,
	): Promise<RedeemResetServiceResult> {
		const stored = await this.redemptions.findByRequestId(requestId);
		if (stored) return this.answerStored(stored, accountId);

		const open = await this.redemptions.findOpenForAccount(accountId);
		if (open) {
			return refuse(409, "open_request", { openRequestId: open.requestId });
		}

		const credits = this.deps.dbOps.getCodexResetCreditsRepository();
		const state = await credits.getState(accountId);
		const live = await credits.listCredits(accountId, {
			includeVanished: false,
		});
		const now = this.deps.now();
		if (!state) return refuse(409, "counts_stale");
		const assessment = assessBankedResets(state, live, now);
		if (assessment.stale) return refuse(409, "counts_stale");
		// Like OpenAI's Codex CLI, a held reset is enough to send. OpenAI's
		// applicable count is shown to the operator, not used as a gate: the
		// router's own capacity fence parks accounts below the point where
		// OpenAI would count a reset as applying, and OpenAI decides what a
		// consume resets (#772).
		if ((assessment.availableCount ?? 0) <= 0) {
			return refuse(409, "none_held");
		}
		if (!this.deps.hasRedeemer()) {
			return refuse(503, "not_sent", { requestId });
		}

		const inserted = await this.redemptions.insertPending({
			requestId,
			accountId,
			creditId: chooseRedeemCreditId(live),
			chatgptAccountHash: await this.deps.readChatGptAccountHash(accountId),
			availableBefore: assessment.availableCount,
			at: now,
		});
		switch (inserted.result) {
			case "created":
				return this.send(inserted.row, now);
			case "exists":
			case "conflict":
				// A concurrent request stored this id first.
				return this.answerStored(inserted.row, accountId);
			case "lost":
				return inserted.row
					? refuse(409, "open_request", {
							openRequestId: inserted.row.requestId,
						})
					: refuse(409, "in_progress", { requestId });
		}
	}

	private async answerStored(
		row: CodexResetRedemptionRow,
		accountId: string,
	): Promise<RedeemResetServiceResult> {
		if (row.accountId !== accountId) return refuse(409, "request_conflict");
		if (isClosed(row)) return ok(row);
		if (
			row.state === "pending" &&
			this.deps.now() - row.attemptedAt < IN_PROGRESS_MS
		) {
			return refuse(409, "in_progress", { requestId: row.requestId });
		}
		// An unclear or retryable answer, or a pending attempt that never
		// finished: resend the same id and credit, whatever the counts say.
		return this.resend(row);
	}

	private async resend(
		row: CodexResetRedemptionRow,
	): Promise<RedeemResetServiceResult> {
		if (!this.deps.hasRedeemer()) {
			return refuse(503, "not_sent", { requestId: row.requestId });
		}
		const at = this.deps.now();
		const claimed = await this.redemptions.claimResend(row.requestId, {
			expectedState: row.state,
			expectedAttemptedAt: row.attemptedAt,
			at,
		});
		if (claimed === 0) return this.answerWithoutSending(row.requestId);
		return this.send(row, at);
	}

	/** Another caller moved the row first: report where it stands, never send. */
	private async answerWithoutSending(
		requestId: string,
	): Promise<RedeemResetServiceResult> {
		const row = await this.redemptions.findByRequestId(requestId);
		if (row && isClosed(row)) return ok(row);
		return refuse(409, "in_progress", { requestId });
	}

	/** Send the attempt claimed at `attemptedAt`, then record what it learned. */
	private async send(
		row: CodexResetRedemptionRow,
		attemptedAt: number,
	): Promise<RedeemResetServiceResult> {
		const { requestId, accountId } = row;
		let dispatched: CodexResetRedeemDispatch;
		try {
			dispatched = await this.deps.dispatch(
				accountId,
				{ redeemRequestId: requestId, creditId: row.creditId },
				row.chatgptAccountHash,
			);
		} catch {
			// It may have reached OpenAI; the same id makes a retry safe.
			dispatched = { sent: true, result: { kind: "network" } };
		}

		if (!dispatched.sent) {
			log.warn(
				`Reset redemption ${requestId} for account ${accountId} was not sent (${dispatched.reason})`,
			);
			if (dispatched.reason === "account_changed") {
				return this.closeForChangedAccount(requestId, attemptedAt);
			}
			try {
				await this.redemptions.recordOutcome(requestId, {
					attemptedAt,
					state: "retryable",
					code: null,
					windowsReset: null,
					httpStatus: null,
					at: this.deps.now(),
				});
			} catch (error) {
				log.warn(
					`Reset redemption ${requestId}: could not mark the unsent attempt retryable: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return refuse(503, "not_sent", { requestId });
		}

		const outcome = classifyCodexResetConsume(dispatched.result);
		let recorded: number;
		try {
			recorded = await this.redemptions.recordOutcome(requestId, {
				attemptedAt,
				...outcome,
				at: this.deps.now(),
			});
		} catch (error) {
			// The row stays pending, so a retry after 60 seconds resends the same
			// id; never report the attempt as refused or settled.
			log.error(
				`Reset redemption ${requestId}: recording the outcome failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return ok({ ...row, state: "pending", attemptedAt });
		}
		if (recorded === 0) return this.answerWithoutSending(requestId);

		log.info(
			`Reset redemption ${requestId} for account ${accountId}: ${outcome.state}${outcome.code ? ` (${outcome.code})` : ""}`,
		);
		if (outcome.state === "done") {
			const landed = await this.recordCountAfter(accountId, requestId);
			if (landed && RESET_CODES.has(outcome.code)) {
				await this.releaseCooldown(accountId, requestId, attemptedAt);
			}
		}
		return ok(await this.storedRow(requestId));
	}

	/**
	 * The token now names a different ChatGPT account than the one the
	 * request was confirmed for. Nothing was sent; close the request so no
	 * retry ever sends it to the new account.
	 */
	private async closeForChangedAccount(
		requestId: string,
		attemptedAt: number,
	): Promise<RedeemResetServiceResult> {
		let recorded: number;
		try {
			recorded = await this.redemptions.recordOutcome(requestId, {
				attemptedAt,
				state: "abandoned",
				code: "account_changed",
				windowsReset: null,
				httpStatus: null,
				at: this.deps.now(),
			});
		} catch (error) {
			// The row stays pending; a later retry checks the account again.
			log.warn(
				`Reset redemption ${requestId}: could not close the request for a changed account: ${error instanceof Error ? error.message : String(error)}`,
			);
			return refuse(503, "not_sent", { requestId });
		}
		if (recorded === 0) return this.answerWithoutSending(requestId);
		return ok(await this.storedRow(requestId));
	}

	private async storedRow(requestId: string): Promise<CodexResetRedemptionRow> {
		const row = await this.redemptions.findByRequestId(requestId);
		if (!row) {
			throw new Error(
				`Reset redemption ${requestId} disappeared after its outcome was recorded`,
			);
		}
		return row;
	}

	/**
	 * Read usage again after the outcome is stored; keep the count it shows.
	 * Returns whether a read landed.
	 */
	private async recordCountAfter(
		accountId: string,
		requestId: string,
	): Promise<boolean> {
		const landed =
			(await settles(() => this.deps.refreshUsage(accountId))) ||
			(await settles(() => this.deps.refreshUsageManually(accountId)));
		if (!landed) return false;
		const after = this.deps.readAvailableCount(accountId);
		if (after === null) return true;
		try {
			await this.redemptions.recordAvailableAfter(requestId, after);
		} catch (error) {
			log.warn(
				`Reset redemption ${requestId}: could not store the count after: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return true;
	}

	/**
	 * OpenAI reported the limits cleared and the read after it shows room:
	 * lift the cooldown routing recorded before this attempt, so the account
	 * serves again without waiting out the old reset time.
	 */
	private async releaseCooldown(
		accountId: string,
		requestId: string,
		attemptedAt: number,
	): Promise<void> {
		try {
			if (!this.deps.hasCapacity(accountId)) return;
			await this.deps.releaseCooldown(accountId, attemptedAt);
		} catch (error) {
			log.warn(
				`Reset redemption ${requestId}: could not lift the account's earlier cooldown: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

async function settles(read: () => Promise<boolean>): Promise<boolean> {
	try {
		return await read();
	} catch {
		return false;
	}
}
