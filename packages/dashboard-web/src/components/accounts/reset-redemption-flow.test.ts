import { describe, expect, it } from "bun:test";
import type {
	BankedResets,
	RedeemResetErrorReason,
	RedeemResetOutcome,
	RedeemResetResponse,
	RedeemResetSpend,
} from "@better-ccflare/types";
import type { RedeemResetAnswer } from "../../lib/redeem-reset";
import {
	accountResetWindows,
	describeRedeemAnswer,
	formatWindowReset,
	openResetFlow,
	receiveAnswer,
	resetActionAvailability,
	startSending,
} from "./reset-redemption-flow";

const ID = "3f2b8c1e-7a4d-4b9e-9c21-5d6e7f8a9b0c";
const NEXT_ID = "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f";
const OPEN_ID = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const NOW = Date.UTC(2026, 10, 3, 12, 0);
const BANNED =
	/applies now|bonus|free|claim|(?<!al)ready|recommended|today|you can/i;

function result(
	overrides: Partial<RedeemResetResponse> = {},
): RedeemResetAnswer {
	return {
		kind: "result",
		response: {
			requestId: ID,
			accountId: "acc-1",
			state: "done",
			outcome: "reset",
			windowsReset: 2,
			spend: "spent",
			availableBefore: 2,
			availableAfter: 1,
			requestedAt: NOW,
			completedAt: NOW + 1_000,
			...overrides,
		},
	};
}

function refused(
	status: number,
	reason: RedeemResetErrorReason | null,
	extra: { message?: string; openRequestId?: string } = {},
): RedeemResetAnswer {
	return {
		kind: "error",
		status,
		reason,
		message: extra.message ?? null,
		openRequestId: extra.openRequestId ?? null,
	};
}

function allText(answer: RedeemResetAnswer): string {
	const view = describeRedeemAnswer(answer);
	return [...view.lines, view.counts ?? ""].join(" ");
}

describe("the request id a dialog sends", () => {
	it("is minted when the dialog opens and kept through every retry", () => {
		const opened = openResetFlow(() => ID);
		expect(opened).toEqual({ requestId: ID, phase: "confirm", answer: null });

		const sending = startSending(opened);
		expect(sending).toEqual({ requestId: ID, phase: "sending", answer: null });

		for (const answer of [
			refused(503, "not_sent"),
			refused(409, "in_progress"),
			refused(409, "counts_stale"),
			refused(500, null),
			refused(401, null),
			{ kind: "no_answer" } as const,
			result({ state: "unknown", outcome: "unclear", spend: null }),
			result({ state: "retryable", outcome: "retry", spend: null }),
		]) {
			const answered = receiveAnswer(sending, answer);
			expect(answered.requestId).toBe(ID);
			expect(answered.phase).toBe("answered");
			expect(answered.answer).toEqual(answer);
			expect(startSending(answered).requestId).toBe(ID);
		}
	});

	it("adopts the open request id a 409 names, so the retry finishes that request", () => {
		const answered = receiveAnswer(
			startSending(openResetFlow(() => ID)),
			refused(409, "open_request", { openRequestId: OPEN_ID }),
		);
		expect(answered.requestId).toBe(OPEN_ID);
		expect(startSending(answered).requestId).toBe(OPEN_ID);
	});

	it("is new for each opening of the dialog", () => {
		const ids = [ID, NEXT_ID];
		const mint = () => ids.shift() ?? "";
		expect(openResetFlow(mint).requestId).toBe(ID);
		expect(openResetFlow(mint).requestId).toBe(NEXT_ID);
	});
});

