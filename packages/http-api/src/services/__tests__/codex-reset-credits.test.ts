import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseOperations } from "@better-ccflare/database";
import type {
	CodexResetCredit,
	CodexResetCreditListResult,
} from "@better-ccflare/providers";
import {
	assessBankedResets,
	CodexResetCreditObserver,
} from "../codex-reset-credits";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Grant times shaped like the 2026-11-02 capture: two waves about 26 hours
// apart, each spread over a few minutes across accounts.
const WAVE_ONE = Date.parse("2026-10-31T20:04:05.410Z");
const WAVE_TWO = WAVE_ONE + 26 * HOUR;
const START = Date.parse("2026-11-02T12:00:00.000Z");

function credit(
	id: string,
	grantedAt: number,
	overrides: Partial<CodexResetCredit> = {},
): CodexResetCredit {
	return {
		id,
		resetType: "rate_limit",
		status: "available",
		grantedAt,
		expiresAt: grantedAt + 30 * DAY,
		title: "Rate limit reset",
		description: "Resets your usage limits",
		...overrides,
	};
}

function listed(
	credits: CodexResetCredit[],
	chatgptAccountId = "chatgpt-user-a",
): CodexResetCreditListResult {
	return {
		ok: true,
		credits,
		availableCount: credits.filter((c) => c.status === "available").length,
		chatgptAccountId,
	};
}

const FAILED: CodexResetCreditListResult = {
	ok: false,
	reason: "http",
	status: 500,
};

function counts(available: number | null, applicable: number | null) {
	return {
		reset_credits_available_count: available,
		reset_credits_applicable_count: applicable,
		reset_credits_present: true,
	};
}

async function seedAccount(dbOps: DatabaseOperations, id: string) {
	await dbOps
		.getAdapter()
		.run(`INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)`, [
			id,
			`synthetic-${id}`,
			0,
		]);
}

