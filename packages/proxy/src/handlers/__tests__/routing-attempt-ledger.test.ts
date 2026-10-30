import { describe, expect, it, mock } from "bun:test";
import { PROCESS_STARTED_AT_MS } from "@better-ccflare/core";
import * as requestTypes from "@better-ccflare/types/request";
import { sanitizeRequestRoutingAttemptSummary } from "@better-ccflare/types/request";
import {
	formatRoutingAttemptMessage,
	MAX_REQUEST_PHYSICAL_ATTEMPTS,
	PhysicalAttemptBudgetExceededError,
	RoutingAttemptLedger,
} from "../routing-attempt-ledger";

const laneRecord = {
	digest: "a".repeat(64),
	observedAt: 1_793_346_681_263,
	owner: {
		candidateId: "profile:main:model:vendor%2Fmodel:account:a#1",
		accountId: "account-a",
		assignedAt: 1_793_346_681_000,
		installedBelowBestConfiguredTier: false,
		fallbackCandidateId: "account:b#1",
		upgradedAt: 1_793_346_681_100,
		suppressUpgradesUntil: 1_793_346_682_000,
		pressureHoldSince: 1_793_346_681_200,
	},
};

describe("affinity lane summary boundary", () => {
	const base = { version: 1, attempts: [], physicalAttemptCount: 0 };
	it("keeps encoded, repeated-account and 185-character managed candidate ids without loosening attempt identities", () => {
		const managed = `combo:${"c".repeat(36)}:managed:sonnet:rule:${"r".repeat(77)}:account:${"a".repeat(36)}`;
		expect(managed.length).toBe(185);
		for (const candidateId of [
			laneRecord.owner.candidateId,
			"account:a#1",
			managed,
		]) {
			const block = {
				...laneRecord,
				owner: {
					...laneRecord.owner,
					candidateId,
					fallbackCandidateId: candidateId,
				},
			};
			const sanitized = sanitizeRequestRoutingAttemptSummary({
				...base,
				affinityLane: block,
			});
			expect(sanitized?.affinityLane).toEqual(block);
			expect(
				sanitizeRequestRoutingAttemptSummary(JSON.stringify(sanitized)),
			).toEqual(sanitized);
		}
		const summary = sanitizeRequestRoutingAttemptSummary({
			...base,
			physicalAttemptCount: 1,
			attempts: [{ ordinal: 1, accountId: "account:a#1" }],
		});
		expect(summary?.attempts[0].accountId).toBeNull();
	});
	it("turns invalid owners into tombstones and retains the summary", () => {
		for (const invalid of [
			{ assignedAt: Number.POSITIVE_INFINITY },
			{ assignedAt: -1 },
			{ assignedAt: 1.5 },
			{ candidateId: "a".repeat(513) },
			{ fallbackCandidateId: "a".repeat(513) },
			{ candidateId: "" },
			{ candidateId: "secret with spaces" },
			{ accountId: "a#1" },
			{ accountId: "a".repeat(129) },
			{ installedBelowBestConfiguredTier: 1 },
			{ upgradedAt: null },
			{ suppressUpgradesUntil: Number.NaN },
			{ pressureHoldSince: -1 },
		]) {
			const summary = sanitizeRequestRoutingAttemptSummary({
				...base,
				affinityLane: {
					...laneRecord,
					owner: { ...laneRecord.owner, ...invalid },
				},
			});
			expect(summary?.affinityLane).toEqual({ ...laneRecord, owner: null });
			expect(summary?.version).toBe(1);
		}
	});
	it("omits invalid blocks and parses restore records through the write sanitizer", () => {
		expect(typeof requestTypes.sanitizeRoutingAffinityLaneRecord).toBe(
			"function",
		);
		for (const invalid of [
			null,
			[],
			"raw",
			{ ...laneRecord, digest: "A".repeat(64) },
			{ ...laneRecord, digest: "a".repeat(63) },
			{ ...laneRecord, observedAt: -1 },
			{ ...laneRecord, observedAt: 1.5 },
		]) {
			expect(
				requestTypes.sanitizeRoutingAffinityLaneRecord(invalid),
			).toBeNull();
			expect(
				sanitizeRequestRoutingAttemptSummary({ ...base, affinityLane: invalid })
					?.affinityLane,
			).toBeUndefined();
		}
		expect(typeof requestTypes.parseRoutingAffinityLaneSummary).toBe(
			"function",
		);
		for (const processStartedAt of [undefined, 1_793_346_680_000]) {
			const text = JSON.stringify({
				...base,
				processStartedAt,
				affinityLane: laneRecord,
			});
			expect(requestTypes.parseRoutingAffinityLaneSummary(text)).toEqual({
				record: laneRecord,
				processStartedAt: processStartedAt ?? null,
			});
		}
		expect(
			requestTypes.parseRoutingAffinityLaneSummary(
				JSON.stringify({ ...base, affinityLane: { ...laneRecord, owner: {} } }),
			),
		).toEqual({
			record: { ...laneRecord, owner: null },
			processStartedAt: null,
		});
		for (const text of ["{broken", JSON.stringify(base), " ".repeat(16385)])
			expect(requestTypes.parseRoutingAffinityLaneSummary(text)).toBeNull();
	});
	it("exports the lane block from the ledger and bounds the longest real ids to 1,024 characters", () => {
		const managed = `combo:${"c".repeat(36)}:managed:sonnet:rule:${"r".repeat(77)}:account:${"a".repeat(36)}`;
		const profile = `profile:${"p".repeat(36)}:model:${encodeURIComponent("vendor/model[large]")}:account:${"a".repeat(36)}#1`;
		for (const candidateId of [
			managed,
			profile,
			`account:${"a".repeat(36)}#1`,
		]) {
			const block = {
				...laneRecord,
				owner: {
					...laneRecord.owner,
					accountId: "a".repeat(36),
					candidateId,
					fallbackCandidateId: candidateId,
				},
			};
			expect(JSON.stringify(block).length).toBeLessThanOrEqual(1024);
			const summary = new RoutingAttemptLedger().terminalSummary({
				success: true,
				nativeStatus: 200,
				wireStatus: 200,
				affinityLane: block,
			});
			expect(summary?.affinityLane).toEqual(block);
		}
		expect(
			new RoutingAttemptLedger().terminalSummary({
				success: true,
				nativeStatus: 200,
				wireStatus: 200,
				affinityLane: null,
			})?.affinityLane,
		).toBeUndefined();
	});
	it("counts the block in the oversize ladder, dropping decision and stream evidence while retaining the lane", () => {
		const ledger = new RoutingAttemptLedger();
		const identity = "m".repeat(128);
		for (let i = 0; i < 16; i++) {
			ledger.recordPhysicalAttempt({
				accountId: identity,
				provider: identity,
				logicalModel: identity,
				physicalModel: identity,
			});
			ledger.observePhysicalStream({
				rawEventCounts: Object.fromEntries(
					requestTypes.ROUTING_RAW_STREAM_CATEGORIES.map((k) => [
						k,
						Number.MAX_SAFE_INTEGER,
					]),
				),
				rawVisibleEvents: Number.MAX_SAFE_INTEGER,
				meaningfulFrames: Number.MAX_SAFE_INTEGER,
				protocolFrames: Number.MAX_SAFE_INTEGER,
				providerTerminal: "resource_limit",
				gateOutcome: "buffer_limit",
				remainingCommitmentMs: Number.MAX_SAFE_INTEGER,
				cancellationOrigin: "semantic_deadline",
				diagnosis: "meaningful_output",
			});
			ledger.recordPhysicalOutcome("buffer_limit");
		}
		ledger.observeRoutingDecision({
			version: 1,
			requestedLogicalModel: "model",
			operation: "messages",
			origin: "unknown",
			reason: "route_unavailable",
			evidence: "inferred",
			inventory: "complete",
			constraints: {
				forcedRoute: false,
				capabilityProfile: false,
				routeProfile: false,
				profileId: null,
				provider: null,
				physicalModel: null,
			},
			selection: null,
			stages: [],
		});
		const without = ledger.terminalSummary({
			success: false,
			nativeStatus: 503,
			wireStatus: 503,
		});
		const managed = `combo:${"c".repeat(36)}:managed:sonnet:rule:${"r".repeat(77)}:account:${"a".repeat(36)}`;
		const affinityLane = {
			...laneRecord,
			owner: {
				...laneRecord.owner,
				candidateId: managed,
				fallbackCandidateId: managed,
				accountId: "a".repeat(36),
			},
		};
		const withLane = ledger.terminalSummary({
			success: false,
			nativeStatus: 503,
			wireStatus: 503,
			affinityLane,
		});
		expect(withLane?.decision).toBeNull();
		expect(withLane?.decisionGap).toBe("oversize");
		expect(withLane?.affinityLane).toEqual(affinityLane);
		expect(withLane?.attempts.some((a) => a.streamEvidence === null)).toBe(
			true,
		);
		// Including the block makes another evidence snapshot exceed the cap.
		expect(
			withLane?.attempts.filter((a) => a.streamEvidence).length,
		).toBeLessThan(
			without?.attempts.filter((a) => a.streamEvidence).length ?? 0,
		);
		expect(JSON.stringify(withLane).length).toBeLessThanOrEqual(16384);
	});
	it("rejects an entire over-cap stored summary and its block at the restore boundary", () => {
		const text = JSON.stringify({ ...base, affinityLane: laneRecord });
		const atCap = text.padEnd(16384, " ");
		expect(requestTypes.parseRoutingAffinityLaneSummary(atCap)?.record).toEqual(
			laneRecord,
		);
		expect(sanitizeRequestRoutingAttemptSummary(`${atCap} `)).toBeNull();
		expect(
			requestTypes.parseRoutingAffinityLaneSummary(`${atCap} `),
		).toBeNull();
	});
});

