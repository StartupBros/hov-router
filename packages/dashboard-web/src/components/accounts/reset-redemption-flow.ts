import type {
	AnthropicUsageData,
	BankedResets,
	CodexResetRedemptionState,
	RedeemResetResponse,
	RedeemResetSpend,
} from "@better-ccflare/types";
import { formatRelativeReset } from "../../lib/pool-usage";
import {
	mintRedeemRequestId,
	type RedeemResetAnswer,
} from "../../lib/redeem-reset";
import { formatBankedResetObserved } from "./BankedResetsSummary";
import { collectAnthropicUsageRows, displayLabel } from "./rate-limit-helpers";

/**
 * One opening of the Use reset confirmation. The request id is minted when it
 * opens and sent on every attempt, so a retry can never spend a second reset;
 * only a 409 naming another open request on the account replaces it (KTD8).
 */
export interface ResetFlowState {
	requestId: string;
	phase: "confirm" | "sending" | "answered";
	answer: RedeemResetAnswer | null;
}

export function openResetFlow(
	mint: () => string = () => mintRedeemRequestId(),
): ResetFlowState {
	return { requestId: mint(), phase: "confirm", answer: null };
}

export function startSending(state: ResetFlowState): ResetFlowState {
	return { ...state, phase: "sending", answer: null };
}

export function receiveAnswer(
	state: ResetFlowState,
	answer: RedeemResetAnswer,
): ResetFlowState {
	const adopted =
		answer.kind === "error" &&
		answer.reason === "open_request" &&
		answer.openRequestId !== null
			? answer.openRequestId
			: state.requestId;
	return { requestId: adopted, phase: "answered", answer };
}

export interface RedeemAnswerView {
	lines: string[];
	/** "Banked resets: 2 before, 1 after." when both counts are known. */
	counts: string | null;
	/** True when sending the same request again could still finish it. */
	canRetry: boolean;
	/** True when the dialog should point to /usage in the Codex CLI. */
	showsCliPointer: boolean;
}

const SAFE_RETRY =
	"Trying again is safe: it reuses this request, so it cannot spend a second reset.";

/** Requests in these states stay open: only the same request id can close them. */
const OPEN_STATES: ReadonlySet<CodexResetRedemptionState> = new Set([
	"pending",
	"unknown",
	"retryable",
]);

const SPEND_SENTENCE: Record<RedeemResetSpend, string> = {
	spent: "A credit was spent.",
	not_spent: "No credit was spent.",
	not_confirmed:
		"Not confirmed yet whether a credit was spent. Refresh usage to see the current count.",
};

function outcomeSentence(response: RedeemResetResponse): string {
	switch (response.outcome) {
		case "reset":
			return "OpenAI reset this account's usage windows.";
		case "already_redeemed":
			return "OpenAI says this request was already redeemed by an earlier attempt.";
		case "nothing_to_reset":
			return "OpenAI says there was nothing to reset on this account.";
		case "no_credit":
			return "OpenAI says no reset is left on this account. Refresh usage to see the current count.";
		case "unclear":
			return `The outcome is unclear. ${SAFE_RETRY}`;
		case "retry":
			return `OpenAI asked the router to try again later. Nothing is known to be spent. ${SAFE_RETRY}`;
		case "refused":
			return "OpenAI refused the router's request. Nothing is known to be spent.";
		case "abandoned":
			return "This request was closed when its account was merged into another, so its outcome is not known.";
		case "account_changed":
			return "This account now signs in to a different ChatGPT account, so this request was closed and nothing was sent. Open Use reset again to confirm for the current account.";
	}
}

function describeResult(response: RedeemResetResponse): RedeemAnswerView {
	const lines = [outcomeSentence(response)];
	if (response.spend !== null) lines.push(SPEND_SENTENCE[response.spend]);
	const { availableBefore, availableAfter } = response;
	return {
		lines,
		counts:
			availableBefore !== null && availableAfter !== null
				? `Banked resets: ${availableBefore} before, ${availableAfter} after.`
				: null,
		canRetry: OPEN_STATES.has(response.state),
		showsCliPointer: response.outcome === "refused",
	};
}

function errorView(line: string, canRetry: boolean): RedeemAnswerView {
	return { lines: [line], counts: null, canRetry, showsCliPointer: false };
}