describe("CodexResetCreditObserver", () => {
	let dbOps: DatabaseOperations;
	let clock: number;
	let reads: string[];
	let answers: Map<string, CodexResetCreditListResult[]>;
	let observer: CodexResetCreditObserver;

	const answer = (
		accountId: string,
		...results: CodexResetCreditListResult[]
	) => answers.set(accountId, [...(answers.get(accountId) ?? []), ...results]);

	const repo = () => dbOps.getCodexResetCreditsRepository();

	beforeEach(async () => {
		dbOps = new DatabaseOperations(":memory:", { walMode: false });
		clock = START;
		reads = [];
		answers = new Map();
		observer = new CodexResetCreditObserver(
			dbOps,
			async (accountId) => {
				reads.push(accountId);
				const queue = answers.get(accountId) ?? [];
				const next = queue.shift();
				if (!next) throw new Error(`no scripted list answer for ${accountId}`);
				return next;
			},
			() => clock,
		);
		for (const id of ["acct-1", "acct-2", "acct-3"]) {
			await seedAccount(dbOps, id);
		}
	});

	afterEach(async () => {
		await dbOps.dispose();
	});

	it("baselines the capture's six credits in two waves on the first successful read", async () => {
		answer(
			"acct-1",
			listed([credit("c1a", WAVE_ONE), credit("c1b", WAVE_TWO)], "user-1"),
		);
		answer(
			"acct-2",
			listed(
				[
					credit("c2a", WAVE_ONE + 9 * MINUTE),
					credit("c2b", WAVE_TWO + 11 * MINUTE),
				],
				"user-2",
			),
		);
		answer(
			"acct-3",
			listed(
				[
					credit("c3a", WAVE_ONE + 14 * MINUTE),
					credit("c3b", WAVE_TWO + 15 * MINUTE),
				],
				"user-3",
			),
		);

		for (const id of ["acct-1", "acct-2", "acct-3"]) {
			await observer.observeUsageData(id, counts(2, 2));
		}

		const live = await repo().listLiveCredits();
		expect(live).toHaveLength(6);
		expect(live.every((c) => c.isBaseline)).toBe(true);
		const waves = new Set(live.map((c) => c.waveId));
		expect(waves).toEqual(
			new Set(["codex:2026-10-31T20:04Z", "codex:2026-11-01T22:04Z"]),
		);
		const state = await repo().getState("acct-1");
		expect(state?.baselineAt).toBe(START);
		expect(state?.lastListSuccessAt).toBe(START);
		expect(state?.availableCount).toBe(2);
		expect(state?.applicableCount).toBe(2);
	});

	it("reads the list when a count changes and not while counts hold inside six hours", async () => {
		answer("acct-1", listed([credit("c1", WAVE_ONE), credit("c2", WAVE_TWO)]));
		await observer.observeUsageData("acct-1", counts(2, 2));
		expect(reads).toHaveLength(1);

		clock += 5 * HOUR;
		await observer.observeUsageData("acct-1", counts(2, 2));
		expect(reads).toHaveLength(1);

		answer("acct-1", listed([credit("c1", WAVE_ONE), credit("c2", WAVE_TWO)]));
		await observer.observeUsageData("acct-1", counts(2, 0));
		expect(reads).toHaveLength(2);
	});

	it("re-reads after six hours of unchanged counts and records a swapped credit", async () => {
		answer("acct-1", listed([credit("c1", WAVE_ONE), credit("c2", WAVE_TWO)]));
		await observer.observeUsageData("acct-1", counts(2, 2));

		const laterGrant = START + 6 * HOUR;
		clock = START + 6 * HOUR + MINUTE;
		answer(
			"acct-1",
			listed([credit("c1", WAVE_ONE), credit("c3", laterGrant)]),
		);
		await observer.observeUsageData("acct-1", counts(2, 2));

		expect(reads).toHaveLength(2);
		const all = await repo().listCredits("acct-1", { includeVanished: true });
		const byId = new Map(all.map((c) => [c.creditId, c]));
		expect(byId.get("c2")?.vanishedAt).toBe(clock);
		expect(byId.get("c2")?.vanishReason).toBe("redeemed_elsewhere");
		expect(byId.get("c3")?.isBaseline).toBe(false);
		expect(byId.get("c3")?.firstSeenAt).toBe(clock);
		expect(byId.get("c3")?.waveId).toBe(
			`codex:${new Date(laterGrant).toISOString().slice(0, 16)}Z`,
		);
	});

	it("records a credit leaving before its expiry as redeemed elsewhere and one leaving after as expired", async () => {
		const shortLived = credit("short", WAVE_ONE, { expiresAt: START + HOUR });
		answer(
			"acct-1",
			listed([shortLived, credit("keep", WAVE_TWO), credit("used", WAVE_TWO)]),
		);
		await observer.observeUsageData("acct-1", counts(3, 3));

		// The soonest stored expiry has passed: re-read without waiting six hours,
		// even though the count still reads 3.
		clock = START + HOUR + MINUTE;
		answer("acct-1", listed([credit("keep", WAVE_TWO)]));
		await observer.observeUsageData("acct-1", counts(3, 3));

		expect(reads).toHaveLength(2);
		const all = await repo().listCredits("acct-1", { includeVanished: true });
		const reason = (id: string) =>
			all.find((c) => c.creditId === id)?.vanishReason;
		expect(reason("short")).toBe("expired");
		expect(reason("used")).toBe("redeemed_elsewhere");
		expect(reason("keep")).toBeNull();
	});

	it("keeps the last known values after a failed read and marks them stale after twelve hours", async () => {
		answer("acct-1", listed([credit("c1", WAVE_ONE), credit("c2", WAVE_TWO)]));
		await observer.observeUsageData("acct-1", counts(2, 2));

		clock += HOUR;
		answer("acct-1", FAILED);
		await observer.observeUsageData("acct-1", counts(1, 1));
		expect(reads).toHaveLength(2);

		// Retried no sooner than 15 minutes later while the counts hold.
		clock += 5 * MINUTE;
		await observer.observeUsageData("acct-1", counts(1, 1));
		expect(reads).toHaveLength(2);

		const failedAt = START + HOUR;
		const live = await repo().listCredits("acct-1", { includeVanished: false });
		expect(live.map((c) => c.creditId).sort()).toEqual(["c1", "c2"]);

		const viewAt = async (at: number) => {
			const state = await repo().getState("acct-1");
			if (!state) throw new Error("missing state");
			// Fresh counts keep arriving; only the list keeps failing.
			return assessBankedResets(
				{ ...state, countsObservedAt: at - MINUTE },
				live,
				at,
			);
		};
		const early = await viewAt(failedAt + 11 * HOUR);
		expect(early.stale).toBe(false);
		const late = await viewAt(failedAt + 13 * HOUR);
		expect(late.stale).toBe(true);
		expect(late.availableCount).toBe(1);
		expect(late.applicableCount).toBe(1);

		clock = failedAt + 16 * MINUTE;
		answer("acct-1", listed([credit("c1", WAVE_ONE)]));
		await observer.observeUsageData("acct-1", counts(1, 1));
		expect(reads).toHaveLength(3);
		expect((await repo().getState("acct-1"))?.listFailingSince).toBeNull();
	});

	it("marks credits account_changed and baselines again when the ChatGPT account changes", async () => {
		answer("acct-1", listed([credit("old", WAVE_ONE)], "user-a"));
		await observer.observeUsageData("acct-1", counts(1, 1));

		clock += 7 * HOUR;
		answer("acct-1", listed([credit("new", WAVE_TWO)], "user-b"));
		await observer.observeUsageData("acct-1", counts(1, 1));

		const all = await repo().listCredits("acct-1", { includeVanished: true });
		const old = all.find((c) => c.creditId === "old");
		const fresh = all.find((c) => c.creditId === "new");
		expect(old?.vanishReason).toBe("account_changed");
		expect(fresh?.isBaseline).toBe(true);
		expect((await repo().getState("acct-1"))?.baselineAt).toBe(clock);
	});

	it("makes one list read for two concurrent observations of one account", async () => {
		let release: (value: CodexResetCreditListResult) => void = () => {};
		const pending = new Promise<CodexResetCreditListResult>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const gated = new CodexResetCreditObserver(
			dbOps,
			async () => {
				calls++;
				return pending;
			},
			() => clock,
		);

		const first = gated.observeUsageData("acct-1", counts(2, 2));
		const second = gated.observeUsageData("acct-1", counts(2, 1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		release(listed([credit("c1", WAVE_ONE), credit("c2", WAVE_TWO)]));
		await Promise.all([first, second]);

		expect(calls).toBe(1);
		// The call that arrived during the read still recorded its counts.
		const state = await repo().getState("acct-1");
		expect(state?.applicableCount).toBe(1);
	});

	it("groups grants 17 minutes apart on three accounts into one wave and 26 hours apart into two", async () => {
		answer("acct-1", listed([credit("a", WAVE_ONE)], "user-1"));
		answer("acct-2", listed([credit("b", WAVE_ONE + 8 * MINUTE)], "user-2"));
		answer("acct-3", listed([credit("c", WAVE_ONE + 17 * MINUTE)], "user-3"));
		for (const id of ["acct-1", "acct-2", "acct-3"]) {
			await observer.observeUsageData(id, counts(1, 1));
		}
		answer(
			"acct-1",
			listed(
				[credit("a", WAVE_ONE), credit("d", WAVE_ONE + 26 * HOUR)],
				"user-1",
			),
		);
		await observer.observeUsageData("acct-1", counts(2, 2));

		const live = await repo().listLiveCredits();
		const wave = (id: string) => live.find((c) => c.creditId === id)?.waveId;
		expect(wave("a")).toBe("codex:2026-10-31T20:04Z");
		expect(wave("b")).toBe(wave("a"));
		expect(wave("c")).toBe(wave("a"));
		expect(wave("d")).toBe("codex:2026-11-01T22:04Z");
	});

	it("ignores snapshots from other providers", async () => {
		await observer.observeSnapshot({
			accountId: "acct-1",
			provider: "anthropic",
			data: counts(2, 2),
		});
		expect(reads).toHaveLength(0);
		expect(await repo().getState("acct-1")).toBeNull();
	});

	it("records a poll without the credit fields and does not read the list", async () => {
		await observer.observeSnapshot({
			accountId: "acct-1",
			provider: "codex",
			data: { five_hour: null },
		});
		expect(reads).toHaveLength(0);
		const state = await repo().getState("acct-1");
		expect(state?.countsPresent).toBe(false);
		expect(state?.availableCount).toBeNull();
	});
});

describe("assessBankedResets", () => {
	const now = START;
	const baseState = {
		accountId: "acct-1",
		availableCount: 2,
		applicableCount: 2,
		countsPresent: true,
		countsObservedAt: now - MINUTE,
		listedAvailableCount: 2,
		listedApplicableCount: 2,
		lastListSuccessAt: now - HOUR,
		lastListAttemptAt: now - HOUR,
		listFailingSince: null,
		baselineAt: now - DAY,
		chatgptAccountHash: "hash",
		updatedAt: now - MINUTE,
	};
	const row = (
		creditId: string,
		expiresAt: number | null,
		status = "available",
	) => ({
		accountId: "acct-1",
		creditId,
		resetType: null,
		status,
		grantedAt: WAVE_ONE,
		expiresAt,
		title: null,
		description: null,
		firstSeenAt: now - DAY,
		lastSeenAt: now - HOUR,
		isBaseline: true,
		waveId: "codex:2026-10-31T20:04Z",
		vanishedAt: null,
		vanishReason: null,
	});

	it("takes the soonest expiry from available credits only, with no-expiry credits last", () => {
		const view = assessBankedResets(
			baseState,
			[
				row("never", null),
				row("later", now + 5 * DAY),
				row("sooner", now + 2 * DAY),
				row("odd", now + DAY, "frozen"),
			],
			now,
		);
		expect(view.soonestExpiresAt).toBe(now + 2 * DAY);
		expect(view.doesNotExpire).toBe(false);
		expect(view.stale).toBe(false);
	});

	it("says a reset does not expire when every available credit lacks an expiry", () => {
		const view = assessBankedResets(baseState, [row("never", null)], now);
		expect(view.soonestExpiresAt).toBeNull();
		expect(view.doesNotExpire).toBe(true);
	});

	it("is stale when counts are older than ten minutes or the poll lacked the fields", () => {
		expect(
			assessBankedResets(
				{ ...baseState, countsObservedAt: now - 11 * MINUTE },
				[],
				now,
			).stale,
		).toBe(true);
		expect(
			assessBankedResets({ ...baseState, countsPresent: false }, [], now).stale,
		).toBe(true);
	});
});