describe("RoutingAttemptLedger", () => {
	it("preserves failed physical attempts separately from a successful rescue winner", () => {
		const ledger = new RoutingAttemptLedger();
		ledger.claim("account-a", "physical-model");
		ledger.recordPhysicalAttempt({
			accountId: "account-a",
			provider: "codex",
			logicalModel: "logical-model",
			physicalModel: "physical-model",
		});
		ledger.recordPhysicalOutcome("meaningful_progress_timeout", "failed", {
			validProtocolFramesSeen: 79,
			terminalEvidenceSeen: false,
		});
		ledger.recordPhysicalOutcome("transport_error"); // cleanup cannot replace first cause
		ledger.recordPhysicalAttempt({
			accountId: "account-a",
			provider: "codex",
			logicalModel: "logical-model",
			physicalModel: "physical-model",
		});
		ledger.observeOutputOrigin("account-a");
		const result = ledger.terminalSummary({
			success: true,
			nativeStatus: 200,
			wireStatus: 200,
		});
		expect(result.physicalAttemptCount).toBe(2);
		expect(result.routeCount).toBe(1);
		expect(result.attempts[0]).toMatchObject({
			outcome: "failed",
			cause: "meaningful_progress_timeout",
			protocolFrames: 79,
			meaningfulProgress: "absent",
		});
		expect(result.attempts[1]?.outcome).toBe("succeeded");
		expect(result.outputOriginOrdinal).toBe(2);
		expect(result.winnerOrdinal).toBe(2);
		expect(result.terminalCause).toBeNull();
	});

	it("never invents preselection attempts and keeps failed output origin distinct from winner", () => {
		const ledger = new RoutingAttemptLedger();
		expect(
			ledger.terminalSummary({
				success: false,
				error: "routing_rejected",
				nativeStatus: 503,
				wireStatus: 503,
			}),
		).toMatchObject({
			physicalAttemptCount: 0,
			attempts: [],
			outputOriginOrdinal: null,
			winnerOrdinal: null,
		});
		ledger.recordPhysicalAttempt({ accountId: "account-a", provider: "codex" });
		ledger.observeOutputOrigin("account-a");
		expect(
			ledger.terminalSummary({
				success: false,
				error: "client_cancelled",
				nativeStatus: 200,
				wireStatus: 200,
			}),
		).toMatchObject({
			outputOriginOrdinal: 1,
			winnerOrdinal: null,
			cancellationOrigin: "unknown",
		});
	});

	it("caps observations without losing true send count or a winner beyond the cap", () => {
		const ledger = new RoutingAttemptLedger();
		for (let n = 0; n < 32; n++)
			ledger.recordPhysicalAttempt({
				accountId: `account-${n}`,
				provider: "codex",
			});
		ledger.observeOutputOrigin("account-31");
		const result = ledger.terminalSummary({
			success: true,
			nativeStatus: 200,
			wireStatus: 200,
		});
		expect(result.attempts).toHaveLength(16);
		expect(result.physicalAttemptCount).toBe(32);
		expect(result.winnerOrdinal).toBe(32);
		expect(result.truncated).toBe(true);
	});

	it("strips arbitrary content and saturates bounded observation counters", () => {
		const result = sanitizeRequestRoutingAttemptSummary({
			version: 1,
			physicalAttemptCount: 500,
			routeCount: 500,
			attempts: [
				{
					ordinal: 1,
					accountId: "safe-account",
					provider: "codex",
					logicalModel: "raw\npayload",
					physicalModel: "safe-model",
					outcome: "failed",
					cause: "raw secret event",
					protocolFrames: 9999999,
					prompt: "private-content",
				},
			],
			terminalCause: "arbitrary-content",
			completeness: "complete",
			requestBody: "private-content",
		});
		expect(result).toMatchObject({
			physicalAttemptCount: 32,
			routeCount: 32,
			terminalCause: "unknown",
			truncated: true,
			attempts: [
				{ logicalModel: null, cause: "unknown", protocolFrames: 65535 },
			],
		});
		expect(JSON.stringify(result)).not.toContain("private-content");
		expect(sanitizeRequestRoutingAttemptSummary("{malformed")).toBeNull();
		expect(sanitizeRequestRoutingAttemptSummary("x".repeat(16385))).toBeNull();
	});

	it("round-trips maximum observational identity input through bounded persistence", () => {
		for (const identityLength of [128, 256]) {
			const identity = "m".repeat(identityLength);
			const write = sanitizeRequestRoutingAttemptSummary({
				version: 1,
				physicalAttemptCount: 16,
				routeCount: 16,
				truncated: false,
				completeness: "complete",
				outputOriginOrdinal: null,
				winnerOrdinal: null,
				nativeStatus: 503,
				wireStatus: 200,
				terminalCause: "meaningful_progress_timeout",
				cancellationOrigin: null,
				attempts: Array.from({ length: 16 }, (_, i) => ({
					ordinal: i + 1,
					accountId: identity,
					provider: identity,
					logicalModel: identity,
					physicalModel: identity,
					outcome: "failed",
					cause: "meaningful_progress_timeout",
					startedAt: Number.MAX_SAFE_INTEGER,
					outcomeObservedAt: Number.MAX_SAFE_INTEGER,
					nativeStatus: 200,
					protocolFrames: 65535,
					meaningfulProgress: "absent",
					terminalEvidenceSeen: false,
				})),
			});
			expect(write).not.toBeNull();
			const encoded = JSON.stringify(write);
			expect(sanitizeRequestRoutingAttemptSummary(encoded)).toEqual(write);
			expect(encoded.length).toBeLessThanOrEqual(16384);
			expect(write?.physicalAttemptCount).toBe(16);
			if (identityLength === 128) {
				expect(write?.attempts[0]?.accountId).toBe(identity);
				expect(write?.completeness).toBe("complete");
			} else {
				expect(write?.attempts[0]?.accountId).toBeNull();
				expect(write?.attempts[0]?.physicalModel).toBeNull();
				expect(write?.completeness).toBe("partial");
			}
		}
	});

	it("round-trips all maximal new diagnostics within the summary cap without erasing cause", () => {
		const ledger = new RoutingAttemptLedger();
		const identity = "m".repeat(128);
		for (let ordinal = 1; ordinal <= 16; ordinal++) {
			ledger.recordPhysicalAttempt({
				accountId: identity,
				provider: identity,
				logicalModel: identity,
				physicalModel: identity,
			});
			ledger.observePhysicalStream({
				rawEventCounts: Object.fromEntries(
					[
						"created",
						"in_progress",
						"function_call_added",
						"function_call_done",
						"encrypted_reasoning_done",
						"visible_summary_delta",
						"output_text_delta",
						"argument_delta",
						"completed",
						"incomplete",
						"failed",
						"error",
						"other",
					].map((k) => [k, Number.MAX_SAFE_INTEGER]),
				),
				rawVisibleEvents: Number.MAX_SAFE_INTEGER,
				meaningfulFrames: Number.MAX_SAFE_INTEGER,
				protocolFrames: Number.MAX_SAFE_INTEGER,
				providerTerminal: "resource_limit",
				gateOutcome: "buffer_limit",
				remainingCommitmentMs: Number.MAX_SAFE_INTEGER,
				cancellationOrigin: "semantic_deadline",
				diagnosis: "translation_or_gating_candidate",
			});
			ledger.recordPhysicalOutcome("buffer_limit");
		}
		const summary = ledger.terminalSummary({
			success: false,
			error: "route_unavailable",
			nativeStatus: 503,
			wireStatus: 200,
		});
		const encoded = JSON.stringify(summary);
		expect(encoded.length).toBeLessThanOrEqual(16384);
		expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(16384);
		expect(sanitizeRequestRoutingAttemptSummary(encoded)).toEqual(summary);
		expect(summary?.attempts).toHaveLength(16);
		expect(
			summary?.attempts.every(
				(a) => a.accountId === identity && a.cause === "buffer_limit",
			),
		).toBe(true);
		expect(summary?.terminalCause).toBe("buffer_limit");
		expect(summary?.completeness).toBe("partial");
		expect(summary?.truncated).toBe(true);
		const managed = `combo:${"c".repeat(36)}:managed:sonnet:rule:${"r".repeat(77)}:account:${"a".repeat(36)}`;
		const affinityLane = {
			...laneRecord,
			owner: {
				...laneRecord.owner,
				candidateId: managed,
				fallbackCandidateId: managed,
				accountId: "a".repeat(36),
			},
		};
		const withLane = ledger.terminalSummary({
			success: false,
			error: "route_unavailable",
			nativeStatus: 503,
			wireStatus: 200,
			affinityLane,
		});
		expect(withLane?.affinityLane).toEqual(affinityLane);
		expect(JSON.stringify(withLane).length).toBeLessThanOrEqual(16384);
		expect(
			sanitizeRequestRoutingAttemptSummary(JSON.stringify(withLane)),
		).toEqual(withLane);
		console.info(
			`maximal 16-attempt summary: without lane=${encoded.length}; with lane=${JSON.stringify(withLane).length}; before ladder=${JSON.stringify({ ...summary, affinityLane }).length}; block=${JSON.stringify(affinityLane).length}`,
		);
	});

	it("claims hosted dispatch exactly once and exposes its monotonic state", () => {
		const ledger = new RoutingAttemptLedger();

		expect(ledger.hostedDispatchState).toBe("undispatched");
		expect(ledger.claimHostedDispatch()).toBe(true);
		expect(ledger.hostedDispatchState).toBe("hosted_dispatched");
		expect(ledger.claimHostedDispatch()).toBe(false);
		expect(ledger.hostedDispatchState).toBe("hosted_dispatched");
	});

	it("exposes a monotonic native search dispatch state independent of hosted ownership", () => {
		const ledger = new RoutingAttemptLedger();

		expect(ledger.nativeSearchDispatchState).toBe("undispatched");
		ledger.markNativeSearchDispatched();
		ledger.markNativeSearchDispatched();
		expect(ledger.nativeSearchDispatchState).toBe("native_dispatched");
		expect(ledger.hostedDispatchState).toBe("undispatched");
	});

	it("allows exactly one competing microtask to claim hosted dispatch", async () => {
		const ledger = new RoutingAttemptLedger();
		const claims = await Promise.all(
			Array.from({ length: 8 }, async () => {
				await Promise.resolve();
				return ledger.claimHostedDispatch();
			}),
		);

		expect(claims.filter(Boolean)).toHaveLength(1);
		expect(ledger.hostedDispatchState).toBe("hosted_dispatched");
	});

	it("keeps hosted dispatch ownership independent from route claims", () => {
		const ledger = new RoutingAttemptLedger();

		expect(ledger.claim("account-a", "claude-opus-4-8")).toBe(true);
		expect(ledger.claimHostedDispatch()).toBe(true);
		expect(ledger.claim("account-a", "claude-fable-5")).toBe(true);
		expect(ledger.claim("account-a", "claude-opus-4-8")).toBe(false);

		expect(ledger.attemptedCount).toBe(2);
		expect(ledger.physicalAttemptCount).toBe(0);
		expect(ledger.hostedDispatchState).toBe("hosted_dispatched");
	});

	it("does not count hosted dispatch ownership as physical-attempt telemetry", () => {
		const ledger = new RoutingAttemptLedger();

		expect(ledger.claimHostedDispatch()).toBe(true);
		expect(ledger.physicalAttemptCount).toBe(0);
		expect(ledger.recordPhysicalAttempt()).toBe(1);
		expect(ledger.recordPhysicalAttempt()).toBe(2);
		expect(ledger.physicalAttemptCount).toBe(2);
		expect(ledger.claimHostedDispatch()).toBe(false);
	});

	it("admits exactly 32 physical transports and vetoes the 33rd without telemetry", () => {
		const ledger = new RoutingAttemptLedger();

		for (let ordinal = 1; ordinal <= MAX_REQUEST_PHYSICAL_ATTEMPTS; ordinal++) {
			expect(ledger.assertPhysicalAttemptAvailable()).toBeUndefined();
			expect(ledger.recordPhysicalAttempt()).toBe(ordinal);
		}

		expect(() => ledger.assertPhysicalAttemptAvailable()).toThrow(
			PhysicalAttemptBudgetExceededError,
		);
		expect(() => ledger.recordPhysicalAttempt()).toThrow(
			PhysicalAttemptBudgetExceededError,
		);
		expect(ledger.physicalAttemptCount).toBe(MAX_REQUEST_PHYSICAL_ATTEMPTS);
	});

	it("captures only low-cardinality next-route context at the veto boundary", () => {
		const ledger = new RoutingAttemptLedger();
		for (let attempt = 0; attempt < MAX_REQUEST_PHYSICAL_ATTEMPTS; attempt++) {
			ledger.recordPhysicalAttempt();
		}

		let exhausted: PhysicalAttemptBudgetExceededError | null = null;
		try {
			ledger.assertPhysicalAttemptAvailable({
				accountId: " account-next ",
				candidateId: " candidate-next ",
				laneKey: " lane-next ",
			});
		} catch (error) {
			if (error instanceof PhysicalAttemptBudgetExceededError) {
				exhausted = error;
			}
		}

		expect(exhausted).toMatchObject({
			nextAccountId: "account-next",
			nextCandidateId: "candidate-next",
			nextLaneKey: "lane-next",
		});
	});

	it("emits a stable non-recoverable terminal with physical and unique-route counts", async () => {
		const ledger = new RoutingAttemptLedger();
		expect(ledger.claim("account-a", "model-a")).toBe(true);
		expect(ledger.claim("account-b", "model-b")).toBe(true);
		for (let attempt = 0; attempt < MAX_REQUEST_PHYSICAL_ATTEMPTS; attempt++) {
			ledger.recordPhysicalAttempt();
		}

		let exhausted: PhysicalAttemptBudgetExceededError | null = null;
		try {
			ledger.recordPhysicalAttempt();
		} catch (error) {
			if (error instanceof PhysicalAttemptBudgetExceededError)
				exhausted = error;
		}
		expect(exhausted).not.toBeNull();
		const response = await exhausted?.terminalize();

		expect(response?.status).toBe(503);
		expect(response?.headers.get("retry-after")).toBeNull();
		expect(response?.headers.get("x-better-ccflare-pool-status")).toBeNull();
		expect(response?.headers.get("x-better-ccflare-recovery-scope")).toBeNull();
		expect(response?.headers.get("x-should-retry")).toBeNull();
		expect(await response?.json()).toEqual({
			type: "error",
			error: {
				type: "service_unavailable",
				code: "physical_attempt_budget_exhausted",
				message:
					"Request stopped after reaching the upstream transport safety limit.",
				physical_attempts: MAX_REQUEST_PHYSICAL_ATTEMPTS,
				physical_attempt_limit: MAX_REQUEST_PHYSICAL_ATTEMPTS,
				attempted_routes: 2,
			},
		});
	});

	it("runs bound terminal cleanup once when competing owners observe exhaustion", async () => {
		const ledger = new RoutingAttemptLedger();
		const terminalize = mock(
			async () => new Response("bounded", { status: 503 }),
		);
		ledger.bindPhysicalAttemptBudgetTerminal({
			requestId: "request-budget-once",
			terminalize,
		});
		for (let attempt = 0; attempt < MAX_REQUEST_PHYSICAL_ATTEMPTS; attempt++) {
			ledger.recordPhysicalAttempt();
		}
		const errors: PhysicalAttemptBudgetExceededError[] = [];
		try {
			ledger.recordPhysicalAttempt();
		} catch (error) {
			if (error instanceof PhysicalAttemptBudgetExceededError)
				errors.push(error);
		}
		try {
			ledger.recordPhysicalAttempt();
		} catch (error) {
			if (error instanceof PhysicalAttemptBudgetExceededError)
				errors.push(error);
		}
		const exhausted = errors[0];
		if (!exhausted) throw new Error("expected physical attempt exhaustion");

		const [first, second] = await Promise.all([
			exhausted.terminalize(),
			exhausted.terminalize(),
		]);

		expect(first).toBe(second);
		expect(errors).toHaveLength(2);
		expect(errors[1]).toBe(exhausted);
		expect(exhausted.requestId).toBe("request-budget-once");
		expect(terminalize).toHaveBeenCalledTimes(1);
	});

	it("claims each account and normalized concrete model only once", () => {
		const ledger = new RoutingAttemptLedger();

		expect(ledger.claim("account-a", " Claude-Opus-4-8 ")).toBe(true);
		expect(ledger.claim("account-a", "claude-opus-4-8")).toBe(false);
		expect(ledger.claim("account-a", "claude-fable-5")).toBe(true);
		expect(ledger.claim("account-b", "claude-opus-4-8")).toBe(true);
		expect(ledger.attemptedCount).toBe(3);
	});

	it("allows one bounded retry only for an existing unblocked route", () => {
		const ledger = new RoutingAttemptLedger();

		expect(ledger.claimRetry("account-a", "claude-opus-4-8")).toBe(false);
		expect(ledger.claim("account-a", "claude-opus-4-8")).toBe(true);
		expect(ledger.claimRetry("account-a", "claude-opus-4-8")).toBe(true);
		expect(ledger.claimRetry("account-a", "claude-opus-4-8")).toBe(false);
		expect(ledger.claimRetry("account-a", "claude-fable-5")).toBe(false);

		ledger.blockAccount("account-a");
		expect(ledger.claimRetry("account-a", "claude-opus-4-8")).toBe(false);
	});

	it("uses a stable null lane when no concrete model is available", () => {
		const ledger = new RoutingAttemptLedger();

		expect(ledger.claim("account-a", null)).toBe(true);
		expect(ledger.claim("account-a", undefined)).toBe(false);
		expect(ledger.claim("account-a", "   ")).toBe(false);
	});

	it("matches deterministic failures by endpoint capability and normalized model", () => {
		const ledger = new RoutingAttemptLedger();
		const officialOverflow = {
			failureKind: "authoritative_context_overflow",
			provider: "codex",
			endpoint: "https://chatgpt.com/backend-api/codex/responses",
			capabilityScope: "shared-subscription",
			model: " GPT-5.4 ",
		} as const;

		expect(ledger.hasDeterministicFailure(officialOverflow)).toBe(false);
		ledger.recordDeterministicFailure(officialOverflow);

		expect(
			ledger.hasDeterministicFailure({
				...officialOverflow,
				model: "gpt-5.4",
			}),
		).toBe(true);
		expect(
			ledger.hasDeterministicFailure({
				...officialOverflow,
				model: "gpt-5.6-sol",
			}),
		).toBe(false);
		expect(
			ledger.hasDeterministicFailure({
				...officialOverflow,
				endpoint: "https://custom.example.test/v1/responses",
			}),
		).toBe(false);
		expect(
			ledger.hasDeterministicFailure({
				...officialOverflow,
				capabilityScope: "account:credential-scoped-custom-route",
			}),
		).toBe(false);
	});

	it("blocks every sibling model after an account-wide failure", () => {
		const ledger = new RoutingAttemptLedger();

		expect(ledger.claim("account-a", "claude-opus-4-8")).toBe(true);
		expect(ledger.claim("account-a", "claude-fable-5")).toBe(true);

		ledger.blockAccount("account-a");

		expect(ledger.claim("account-a", "claude-haiku-4-5")).toBe(false);
		expect(ledger.claim("account-b", "claude-haiku-4-5")).toBe(true);
		expect(ledger.attemptedCount).toBe(3);
	});

	it("records one definitive auth failure per account and blocks sibling models", () => {
		const ledger = new RoutingAttemptLedger();

		ledger.recordAuthFailure("account-a", "oauth_invalid_grant");
		ledger.recordAuthFailure("account-a", "auth_failure");
		ledger.recordAuthFailure("account-b", "auth_failure");

		expect(ledger.hasAuthFailures).toBe(true);
		expect(ledger.authFailureCount).toBe(2);
		expect(ledger.authFailureEntries).toEqual([
			{ accountId: "account-a", reason: "oauth_invalid_grant" },
			{ accountId: "account-b", reason: "auth_failure" },
		]);
		expect(ledger.claim("account-a", "claude-opus-4-8")).toBe(false);
		expect(ledger.claim("account-b", "claude-opus-4-8")).toBe(false);
	});

	it("counts deferred concrete routes while excluding pretransport, duplicate, and blocked skips", () => {
		const ledger = new RoutingAttemptLedger();

		// Pretransport/cooldown skips never claim a route and therefore contribute
		// nothing. The initial transport and its deferred concrete-model route do.
		expect(ledger.claim("account-a", "claude-opus-4-8")).toBe(true);
		expect(ledger.claim("account-a", "provider-opus-fallback")).toBe(true);
		expect(ledger.claim("account-a", "provider-opus-fallback")).toBe(false);
		ledger.blockAccount("account-a");
		expect(ledger.claim("account-a", "provider-second-fallback")).toBe(false);

		expect(ledger.attemptedCount).toBe(2);
		expect(
			formatRoutingAttemptMessage(
				"All compatible upstream routes failed to proxy the request",
				ledger,
			),
		).toBe(
			"All compatible upstream routes failed to proxy the request (2 unique account/model routes attempted)",
		);
	});

	it("uses singular route wording for one concrete transport", () => {
		const ledger = new RoutingAttemptLedger();
		expect(ledger.claim("account-a", "claude-opus-4-8")).toBe(true);

		expect(
			formatRoutingAttemptMessage(
				"All compatible upstream routes failed to proxy the request",
				ledger,
			),
		).toBe(
			"All compatible upstream routes failed to proxy the request (1 unique account/model route attempted)",
		);
	});

	it("labels auth failures instead of presenting them as generic capacity", () => {
		const ledger = new RoutingAttemptLedger();
		ledger.claim("account-a", "claude-opus-4-8");
		ledger.recordAuthFailure("account-a", "oauth_invalid_grant");

		expect(
			formatRoutingAttemptMessage(
				"All compatible upstream routes failed to proxy the request",
				ledger,
			),
		).toBe(
			"All compatible upstream routes failed to proxy the request (1 unique account/model route attempted; upstream authentication failed for 1 account)",
		);
	});

	it("transfers one retained terminal response and disposes replacements exactly once", async () => {
		const ledger = new RoutingAttemptLedger();
		const firstDiscard = mock(async () => undefined);
		const secondDiscard = mock(async () => undefined);
		const deliver = mock(
			async (failoverAttempts: number) =>
				new Response(String(failoverAttempts), { status: 529 }),
		);

		await ledger.retainTerminalResponse({
			deliver,
			discard: firstDiscard,
		});
		await ledger.retainTerminalResponse({
			deliver,
			discard: secondDiscard,
		});

		expect(firstDiscard).toHaveBeenCalledTimes(1);
		expect(secondDiscard).not.toHaveBeenCalled();
		const retained = ledger.takeTerminalResponse();
		expect(retained).not.toBeNull();
		const response = await retained?.deliver(3);
		expect(response?.status).toBe(529);
		expect(await response?.text()).toBe("3");
		expect(ledger.takeTerminalResponse()).toBeNull();
		expect(secondDiscard).not.toHaveBeenCalled();
	});

	it("keeps authoritative context overflow ahead of a later legacy terminal", async () => {
		const ledger = new RoutingAttemptLedger();
		const authoritativeDiscard = mock(async () => undefined);
		const legacyDiscard = mock(async () => undefined);

		await ledger.retainTerminalResponse({
			terminalKind: "authoritative_context_overflow",
			deliver: async () =>
				new Response("authoritative", {
					status: 400,
					headers: { "x-upstream-proof": "authoritative" },
				}),
			discard: authoritativeDiscard,
		});
		await ledger.retainTerminalResponse({
			terminalKind: "legacy_context_overflow",
			deliver: async () => new Response("legacy", { status: 400 }),
			discard: legacyDiscard,
		});

		expect(authoritativeDiscard).not.toHaveBeenCalled();
		expect(legacyDiscard).toHaveBeenCalledTimes(1);
		const retained = ledger.takeTerminalResponse();
		const response = await retained?.deliver(2);
		expect(response?.headers.get("x-upstream-proof")).toBe("authoritative");
	});

	it("keeps context overflow ahead of a later untyped terminal", async () => {
		const ledger = new RoutingAttemptLedger();
		const contextDiscard = mock(async () => undefined);
		const untypedDiscard = mock(async () => undefined);

		await ledger.retainTerminalResponse({
			terminalKind: "legacy_context_overflow",
			deliver: async () => new Response("context", { status: 400 }),
			discard: contextDiscard,
		});
		await ledger.retainTerminalResponse({
			deliver: async () => new Response("model unavailable", { status: 503 }),
			discard: untypedDiscard,
		});

		expect(contextDiscard).not.toHaveBeenCalled();
		expect(untypedDiscard).toHaveBeenCalledTimes(1);
		const response = await ledger.takeTerminalResponse()?.deliver(1);
		expect(response?.status).toBe(400);
		expect(await response?.text()).toBe("context");
	});

	it("discards retained terminal ownership idempotently", async () => {
		const ledger = new RoutingAttemptLedger();
		const discard = mock(async () => undefined);

		await ledger.retainTerminalResponse({
			deliver: async () => new Response(null, { status: 529 }),
			discard,
		});
		await ledger.discardTerminalResponse();
		await ledger.discardTerminalResponse();

		expect(discard).toHaveBeenCalledTimes(1);
	});

	it("reconciles physical send ordinals without changing unique route claims", () => {
		const ledger = new RoutingAttemptLedger();

		expect(ledger.claim("account-a", "claude-opus-4-8")).toBe(true);
		expect(ledger.recordPhysicalAttempt()).toBe(1);
		expect(ledger.recordPhysicalAttempt()).toBe(2);
		expect(ledger.claim("account-a", "claude-opus-4-8")).toBe(false);
		expect(ledger.recordPhysicalAttempt()).toBe(3);

		expect(ledger.attemptedCount).toBe(1);
		expect(ledger.physicalAttemptCount).toBe(3);
	});

	it("stamps every terminal summary with the serving process start", () => {
		expect(Number.isSafeInteger(PROCESS_STARTED_AT_MS)).toBe(true);
		expect(PROCESS_STARTED_AT_MS).toBeLessThanOrEqual(Date.now());

		const succeeded = new RoutingAttemptLedger();
		succeeded.recordPhysicalAttempt({ accountId: "account-a" });
		expect(
			succeeded.terminalSummary({
				success: true,
				nativeStatus: 200,
				wireStatus: 200,
			})?.processStartedAt,
		).toBe(PROCESS_STARTED_AT_MS);

		const rejected = new RoutingAttemptLedger();
		expect(
			rejected.terminalSummary({
				success: false,
				error: "route_unavailable",
				nativeStatus: 503,
				wireStatus: 503,
			})?.processStartedAt,
		).toBe(PROCESS_STARTED_AT_MS);
	});

	it("keeps a valid process start through persistence and omits it on older summaries", () => {
		const base = {
			version: 1,
			physicalAttemptCount: 0,
			routeCount: 0,
			attempts: [],
			completeness: "complete",
		};
		const stamped = sanitizeRequestRoutingAttemptSummary({
			...base,
			processStartedAt: 1_793_346_681_263,
		});
		expect(stamped?.processStartedAt).toBe(1_793_346_681_263);
		expect(
			sanitizeRequestRoutingAttemptSummary(JSON.stringify(stamped)),
		).toEqual(stamped);

		const legacy = sanitizeRequestRoutingAttemptSummary(base);
		expect(legacy).not.toBeNull();
		expect(legacy && "processStartedAt" in legacy).toBe(false);

		for (const invalid of [-1, 1.5, "2026-10-30T00:00:00Z", Number.NaN, null]) {
			expect(
				sanitizeRequestRoutingAttemptSummary({
					...base,
					processStartedAt: invalid,
				})?.processStartedAt,
			).toBeNull();
		}
	});
});
