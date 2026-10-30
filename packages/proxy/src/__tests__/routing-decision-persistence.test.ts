import { describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import { SessionAffinityStrategy } from "@better-ccflare/load-balancer";
import type { RequestMeta } from "@better-ccflare/types";
import {
	sanitizeRequestRoutingAttemptSummary,
	sanitizeRoutingDecision,
} from "@better-ccflare/types/request";
import { RoutingAttemptLedger } from "../handlers/routing-attempt-ledger";
import {
	captureRoutingDecision,
	completeRoutingSelectionStage,
	freezeRoutingDecisionConstraints,
	observeRoutingCapacity,
	observeRoutingSelectionCandidate,
	routingDiagnosticCandidateKey,
	routingSelectionStageSnapshot,
} from "../handlers/routing-selection-diagnostics";
import {
	getRequestLifecycleCoordinator,
	recordRoutingTerminalRequest,
} from "../routing-terminal-recorder";
import type { EndMessage, StartMessage } from "../worker-messages";

describe("affinity lane finalization", () => {
	function lifecycle() {
		let now = 1_793_346_681_000;
		const m = { ...meta(), clientSessionId: "finalize-client" };
		const strategy = new SessionAffinityStrategy(
			undefined,
			undefined,
			undefined,
			undefined,
			() => now,
		);
		const owner = { candidateId: "account:owner", accountId: "owner" };
		strategy.commitAffinityOwner(m, owner);
		const ledger = new RoutingAttemptLedger();
		ledger.recordPhysicalAttempt({ accountId: "owner", provider: "test" });
		const coordinator = getRequestLifecycleCoordinator(m);
		const ends: EndMessage[] = [];
		const errors: unknown[] = [];
		const collector = {
			handleStart: (_message: StartMessage) => {},
			handleEnd: async (message: EndMessage) => {
				ends.push(message);
			},
		};
		return {
			m,
			strategy,
			owner,
			ledger,
			coordinator,
			ends,
			errors,
			collector,
			setNow: (value: number) => {
				now = value;
			},
			start: () =>
				coordinator.start({
					collector,
					onError: (error) => errors.push(error),
					message: {
						requestId: m.id,
						responseStatus: 200,
						accountId: "owner",
					} as StartMessage,
				}),
		};
	}

	it("records successful owner state at finalize rather than bind", async () => {
		const t = lifecycle();
		t.coordinator.bindRoutingObservation(
			t.ledger,
			(status) => status,
			() => t.strategy.exportAffinityLaneRecord(t.m),
		);
		t.start();
		t.setNow(1_793_346_681_500);
		t.strategy.commitAffinityOwner(t.m, t.owner);
		await t.coordinator.finalize({
			type: "end",
			requestId: t.m.id,
			success: true,
		});
		expect(t.ends[0].routingAttemptSummary?.affinityLane).toMatchObject({
			observedAt: 1_793_346_681_500,
			owner: {
				...t.owner,
				assignedAt: 1_793_346_681_500,
				installedBelowBestConfiguredTier: false,
			},
		});
	});
	it("observes a deferred request at release and calls the closure once", async () => {
		const t = lifecycle();
		let calls = 0;
		t.coordinator.bindRoutingObservation(
			t.ledger,
			(status) => status,
			() => {
				calls++;
				return t.strategy.exportAffinityLaneRecord(t.m);
			},
		);
		t.start();
		t.coordinator.deferFinalization();
		await t.coordinator.finalize({
			type: "end",
			requestId: t.m.id,
			success: true,
		});
		expect(calls).toBe(0);
		expect(t.ends).toHaveLength(0);
		t.setNow(1_793_346_682_000);
		t.strategy.commitAffinityOwner(t.m, t.owner);
		await t.coordinator.releaseFinalization();
		await t.coordinator.releaseFinalization();
		expect(calls).toBe(1);
		expect(
			t.ends[0].routingAttemptSummary?.affinityLane?.owner?.assignedAt,
		).toBe(1_793_346_682_000);
	});
	it("records a local routing terminal's current owner", async () => {
		const t = lifecycle();
		t.coordinator.bindRoutingObservation(
			t.ledger,
			(status) => status,
			() => t.strategy.exportAffinityLaneRecord(t.m),
		);
		t.setNow(1_793_346_683_000);
		t.strategy.commitAffinityOwner(t.m, t.owner);
		await recordRoutingTerminalRequest({
			collector: t.collector,
			requestMeta: t.m,
			requestHeaders: new Headers(),
			response: new Response(null, { status: 503 }),
			providerName: "test",
			terminalKind: "route_unavailable",
			upstreamAttempts: 1,
		});
		expect(t.ends[0].routingAttemptSummary?.affinityLane).toMatchObject({
			observedAt: 1_793_346_683_000,
			owner: { ...t.owner, assignedAt: 1_793_346_683_000 },
		});
	});
	it("reports a throwing lane recorder and keeps the rest of the summary", async () => {
		const t = lifecycle();
		const failure = new Error("synthetic lane export failure");
		t.coordinator.bindRoutingObservation(
			t.ledger,
			(status) => status,
			() => {
				throw failure;
			},
		);
		t.start();
		await t.coordinator.finalize({
			type: "end",
			requestId: t.m.id,
			success: true,
		});
		expect(t.errors).toEqual([failure]);
		expect(t.ends[0].routingAttemptSummary).toMatchObject({
			physicalAttemptCount: 1,
			processStartedAt: expect.any(Number),
			winnerOrdinal: 1,
		});
		expect(t.ends[0].routingAttemptSummary?.affinityLane).toBeUndefined();
	});
	it("records only the final fallback rung's lane, leaving the earlier rung's prior record", async () => {
		const t = lifecycle();
		const firstLane = JSON.stringify([
			"routing-lane-profile-v1",
			"session",
			"requested-model",
		]);
		const finalLane = JSON.stringify([
			"routing-lane-profile-v1",
			"session",
			"root-model",
		]);
		t.m.affinityLaneKey = firstLane;
		t.strategy.commitAffinityOwner(t.m, {
			candidateId: "profile:requested:account:first",
			accountId: "first",
		});
		const prior = new RoutingAttemptLedger().terminalSummary({
			success: true,
			nativeStatus: 200,
			wireStatus: 200,
			affinityLane: t.strategy.exportAffinityLaneRecord(t.m),
		});
		t.coordinator.bindRoutingObservation(
			t.ledger,
			(status) => status,
			() => t.strategy.exportAffinityLaneRecord(t.m),
		);
		t.start();
		t.ledger.recordPhysicalOutcome("upstream_error");
		t.m.affinityLaneKey = finalLane;
		t.setNow(1_793_346_684_000);
		t.strategy.commitAffinityOwner(t.m, {
			candidateId: "profile:root:account:final",
			accountId: "final",
		});
		t.ledger.recordPhysicalAttempt({ accountId: "final", provider: "test" });
		await t.coordinator.finalize({
			type: "end",
			requestId: t.m.id,
			success: true,
		});
		expect(t.ends[0].routingAttemptSummary?.affinityLane?.owner).toMatchObject({
			candidateId: "profile:root:account:final",
			accountId: "final",
			assignedAt: 1_793_346_684_000,
		});
		expect(t.ends[0].routingAttemptSummary?.affinityLane?.digest).not.toBe(
			prior?.affinityLane?.digest,
		);
		expect(prior?.affinityLane?.owner).toMatchObject({
			candidateId: "profile:requested:account:first",
			assignedAt: 1_793_346_681_000,
		});
		expect(
			t.strategy.exportAffinityLaneRecord({
				...t.m,
				affinityLaneKey: firstLane,
			})?.owner,
		).toEqual({
			candidateId: "profile:requested:account:first",
			accountId: "first",
			assignedAt: 1_793_346_681_000,
			installedBelowBestConfiguredTier: false,
		});
	});
});

const diagnostics = {
	mode: "enforce" as const,
	structuralCandidateCount: 2,
	eligibleCandidateCount: 0,
	excludedCandidateCount: 2,
	selectedCandidateCount: 0,
	zeroAttemptReason: "policy_excluded" as const,
	forcedRoute: false,
	capabilityProfile: false,
	routeProfile: false,
	reasonEvidence: "exact" as const,
};
function meta(path = "/v1/messages"): RequestMeta {
	return {
		id: crypto.randomUUID(),
		timestamp: Date.now(),
		method: "POST",
		path,
		requestedLogicalModel: "changed-model",
		routingRequestedLogicalModel: "claude-opus-4-6",
		routingSelectionDiagnostics: diagnostics,
	} as RequestMeta;
}
async function record(
	m: RequestMeta,
	kind = "route_unavailable",
	skip = false,
) {
	const starts: StartMessage[] = [];
	const ends: EndMessage[] = [];
	const ledger = new RoutingAttemptLedger();
	getRequestLifecycleCoordinator(m).bindRoutingObservation(
		ledger,
		(status) => status,
	);
	const options = {
		collector: {
			handleStart(v: StartMessage) {
				starts.push(v);
			},
			async handleEnd(v: EndMessage) {
				ends.push(v);
			},
		},
		requestMeta: m,
		requestHeaders: new Headers(),
		response: new Response("wire unchanged", { status: 503 }),
		providerName: "test",
		terminalKind: kind,
		upstreamAttempts: 0,
		skip,
	};
	await recordRoutingTerminalRequest(options);
	await recordRoutingTerminalRequest(options);
	return { starts, ends, options };
}
describe("local terminal decision persistence", () => {
	it.each([
		"/v1/messages",
		"/v1/messages/count_tokens",
	])("retains typed intent and exact refusal on %s once without inventing a winner", async (path) => {
		const { starts, ends, options } = await record(meta(path));
		expect(starts).toHaveLength(1);
		expect(ends).toHaveLength(1);
		expect(starts[0].path).toBe(path);
		expect(starts[0].accountId).toBeNull();
		expect(ends[0].routingAttemptSummary).toMatchObject({
			physicalAttemptCount: 0,
			attempts: [],
			winnerOrdinal: null,
			terminalCause: "routing_rejected",
			decision: {
				requestedLogicalModel: "claude-opus-4-6",
				operation: path.endsWith("count_tokens") ? "count_tokens" : "messages",
				reason: "policy_excluded",
				evidence: "exact",
			},
		});
		expect(await options.response.text()).toBe("wire unchanged");
	});
	it("freezes its first decision before late selector metadata changes", async () => {
		const m = meta();
		const { ends, options } = await record(m);
		m.routingSelectionDiagnostics = {
			...diagnostics,
			zeroAttemptReason: "all_unavailable",
		};
		m.requestedLogicalModel = "late-model";
		await recordRoutingTerminalRequest(options);
		expect(ends).toHaveLength(1);
		expect(ends[0].routingAttemptSummary).toMatchObject({
			decision: {
				reason: "policy_excluded",
				requestedLogicalModel: "claude-opus-4-6",
			},
		});
	});
	it("keeps trusted probe exclusion", async () => {
		const { starts, ends } = await record(meta(), "route_unavailable", true);
		expect(starts).toHaveLength(0);
		expect(ends).toHaveLength(0);
	});
	it("reports inventory failure as unknown evidence rather than an empty pool", async () => {
		const m = meta();
		Object.assign(m, {
			routingInventoryOutcome: "failed",
			routingSelectionDiagnostics: null,
		});
		const { ends } = await record(m);
		expect(ends[0].routingAttemptSummary).toMatchObject({
			decision: {
				inventory: "failed",
				reason: "inventory_failed",
				evidence: "exact",
			},
		});
	});
	it("rejects unsafe identities/counts and bounds decision without dropping physical evidence", () => {
		const base = {
			version: 1,
			physicalAttemptCount: 0,
			routeCount: 0,
			attempts: [],
			truncated: false,
			completeness: "complete",
			winnerOrdinal: null,
			outputOriginOrdinal: null,
			nativeStatus: 503,
			wireStatus: 503,
			terminalCause: "routing_rejected",
			cancellationOrigin: null,
		};
		const clean = sanitizeRequestRoutingAttemptSummary({
			...base,
			decision: {
				version: 1,
				requestedLogicalModel: "unsafe model\nsecret",
				operation: "messages",
				origin: "unknown",
				reason: "policy_excluded",
				evidence: "exact",
				inventory: "complete",
				constraints: {},
				selection: {
					...diagnostics,
					structuralCandidateCount: -1,
					eligibleCandidateCount: 0.5,
				},
				stages: [],
			},
		});
		expect(clean).toMatchObject({
			decision: {
				requestedLogicalModel: null,
				selection: {
					structuralCandidateCount: null,
					eligibleCandidateCount: null,
				},
			},
			completeness: "partial",
		});
		const huge = sanitizeRequestRoutingAttemptSummary({
			...base,
			decision: { version: 1, prompt: "secret".repeat(5000) },
		});
		expect(huge).toMatchObject({
			attempts: [],
			decision: null,
			decisionGap: "oversize",
			completeness: "partial",
		});
		expect(JSON.stringify(clean)).not.toContain("secret");
	});
});

it("counts the first exclusion per candidate/stage without summing distinct stage denominators", () => {
	const m = meta();
	observeRoutingSelectionCandidate(m, "provider_constraint", "a", null);
	observeRoutingSelectionCandidate(
		m,
		"provider_constraint",
		"a",
		"provider_excluded",
	);
	observeRoutingSelectionCandidate(
		m,
		"provider_constraint",
		"a",
		"provider_mismatch",
	);
	observeRoutingSelectionCandidate(m, "provider_constraint", "b", null);
	completeRoutingSelectionStage(m, "provider_constraint");
	observeRoutingSelectionCandidate(m, "capacity", "b:model", "model_capacity");
	completeRoutingSelectionStage(m, "capacity");
	expect(routingSelectionStageSnapshot(m)).toEqual([
		{
			stage: "provider_constraint",
			observed: 2,
			excluded: 1,
			complete: true,
			reasons: { provider_excluded: 1 },
		},
		{
			stage: "capacity",
			observed: 1,
			excluded: 1,
			complete: true,
			reasons: { model_capacity: 1 },
		},
	]);
});
it("bounds candidate retention and marks saturation incomplete", () => {
	const m = meta();
	for (let i = 0; i < 4097; i++)
		observeRoutingSelectionCandidate(m, "capacity", String(i), null);
	completeRoutingSelectionStage(m, "capacity");
	expect(routingSelectionStageSnapshot(m)).toMatchObject([
		{ observed: 4096, complete: false },
	]);
});
it("preserves missing original model and trusted helper purpose without inferring it from messages path", () => {
	const m = meta();
	m.routingRequestedLogicalModel = null;
	expect(captureRoutingDecision(m, "route_unavailable")).toMatchObject({
		requestedLogicalModel: null,
		origin: "unknown",
	});
	m.routeLineage = { kind: "helper", childHomeKey: null };
	expect(captureRoutingDecision(m, "route_unavailable")).toMatchObject({
		origin: "trusted_helper",
		operation: "messages",
	});
});
it("rejects every invalid integer observation rather than claiming zero", () => {
	for (const bad of [-1, 0.5, NaN, Infinity, 1_000_001]) {
		const decision = captureRoutingDecision(meta(), "route_unavailable");
		const result = sanitizeRequestRoutingAttemptSummary({
			version: 1,
			physicalAttemptCount: 0,
			routeCount: 0,
			attempts: [],
			completeness: "complete",
			decision: {
				...decision,
				selection: { ...decision.selection, structuralCandidateCount: bad },
			},
		});
		expect(result).toMatchObject({
			completeness: "partial",
			decisionGap: "invalid",
			decision: { selection: { structuralCandidateCount: null } },
		});
	}
});

it("separates absent snapshot evidence from actual capacity exclusion and bounds age/expiry", () => {
	const m = meta();
	observeRoutingCapacity(m, "a:model", null, null, 1_000);
	observeRoutingCapacity(m, "b:model", 0, 3_000, 1_000);
	observeRoutingCapacity(m, "b:model", 900, null, 1_000);
	expect(captureRoutingDecision(m, "route_unavailable")).toMatchObject({
		capacity: {
			observed: 2,
			missingSnapshot: 1,
			oldestSnapshotAgeMs: 1_000,
			earliestBlockerExpiryMs: 2_000,
			saturated: false,
		},
	});
	observeRoutingCapacity(m, "c:model", 0, 172_800_000, 86_400_001);
	expect(captureRoutingDecision(m, "route_unavailable")).toMatchObject({
		capacity: { oldestSnapshotAgeMs: 86_400_000, saturated: true },
	});
});

it("retains real physical attempts and first semantic cause when a decision exceeds its budget", () => {
	const ledger = new RoutingAttemptLedger();
	ledger.recordPhysicalAttempt({
		accountId: "actual",
		provider: "codex",
		logicalModel: "logical",
		physicalModel: "physical",
	});
	ledger.recordPhysicalOutcome("meaningful_progress_timeout");
	ledger.observeRoutingDecision({
		...captureRoutingDecision(meta(), "route_unavailable"),
		requestedLogicalModel: "x".repeat(3000),
	});
	const summary = ledger.terminalSummary({
		success: false,
		error: "route_unavailable",
		nativeStatus: 503,
		wireStatus: 200,
	});
	expect(summary).toMatchObject({
		physicalAttemptCount: 1,
		attempts: [
			{
				accountId: "actual",
				physicalModel: "physical",
				cause: "meaningful_progress_timeout",
			},
		],
		winnerOrdinal: null,
		terminalCause: "meaningful_progress_timeout",
		decision: null,
		decisionGap: "oversize",
		completeness: "partial",
	});
});
it("keeps equal selection cardinalities distinguishable by their actual policy or unavailable evidence", () => {
	const a = captureRoutingDecision(meta(), "route_unavailable");
	const m = meta();
	m.routingSelectionDiagnostics = {
		...diagnostics,
		zeroAttemptReason: "all_unavailable",
		reasonEvidence: "inferred",
	};
	const b = captureRoutingDecision(m, "route_unavailable");
	expect(a.selection).toMatchObject({
		structuralCandidateCount: 2,
		eligibleCandidateCount: 0,
	});
	expect(b.selection).toMatchObject({
		structuralCandidateCount: 2,
		eligibleCandidateCount: 0,
	});
	expect(a).toMatchObject({ reason: "policy_excluded", evidence: "exact" });
	expect(b).toMatchObject({ reason: "all_unavailable", evidence: "inferred" });
});

it("rejects malformed enum evidence and drops arbitrary content", () => {
	const decision = captureRoutingDecision(meta(), "route_unavailable");
	const result = sanitizeRequestRoutingAttemptSummary({
		version: 1,
		physicalAttemptCount: 0,
		routeCount: 0,
		attempts: [],
		completeness: "complete",
		decision: {
			...decision,
			reason: "secret-prompt",
			evidence: "certain",
			prompt: "do-not-retain",
		},
	});
	expect(result).toMatchObject({
		completeness: "partial",
		decisionGap: "invalid",
		decision: { reason: "unknown", evidence: "unknown" },
	});
	expect(JSON.stringify(result)).not.toContain("secret-prompt");
	expect(JSON.stringify(result)).not.toContain("do-not-retain");
});

it("freezes declared profile constraints before authorized fallback mutates working route metadata", () => {
	const m = meta();
	m.routeProfileId = "declared-profile";
	m.routeExpectedProvider = "codex";
	m.routeProfileExpectedPhysicalModel = "original-physical";
	freezeRoutingDecisionConstraints(m);
	m.routeProfileId = null;
	m.routeExpectedProvider = "other-provider";
	m.routeExpectedPhysicalModel = "fallback-physical";
	expect(captureRoutingDecision(m, "route_unavailable")).toMatchObject({
		constraints: {
			routeProfile: true,
			profileId: "declared-profile",
			provider: "codex",
			physicalModel: "original-physical",
		},
	});
});

it("does not retain oversized or unsafe observation keys or claim complete evidence", () => {
	const m = meta();
	const huge = "x".repeat(1_000_000);
	for (const key of [huge, "unsafe prompt arguments"]) {
		expect(() =>
			observeRoutingSelectionCandidate(m, "capacity", key, "model_capacity"),
		).not.toThrow();
		expect(() =>
			observeRoutingCapacity(m, key, null, null, 1_000),
		).not.toThrow();
	}
	completeRoutingSelectionStage(m, "capacity");
	expect(routingSelectionStageSnapshot(m)).toMatchObject([
		{ observed: 0, excluded: 0, complete: false },
	]);
	expect(captureRoutingDecision(m, "route_unavailable")).toMatchObject({
		capacity: { observed: 0, saturated: true },
	});
});
it("returns an invalid evidence gap when serialization yields undefined", () => {
	for (const value of [() => undefined, { toJSON: () => undefined }])
		expect(sanitizeRoutingDecision(value)).toEqual({
			decision: null,
			gap: "invalid",
		});
});

it("bounds account and model identities before diagnostic serialization without changing caller inputs", () => {
	const hugeModel = "x".repeat(1_000_000);
	for (const model of [hugeModel, "prompt with unsafe arguments"]) {
		expect(() => routingDiagnosticCandidateKey("account", model)).not.toThrow();
		expect(routingDiagnosticCandidateKey("account", model)).toBeNull();
	}
	const safe = routingDiagnosticCandidateKey("a".repeat(128), "m".repeat(128));
	expect(safe?.length).toBe(263);
	expect(routingDiagnosticCandidateKey("unsafe account", "model")).toBeNull();
	expect(hugeModel.length).toBe(1_000_000);
});
