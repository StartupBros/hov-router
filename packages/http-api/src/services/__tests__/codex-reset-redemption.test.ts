import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type CodexResetCreditRow,
	DatabaseOperations,
} from "@better-ccflare/database";
import type { CodexResetConsumeRequest } from "@better-ccflare/providers";
import type { CodexResetRedeemDispatch } from "@better-ccflare/proxy";
import {
	CodexResetRedemptionService,
	chooseRedeemCreditId,
	readAvailableCountFromUsage,
} from "../codex-reset-redemption";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
const START = Date.parse("2026-11-03T12:00:00.000Z");
const ACCOUNT = "acct-1";
const OTHER_ACCOUNT = "acct-2";

function answered(
	code: string | null,
	windowsReset: number | null = 1,
): CodexResetRedeemDispatch {
	return {
		sent: true,
		result: { kind: "answered", status: 200, code, windowsReset },
	};
}

function creditRow(
	creditId: string,
	expiresAt: number | null,
	overrides: Partial<CodexResetCreditRow> = {},
): CodexResetCreditRow {
	return {
		accountId: ACCOUNT,
		creditId,
		resetType: "rate_limit",
		status: "available",
		grantedAt: START - DAY,
		expiresAt,
		title: null,
		description: null,
		firstSeenAt: START - DAY,
		lastSeenAt: START - DAY,
		isBaseline: true,
		waveId: null,
		vanishedAt: null,
		vanishReason: null,
		...overrides,
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

describe("chooseRedeemCreditId", () => {
	it("picks the soonest-expiring available credit, no-expiry last, ties by id", () => {
		expect(
			chooseRedeemCreditId([
				creditRow("never", null),
				creditRow("later", START + 20 * DAY),
				creditRow("b-sooner", START + 5 * DAY),
				creditRow("a-sooner", START + 5 * DAY),
			]),
		).toBe("a-sooner");
		expect(
			chooseRedeemCreditId([creditRow("z", null), creditRow("y", null)]),
		).toBe("y");
	});

	it("skips vanished and unavailable credits and returns null when none is left", () => {
		expect(
			chooseRedeemCreditId([
				creditRow("gone", START + DAY, { vanishedAt: START }),
				creditRow("used", START + DAY, { status: "redeemed" }),
				creditRow("left", START + 9 * DAY),
			]),
		).toBe("left");
		expect(
			chooseRedeemCreditId([
				creditRow("gone", START + DAY, { vanishedAt: START }),
			]),
		).toBeNull();
		expect(chooseRedeemCreditId([])).toBeNull();
	});
});

describe("readAvailableCountFromUsage", () => {
	it("reads the available count only when the usage says reset credits are present", () => {
		expect(
			readAvailableCountFromUsage({
				reset_credits_present: true,
				reset_credits_available_count: 3,
			}),
		).toBe(3);
		expect(
			readAvailableCountFromUsage({
				reset_credits_present: false,
				reset_credits_available_count: 3,
			}),
		).toBeNull();
		expect(
			readAvailableCountFromUsage({
				reset_credits_present: true,
				reset_credits_available_count: -1,
			}),
		).toBeNull();
		expect(readAvailableCountFromUsage(null)).toBeNull();
	});
});

describe("CodexResetRedemptionService", () => {
	let dbOps: DatabaseOperations;
	let clock: number;
	let redeemerPresent: boolean;
	let dispatches: Array<{
		accountId: string;
		request: CodexResetConsumeRequest;
	}>;
	let nextDispatch: () => Promise<CodexResetRedeemDispatch>;
	let refreshes: string[];
	let autoRefresh: () => Promise<boolean>;
	let manualRefresh: () => Promise<boolean>;
	let cachedAvailable: number | null;
	let service: CodexResetRedemptionService;

	const redemptions = () => dbOps.getCodexResetRedemptionsRepository();
	const credits = () => dbOps.getCodexResetCreditsRepository();

	async function seedCounts(
		available: number | null,
		applicable: number | null,
		observedAt = clock,
	) {
		await credits().recordCounts(ACCOUNT, {
			availableCount: available,
			applicableCount: applicable,
			countsPresent: true,
			observedAt,
		});
	}

	/** Two available credits, one of them applying now, counts fresh. */
	async function seedRedeemable() {
		await seedCounts(2, 1);
		await credits().insertCreditIfAbsent(creditRow("later", START + 20 * DAY));
		await credits().insertCreditIfAbsent(creditRow("sooner", START + 5 * DAY));
	}

	async function openRow(
		requestId: string,
		creditId: string | null,
		accountId = ACCOUNT,
		availableBefore: number | null = 2,
	) {
		const inserted = await redemptions().insertPending({
			requestId,
			accountId,
			creditId,
			availableBefore,
			at: clock,
		});
		expect(inserted.result).toBe("created");
	}

	beforeEach(async () => {
		dbOps = new DatabaseOperations(":memory:", { walMode: false });
		await seedAccount(dbOps, ACCOUNT);
		await seedAccount(dbOps, OTHER_ACCOUNT);
		clock = START;
		redeemerPresent = true;
		dispatches = [];
		nextDispatch = async () => answered("reset");
		refreshes = [];
		autoRefresh = async () => true;
		manualRefresh = async () => true;
		cachedAvailable = null;
		service = new CodexResetRedemptionService({
			dbOps,
			hasRedeemer: () => redeemerPresent,
			dispatch: async (accountId, request) => {
				dispatches.push({ accountId, request });
				return nextDispatch();
			},
			refreshUsage: async (accountId) => {
				refreshes.push(`auto:${accountId}`);
				return autoRefresh();
			},
			refreshUsageManually: async (accountId) => {
				refreshes.push(`manual:${accountId}`);
				return manualRefresh();
			},
			readAvailableCount: () => cachedAvailable,
			now: () => clock,
		});
	});

	afterEach(async () => {
		await dbOps.dispose();
	});

	describe("the gate for a new request id", () => {
		it("answers counts_stale and sends nothing when no counts were ever recorded", async () => {
			const result = await service.redeem(ACCOUNT, "req-1");
			expect(result.status).toBe(409);
			expect(result.body).toMatchObject({ reason: "counts_stale" });
			expect(dispatches).toHaveLength(0);
			expect(await redemptions().findByRequestId("req-1")).toBeNull();
		});

		it("answers counts_stale when the counts are over ten minutes old", async () => {
			await seedCounts(2, 1, clock - 11 * MINUTE);
			const result = await service.redeem(ACCOUNT, "req-1");
			expect(result.status).toBe(409);
			expect(result.body).toMatchObject({ reason: "counts_stale" });
			expect(dispatches).toHaveLength(0);
		});

		it("answers not_applicable when no reset applies right now (AE2)", async () => {
			await seedCounts(2, 0);
			const result = await service.redeem(ACCOUNT, "req-1");
			expect(result.status).toBe(409);
			expect(result.body).toMatchObject({ reason: "not_applicable" });
			expect(dispatches).toHaveLength(0);
			expect(await redemptions().findByRequestId("req-1")).toBeNull();
		});

		it("answers 503 not_sent without opening a row when no redeemer is registered", async () => {
			await seedRedeemable();
			redeemerPresent = false;
			const result = await service.redeem(ACCOUNT, "req-1");
			expect(result).toEqual({
				status: 503,
				body: expect.objectContaining({
					reason: "not_sent",
					requestId: "req-1",
				}),
			});
			expect(dispatches).toHaveLength(0);
			expect(await redemptions().findByRequestId("req-1")).toBeNull();
		});
	});

	describe("sending", () => {
		it("sends the soonest-expiring credit, records the outcome before refreshing, and reports a spent credit", async () => {
			await seedRedeemable();
			cachedAvailable = 1;
			let stateDuringRefresh: string | undefined;
			autoRefresh = async () => {
				stateDuringRefresh = (await redemptions().findByRequestId("req-1"))
					?.state;
				return true;
			};

			const result = await service.redeem(ACCOUNT, "req-1");

			expect(result).toEqual({
				status: 200,
				body: {
					requestId: "req-1",
					accountId: ACCOUNT,
					state: "done",
					outcome: "reset",
					windowsReset: 1,
					spend: "spent",
					availableBefore: 2,
					availableAfter: 1,
					requestedAt: START,
					completedAt: START,
				},
			});
			expect(dispatches).toEqual([
				{
					accountId: ACCOUNT,
					request: { redeemRequestId: "req-1", creditId: "sooner" },
				},
			]);
			expect(stateDuringRefresh).toBe("done");
			expect(refreshes).toEqual([`auto:${ACCOUNT}`]);
		});

		it("sends no credit id when no credit is listed", async () => {
			await seedCounts(1, 1);
			const result = await service.redeem(ACCOUNT, "req-1");
			expect(result.status).toBe(200);
			expect(dispatches[0]?.request).toEqual({
				redeemRequestId: "req-1",
				creditId: null,
			});
			expect((await redemptions().findByRequestId("req-1"))?.creditId).toBe(
				null,
			);
		});

		it.each<
			[
				string,
				CodexResetRedeemDispatch,
				string,
				string,
				number | null,
				string | null,
				boolean,
			]
		>([
			// label, dispatch, row state, outcome, windowsReset, spend, refreshed
			[
				"200 nothing_to_reset",
				answered("nothing_to_reset", 0),
				"done",
				"nothing_to_reset",
				0,
				"not_spent",
				true,
			],
			[
				"200 no_credit",
				answered("no_credit", 0),
				"done",
				"no_credit",
				0,
				"not_spent",
				true,
			],
			[
				"200 already_redeemed",
				answered("already_redeemed", 1),
				"done",
				"already_redeemed",
				1,
				"not_confirmed",
				true,
			],
			[
				"200 with an unknown code",
				answered("surprise", 3),
				"unknown",
				"unclear",
				null,
				null,
				false,
			],
			[
				"403",
				{ sent: true, result: { kind: "http", status: 403 } },
				"refused",
				"refused",
				null,
				null,
				false,
			],
			[
				"404",
				{ sent: true, result: { kind: "http", status: 404 } },
				"refused",
				"refused",
				null,
				null,
				false,
			],
			[
				"401",
				{ sent: true, result: { kind: "http", status: 401 } },
				"retryable",
				"retry",
				null,
				null,
				false,
			],
			[
				"429",
				{ sent: true, result: { kind: "http", status: 429 } },
				"retryable",
				"retry",
				null,
				null,
				false,
			],
			[
				"502",
				{ sent: true, result: { kind: "http", status: 502 } },
				"unknown",
				"unclear",
				null,
				null,
				false,
			],
			[
				"a timeout",
				{ sent: true, result: { kind: "timeout" } },
				"unknown",
				"unclear",
				null,
				null,
				false,
			],
			[
				"a network error",
				{ sent: true, result: { kind: "network" } },
				"unknown",
				"unclear",
				null,
				null,
				false,
			],
		])("records %s as KTD10's table says", async (_label, dispatch, state, outcome, windowsReset, spend, refreshed) => {
			await seedRedeemable();
			cachedAvailable = 2;
			nextDispatch = async () => dispatch;

			const result = await service.redeem(ACCOUNT, "req-1");

			expect(result.status).toBe(200);
			expect(result.body).toMatchObject({
				state,
				outcome,
				windowsReset,
				spend,
			});
			expect((await redemptions().findByRequestId("req-1"))?.state).toBe(
				state as never,
			);
			expect(refreshes.length > 0).toBe(refreshed);
		});

		it("answers 503 not_sent and leaves a retryable row when the redeemer could not send; the same id then sends", async () => {
			await seedRedeemable();
			nextDispatch = async () => ({
				sent: false,
				reason: "token_unavailable",
			});

			const first = await service.redeem(ACCOUNT, "req-1");
			expect(first.status).toBe(503);
			expect(first.body).toMatchObject({
				reason: "not_sent",
				requestId: "req-1",
			});
			expect((await redemptions().findByRequestId("req-1"))?.state).toBe(
				"retryable",
			);

			nextDispatch = async () => answered("reset");
			clock += SECOND;
			const second = await service.redeem(ACCOUNT, "req-1");
			expect(second.status).toBe(200);
			expect(second.body).toMatchObject({ state: "done", outcome: "reset" });
			expect(dispatches.map((d) => d.request)).toEqual([
				{ redeemRequestId: "req-1", creditId: "sooner" },
				{ redeemRequestId: "req-1", creditId: "sooner" },
			]);
		});

		it("treats a dispatch that throws as an unclear outcome", async () => {
			await seedRedeemable();
			nextDispatch = async () => {
				throw new Error("boom");
			};
			const result = await service.redeem(ACCOUNT, "req-1");
			expect(result.status).toBe(200);
			expect(result.body).toMatchObject({
				state: "unknown",
				outcome: "unclear",
			});
		});
	});

	describe("a request id that already has a row (KTD8)", () => {
		it("answers a stored outcome again without sending", async () => {
			await seedRedeemable();
			cachedAvailable = 1;
			const first = await service.redeem(ACCOUNT, "req-1");
			clock += 5 * MINUTE;
			const second = await service.redeem(ACCOUNT, "req-1");
			expect(second).toEqual(first);
			expect(dispatches).toHaveLength(1);
			expect(refreshes).toHaveLength(1);
		});

		it("answers 409 in_progress for a pending row under 60 seconds old", async () => {
			await seedRedeemable();
			await openRow("req-1", "sooner");
			clock += 59 * SECOND;
			const result = await service.redeem(ACCOUNT, "req-1");
			expect(result.status).toBe(409);
			expect(result.body).toMatchObject({
				reason: "in_progress",
				requestId: "req-1",
			});
			expect(dispatches).toHaveLength(0);
		});

		it("resends a pending row left by a crash, with its id and credit, whatever the counts now say", async () => {
			// A single-credit account whose answer was lost: by the retry the
			// refreshed counts read 0 available, 0 applicable, and are stale.
			await seedCounts(1, 1);
			await openRow("req-1", "only", ACCOUNT, 1);
			await seedCounts(0, 0, clock - 30 * MINUTE);
			clock += 61 * SECOND;
			cachedAvailable = 0;
			nextDispatch = async () => answered("already_redeemed");

			const result = await service.redeem(ACCOUNT, "req-1");

			expect(result.status).toBe(200);
			expect(result.body).toMatchObject({
				state: "done",
				outcome: "already_redeemed",
				spend: "spent",
				availableBefore: 1,
				availableAfter: 0,
			});
			expect(dispatches.map((d) => d.request)).toEqual([
				{ redeemRequestId: "req-1", creditId: "only" },
			]);
			expect((await redemptions().findByRequestId("req-1"))?.attempts).toBe(2);
		});

		it.each([
			"unknown",
			"retryable",
		] as const)("resends a %s row at once", async (state) => {
			await seedRedeemable();
			await openRow("req-1", "later");
			await redemptions().recordOutcome("req-1", {
				attemptedAt: clock,
				state,
				code: null,
				windowsReset: null,
				httpStatus: null,
				at: clock,
			});
			await seedCounts(2, 0);
			clock += SECOND;

			const result = await service.redeem(ACCOUNT, "req-1");

			expect(result.body).toMatchObject({ state: "done", outcome: "reset" });
			expect(dispatches.map((d) => d.request)).toEqual([
				{ redeemRequestId: "req-1", creditId: "later" },
			]);
		});

		it("answers 409 open_request naming the open id when another id arrives", async () => {
			await seedRedeemable();
			await openRow("req-open", "sooner");
			const result = await service.redeem(ACCOUNT, "req-new");
			expect(result.status).toBe(409);
			expect(result.body).toMatchObject({
				reason: "open_request",
				openRequestId: "req-open",
			});
			expect(dispatches).toHaveLength(0);
			expect(await redemptions().findByRequestId("req-new")).toBeNull();
		});

		it("answers request_conflict when the id belongs to another account", async () => {
			await seedRedeemable();
			await openRow("req-1", null, OTHER_ACCOUNT);
			const result = await service.redeem(ACCOUNT, "req-1");
			expect(result.status).toBe(409);
			expect(result.body).toMatchObject({ reason: "request_conflict" });
			expect(dispatches).toHaveLength(0);
		});

		it("answers an abandoned row as abandoned without sending", async () => {
			await seedRedeemable();
			await openRow("req-1", "sooner");
			await dbOps
				.getAdapter()
				.run(
					`UPDATE codex_reset_redemptions SET state = 'abandoned', completed_at = ? WHERE request_id = ?`,
					[clock, "req-1"],
				);
			const result = await service.redeem(ACCOUNT, "req-1");
			expect(result.status).toBe(200);
			expect(result.body).toMatchObject({
				state: "abandoned",
				outcome: "abandoned",
				spend: null,
			});
			expect(dispatches).toHaveLength(0);
		});
	});

	describe("the count after and the spend (KTD11)", () => {
		it("falls back to the manual refresh when the polled refresh fails", async () => {
			await seedRedeemable();
			autoRefresh = async () => false;
			cachedAvailable = 1;
			const result = await service.redeem(ACCOUNT, "req-1");
			expect(result.body).toMatchObject({
				availableAfter: 1,
				spend: "spent",
			});
			expect(refreshes).toEqual([`auto:${ACCOUNT}`, `manual:${ACCOUNT}`]);
		});

		it("reports not_confirmed and stores no count after when no refresh lands", async () => {
			await seedRedeemable();
			autoRefresh = async () => {
				throw new Error("poller gone");
			};
			manualRefresh = async () => false;
			// A count left in the cache from before must not be read as "after".
			cachedAvailable = 1;
			const result = await service.redeem(ACCOUNT, "req-1");
			expect(result.body).toMatchObject({
				state: "done",
				availableAfter: null,
				spend: "not_confirmed",
			});
			expect(
				(await redemptions().findByRequestId("req-1"))?.availableAfter,
			).toBeNull();
		});

		it.each<[string, number | null, string]>([
			// code, count after (before is 2), spend
			["reset", 1, "spent"],
			["reset", 2, "not_confirmed"],
			["reset", null, "not_confirmed"],
			["already_redeemed", 2, "not_confirmed"],
			["nothing_to_reset", 2, "not_spent"],
			["nothing_to_reset", 1, "spent"],
			["no_credit", 2, "not_spent"],
		])("reports %s with a count after of %p as %s", async (code, after, spend) => {
			await seedRedeemable();
			cachedAvailable = after;
			nextDispatch = async () => answered(code);
			const result = await service.redeem(ACCOUNT, "req-1");
			expect(result.body).toMatchObject({
				outcome: code,
				availableBefore: 2,
				availableAfter: after,
				spend,
			});
		});
	});

	describe("write failures and races", () => {
		it("answers pending and unclear when the outcome write fails after OpenAI answered, leaving the row pending", async () => {
			await seedRedeemable();
			nextDispatch = async () => ({
				sent: true,
				result: { kind: "http", status: 403 },
			});
			redemptions().recordOutcome = async () => {
				throw new Error("disk full");
			};
			const result = await service.redeem(ACCOUNT, "req-1");
			expect(result.status).toBe(200);
			expect(result.body).toMatchObject({
				state: "pending",
				outcome: "unclear",
				spend: null,
			});
			expect((await redemptions().findByRequestId("req-1"))?.state).toBe(
				"pending",
			);
			expect(refreshes).toHaveLength(0);
		});

		it("answers from the stored row when it changed while the request was out", async () => {
			await seedRedeemable();
			nextDispatch = async () => {
				await dbOps
					.getAdapter()
					.run(
						`UPDATE codex_reset_redemptions SET state = 'abandoned', completed_at = ? WHERE request_id = ?`,
						[clock, "req-1"],
					);
				return answered("reset");
			};
			const result = await service.redeem(ACCOUNT, "req-1");
			expect(result.body).toMatchObject({
				state: "abandoned",
				outcome: "abandoned",
			});
			expect(refreshes).toHaveLength(0);
		});

		function gatedDispatch() {
			let release = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			nextDispatch = async () => {
				await gate;
				return answered("reset");
			};
			setTimeout(() => release(), 20);
		}

		it("sends once when two requests with one id arrive together (AE5)", async () => {
			await seedRedeemable();
			gatedDispatch();
			const results = await Promise.all([
				service.redeem(ACCOUNT, "req-1"),
				service.redeem(ACCOUNT, "req-1"),
			]);
			expect(dispatches).toHaveLength(1);
			expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
			expect(results.find((r) => r.status === 409)?.body).toMatchObject({
				reason: "in_progress",
				requestId: "req-1",
			});
		});

		it("sends once when two ids arrive together; the other is told the open id", async () => {
			await seedRedeemable();
			gatedDispatch();
			const results = await Promise.all([
				service.redeem(ACCOUNT, "req-a"),
				service.redeem(ACCOUNT, "req-b"),
			]);
			expect(dispatches).toHaveLength(1);
			const winner = dispatches[0]?.request.redeemRequestId;
			const loser = results.find((r) => r.status === 409);
			expect(loser?.body).toMatchObject({
				reason: "open_request",
				openRequestId: winner,
			});
		});

		it("sends once when two retries of an unclear row arrive together", async () => {
			await seedRedeemable();
			await openRow("req-1", "sooner");
			await redemptions().recordOutcome("req-1", {
				attemptedAt: clock,
				state: "unknown",
				code: null,
				windowsReset: null,
				httpStatus: null,
				at: clock,
			});
			clock += SECOND;
			gatedDispatch();
			const results = await Promise.all([
				service.redeem(ACCOUNT, "req-1"),
				service.redeem(ACCOUNT, "req-1"),
			]);
			expect(dispatches).toHaveLength(1);
			expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
		});
	});
});
