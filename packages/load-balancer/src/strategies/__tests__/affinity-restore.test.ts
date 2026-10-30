import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as loadBalancer from "@better-ccflare/load-balancer";
import type {
	Account,
	RequestMeta,
	RoutingAffinityLaneOwner,
	RoutingAffinityLaneRecord,
	StrategyStore,
} from "@better-ccflare/types";
import { sanitizeRequestRoutingAttemptSummary } from "@better-ccflare/types/request";
import { RoutingAttemptLedger } from "../../../../proxy/src/handlers/routing-attempt-ledger";
import { getRequestLifecycleCoordinator } from "../../../../proxy/src/routing-terminal-recorder";
import type {
	EndMessage,
	StartMessage,
} from "../../../../proxy/src/worker-messages";

const MINUTE = 60_000;
const START = 1_800_000_000_000;
const TTL = 5 * 60 * MINUTE;

function account(id: string, overrides: Partial<Account> = {}): Account {
	return {
		id,
		name: id,
		provider: "anthropic",
		api_key: null,
		refresh_token: "test-refresh",
		access_token: "test-access",
		expires_at: START + TTL,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: START - TTL,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

class TestStore implements StrategyStore {
	utilization = new Map<string, number>();
	resetAccountSession(): void {}
	getAccountUtilization(id: string): number {
		return this.utilization.get(id) ?? 0;
	}
}

function meta(session = "restart-session"): RequestMeta {
	return {
		id: "test-request",
		headers: new Headers(),
		timestamp: Date.now(),
		clientSessionId: session,
		affinityLaneKey: JSON.stringify([
			"routing-lane-v1",
			session,
			"messages",
			"/v1/messages",
			"opus",
			"claude-opus-4-8",
			"",
		]),
	} as RequestMeta;
}

function text(
	record: RoutingAffinityLaneRecord,
	processStartedAt: number | null = START - TTL,
): string {
	const summary = sanitizeRequestRoutingAttemptSummary({
		version: 1,
		processStartedAt,
		affinityLane: record,
		physicalAttemptCount: 0,
		routeCount: 0,
		attempts: [],
		truncated: false,
		completeness: "complete",
		outputOriginOrdinal: null,
		winnerOrdinal: null,
		nativeStatus: 200,
		wireStatus: 200,
		terminalCause: null,
		cancellationOrigin: null,
	});
	expect(summary?.affinityLane).toEqual(record);
	return JSON.stringify(summary);
}

const reader = (summaries: string[], capReached = false) => ({
	async listAffinityLaneSummariesSince() {
		return { summaries, capReached };
	},
});

describe("affinity restore", () => {
	let now: number;
	let clock: ReturnType<typeof spyOn>;
	beforeEach(() => {
		now = START;
		clock = spyOn(Date, "now").mockImplementation(() => now);
	});
	afterEach(() => {
		clock.mockRestore();
	});

	function strategy(maxEntries?: number, ttl = TTL) {
		const instance = new loadBalancer.SessionAffinityStrategy(
			ttl,
			maxEntries,
			5 * MINUTE,
			undefined,
			() => now,
		);
		const store = new TestStore();
		instance.initialize(store);
		return { instance, store };
	}

	async function restart(
		live: loadBalancer.SessionAffinityStrategy,
		drain = false,
	) {
		const record = live.exportAffinityLaneRecord(meta());
		expect(record?.owner?.candidateId).toBe("account:owner");
		const summaries = [text(record as RoutingAffinityLaneRecord)];
		const restored = drain
			? new loadBalancer.SessionDrainSoonestStrategy()
			: strategy().instance;
		restored.initialize(new TestStore());
		const health = await loadBalancer.restoreAffinityPins({
			strategy: restored,
			reader: reader(summaries),
			now: () => now,
		});
		expect(health).toMatchObject({
			state: "restored",
			recordsRead: 1,
			pinsRestored: 1,
			abandonReason: null,
		});
		expect(restored.exportAffinityLaneRecord(meta())).toEqual(record);
		return restored;
	}

	async function sameTurn(
		live: loadBalancer.SessionAffinityStrategy,
		restored: loadBalancer.SessionAffinityStrategy,
		accounts: Account[],
		expected: string[],
		request: () => RequestMeta = meta,
	) {
		for (const instance of [live, restored]) {
			const ordered = await instance.select(
				accounts.map((a) => ({ ...a })),
				request(),
			);
			expect(ordered.map((a) => a.id)).toEqual(expected);
		}
		expect(restored.exportAffinityLaneRecord(meta())).toEqual(
			live.exportAffinityLaneRecord(meta()),
		);
	}

	function pressureMeta() {
		return {
			...meta(),
			quotaPressureByAccountId: new Map([
				["owner", { band: "cold" as const, comparisonKey: "weekly" }],
				["urgent", { band: "critical" as const, comparisonKey: "weekly" }],
			]),
		};
	}

	async function heldOwner() {
		now = START - 26 * MINUTE;
		const live = new loadBalancer.SessionDrainSoonestStrategy();
		live.initialize(new TestStore());
		const accounts = [account("owner"), account("urgent")];
		await live.select([accounts[0]], meta());
		// Start the hold 25 minutes before restart, keeping it warm through real turns.
		for (let minute = 25; minute >= 2; minute--) {
			now = START - minute * MINUTE;
			expect((await live.select(accounts, pressureMeta()))[0].id).toBe("owner");
		}
		expect(live.exportAffinityLaneRecord(meta())?.owner).toEqual({
			candidateId: "account:owner",
			accountId: "owner",
			assignedAt: START - 2 * MINUTE,
			installedBelowBestConfiguredTier: false,
			pressureHoldSince: START - 25 * MINUTE,
		});
		now = START;
		return { live, restored: await restart(live, true), accounts };
	}

	it("AE4: a restored warm hold keeps its original 30-minute cap", async () => {
		const { live, restored, accounts } = await heldOwner();
		await sameTurn(live, restored, accounts, ["owner", "urgent"], pressureMeta);
		now += 4 * MINUTE;
		await sameTurn(live, restored, accounts, ["owner", "urgent"], pressureMeta);
		now += MINUTE;
		await sameTurn(live, restored, accounts, ["urgent", "owner"], pressureMeta);
		expect(
			restored.exportAffinityLaneRecord(meta())?.owner?.pressureHoldSince,
		).toBeUndefined();
	});

	it("AE4: missing startup usage preserves the hold start until its original cap", async () => {
		const { live, restored, accounts } = await heldOwner();
		await sameTurn(live, restored, accounts, ["owner", "urgent"]);
		for (const instance of [live, restored]) {
			expect(
				instance.exportAffinityLaneRecord(meta())?.owner?.pressureHoldSince,
			).toBe(START - 25 * MINUTE);
		}
		now += 4 * MINUTE;
		await sameTurn(live, restored, accounts, ["owner", "urgent"], pressureMeta);
		now += MINUTE;
		await sameTurn(live, restored, accounts, ["urgent", "owner"], pressureMeta);
	});

	it("AE5: an eight-minute idle owner is cold even if its stream finished two minutes ago", async () => {
		now = START - 8 * MINUTE;
		const live = new loadBalancer.SessionDrainSoonestStrategy();
		live.initialize(new TestStore());
		const accounts = [account("owner"), account("urgent")];
		await live.select([accounts[0]], meta());
		now = START - 2 * MINUTE;
		const finalized = text(
			live.exportAffinityLaneRecord(meta()) as RoutingAffinityLaneRecord,
		);
		now = START;
		const restored = new loadBalancer.SessionDrainSoonestStrategy();
		restored.initialize(new TestStore());
		await loadBalancer.restoreAffinityPins({
			strategy: restored,
			reader: reader([finalized]),
			now: () => now,
		});
		await sameTurn(live, restored, accounts, ["urgent", "owner"], pressureMeta);
	});

	function record(
		session = "restart-session",
		owner: Partial<RoutingAffinityLaneOwner> = {},
		observedAt = now,
	): RoutingAffinityLaneRecord {
		return {
			digest: loadBalancer.affinityLaneDigest(
				`lane:${meta(session).affinityLaneKey}`,
			),
			observedAt,
			owner: {
				candidateId: "account:owner",
				accountId: "owner",
				assignedAt: START - MINUTE,
				installedBelowBestConfiguredTier: false,
				...owner,
			},
		};
	}

	async function restoreRows(
		records: string[],
		instance = strategy().instance,
	) {
		const health = await loadBalancer.restoreAffinityPins({
			strategy: instance,
			reader: reader(records),
			now: () => now,
		});
		return { instance, health };
	}

	it("AE6: a failed read opens the gate with no pins and read_failed health", async () => {
		const instance = strategy().instance;
		const result = loadBalancer.restoreAffinityPins({
			strategy: instance,
			now: () => now,
			reader: {
				async listAffinityLaneSummariesSince() {
					throw new Error("test read failed");
				},
			},
		});
		const gate = instance.affinityRestoreGate();
		expect(gate).toBeInstanceOf(Promise);
		expect(instance.getRoutingHealth().affinityRestore).toEqual({
			state: "pending",
			recordsRead: 0,
			pinsRestored: 0,
			durationMs: null,
			abandonReason: null,
		});
		expect(await result).toEqual({
			state: "abandoned",
			recordsRead: 0,
			pinsRestored: 0,
			durationMs: 0,
			abandonReason: "read_failed",
		});
		await gate;
		expect(instance.affinityRestoreGate()).toBeNull();
		expect(instance.affinityEntries).toBe(0);
		expect(instance.getRoutingHealth().affinityRestore?.abandonReason).toBe(
			"read_failed",
		);
	});

	it("AE7: six-hour and exact-TTL owners are not restored; just-inside-TTL is", async () => {
		const { instance, health } = await restoreRows([
			text(record("six-hours", { assignedAt: START - 6 * 60 * MINUTE })),
			text(record("boundary", { assignedAt: START - TTL })),
			text(record("inside", { assignedAt: START - TTL + 1 })),
		]);
		expect(health?.pinsRestored).toBe(1);
		expect(
			instance.exportAffinityLaneRecord(meta("six-hours"))?.owner,
		).toBeNull();
		expect(
			instance.exportAffinityLaneRecord(meta("boundary"))?.owner,
		).toBeNull();
		expect(
			instance.exportAffinityLaneRecord(meta("inside"))?.owner?.assignedAt,
		).toBe(START - TTL + 1);

		// Also exercise expiry against the uninterrupted process, through real select/export.
		now = START - 6 * 60 * MINUTE;
		const { instance: live, store } = strategy();
		await live.select([account("owner")], meta());
		const finalized = text(
			live.exportAffinityLaneRecord(meta()) as RoutingAffinityLaneRecord,
		);
		now = START;
		const { instance: restored, health: expiredHealth } = await restoreRows([
			finalized,
		]);
		expect(expiredHealth?.pinsRestored).toBe(0);
		store.utilization.set("owner", 90);
		const restoredStore = new TestStore();
		restoredStore.utilization.set("owner", 90);
		restored.initialize(restoredStore);
		await sameTurn(
			live,
			restored,
			[account("owner"), account("other")],
			["other", "owner"],
		);
	});

	it("ranks out-of-order observations first, then larger assignment timestamps", async () => {
		const { instance, health } = await restoreRows([
			text(
				record(
					"latest",
					{ candidateId: "account:stale", assignedAt: START - 1 },
					START - 20,
				),
			),
			text(
				record(
					"tie",
					{ candidateId: "account:newer", assignedAt: START - 5 },
					START,
				),
			),
			text(
				record(
					"latest",
					{ candidateId: "account:observed-last", assignedAt: START - 100 },
					START,
				),
			),
			text(
				record(
					"tie",
					{ candidateId: "account:older", assignedAt: START - 10 },
					START,
				),
			),
		]);
		expect(health?.recordsRead).toBe(4);
		expect(
			instance.exportAffinityLaneRecord(meta("latest"))?.owner?.candidateId,
		).toBe("account:observed-last");
		expect(
			instance.exportAffinityLaneRecord(meta("tie"))?.owner?.candidateId,
		).toBe("account:newer");
	});

	it("a latest tombstone prevents resurrection while an exact-tie owner outranks a tombstone", async () => {
		const tombstone = { ...record("deleted", {}, START), owner: null };
		const tied = { ...record("tied", {}, START), owner: null };
		const { instance, health } = await restoreRows([
			text(tombstone),
			text(record("deleted", {}, START - 1)),
			text(tied),
			text(record("tied")),
			text(tied),
		]);
		expect(health?.pinsRestored).toBe(1);
		expect(
			instance.exportAffinityLaneRecord(meta("deleted"))?.owner,
		).toBeNull();
		expect(
			instance.exportAffinityLaneRecord(meta("tied"))?.owner?.candidateId,
		).toBe("account:owner");
	});

	it.each([
		START - 10_000,
		null,
	])("new process outranks later observations from process %s", async (oldStart) => {
		const { instance } = await restoreRows([
			text(
				record(
					"restart-session",
					{ candidateId: "account:new-process" },
					START - 10,
				),
				START - 1_000,
			),
			text(
				record(
					"restart-session",
					{ candidateId: "account:old-process", assignedAt: START },
					START,
				),
				oldStart,
			),
		]);
		expect(instance.exportAffinityLaneRecord(meta())?.owner?.candidateId).toBe(
			"account:new-process",
		);
	});

	it.each([
		true,
		false,
	])("overlapping requests finalize in reverse start order (late success=%s) with current live state", async (success) => {
		const live = strategy().instance;
		const summaries: string[] = [];
		function start(request: RequestMeta) {
			const ledger = new RoutingAttemptLedger();
			ledger.recordPhysicalAttempt({
				accountId: live.snapshotAffinityOwner(request)?.accountId,
				provider: "test",
			});
			const lifecycle = getRequestLifecycleCoordinator(request);
			lifecycle.bindRoutingObservation(
				ledger,
				(status) => status,
				() => live.exportAffinityLaneRecord(request),
			);
			lifecycle.start({
				collector: {
					handleStart: (_message: StartMessage) => {},
					async handleEnd(message: EndMessage) {
						summaries.push(JSON.stringify(message.routingAttemptSummary));
					},
				},
				message: {
					requestId: request.id,
					responseStatus: 200,
					accountId: live.snapshotAffinityOwner(request)?.accountId,
				} as StartMessage,
			});
			return lifecycle;
		}
		now = START - 3 * MINUTE;
		const firstMeta = { ...meta(), id: "first" };
		await live.select([account("owner")], firstMeta);
		const first = start(firstMeta);
		now += MINUTE;
		const secondMeta = { ...meta(), id: "second" };
		await live.select([account("other")], secondMeta);
		const second = start(secondMeta);
		now += MINUTE;
		await second.finalize({ type: "end", requestId: "second", success: true });
		now = START;
		await first.finalize({
			type: "end",
			requestId: "first",
			success,
			...(success ? {} : { error: "test transport failure" }),
		});
		for (const summary of summaries) {
			expect(JSON.parse(summary).affinityLane.owner).toEqual({
				candidateId: "account:other",
				accountId: "other",
				assignedAt: START - 2 * MINUTE,
				installedBelowBestConfiguredTier: false,
			});
		}
		const { instance: restored, health } = await restoreRows(
			summaries.reverse(),
		);
		expect(health?.recordsRead).toBe(2);
		expect(restored.exportAffinityLaneRecord(meta())).toEqual(
			live.exportAffinityLaneRecord(meta()),
		);
		await sameTurn(
			live,
			restored,
			[account("owner"), account("other")],
			["other", "owner"],
		);
	});

	it.each([
		["fallback equals owner", { fallbackCandidateId: "account:owner" }],
		["upgrade after assignment", { upgradedAt: START - MINUTE + 1 }],
		["hold after assignment", { pressureHoldSince: START - MINUTE + 1 }],
		[
			"suppression beyond anti-thrash",
			{ suppressUpgradesUntil: START + 4 * MINUTE + 1 },
		],
	] as const)("drops an impossible record: %s", async (_reason, fields) => {
		const { instance, health } = await restoreRows([
			text(record("restart-session", fields)),
		]);
		expect(health?.pinsRestored).toBe(0);
		expect(instance.affinityEntries).toBe(0);
	});

	it("keeps a recorded temporary fallback and hold, then treats its owner as cold", async () => {
		const { live, accounts } = await heldOwner();
		// Preserve a strictly better preferred owner while a worse-tier backup serves.
		now = START - MINUTE;
		const backup = account("backup", { priority: 1 });
		const down = account("owner", { rate_limited_until: START + MINUTE });
		expect((await live.select([down, backup], meta()))[0].id).toBe("backup");
		expect(live.exportAffinityLaneRecord(meta())?.owner).toMatchObject({
			fallbackCandidateId: "account:backup",
			pressureHoldSince: START - 25 * MINUTE,
		});
		now = START;
		const restored = await restart(live, true);
		await sameTurn(live, restored, [down, backup], ["backup"]);
		// Preferred owner recovers, but did not serve the previous turn: no warm hold.
		await sameTurn(live, restored, accounts, ["urgent", "owner"], pressureMeta);
	});

	it("late reader records are discarded after the real budget opens the gate", async () => {
		const instance = strategy().instance;
		let resolveRead!: (result: {
			summaries: string[];
			capReached: boolean;
		}) => void;
		const read = new Promise<{ summaries: string[]; capReached: boolean }>(
			(resolve) => {
				resolveRead = resolve;
			},
		);
		const result = loadBalancer.restoreAffinityPins({
			strategy: instance,
			budgetMs: 25,
			reader: { listAffinityLaneSummariesSince: () => read },
		});
		const gate = instance.affinityRestoreGate();
		expect(gate).toBeInstanceOf(Promise);
		try {
			const health = await result;
			await gate;
			expect(health).toMatchObject({
				state: "abandoned",
				abandonReason: "budget",
				recordsRead: 0,
				pinsRestored: 0,
			});
			expect(instance.affinityRestoreGate()).toBeNull();
		} finally {
			resolveRead({ summaries: [text(record())], capReached: false });
			await read;
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(instance.affinityEntries).toBe(0);
		expect(instance.getRoutingHealth().affinityRestore?.state).toBe(
			"abandoned",
		);
	});

	it("a reader that never settles during restore cannot hold the gate past the budget", async () => {
		const instance = strategy().instance;
		let rejectRead!: (error: Error) => void;
		const read = new Promise<never>((_resolve, reject) => {
			rejectRead = reject;
		});
		const result = loadBalancer.restoreAffinityPins({
			strategy: instance,
			budgetMs: 25,
			reader: { listAffinityLaneSummariesSince: () => read },
		});
		const gate = instance.affinityRestoreGate();
		try {
			await gate;
			expect(instance.affinityRestoreGate()).toBeNull();
			expect(await result).toMatchObject({
				state: "abandoned",
				abandonReason: "budget",
				pinsRestored: 0,
			});
			expect(instance.affinityEntries).toBe(0);
		} finally {
			// Settle the otherwise hung dependency only for cleanup; its late rejection is consumed.
			rejectRead(new Error("test cleanup after budget"));
			await read.catch(() => {});
		}
	});

	it("a mid-parse budget discards staged records and yields between chunks", async () => {
		const instance = strategy().instance;
		let yielded = false;
		let calls = 0;
		const turn = setTimeout(() => {
			yielded = true;
		}, 0);
		try {
			const health = await loadBalancer.restoreAffinityPins({
				strategy: instance,
				reader: reader([
					text(record("first")),
					text(record("second")),
					text(record("third")),
				]),
				budgetMs: 50,
				chunkSize: 1,
				now: () => START + (calls++ >= 4 ? 51 : 0),
			});
			expect(health).toMatchObject({
				state: "abandoned",
				abandonReason: "budget",
				recordsRead: 3,
				pinsRestored: 0,
			});
			expect(yielded).toBe(true);
			expect(instance.affinityEntries).toBe(0);
			expect(instance.affinityRestoreGate()).toBeNull();
		} finally {
			clearTimeout(turn);
		}
	});

	it("a reached row cap abandons the entire read without installing", async () => {
		const instance = strategy().instance;
		const health = await loadBalancer.restoreAffinityPins({
			strategy: instance,
			reader: reader([text(record())], true),
			now: () => now,
		});
		expect(health).toEqual({
			state: "abandoned",
			abandonReason: "row_cap",
			recordsRead: 1,
			pinsRestored: 0,
			durationMs: 0,
		});
		expect(instance.affinityEntries).toBe(0);
		expect(instance.affinityRestoreGate()).toBeNull();
	});

	it("uses the strategy TTL for the read window and the configured/default row caps", async () => {
		for (const rowCap of [undefined, 7]) {
			const instance = strategy(undefined, 12 * MINUTE).instance;
			const calls: number[][] = [];
			const health = await loadBalancer.restoreAffinityPins({
				strategy: instance,
				rowCap,
				now: () => now,
				reader: {
					async listAffinityLaneSummariesSince(since, limit) {
						calls.push([since, limit]);
						return {
							summaries: ["malformed JSON", "{}", text(record())],
							capReached: false,
						};
					},
				},
			});
			expect(calls).toEqual([[START - 12 * MINUTE, rowCap ?? 20_000]]);
			expect(health).toMatchObject({
				state: "restored",
				recordsRead: 3,
				pinsRestored: 1,
			});
		}
		expect(loadBalancer.AFFINITY_RESTORE_BUDGET_MS).toBe(3000);
		expect(loadBalancer.AFFINITY_RESTORE_ROW_CAP).toBe(20_000);
	});

	it("strict mode reads nothing, keeps its gate open and reports skipped", async () => {
		const strict = new loadBalancer.SessionDrainSoonestStrategy(
			undefined,
			"strict",
		);
		let reads = 0;
		expect(
			await loadBalancer.restoreAffinityPins({
				strategy: strict,
				reader: {
					async listAffinityLaneSummariesSince() {
						reads++;
						return { summaries: [text(record())], capReached: false };
					},
				},
			}),
		).toBeNull();
		expect(reads).toBe(0);
		expect(strict.affinityRestoreGate()).toBeNull();
		expect(strict.getRoutingHealth().affinityRestore).toEqual({
			state: "skipped",
			recordsRead: 0,
			pinsRestored: 0,
			durationMs: null,
			abandonReason: null,
		});
	});

	it("strategies without restore hooks read nothing", async () => {
		for (const instance of [
			new loadBalancer.LeastUsedStrategy(),
			new loadBalancer.SessionStrategy(),
		]) {
			let reads = 0;
			expect(
				await loadBalancer.restoreAffinityPins({
					strategy: instance,
					reader: {
						async listAffinityLaneSummariesSince() {
							reads++;
							return { summaries: [], capReached: false };
						},
					},
				}),
			).toBeNull();
			expect(reads).toBe(0);
		}
	});

	it("AE1: an available three-minute owner has the same order and record after restart", async () => {
		now -= 3 * MINUTE;
		const { instance: live, store } = strategy();
		const accounts = [account("owner"), account("other")];
		store.utilization.set("other", 90);
		expect((await live.select(accounts, meta())).map((a) => a.id)).toEqual([
			"owner",
			"other",
		]);
		now = START;
		const restored = await restart(live);
		// Make a fresh selection prefer other, so missing pins cannot pass parity.
		store.utilization.set("owner", 90);
		store.utilization.set("other", 0);
		const restoredStore = new TestStore();
		restoredStore.utilization.set("owner", 90);
		restored.initialize(restoredStore);
		await sameTurn(live, restored, accounts, ["owner", "other"]);
	});

	it.each([
		"rate-limited",
		"paused",
		"removed",
		"unauthorized",
	])("AE2/AE3: a %s owner fails over identically", async (reason) => {
		now -= 3 * MINUTE;
		const live = strategy().instance;
		await live.select([account("owner")], meta());
		now = START;
		const restored = await restart(live);
		const owner = account("owner", {
			rate_limited_until: reason === "rate-limited" ? now + MINUTE : null,
			paused: reason === "paused",
		});
		const accounts =
			reason === "removed" ? [account("other")] : [owner, account("other")];
		await sameTurn(live, restored, accounts, ["other"], () => ({
			...meta(),
			...(reason === "unauthorized"
				? { hardExcludedAccountIds: new Set(["owner"]) }
				: {}),
		}));
		expect(restored.exportAffinityLaneRecord(meta())?.owner?.candidateId).toBe(
			"account:other",
		);
	});
});