/** What the dialog says about one answer, in the words R12 requires. */
export function describeRedeemAnswer(
	answer: RedeemResetAnswer,
): RedeemAnswerView {
	if (answer.kind === "result") return describeResult(answer.response);
	if (answer.kind === "no_answer") {
		return errorView(
			`No answer reached the dashboard. The request may still have reached OpenAI. ${SAFE_RETRY}`,
			true,
		);
	}

	const { status, reason, message } = answer;
	switch (reason) {
		case "in_progress":
			return errorView(
				"This request is still being sent to OpenAI. Wait a moment, then try again; it reuses this request.",
				true,
			);
		case "open_request":
			return errorView(
				"An earlier request on this account has not finished. Trying again finishes that request instead of starting a new one.",
				true,
			);
		case "none_held":
			return errorView(
				"OpenAI reports no banked reset on this account. Nothing was sent.",
				false,
			);
		case "counts_stale":
			return errorView(
				"The banked-reset count is too old to rely on. Nothing was sent. Refresh usage, then try again.",
				true,
			);
		case "request_conflict":
			return errorView(
				"This request id was used for a different account. Nothing was sent. Close this and open Use reset again.",
				false,
			);
		case "not_sent":
			return errorView(`Nothing was sent to OpenAI. ${SAFE_RETRY}`, true);
	}

	if (status === 401) {
		return errorView(
			"The router did not accept the dashboard key. Sign in, then try again; it reuses this request.",
			true,
		);
	}
	if (status >= 500) {
		return errorView(
			`${message ?? "The router could not finish the request."} ${SAFE_RETRY}`,
			true,
		);
	}
	return errorView(
		message ?? `The router rejected the request (HTTP ${status}).`,
		false,
	);
}

export interface ResetActionAvailability {
	shown: boolean;
	enabled: boolean;
	/** Why the button is disabled, when the status line does not already say. */
	note: string | null;
}

/**
 * Whether the account card offers Use reset (R8). It is shown whenever the
 * account holds a reset, and enabled on any fresh count, which is when the
 * router would send it. OpenAI's applicable count does not gate it: the
 * Codex CLI offers Redeem reset on the held count alone, and OpenAI decides
 * what a consume resets (#772).
 */
export function resetActionAvailability(
	resets: BankedResets,
): ResetActionAvailability {
	// The same test as bankedResetsRowState's "applicable" and "not_applicable" kinds.
	const holdsResets =
		resets.tracked &&
		resets.availableCount !== null &&
		resets.availableCount > 0;
	if (!holdsResets) return { shown: false, enabled: false, note: null };
	if (resets.stale) {
		return {
			shown: true,
			enabled: false,
			note: "Use reset needs a fresh count.",
		};
	}
	return { shown: true, enabled: true, note: null };
}

/**
 * What OpenAI said about whether a reset would help, when it did not say
 * one would. Null when OpenAI counts a held reset as applying now.
 */
export function applicabilitySentence(resets: BankedResets): string | null {
	if (resets.appliesNow) return null;
	return resets.applicableCount === null
		? "OpenAI did not say whether a reset would help this account right now."
		: "OpenAI does not expect a reset to help this account right now.";
}

export interface ResetWindow {
	label: string;
	resetsAt: number;
}

/**
 * The usage windows this account reports, with the time each resets without
 * a banked reset (KTD12). Windows with no usage or no reset time are left out.
 */
export function accountResetWindows(
	usage: AnthropicUsageData | null | undefined,
): ResetWindow[] {
	if (!usage) return [];
	return collectAnthropicUsageRows(usage, {
		utilization: null,
		resetTime: null,
	}).flatMap((row) => {
		if (row.utilization === null || row.resetTime === null) return [];
		const resetsAt = Date.parse(row.resetTime);
		return Number.isFinite(resetsAt)
			? [{ label: displayLabel(row), resetsAt }]
			: [];
	});
}

/** "Nov 9, 14:00 UTC (in 6d 2h)"; a time already passed has no countdown. */
export function formatWindowReset(atMs: number, now: number): string {
	const when = formatBankedResetObserved(atMs);
	const countdown = formatRelativeReset(atMs, now);
	return countdown ? `${when} (${countdown})` : when;
}