describe("describeRedeemAnswer: what happened (R12)", () => {
	const sentences: Array<[RedeemResetOutcome, RegExp]> = [
		["reset", /OpenAI reset this account's usage windows/],
		["already_redeemed", /already redeemed by an earlier attempt/i],
		["nothing_to_reset", /OpenAI says there was nothing to reset/],
		["no_credit", /no reset is left.*Refresh usage/],
	];

	it.each(sentences)("says what %s means in plain words", (outcome, words) => {
		expect(allText(result({ outcome }))).toMatch(words);
	});

	it("takes the spend from the count, not the reply (KTD11)", () => {
		const spend: Array<[RedeemResetSpend, RegExp]> = [
			["spent", /A credit was spent/],
			["not_spent", /No credit was spent/],
			["not_confirmed", /Not confirmed yet whether a credit was spent/],
		];
		for (const [value, words] of spend) {
			expect(
				allText(result({ outcome: "nothing_to_reset", spend: value })),
			).toMatch(words);
		}
		// "Nothing to reset" with a falling count still says a credit was spent.
		const text = allText(
			result({ outcome: "nothing_to_reset", spend: "spent" }),
		);
		expect(text).not.toMatch(/No credit was spent/);
	});

	it("shows the count before and after when both are known", () => {
		expect(describeRedeemAnswer(result()).counts).toBe(
			"Banked resets: 2 before, 1 after.",
		);
		expect(
			describeRedeemAnswer(result({ availableAfter: null })).counts,
		).toBeNull();
	});

	it("offers no retry once the request is closed", () => {
		for (const outcome of [
			"reset",
			"already_redeemed",
			"nothing_to_reset",
			"no_credit",
		] as const) {
			expect(describeRedeemAnswer(result({ outcome })).canRetry).toBe(false);
		}
	});

	it("says an unclear answer is safe to retry with the same request", () => {
		const view = describeRedeemAnswer(
			result({ state: "unknown", outcome: "unclear", spend: null }),
		);
		expect(view.lines.join(" ")).toMatch(/unclear.*Trying again is safe/);
		expect(view.canRetry).toBe(true);
	});

	it("asks for a later retry when OpenAI asked for one", () => {
		const view = describeRedeemAnswer(
			result({ state: "retryable", outcome: "retry", spend: null }),
		);
		expect(view.lines.join(" ")).toMatch(
			/OpenAI asked the router to try again/,
		);
		expect(view.canRetry).toBe(true);
	});

	it("points a refusal to /usage in the Codex CLI and offers no retry", () => {
		const view = describeRedeemAnswer(
			result({ state: "refused", outcome: "refused", spend: null }),
		);
		expect(view.lines.join(" ")).toContain(
			"OpenAI refused the router's request",
		);
		expect(view.showsCliPointer).toBe(true);
		expect(view.canRetry).toBe(false);
		expect(describeRedeemAnswer(result()).showsCliPointer).toBe(false);
	});

	it("says a merged-away request has an unknown outcome", () => {
		const view = describeRedeemAnswer(
			result({ state: "abandoned", outcome: "abandoned", spend: null }),
		);
		expect(view.lines.join(" ")).toMatch(/merged.*not known/);
		expect(view.canRetry).toBe(false);
	});
});

describe("describeRedeemAnswer: answers that sent nothing or got no reply", () => {
	const cases: Array<[string, RedeemResetAnswer, RegExp, boolean]> = [
		["409 in_progress", refused(409, "in_progress"), /still being sent/, true],
		[
			"409 open_request",
			refused(409, "open_request", { openRequestId: OPEN_ID }),
			/earlier request on this account has not finished/,
			true,
		],
		[
			"409 not_applicable",
			refused(409, "not_applicable"),
			/would not help.*Nothing was sent/,
			false,
		],
		[
			"409 counts_stale",
			refused(409, "counts_stale"),
			/too old.*Nothing was sent/,
			true,
		],
		[
			"409 request_conflict",
			refused(409, "request_conflict"),
			/different account/,
			false,
		],
		[
			"503 not_sent",
			refused(503, "not_sent"),
			/Nothing was sent to OpenAI/,
			true,
		],
		[
			"401 without a reason",
			refused(401, null),
			/did not accept the dashboard key/,
			true,
		],
		[
			"500 with the server's message",
			refused(500, null, { message: "The redemption could not be completed." }),
			/could not be completed.*Trying again is safe/,
			true,
		],
		[
			"500 without a body",
			refused(500, null),
			/could not finish.*Trying again is safe/,
			true,
		],
		[
			"400 not_codex",
			refused(400, "not_codex", {
				message: "Only Codex subscription accounts hold banked resets.",
			}),
			/Only Codex subscription accounts/,
			false,
		],
		[
			"no answer at all",
			{ kind: "no_answer" },
			/No answer reached the dashboard.*safe/,
			true,
		],
	];

	it.each(cases)("%s", (_label, answer, words, canRetry) => {
		const view = describeRedeemAnswer(answer);
		expect(view.lines.join(" ")).toMatch(words);
		expect(view.canRetry).toBe(canRetry);
		expect(view.counts).toBeNull();
	});
});

describe("dialog copy", () => {
	it("never reads as a prompt to spend", () => {
		const outcomes: RedeemResetOutcome[] = [
			"reset",
			"already_redeemed",
			"nothing_to_reset",
			"no_credit",
			"unclear",
			"retry",
			"refused",
			"abandoned",
		];
		const reasons: RedeemResetErrorReason[] = [
			"in_progress",
			"open_request",
			"not_applicable",
			"counts_stale",
			"request_conflict",
			"not_sent",
		];
		for (const outcome of outcomes) {
			for (const spend of [
				"spent",
				"not_spent",
				"not_confirmed",
				null,
			] as const) {
				expect(allText(result({ outcome, spend }))).not.toMatch(BANNED);
			}
		}
		for (const reason of reasons) {
			expect(allText(refused(409, reason))).not.toMatch(BANNED);
		}
		expect(allText({ kind: "no_answer" })).not.toMatch(BANNED);
	});
});

describe("resetActionAvailability (R8)", () => {
	const held: BankedResets = {
		tracked: true,
		availableCount: 2,
		applicableCount: 2,
		soonestExpiresAt: NOW + 86_400_000,
		doesNotExpire: false,
		appliesNow: true,
		stale: false,
		observedAt: NOW,
	};

	it("is enabled only when OpenAI says a reset would help and the count is fresh", () => {
		expect(resetActionAvailability(held)).toEqual({
			shown: true,
			enabled: true,
			note: null,
		});
	});

	it("is shown but disabled when no reset would help; the status line says why", () => {
		expect(resetActionAvailability({ ...held, appliesNow: false })).toEqual({
			shown: true,
			enabled: false,
			note: null,
		});
	});

	it("is disabled with a reason while the count is stale, as the server would refuse it", () => {
		for (const appliesNow of [true, false]) {
			expect(
				resetActionAvailability({ ...held, appliesNow, stale: true }),
			).toEqual({
				shown: true,
				enabled: false,
				note: "Use reset needs a fresh count.",
			});
		}
	});

	it("is not shown when no reset is held or the count is unknown", () => {
		for (const resets of [
			{ ...held, availableCount: 0 },
			{ ...held, availableCount: null },
			{ ...held, tracked: false },
		]) {
			expect(resetActionAvailability(resets).shown).toBe(false);
			expect(resetActionAvailability(resets).enabled).toBe(false);
		}
	});
});

describe("accountResetWindows (KTD12)", () => {
	const FIVE = "2026-11-03T15:30:00.000Z";
	const WEEK = "2026-11-09T14:00:00.000Z";

	it("lists the windows this account reports, with their reset times", () => {
		expect(
			accountResetWindows({
				five_hour: { utilization: 40, resets_at: FIVE },
				seven_day: { utilization: 70, resets_at: WEEK },
			}),
		).toEqual([
			{ label: "5-hour", resetsAt: Date.parse(FIVE) },
			{ label: "Weekly", resetsAt: Date.parse(WEEK) },
		]);
	});

	it("lists only the weekly window when that is all the account reports", () => {
		expect(
			accountResetWindows({ seven_day: { utilization: 70, resets_at: WEEK } }),
		).toEqual([{ label: "Weekly", resetsAt: Date.parse(WEEK) }]);
	});

	it("leaves out windows without a reset time and accounts without usage", () => {
		expect(
			accountResetWindows({
				five_hour: { utilization: null, resets_at: FIVE },
				seven_day: { utilization: 70, resets_at: null },
			}),
		).toEqual([]);
		expect(accountResetWindows(null)).toEqual([]);
		expect(accountResetWindows(undefined)).toEqual([]);
	});

	it("formats a reset time in UTC with a countdown", () => {
		expect(formatWindowReset(Date.parse(WEEK), NOW)).toBe(
			"Nov 9, 14:00 UTC (in 6d 2h)",
		);
		expect(formatWindowReset(NOW - 60_000, NOW)).toBe("Nov 3, 11:59 UTC");
	});
});
