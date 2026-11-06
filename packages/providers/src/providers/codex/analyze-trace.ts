/** Analyze Codex JSONL traces without retaining prompt content. */
import { readFileSync } from "node:fs";
import {
	type CacheUsageObservation,
	summarizeCacheReadObservations,
} from "@better-ccflare/core";
import { classifyCodexModelFamily } from "./model-family";

interface ToolCall {
	name: string;
	arg_preview: string;
}

interface InputFingerprint {
	index: number;
	bytes: number;
	hmac: string;
}

/**
 * One JSONL trace line. Records from trace schema 22 and earlier can also
 * carry the retired canary fields (cache_key_assignment, pacing_canary,
 * pacing_action, explicit_breakpoint_*, ...); the analyzer ignores them.
 */
export interface TraceRecord {
	trace_schema_version?: number;
	phase?: "request" | "response" | "attempt_aborted";
	ts?: string;
	request_id?: string | null;
	attempt_id?: string | null;
	attempt_ordinal?: number | null;
	attempt_cause?: string | null;
	model_in?: string | null;
	model_out?: string | null;
	account?: string | null;
	cache_key_mode?: "conversation" | "session" | null;
	conversation_id?: string | null;
	cache_key_continuity_basis?:
		| "derived"
		| "identity_match"
		| "lineage_match"
		| "rejected"
		| "session"
		| "ineligible"
		| string
		| null;
	cache_key_continuity_applied?: boolean | null;
	continuity_evidence_id?: string | null;
	canonical_conversation_id?: string | null;
	pacing_cohort_id?: string | null;
	pacing_role?: "leader" | "follower" | string | null;
	pacing_wait_ms?: number | null;
	pacing_release_reason?: "leader" | "cap" | string | null;
	input_item_count?: number;
	input_item_total_count?: number;
	input_item_fingerprints?: InputFingerprint[];
	input_item_fingerprints_truncated?: boolean;
	approx_input_chars?: number;
	history_function_call_count?: number;
	history_empty_output_count?: number;
	nudge_count?: number;
	history_tool_use_by_name?: Record<string, number>;
	session_key_hash?: string | null;
	prompt_cache_key_set?: boolean;
	prompt_cache_key_id?: string | null;
	affinity_session_identity?: "derived" | "client" | null;
	affinity_routing_hint?: boolean;
	instructions_hmac?: string | null;
	tools_hmac?: string | null;
	new_tool_call_count?: number;
	new_subagent_spawn_count?: number;
	new_tool_use_by_name?: Record<string, number>;
	new_tool_calls?: ToolCall[];
	stop_reason?: "tool_use" | "end_turn" | "max_tokens" | "refusal" | "error";
	usage_measurement_available?: boolean;
	cache_measurement_available?: boolean;
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	cache_creation_measurement_available?: boolean;
	cache_hit_pct?: number | null;
	context_utilization_pct?: number | null;
	error_type?: string;
	error_message?: string;
	error_code?: string;
	error_status?: string;
}

const LARGE_INPUT_TOKENS = 50_000;

export interface CacheCohortStats {
	responses: number;
	avgCacheHitPct: number | null;
	zeroHitResponses: number;
	largeResponses: number;
	largeAvgCacheHitPct: number | null;
	largeZeroHitResponses: number;
}

interface StabilityStats {
	stable: number;
	changed: number;
	unavailable: number;
}

interface ContextBandStats {
	responses: number;
	terminals: Record<string, number>;
	zeroCacheResponses: number;
	weightedCacheReusePct: number | null;
}

interface ContextBandAccumulator extends ContextBandStats {
	inputTokens: number;
	cacheReadInputTokens: number;
}

export type CacheKeyContinuityBasis =
	| "derived"
	| "identity_match"
	| "lineage_match"
	| "rejected"
	| "session"
	| "ineligible"
	| "unknown";
export type CacheKeyContinuityApplication = "canonical" | "derived" | "unknown";

export interface CacheKeyContinuityRow {
	basis: CacheKeyContinuityBasis;
	application: CacheKeyContinuityApplication;
	model: string;
	turn: CacheExperimentTurn;
	gapBand: CacheExperimentGapBand;
	requests: number;
	joinedResponses: number;
	unjoinedRequests: number;
	measuredResponses: number;
	weightedCachedReadPct: number | null;
	positiveHitResponses: number;
	positiveHitRatePct: number | null;
	zeroHitResponses: number;
	cacheWriteMeasuredResponses: number;
	cacheWriteUnavailableResponses: number;
	cacheWriteTokens: number;
	compactionContinuations: number;
	keyRotations: number;
	distinctEffectiveKeys: number;
	maxRequestsPerKeyMinute: number;
	keysOver15RequestsPerMinute: number;
}

export interface CacheKeyContinuityReport {
	rows: CacheKeyContinuityRow[];
}

export interface TraceReport {
	requests: number;
	responses: number;
	logicalRequests: number;
	attempts: number;
	joins: {
		missing: number;
		ambiguous: number;
		schema9MissingAttemptId: number;
	};
	cacheDenominators: {
		attemptInclusive: {
			measuredResponses: number;
			weightedCacheReusePct: number | null;
		};
		finalResponseOnly: {
			measuredResponses: number;
			weightedCacheReusePct: number | null;
		};
	};
	readiness: {
		maxRequestsPerKeyMinute: number;
		keysOver15RequestsPerMinute: number;
	};
	continuity: CacheKeyContinuityReport;
	span: { first?: string; last?: string };
	request: {
		maxHistoryToolCalls: number;
		maxInputItems: number;
		maxApproxInputChars: number;
		totalNudges: number;
		distinctSessions: number;
		topSessions: Array<{ session: string; requests: number }>;
		fingerprintCoverage: { usable: number; missing: number; truncated: number };
		prefixTransitions: {
			retainedExactPriorFullPrefix: number;
			measurableChanged: number;
			unavailableAbsentFingerprints: number;
			unavailableRetentionWindow: number;
		};
		instructionStability: StabilityStats;
		toolStability: StabilityStats;
	};
	response: {
		totalNewToolCalls: number;
		maxNewFanOut: number;
		totalSubagentSpawns: number;
		maxSubagentSpawns: number;
		cacheCohorts: { keyOn: CacheCohortStats; keyOff: CacheCohortStats };
		unjoinedResponses: number;
		newFanOutHistogram: Record<string, number>;
		newToolUseByName: Record<string, number>;
		stopReasons: Record<string, number>;
		textOnlyResponses: number;
		errors: Record<string, number>;
		errorCodes: Record<string, number>;
		errorStatuses: Record<string, number>;
		cacheHitPctAvg: number | null;
		weightedCacheReusePct: number | null;
		zeroCacheResponses: number;
		contextBands: {
			under50: ContextBandStats;
			from50To80: ContextBandStats;
			from80To95: ContextBandStats;
			atLeast95: ContextBandStats;
			unavailable: ContextBandStats;
		};
		usage: {
			inputTokens: number;
			outputTokens: number;
			cacheReadInputTokens: number;
			cacheCreationInputTokens: number;
			availableResponses: number;
			unavailableResponses: number;
		};
		respawnResponses: number;
		worstRespawns: Array<{
			request_id: string | null;
			tool: string;
			count: number;
		}>;
	};
}

export type CacheExperimentTurn =
	| "first_observed"
	| "follow_up_observed"
	| "unknown";
export type CacheExperimentGapBand =
	| "under_1m"
	| "from_1m_to_5m"
	| "from_5m_to_15m"
	| "from_15m_to_60m"
	| "at_least_60m"
	| "unknown";

export interface CacheExperimentRow {
	model: string;
	turn: CacheExperimentTurn;
	gapBand: CacheExperimentGapBand;
	observedCodexAttempts: number;
	joinedObservedCodexResponses: number;
	unjoinedObservedCodexAttempts: number;
	cache: {
		measuredResponses: number;
		unavailableResponses: number;
		overflowResponses: number;
		inputTokens: number;
		cachedReadTokens: number;
		weightedCachedReadPct: number | null;
		/**
		 * Per-response cache-read share distribution (percentage, 0-100,
		 * rounded to one decimal), over MEASURED responses only (same gate as
		 * weightedCachedReadPct) -- null when there are none. #204: a handful
		 * of very large requests can swamp the token-weighted average while
		 * the median stays representative of a typical response, and the two
		 * can point in opposite directions on real data. Never report
		 * weightedCachedReadPct without medianCachedReadPct alongside it (see
		 * the #174 retraction, caused by quoting one statistic alone).
		 */
		medianCachedReadPct: number | null;
		p25CachedReadPct: number | null;
		p75CachedReadPct: number | null;
		cacheWriteMeasuredResponses: number;
		cacheWriteUnavailableResponses: number;
		cacheWriteOverflowResponses: number;
		cacheWriteTokens: number;
		positiveHitResponses: number;
		positiveHitRatePct: number | null;
	};
	elapsed: {
		availableResponses: number;
		unavailableResponses: number;
		p50Ms: number | null;
		p95Ms: number | null;
	};
	outcomes: {
		observedCodex400Responses: number;
		observedCodexErrorResponses: number;
		finalObservedCodexAttemptFallbacks: number;
		observedCodexFallbackAttempts: number;
	};
	pacing: {
		waitMsAvailableRequests: number;
		waitMsUnavailableRequests: number;
		p50WaitMs: number | null;
		p95WaitMs: number | null;
		receiptCounts: {
			leader: number;
			followerReleasedByLeader: number;
			followerReleasedByCap: number;
			unknown: number;
		};
	};
}

export interface CacheExperimentDimensionReport {
	rows: CacheExperimentRow[];
}

export interface CodexCacheExperimentReport {
	/**
	 * Bumped 3 -> 4 when CacheExperimentRow.pacing gained schema-20 role,
	 * release-reason, and wait-duration receipt summaries, 4 -> 5 when the
	 * `websocket` report was removed with the Codex WebSocket transport, and
	 * 5 -> 6 when the pacing-bypass and explicit-breakpoint canaries were
	 * retired: `explicitBreakpoint` is gone, and pacing rows lost `arm`,
	 * `actions`, the per-action pacing counters and `assignmentCounts`.
	 * 6 -> 7 removes the HTTP replay report and promotes promptKeyConcentration
	 * to all logical samples, including traces without experiment fields.
	 * Consumers that key on a fixed shape need to know the report changed.
	 */
	schemaVersion: 7;
	attribution: {
		unit: "final_observed_codex_attempt";
		responseScope: "codex_trace_only_no_cross_provider_terminal_visibility";
		elapsed: "observed_codex_response_ts_minus_observed_codex_attempt_request_ts";
		gap: "prior_observed_codex_request_ts_in_same_trace_and_valid_cohort";
		pacingWaitMs: "schema20_request_receipt";
		pacingWaitReason: "legacy_or_invalid_receipt_is_unknown";
	};
	pacing: CacheExperimentDimensionReport;
	/** Report-wide sliding 60-second pressure across every physical attempt's prompt key. */
	promptKeyConcentration: {
		distinctKeys: number;
		maxRequestsPerKeyMinute: number;
		keysOver15RequestsPerMinute: number;
	};
}

function keyOf(call: ToolCall): string {
	return `${call.name}::${call.arg_preview}`;
}

function average(values: number[]): number | null {
	return values.length > 0
		? Math.round(
				(10 * values.reduce((sum, value) => sum + value, 0)) / values.length,
			) / 10
		: null;
}

function cohortStats(
	samples: ReadonlyArray<{ pct: number | null; inputTokens: number }>,
): CacheCohortStats {
	const withPct = samples.filter(
		(sample): sample is { pct: number; inputTokens: number } =>
			sample.pct !== null,
	);
	const large = withPct.filter(
		(sample) => sample.inputTokens > LARGE_INPUT_TOKENS,
	);
	return {
		responses: samples.length,
		avgCacheHitPct: average(withPct.map((sample) => sample.pct)),
		zeroHitResponses: withPct.filter((sample) => sample.pct === 0).length,
		largeResponses: large.length,
		largeAvgCacheHitPct: average(large.map((sample) => sample.pct)),
		largeZeroHitResponses: large.filter((sample) => sample.pct === 0).length,
	};
}

function compareHmac(
	previous: string | null | undefined,
	current: string | null | undefined,
	stats: StabilityStats,
): void {
	if (!previous || !current) stats.unavailable++;
	else if (previous === current) stats.stable++;
	else stats.changed++;
}

function contextBandAccumulator(): ContextBandAccumulator {
	return {
		responses: 0,
		terminals: {},
		zeroCacheResponses: 0,
		weightedCacheReusePct: null,
		inputTokens: 0,
		cacheReadInputTokens: 0,
	};
}

function finishContextBand(band: ContextBandAccumulator): ContextBandStats {
	return {
		responses: band.responses,
		terminals: band.terminals,
		zeroCacheResponses: band.zeroCacheResponses,
		weightedCacheReusePct:
			band.inputTokens > 0
				? Math.round((1000 * band.cacheReadInputTokens) / band.inputTokens) / 10
				: null,
	};
}

// Logical-ID joins are a compatibility path for schema 6-8 records only. A
// schema-9 record without attempt_id is an instrumentation failure and must
// surface as unjoinable rather than silently collapsing physical attempts.
function isLegacyJoinEligible(record: TraceRecord): boolean {
	return (record.trace_schema_version ?? 0) < 9;
}

function analyzeRequestTransitions(requests: TraceRecord[]) {
	const prefixTransitions = {
		retainedExactPriorFullPrefix: 0,
		measurableChanged: 0,
		unavailableAbsentFingerprints: 0,
		unavailableRetentionWindow: 0,
	};
	const instructionStability: StabilityStats = {
		stable: 0,
		changed: 0,
		unavailable: 0,
	};
	const toolStability: StabilityStats = {
		stable: 0,
		changed: 0,
		unavailable: 0,
	};
	const groups = new Map<string, TraceRecord[]>();
	for (const request of requests) {
		if (!request.prompt_cache_key_id) continue;
		const group = groups.get(request.prompt_cache_key_id) ?? [];
		group.push(request);
		groups.set(request.prompt_cache_key_id, group);
	}
	for (const group of groups.values()) {
		group.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
		for (let index = 1; index < group.length; index++) {
			const previous = group[index - 1] as TraceRecord;
			const current = group[index] as TraceRecord;
			compareHmac(
				previous.instructions_hmac,
				current.instructions_hmac,
				instructionStability,
			);
			compareHmac(previous.tools_hmac, current.tools_hmac, toolStability);
			const previousCount =
				previous.input_item_total_count ?? previous.input_item_count;
			const currentCount =
				current.input_item_total_count ?? current.input_item_count;
			const fingerprints = current.input_item_fingerprints ?? [];
			if (previousCount === undefined || fingerprints.length === 0) {
				prefixTransitions.unavailableAbsentFingerprints++;
				continue;
			}
			const boundaryIndex = previousCount - 1;
			const previousFinal = (previous.input_item_fingerprints ?? []).find(
				(fingerprint) => fingerprint.index === boundaryIndex,
			);
			if (!previousFinal) {
				prefixTransitions.unavailableAbsentFingerprints++;
				continue;
			}
			if (currentCount !== undefined && currentCount < previousCount) {
				prefixTransitions.measurableChanged++;
				continue;
			}
			const currentBoundary = fingerprints.find(
				(fingerprint) => fingerprint.index === boundaryIndex,
			);
			if (!currentBoundary) {
				const firstRetained = fingerprints[0]?.index;
				if (
					current.input_item_fingerprints_truncated === true &&
					firstRetained !== undefined &&
					firstRetained > boundaryIndex
				) {
					prefixTransitions.unavailableRetentionWindow++;
				} else {
					prefixTransitions.measurableChanged++;
				}
				continue;
			}
			if (previousFinal.hmac === currentBoundary.hmac)
				prefixTransitions.retainedExactPriorFullPrefix++;
			else prefixTransitions.measurableChanged++;
		}
	}
	return { prefixTransitions, instructionStability, toolStability };
}

const SAFE_COHORT = /^[a-fA-F0-9]{16}$/;
const FALLBACK_CAUSES = new Set(["model_fallback", "account_failover"]);
interface CacheExperimentLogicalSample {
	request: TraceRecord;
	attempts: TraceRecord[];
	response?: TraceRecord;
	logicalTimestamp: number | null;
}

interface CacheExperimentAnnotatedSample extends CacheExperimentLogicalSample {
	model: string;
	turn: CacheExperimentTurn;
	gapBand: CacheExperimentGapBand;
}

interface CacheExperimentRowAccumulator extends CacheExperimentRow {
	elapsedSamples: number[];
	/** Cache-inclusive observations, one entry per measured response in this row. */
	cacheUsageObservations: CacheUsageObservation[];
	pacingWaitSamples: number[];
}

/**
 * Phase of the tombstone written by `writeCodexAbortedAttemptTrace` in
 * `trace.ts`. This analyzer reads JSONL off disk and deliberately imports
 * nothing from the provider, so the string is duplicated rather than shared;
 * changing it needs both sides.
 */
const ABORTED_ATTEMPT_PHASE = "attempt_aborted";

/**
 * Remove every attempt that was registered but never physically dispatched,
 * together with the tombstones that annul them.
 *
 * A request record is written while the body is transformed -- before route
 * claiming -- so a candidate later abandoned still leaves one behind. Counting
 * it as a physical attempt inflates requests-per-key pressure and fallback
 * totals, and an abandoned candidate holding the highest ordinal also takes
 * final-attempt attribution from the attempt that really ran, leaving that
 * attempt's response unjoined. Filtering at the entry points keeps one guard
 * for every downstream report instead of one per metric.
 */
function withoutAbortedAttempts(
	records: readonly TraceRecord[],
): readonly TraceRecord[] {
	const aborted = new Set<string>();
	for (const record of records) {
		if (record.phase !== ABORTED_ATTEMPT_PHASE) continue;
		if (typeof record.attempt_id === "string" && record.attempt_id.length > 0) {
			aborted.add(record.attempt_id);
		}
	}
	return records.filter(
		(record) =>
			record.phase !== ABORTED_ATTEMPT_PHASE &&
			!(
				typeof record.attempt_id === "string" && aborted.has(record.attempt_id)
			),
	);
}

function traceTimestamp(record: TraceRecord): number | null {
	if (!record.ts) return null;
	const parsed = Date.parse(record.ts);
	return Number.isFinite(parsed) ? parsed : null;
}

function appendRecord(
	map: Map<string, TraceRecord[]>,
	id: string,
	record: TraceRecord,
): void {
	const records = map.get(id) ?? [];
	records.push(record);
	map.set(id, records);
}

function matchingLogicalRequestIds(
	request: TraceRecord,
	response: TraceRecord,
): boolean {
	return !(
		request.request_id &&
		response.request_id &&
		request.request_id !== response.request_id
	);
}

/**
 * Retain the last Codex attempt observed per request ID in this trace slice.
 * The trace cannot reveal a later cross-provider attempt or terminal. IDs are
 * used only as ephemeral join keys and never copied into the report.
 */
function cacheExperimentLogicalSamples(
	records: readonly TraceRecord[],
): CacheExperimentLogicalSample[] {
	const requestRecords = records.filter(
		(record) => (record.phase ?? "request") === "request",
	);
	const responseRecords = records.filter(
		(record) => record.phase === "response",
	);
	const requestsByAttempt = new Map<string, TraceRecord[]>();
	const responsesByAttempt = new Map<string, TraceRecord[]>();
	const legacyRequestsByLogical = new Map<string, TraceRecord[]>();
	const legacyResponsesByLogical = new Map<string, TraceRecord[]>();
	for (const request of requestRecords) {
		if (request.attempt_id)
			appendRecord(requestsByAttempt, request.attempt_id, request);
		else if (request.request_id && isLegacyJoinEligible(request))
			appendRecord(legacyRequestsByLogical, request.request_id, request);
	}
	for (const response of responseRecords) {
		if (response.attempt_id)
			appendRecord(responsesByAttempt, response.attempt_id, response);
		else if (response.request_id && isLegacyJoinEligible(response))
			appendRecord(legacyResponsesByLogical, response.request_id, response);
	}

	const logicalRequests = new Map<string, TraceRecord[]>();
	let anonymous = 0;
	for (const request of requestRecords) {
		const key = request.request_id
			? `logical:${request.request_id}`
			: request.attempt_id
				? `attempt:${request.attempt_id}`
				: `anonymous:${anonymous++}`;
		appendRecord(logicalRequests, key, request);
	}

	const timestampOf = (record: TraceRecord): number | null => {
		if (!record.ts) return null;
		const parsed = Date.parse(record.ts);
		return Number.isFinite(parsed) ? parsed : null;
	};
	const samples: CacheExperimentLogicalSample[] = [];
	for (const attempts of logicalRequests.values()) {
		const ordered = [...attempts].sort(
			(a, b) =>
				(a.attempt_ordinal ?? 0) - (b.attempt_ordinal ?? 0) ||
				(timestampOf(a) ?? Number.POSITIVE_INFINITY) -
					(timestampOf(b) ?? Number.POSITIVE_INFINITY),
		);
		const request = ordered.at(-1);
		if (!request) continue;
		let response: TraceRecord | undefined;
		if (request.attempt_id) {
			const joinedRequests = requestsByAttempt.get(request.attempt_id) ?? [];
			const joinedResponses = responsesByAttempt.get(request.attempt_id) ?? [];
			if (
				joinedRequests.length === 1 &&
				joinedResponses.length === 1 &&
				joinedResponses[0] &&
				matchingLogicalRequestIds(request, joinedResponses[0])
			)
				response = joinedResponses[0];
		} else if (request.request_id && isLegacyJoinEligible(request)) {
			const joinedRequests =
				legacyRequestsByLogical.get(request.request_id) ?? [];
			const joinedResponses =
				legacyResponsesByLogical.get(request.request_id) ?? [];
			if (
				joinedRequests.length === 1 &&
				joinedResponses.length === 1 &&
				joinedResponses[0] &&
				matchingLogicalRequestIds(request, joinedResponses[0])
			)
				response = joinedResponses[0];
		}
		const validAttemptTimes = ordered
			.map(timestampOf)
			.filter((value): value is number => value !== null);
		const logicalTimestamp = validAttemptTimes.reduce<number | null>(
			(earliest, timestamp) =>
				earliest === null || timestamp < earliest ? timestamp : earliest,
			null,
		);
		samples.push({
			request,
			attempts: ordered,
			response,
			logicalTimestamp,
		});
	}
	return samples;
}

function pacingCohort(request: TraceRecord): string | null {
	const cohort = request.pacing_cohort_id;
	return typeof cohort === "string" && SAFE_COHORT.test(cohort)
		? cohort.toLowerCase()
		: null;
}

function safeModel(request: TraceRecord): string {
	return classifyCodexModelFamily(request.model_out ?? request.model_in);
}

function gapBand(gapMs: number): CacheExperimentGapBand {
	if (gapMs < 60_000) return "under_1m";
	if (gapMs < 5 * 60_000) return "from_1m_to_5m";
	if (gapMs < 15 * 60_000) return "from_5m_to_15m";
	if (gapMs < 60 * 60_000) return "from_15m_to_60m";
	return "at_least_60m";
}

function continuityBasis(value: unknown): CacheKeyContinuityBasis {
	switch (value) {
		case "derived":
		case "identity_match":
		case "lineage_match":
		case "rejected":
		case "session":
		case "ineligible":
			return value;
		default:
			return "unknown";
	}
}

interface ContinuityRowAccumulator extends CacheKeyContinuityRow {
	inputTokens: number;
	cachedReadTokens: number;
	positiveHitResponses: number;
	effectiveKeys: Set<string>;
	keyTimestamps: Map<string, number[]>;
}

function continuityApplication(
	request: TraceRecord,
): CacheKeyContinuityApplication {
	if (request.cache_key_continuity_applied === true) return "canonical";
	if (request.cache_key_continuity_applied === false) return "derived";
	return "unknown";
}

function continuityRowAccumulator(
	basis: CacheKeyContinuityBasis,
	application: CacheKeyContinuityApplication,
	model: string,
	turn: CacheExperimentTurn,
	gapBandValue: CacheExperimentGapBand,
): ContinuityRowAccumulator {
	return {
		basis,
		application,
		model,
		turn,
		gapBand: gapBandValue,
		requests: 0,
		joinedResponses: 0,
		unjoinedRequests: 0,
		measuredResponses: 0,
		weightedCachedReadPct: null,
		positiveHitResponses: 0,
		positiveHitRatePct: null,
		zeroHitResponses: 0,
		cacheWriteMeasuredResponses: 0,
		cacheWriteUnavailableResponses: 0,
		cacheWriteTokens: 0,
		compactionContinuations: 0,
		keyRotations: 0,
		distinctEffectiveKeys: 0,
		maxRequestsPerKeyMinute: 0,
		keysOver15RequestsPerMinute: 0,
		inputTokens: 0,
		cachedReadTokens: 0,
		effectiveKeys: new Set(),
		keyTimestamps: new Map(),
	};
}

function finishContinuityRow(
	row: ContinuityRowAccumulator,
): CacheKeyContinuityRow {
	let maxRequestsPerKeyMinute = 0;
	for (const timestamps of row.keyTimestamps.values()) {
		timestamps.sort((a, b) => a - b);
		let left = 0;
		for (let right = 0; right < timestamps.length; right++) {
			while ((timestamps[right] ?? 0) - (timestamps[left] ?? 0) >= 60_000)
				left++;
			maxRequestsPerKeyMinute = Math.max(
				maxRequestsPerKeyMinute,
				right - left + 1,
			);
		}
	}
	return {
		basis: row.basis,
		application: row.application,
		model: row.model,
		turn: row.turn,
		gapBand: row.gapBand,
		requests: row.requests,
		joinedResponses: row.joinedResponses,
		unjoinedRequests: row.unjoinedRequests,
		measuredResponses: row.measuredResponses,
		weightedCachedReadPct:
			row.inputTokens > 0
				? Math.round((1000 * row.cachedReadTokens) / row.inputTokens) / 10
				: null,
		positiveHitResponses: row.positiveHitResponses,
		positiveHitRatePct:
			row.measuredResponses > 0
				? Math.round(
						(1000 * row.positiveHitResponses) / row.measuredResponses,
					) / 10
				: null,
		zeroHitResponses: row.zeroHitResponses,
		cacheWriteMeasuredResponses: row.cacheWriteMeasuredResponses,
		cacheWriteUnavailableResponses: row.cacheWriteUnavailableResponses,
		cacheWriteTokens: row.cacheWriteTokens,
		compactionContinuations: row.compactionContinuations,
		keyRotations: row.keyRotations,
		distinctEffectiveKeys: row.effectiveKeys.size,
		maxRequestsPerKeyMinute,
		keysOver15RequestsPerMinute: [...row.keyTimestamps.values()].filter(
			(timestamps) => {
				timestamps.sort((a, b) => a - b);
				let left = 0;
				for (let right = 0; right < timestamps.length; right++) {
					while ((timestamps[right] ?? 0) - (timestamps[left] ?? 0) >= 60_000)
						left++;
					if (right - left + 1 > 15) return true;
				}
				return false;
			},
		).length,
	};
}

function continuityLogicalSamples(
	requestRecords: readonly TraceRecord[],
	requestsByAttemptId: ReadonlyMap<string, TraceRecord[]>,
	responsesByAttemptId: ReadonlyMap<string, TraceRecord[]>,
	legacyRequestsByLogicalId: ReadonlyMap<string, TraceRecord[]>,
	legacyResponsesByLogicalId: ReadonlyMap<string, TraceRecord[]>,
): CacheExperimentLogicalSample[] {
	const hasContinuityProvenance = (request: TraceRecord): boolean =>
		request.cache_key_continuity_basis !== undefined ||
		request.cache_key_continuity_applied !== undefined ||
		request.continuity_evidence_id !== undefined ||
		request.canonical_conversation_id !== undefined ||
		request.conversation_id !== undefined ||
		request.cache_key_mode !== undefined;
	const selectedLogicalIds = new Set<string>();
	let hasAnonymousProvenance = false;
	for (const request of requestRecords) {
		if (!hasContinuityProvenance(request)) continue;
		if (request.request_id) selectedLogicalIds.add(request.request_id);
		else hasAnonymousProvenance = true;
	}
	if (selectedLogicalIds.size === 0 && !hasAnonymousProvenance) return [];
	const logicalRequests = new Map<string, TraceRecord[]>();
	let anonymous = 0;
	for (const request of requestRecords) {
		const selected = request.request_id
			? selectedLogicalIds.has(request.request_id)
			: hasContinuityProvenance(request);
		if (!selected) continue;
		const key = request.request_id
			? `logical:${request.request_id}`
			: request.attempt_id
				? `attempt:${request.attempt_id}`
				: `anonymous:${anonymous++}`;
		appendRecord(logicalRequests, key, request);
	}
	const timestampOf = (record: TraceRecord): number | null => {
		if (!record.ts) return null;
		const parsed = Date.parse(record.ts);
		return Number.isFinite(parsed) ? parsed : null;
	};
	const samples: CacheExperimentLogicalSample[] = [];
	for (const attempts of logicalRequests.values()) {
		const ordered = [...attempts].sort(
			(a, b) =>
				(a.attempt_ordinal ?? 0) - (b.attempt_ordinal ?? 0) ||
				(timestampOf(a) ?? Number.POSITIVE_INFINITY) -
					(timestampOf(b) ?? Number.POSITIVE_INFINITY),
		);
		const request = ordered.at(-1);
		if (!request) continue;
		let response: TraceRecord | undefined;
		if (request.attempt_id) {
			const joinedRequests = requestsByAttemptId.get(request.attempt_id) ?? [];
			const joinedResponses =
				responsesByAttemptId.get(request.attempt_id) ?? [];
			if (
				joinedRequests.length === 1 &&
				joinedResponses.length === 1 &&
				joinedResponses[0] &&
				matchingLogicalRequestIds(request, joinedResponses[0])
			) {
				response = joinedResponses[0];
			}
		} else if (request.request_id && isLegacyJoinEligible(request)) {
			const joinedRequests =
				legacyRequestsByLogicalId.get(request.request_id) ?? [];
			const joinedResponses =
				legacyResponsesByLogicalId.get(request.request_id) ?? [];
			if (
				joinedRequests.length === 1 &&
				joinedResponses.length === 1 &&
				joinedResponses[0] &&
				matchingLogicalRequestIds(request, joinedResponses[0])
			) {
				response = joinedResponses[0];
			}
		}
		const logicalTimestamp = ordered.reduce<number | null>(
			(earliest, attempt) => {
				const timestamp = timestampOf(attempt);
				return timestamp !== null && (earliest === null || timestamp < earliest)
					? timestamp
					: earliest;
			},
			null,
		);
		samples.push({ request, attempts: ordered, response, logicalTimestamp });
	}
	return samples;
}

function analyzeContinuityProvenance(
	samples: readonly CacheExperimentLogicalSample[],
): CacheKeyContinuityReport {
	const boundedIdentity = (identity: unknown): string | null =>
		typeof identity === "string" && identity.length > 0 ? identity : null;
	const identityOf = (request: TraceRecord): string | null => {
		if (request.cache_key_mode === "session") {
			return boundedIdentity(request.conversation_id);
		}
		if (request.cache_key_continuity_applied === true) {
			return boundedIdentity(request.canonical_conversation_id);
		}
		if (
			request.trace_schema_version !== undefined &&
			request.trace_schema_version >= 17
		) {
			return (
				boundedIdentity(request.continuity_evidence_id) ??
				boundedIdentity(request.conversation_id)
			);
		}
		return (
			boundedIdentity(request.canonical_conversation_id) ??
			boundedIdentity(request.conversation_id)
		);
	};
	type ContinuityLogicalSample = CacheExperimentLogicalSample & {
		provenance: TraceRecord;
		application: CacheKeyContinuityApplication;
		identity: string | null;
	};
	const logicalSamples: ContinuityLogicalSample[] = samples.map((sample) => {
		const provenance = sample.attempts[0] ?? sample.request;
		return {
			...sample,
			provenance,
			application: continuityApplication(provenance),
			identity: identityOf(provenance),
		};
	});
	const grouped = new Map<string, ContinuityLogicalSample[]>();
	for (const sample of logicalSamples) {
		if (!sample.identity) continue;
		const groupKey = `${sample.identity.length}:${sample.identity}\0${sample.application}`;
		const group = grouped.get(groupKey) ?? [];
		group.push(sample);
		grouped.set(groupKey, group);
	}
	const position = new Map<
		ContinuityLogicalSample,
		{
			turn: CacheExperimentTurn;
			gapBand: CacheExperimentGapBand;
			previousKey: string | null;
		}
	>();
	for (const group of grouped.values()) {
		group.sort((a, b) => (a.logicalTimestamp ?? 0) - (b.logicalTimestamp ?? 0));
		group.forEach((sample, index) => {
			const previous = group[index - 1];
			const currentTs = sample.logicalTimestamp;
			const previousTs = previous?.logicalTimestamp ?? null;
			position.set(sample, {
				turn: index === 0 ? "first_observed" : "follow_up_observed",
				gapBand:
					index === 0 ||
					currentTs === null ||
					previousTs === null ||
					currentTs < previousTs
						? "unknown"
						: gapBand(currentTs - previousTs),
				previousKey: previous?.request.prompt_cache_key_id ?? null,
			});
		});
	}
	const rows = new Map<string, ContinuityRowAccumulator>();
	for (const sample of logicalSamples) {
		const metadata = position.get(sample) ?? {
			turn: "unknown" as const,
			gapBand: "unknown" as const,
			previousKey: null,
		};
		const basis = continuityBasis(sample.provenance.cache_key_continuity_basis);
		const application = sample.application;
		const model = safeModel(sample.request);
		const rowKey = [
			basis,
			application,
			model,
			metadata.turn,
			metadata.gapBand,
		].join("\0");
		let row = rows.get(rowKey);
		if (!row) {
			row = continuityRowAccumulator(
				basis,
				application,
				model,
				metadata.turn,
				metadata.gapBand,
			);
			rows.set(rowKey, row);
		}
		row.requests++;
		if (basis === "lineage_match") row.compactionContinuations++;
		const effectiveKey = sample.request.prompt_cache_key_id;
		if (typeof effectiveKey === "string" && effectiveKey.length > 0) {
			row.effectiveKeys.add(effectiveKey);
			if (sample.logicalTimestamp !== null) {
				const timestamps = row.keyTimestamps.get(effectiveKey) ?? [];
				timestamps.push(sample.logicalTimestamp);
				row.keyTimestamps.set(effectiveKey, timestamps);
			}
			if (metadata.previousKey && metadata.previousKey !== effectiveKey)
				row.keyRotations++;
		}
		const response = sample.response;
		if (!response) {
			row.unjoinedRequests++;
			continue;
		}
		row.joinedResponses++;
		if (
			response.cache_measurement_available !== false &&
			safeTokenCount(response.input_tokens) &&
			safeTokenCount(response.cache_read_input_tokens) &&
			response.cache_read_input_tokens <= response.input_tokens
		) {
			row.measuredResponses++;
			row.inputTokens += response.input_tokens;
			row.cachedReadTokens += response.cache_read_input_tokens;
			if (response.cache_read_input_tokens > 0) row.positiveHitResponses++;
			else row.zeroHitResponses++;
		}
		if (hasMeasuredCacheWrite(response)) {
			row.cacheWriteMeasuredResponses++;
			row.cacheWriteTokens += response.cache_creation_input_tokens ?? 0;
		} else row.cacheWriteUnavailableResponses++;
	}
	const finishedRows = [...rows.values()].map(finishContinuityRow);
	finishedRows.sort(
		(a, b) =>
			a.basis.localeCompare(b.basis) ||
			a.application.localeCompare(b.application) ||
			a.model.localeCompare(b.model) ||
			a.turn.localeCompare(b.turn) ||
			a.gapBand.localeCompare(b.gapBand),
	);
	return { rows: finishedRows };
}

/**
 * Every observed Codex attempt is a pacing sample. Turn and gap come from the
 * pacing cohort; an attempt without one (no client session, or a keepalive
 * replay) is counted with turn and gap "unknown".
 */
function annotateExperimentSamples(
	samples: readonly CacheExperimentLogicalSample[],
): CacheExperimentAnnotatedSample[] {
	const turnBySample = new Map<
		CacheExperimentLogicalSample,
		{ turn: CacheExperimentTurn; gapBand: CacheExperimentGapBand }
	>();
	const samplesByCohort = new Map<string, CacheExperimentLogicalSample[]>();
	for (const sample of samples) {
		const cohort = pacingCohort(sample.request);
		if (!cohort || sample.logicalTimestamp === null) {
			turnBySample.set(sample, { turn: "unknown", gapBand: "unknown" });
			continue;
		}
		const group = samplesByCohort.get(cohort) ?? [];
		group.push(sample);
		samplesByCohort.set(cohort, group);
	}
	for (const group of samplesByCohort.values()) {
		group.sort((a, b) => (a.logicalTimestamp ?? 0) - (b.logicalTimestamp ?? 0));
		group.forEach((sample, index) => {
			if (index === 0) {
				turnBySample.set(sample, {
					turn: "first_observed",
					gapBand: "unknown",
				});
				return;
			}
			const previous = group[index - 1];
			const currentTs = sample.logicalTimestamp;
			const previousTs = previous?.logicalTimestamp;
			if (
				currentTs === null ||
				previousTs === null ||
				previousTs === undefined ||
				currentTs < previousTs
			) {
				turnBySample.set(sample, {
					turn: "follow_up_observed",
					gapBand: "unknown",
				});
				return;
			}
			const observedGapMs = currentTs - previousTs;
			turnBySample.set(sample, {
				turn: "follow_up_observed",
				gapBand: Number.isSafeInteger(observedGapMs)
					? gapBand(observedGapMs)
					: "unknown",
			});
		});
	}
	return samples.map((sample) => ({
		...sample,
		model: safeModel(sample.request),
		...(turnBySample.get(sample) ?? {
			turn: "unknown" as const,
			gapBand: "unknown" as const,
		}),
	}));
}

function cacheExperimentRowAccumulator(
	sample: CacheExperimentAnnotatedSample,
): CacheExperimentRowAccumulator {
	return {
		model: sample.model,
		turn: sample.turn,
		gapBand: sample.gapBand,
		observedCodexAttempts: 0,
		joinedObservedCodexResponses: 0,
		unjoinedObservedCodexAttempts: 0,
		cache: {
			measuredResponses: 0,
			unavailableResponses: 0,
			overflowResponses: 0,
			inputTokens: 0,
			cachedReadTokens: 0,
			weightedCachedReadPct: null,
			medianCachedReadPct: null,
			p25CachedReadPct: null,
			p75CachedReadPct: null,
			cacheWriteMeasuredResponses: 0,
			cacheWriteUnavailableResponses: 0,
			cacheWriteOverflowResponses: 0,
			cacheWriteTokens: 0,
			positiveHitResponses: 0,
			positiveHitRatePct: null,
		},
		elapsed: {
			availableResponses: 0,
			unavailableResponses: 0,
			p50Ms: null,
			p95Ms: null,
		},
		outcomes: {
			observedCodex400Responses: 0,
			observedCodexErrorResponses: 0,
			finalObservedCodexAttemptFallbacks: 0,
			observedCodexFallbackAttempts: 0,
		},
		pacing: {
			waitMsAvailableRequests: 0,
			waitMsUnavailableRequests: 0,
			p50WaitMs: null,
			p95WaitMs: null,
			receiptCounts: {
				leader: 0,
				followerReleasedByLeader: 0,
				followerReleasedByCap: 0,
				unknown: 0,
			},
		},
		elapsedSamples: [],
		cacheUsageObservations: [],
		pacingWaitSamples: [],
	};
}

function safeTokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Schema 11 records say whether cache-write usage was actually reported.
 * Earlier positive values remain usable, but an earlier zero is ambiguous
 * because the normalizer historically substituted zero when the field was
 * absent. Treat those legacy zeros as unavailable instead of measured facts.
 */
function hasMeasuredCacheWrite(response: TraceRecord): boolean {
	if (response.usage_measurement_available === false) return false;
	if (!safeTokenCount(response.cache_creation_input_tokens)) return false;
	if (response.cache_creation_measurement_available === false) return false;
	if (response.cache_creation_measurement_available === true) return true;
	return response.cache_creation_input_tokens > 0;
}

function safeTokenSum(current: number, increment: number): number | null {
	if (increment > Number.MAX_SAFE_INTEGER - current) return null;
	return current + increment;
}

function percentile(
	values: readonly number[],
	quantile: number,
): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
	return sorted[index] ?? null;
}

function incrementPacingReceipt(
	row: CacheExperimentRowAccumulator,
	request: TraceRecord,
): void {
	// A pacing role means the request held the slot (leader) or waited for it
	// (follower), so a wait receipt is expected.
	const waitExpected =
		request.pacing_role === "leader" || request.pacing_role === "follower";
	if ((request.trace_schema_version ?? 0) < 20) {
		row.pacing.receiptCounts.unknown++;
		if (waitExpected) row.pacing.waitMsUnavailableRequests++;
		return;
	}

	if (
		request.pacing_role === "leader" &&
		request.pacing_release_reason == null
	) {
		row.pacing.receiptCounts.leader++;
	} else if (
		request.pacing_role === "follower" &&
		request.pacing_release_reason === "leader"
	) {
		row.pacing.receiptCounts.followerReleasedByLeader++;
	} else if (
		request.pacing_role === "follower" &&
		request.pacing_release_reason === "cap"
	) {
		row.pacing.receiptCounts.followerReleasedByCap++;
	} else {
		row.pacing.receiptCounts.unknown++;
	}

	if (safeTokenCount(request.pacing_wait_ms)) {
		row.pacing.waitMsAvailableRequests++;
		row.pacingWaitSamples.push(request.pacing_wait_ms);
	} else if (waitExpected) {
		row.pacing.waitMsUnavailableRequests++;
	}
}

function finishCacheExperimentRow(
	row: CacheExperimentRowAccumulator,
): CacheExperimentRow {
	const cacheSummary = summarizeCacheReadObservations(
		row.cacheUsageObservations,
	);
	return {
		model: row.model,
		turn: row.turn,
		gapBand: row.gapBand,
		observedCodexAttempts: row.observedCodexAttempts,
		joinedObservedCodexResponses: row.joinedObservedCodexResponses,
		unjoinedObservedCodexAttempts: row.unjoinedObservedCodexAttempts,
		cache: {
			...row.cache,
			weightedCachedReadPct: cacheSummary.weightedCacheReadPercent,
			medianCachedReadPct: cacheSummary.medianCacheReadPercent,
			p25CachedReadPct: cacheSummary.p25CacheReadPercent,
			p75CachedReadPct: cacheSummary.p75CacheReadPercent,
			positiveHitRatePct: cacheSummary.positiveHitRatePercent,
		},
		elapsed: {
			availableResponses: row.elapsed.availableResponses,
			unavailableResponses: row.elapsed.unavailableResponses,
			p50Ms: percentile(row.elapsedSamples, 0.5),
			p95Ms: percentile(row.elapsedSamples, 0.95),
		},
		outcomes: row.outcomes,
		pacing: {
			...row.pacing,
			p50WaitMs: percentile(row.pacingWaitSamples, 0.5),
			p95WaitMs: percentile(row.pacingWaitSamples, 0.95),
		},
	};
}

const TURN_ORDER: CacheExperimentTurn[] = [
	"first_observed",
	"follow_up_observed",
	"unknown",
];
const GAP_ORDER: CacheExperimentGapBand[] = [
	"under_1m",
	"from_1m_to_5m",
	"from_5m_to_15m",
	"from_15m_to_60m",
	"at_least_60m",
	"unknown",
];

function cacheExperimentDimension(
	samples: readonly CacheExperimentLogicalSample[],
): CacheExperimentDimensionReport {
	const annotated = annotateExperimentSamples(samples);
	const rows = new Map<string, CacheExperimentRowAccumulator>();
	for (const sample of annotated) {
		const rowKey = [sample.model, sample.turn, sample.gapBand].join("\u0000");
		let row = rows.get(rowKey);
		if (!row) {
			row = cacheExperimentRowAccumulator(sample);
			rows.set(rowKey, row);
		}
		row.observedCodexAttempts++;
		incrementPacingReceipt(row, sample.request);
		const fallbackAttempts = sample.attempts.filter((attempt) =>
			FALLBACK_CAUSES.has(attempt.attempt_cause ?? ""),
		).length;
		if (FALLBACK_CAUSES.has(sample.request.attempt_cause ?? ""))
			row.outcomes.finalObservedCodexAttemptFallbacks++;
		row.outcomes.observedCodexFallbackAttempts += fallbackAttempts;
		const response = sample.response;
		if (!response) {
			row.unjoinedObservedCodexAttempts++;
			continue;
		}
		row.joinedObservedCodexResponses++;
		if (response.stop_reason === "error")
			row.outcomes.observedCodexErrorResponses++;
		if (
			Number(response.error_status) === 400 ||
			response.error_type === "http_400"
		)
			row.outcomes.observedCodex400Responses++;
		if (
			response.cache_measurement_available !== false &&
			safeTokenCount(response.input_tokens) &&
			safeTokenCount(response.cache_read_input_tokens) &&
			response.cache_read_input_tokens <= response.input_tokens
		) {
			const nextInputTokens = safeTokenSum(
				row.cache.inputTokens,
				response.input_tokens,
			);
			const nextCachedReadTokens = safeTokenSum(
				row.cache.cachedReadTokens,
				response.cache_read_input_tokens,
			);
			if (nextInputTokens === null || nextCachedReadTokens === null) {
				row.cache.overflowResponses++;
			} else {
				row.cache.measuredResponses++;
				row.cache.inputTokens = nextInputTokens;
				row.cache.cachedReadTokens = nextCachedReadTokens;
				row.cacheUsageObservations.push({
					shape: "inclusive",
					totalInputTokens: response.input_tokens,
					cacheReadInputTokens: response.cache_read_input_tokens,
				});
				if (response.cache_read_input_tokens > 0)
					row.cache.positiveHitResponses++;
			}
		} else {
			row.cache.unavailableResponses++;
		}
		if (!hasMeasuredCacheWrite(response)) {
			row.cache.cacheWriteUnavailableResponses++;
		} else {
			const nextCacheWriteTokens = safeTokenSum(
				row.cache.cacheWriteTokens,
				response.cache_creation_input_tokens ?? 0,
			);
			if (nextCacheWriteTokens === null) {
				row.cache.cacheWriteOverflowResponses++;
			} else {
				row.cache.cacheWriteMeasuredResponses++;
				row.cache.cacheWriteTokens = nextCacheWriteTokens;
			}
		}
		const requestTimestamp = sample.request.ts
			? Date.parse(sample.request.ts)
			: Number.NaN;
		const responseTimestamp = response.ts
			? Date.parse(response.ts)
			: Number.NaN;
		const observedElapsedMs = responseTimestamp - requestTimestamp;
		if (
			Number.isFinite(requestTimestamp) &&
			Number.isFinite(responseTimestamp) &&
			responseTimestamp >= requestTimestamp &&
			Number.isSafeInteger(observedElapsedMs)
		) {
			row.elapsed.availableResponses++;
			row.elapsedSamples.push(observedElapsedMs);
		} else {
			row.elapsed.unavailableResponses++;
		}
	}
	const finishedRows = [...rows.values()].map(finishCacheExperimentRow);
	finishedRows.sort(
		(a, b) =>
			a.model.localeCompare(b.model) ||
			TURN_ORDER.indexOf(a.turn) - TURN_ORDER.indexOf(b.turn) ||
			GAP_ORDER.indexOf(a.gapBand) - GAP_ORDER.indexOf(b.gapBand),
	);
	return { rows: finishedRows };
}

/**
 * Largest value in a list, or 0 for an empty one.
 *
 * Deliberately a loop rather than `Math.max(0, ...values)`: these lists carry
 * one entry per distinct prompt key, so on a large corpus the spread turns every
 * key into a call argument and the runtime throws `RangeError` once it exceeds
 * its argument limit -- failing exactly on the big traces this analyzer exists
 * to summarize.
 */
function maxOfCounts(values: readonly number[]): number {
	let maximum = 0;
	for (const value of values) {
		if (value > maximum) maximum = value;
	}
	return maximum;
}

function maximumRequestsPerMinute(timestamps: readonly number[]): number {
	const ordered = [...timestamps].sort((a, b) => a - b);
	let left = 0;
	let maximum = 0;
	for (let right = 0; right < ordered.length; right++) {
		while ((ordered[right] ?? 0) - (ordered[left] ?? 0) >= 60_000) left++;
		maximum = Math.max(maximum, right - left + 1);
	}
	return maximum;
}

function promptKeyConcentration(
	samples: readonly CacheExperimentLogicalSample[],
): CodexCacheExperimentReport["promptKeyConcentration"] {
	const timestampsByKey = new Map<string, number[]>();
	for (const sample of samples) {
		for (const attempt of sample.attempts) {
			const key = attempt.prompt_cache_key_id;
			const timestamp = traceTimestamp(attempt);
			if (typeof key !== "string" || key.length === 0 || timestamp === null)
				continue;
			const timestamps = timestampsByKey.get(key) ?? [];
			timestamps.push(timestamp);
			timestampsByKey.set(key, timestamps);
		}
	}
	const counts = [...timestampsByKey.values()].map(maximumRequestsPerMinute);
	return {
		distinctKeys: timestampsByKey.size,
		maxRequestsPerKeyMinute: maxOfCounts(counts),
		keysOver15RequestsPerMinute: counts.filter((count) => count > 15).length,
	};
}

/**
 * Privacy-safe, opt-in cache experiment analysis. Cohort hashes and join IDs
 * are used only in-memory and never appear in the returned report.
 */
export function analyzeCodexCacheExperiments(
	allRecords: readonly TraceRecord[],
): CodexCacheExperimentReport {
	const records = withoutAbortedAttempts(allRecords);
	const samples = cacheExperimentLogicalSamples(records);
	return {
		schemaVersion: 7,
		attribution: {
			unit: "final_observed_codex_attempt",
			responseScope: "codex_trace_only_no_cross_provider_terminal_visibility",
			elapsed:
				"observed_codex_response_ts_minus_observed_codex_attempt_request_ts",
			gap: "prior_observed_codex_request_ts_in_same_trace_and_valid_cohort",
			pacingWaitMs: "schema20_request_receipt",
			pacingWaitReason: "legacy_or_invalid_receipt_is_unknown",
		},
		pacing: cacheExperimentDimension(samples),
		promptKeyConcentration: promptKeyConcentration(samples),
	};
}

export function analyzeCodexTrace(
	allRecords: readonly TraceRecord[],
): TraceReport {
	const records = withoutAbortedAttempts(allRecords);
	const timestamps: string[] = [];
	const requestRecords = records.filter(
		(record) => (record.phase ?? "request") === "request",
	);
	const responseRecords = records.filter(
		(record) => record.phase === "response",
	);
	const logicalIds = new Set(
		requestRecords
			.map((record) => record.request_id)
			.filter((id): id is string => Boolean(id)),
	);
	const requestsByLogicalId = new Map<string, TraceRecord[]>();
	for (const request of requestRecords) {
		if (!request.request_id) continue;
		const group = requestsByLogicalId.get(request.request_id) ?? [];
		group.push(request);
		requestsByLogicalId.set(request.request_id, group);
	}
	const requestsByAttemptId = new Map<string, TraceRecord[]>();
	const responsesByAttemptId = new Map<string, TraceRecord[]>();
	const legacyRequestsByLogicalId = new Map<string, TraceRecord[]>();
	const legacyResponsesByLogicalId = new Map<string, TraceRecord[]>();
	let schema9MissingAttemptId = 0;
	for (const request of requestRecords) {
		if (!request.attempt_id && !isLegacyJoinEligible(request)) {
			schema9MissingAttemptId++;
			continue;
		}
		const map = request.attempt_id
			? requestsByAttemptId
			: legacyRequestsByLogicalId;
		const id = request.attempt_id ?? request.request_id;
		if (!id) continue;
		const group = map.get(id) ?? [];
		group.push(request);
		map.set(id, group);
	}
	for (const response of responseRecords) {
		if (!response.attempt_id && !isLegacyJoinEligible(response)) {
			schema9MissingAttemptId++;
			continue;
		}
		const map = response.attempt_id
			? responsesByAttemptId
			: legacyResponsesByLogicalId;
		const id = response.attempt_id ?? response.request_id;
		if (!id) continue;
		const group = map.get(id) ?? [];
		group.push(response);
		map.set(id, group);
	}
	let missingJoins =
		records.filter((record) => !record.request_id && !record.attempt_id)
			.length + schema9MissingAttemptId;
	let ambiguousJoins = 0;
	const countJoinQuality = (
		requests: ReadonlyMap<string, TraceRecord[]>,
		responses: ReadonlyMap<string, TraceRecord[]>,
	) => {
		for (const id of new Set([...requests.keys(), ...responses.keys()])) {
			const requestCount = requests.get(id)?.length ?? 0;
			const responseCount = responses.get(id)?.length ?? 0;
			if (requestCount === 0 || responseCount === 0) {
				missingJoins += Math.max(requestCount, responseCount);
			} else if (requestCount !== 1 || responseCount !== 1) {
				ambiguousJoins++;
			}
		}
	};
	countJoinQuality(requestsByAttemptId, responsesByAttemptId);
	countJoinQuality(legacyRequestsByLogicalId, legacyResponsesByLogicalId);
	const continuity = analyzeContinuityProvenance(
		continuityLogicalSamples(
			requestRecords,
			requestsByAttemptId,
			responsesByAttemptId,
			legacyRequestsByLogicalId,
			legacyResponsesByLogicalId,
		),
	);
	const measuredStats = (samples: readonly TraceRecord[]) => {
		let input = 0;
		let cacheRead = 0;
		let measuredResponses = 0;
		for (const sample of samples) {
			if (
				sample.cache_measurement_available === false ||
				typeof sample.cache_read_input_tokens !== "number" ||
				typeof sample.input_tokens !== "number"
			)
				continue;
			const sampleInput = sample.input_tokens;
			input += sampleInput;
			cacheRead += Math.min(
				Math.max(sample.cache_read_input_tokens, 0),
				sampleInput,
			);
			measuredResponses++;
		}
		return {
			measuredResponses,
			weightedCacheReusePct:
				input > 0 ? Math.round((1000 * cacheRead) / input) / 10 : null,
		};
	};
	const finalResponses: TraceRecord[] = [];
	for (const [logicalId, attempts] of requestsByLogicalId) {
		const ordered = [...attempts].sort(
			(a, b) =>
				(a.attempt_ordinal ?? 0) - (b.attempt_ordinal ?? 0) ||
				(a.ts ?? "").localeCompare(b.ts ?? ""),
		);
		const finalAttempt = ordered.at(-1);
		const attemptResponses = finalAttempt?.attempt_id
			? responsesByAttemptId.get(finalAttempt.attempt_id)
			: undefined;
		const joined = finalAttempt?.attempt_id
			? (requestsByAttemptId.get(finalAttempt.attempt_id)?.length ?? 0) === 1 &&
				attemptResponses?.length === 1
				? attemptResponses[0]
				: undefined
			: attempts.length === 1 &&
					(legacyResponsesByLogicalId.get(logicalId)?.length ?? 0) === 1
				? legacyResponsesByLogicalId.get(logicalId)?.[0]
				: undefined;
		if (joined) finalResponses.push(joined);
	}
	const timestampsByKey = new Map<string, number[]>();
	for (const request of requestRecords) {
		if (!request.prompt_cache_key_id || !request.ts) continue;
		const timestamp = Date.parse(request.ts);
		if (!Number.isFinite(timestamp)) continue;
		const timestamps = timestampsByKey.get(request.prompt_cache_key_id) ?? [];
		timestamps.push(timestamp);
		timestampsByKey.set(request.prompt_cache_key_id, timestamps);
	}
	const concentration: number[] = [];
	let maxRequestsPerKeyMinute = 0;
	for (const timestamps of timestampsByKey.values()) {
		timestamps.sort((a, b) => a - b);
		let left = 0;
		let maximum = 0;
		for (let right = 0; right < timestamps.length; right++) {
			while ((timestamps[right] ?? 0) - (timestamps[left] ?? 0) >= 60_000)
				left++;
			maximum = Math.max(maximum, right - left + 1);
		}
		concentration.push(maximum);
		maxRequestsPerKeyMinute = Math.max(maxRequestsPerKeyMinute, maximum);
	}
	const attemptInclusiveResponses: TraceRecord[] = [];
	const collectUnambiguousJoins = (
		requests: ReadonlyMap<string, TraceRecord[]>,
		responses: ReadonlyMap<string, TraceRecord[]>,
	) => {
		for (const [id, requestGroup] of requests) {
			const response =
				responses.get(id)?.length === 1 ? responses.get(id)?.[0] : undefined;
			if (requestGroup.length === 1 && response) {
				attemptInclusiveResponses.push(response);
			}
		}
	};
	collectUnambiguousJoins(requestsByAttemptId, responsesByAttemptId);
	collectUnambiguousJoins(
		legacyRequestsByLogicalId,
		legacyResponsesByLogicalId,
	);
	const sessions = new Map<string, number>();
	const requestKeySetByAttemptId = new Map<string, boolean>();
	const legacyRequestKeySetByLogicalId = new Map<string, boolean>();
	let maxHistoryToolCalls = 0;
	let maxInputItems = 0;
	let maxApproxInputChars = 0;
	let totalNudges = 0;
	for (const request of requestRecords) {
		if (request.ts) timestamps.push(request.ts);
		maxHistoryToolCalls = Math.max(
			maxHistoryToolCalls,
			request.history_function_call_count ?? 0,
		);
		maxInputItems = Math.max(maxInputItems, request.input_item_count ?? 0);
		maxApproxInputChars = Math.max(
			maxApproxInputChars,
			request.approx_input_chars ?? 0,
		);
		totalNudges += request.nudge_count ?? 0;
		if (request.attempt_id) {
			const requests = requestsByAttemptId.get(request.attempt_id) ?? [];
			if (requests.length === 1) {
				requestKeySetByAttemptId.set(
					request.attempt_id,
					request.prompt_cache_key_set === true,
				);
			}
		} else if (request.request_id) {
			const requests = legacyRequestsByLogicalId.get(request.request_id) ?? [];
			if (requests.length === 1) {
				legacyRequestKeySetByLogicalId.set(
					request.request_id,
					request.prompt_cache_key_set === true,
				);
			}
		}
		if (request.session_key_hash)
			sessions.set(
				request.session_key_hash,
				(sessions.get(request.session_key_hash) ?? 0) + 1,
			);
	}
	const fingerprintCoverage = {
		usable: requestRecords.filter(
			(request) => (request.input_item_fingerprints?.length ?? 0) > 0,
		).length,
		missing: requestRecords.filter(
			(request) => (request.input_item_fingerprints?.length ?? 0) === 0,
		).length,
		truncated: requestRecords.filter(
			(request) => request.input_item_fingerprints_truncated === true,
		).length,
	};
	const transitions = analyzeRequestTransitions(requestRecords);
	const newFanOutHistogram: Record<string, number> = {};
	const newToolUseByName: Record<string, number> = {};
	const stopReasons: Record<string, number> = {};
	const errors: Record<string, number> = {};
	const errorCodes: Record<string, number> = {};
	const errorStatuses: Record<string, number> = {};
	const contextBands = {
		under50: contextBandAccumulator(),
		from50To80: contextBandAccumulator(),
		from80To95: contextBandAccumulator(),
		atLeast95: contextBandAccumulator(),
		unavailable: contextBandAccumulator(),
	};
	const usage = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		availableResponses: 0,
		unavailableResponses: 0,
	};
	let cacheMeasuredInputTokens = 0;
	const cachePcts: number[] = [];
	const cohortSamples = {
		keyOn: [] as Array<{ pct: number | null; inputTokens: number }>,
		keyOff: [] as Array<{ pct: number | null; inputTokens: number }>,
	};
	const worstRespawns: TraceReport["response"]["worstRespawns"] = [];
	let totalNewToolCalls = 0;
	let maxNewFanOut = 0;
	let totalSubagentSpawns = 0;
	let maxSubagentSpawns = 0;
	let textOnlyResponses = 0;
	let unjoinedResponses = 0;
	let respawnResponses = 0;
	let zeroCacheResponses = 0;
	for (const response of responseRecords) {
		if (response.ts) timestamps.push(response.ts);
		const newCalls = response.new_tool_call_count ?? 0;
		totalNewToolCalls += newCalls;
		maxNewFanOut = Math.max(maxNewFanOut, newCalls);
		newFanOutHistogram[String(newCalls)] =
			(newFanOutHistogram[String(newCalls)] ?? 0) + 1;
		for (const [name, count] of Object.entries(
			response.new_tool_use_by_name ?? {},
		))
			newToolUseByName[name] = (newToolUseByName[name] ?? 0) + count;
		const spawns =
			response.new_subagent_spawn_count ??
			(response.new_tool_use_by_name?.Task ?? 0) +
				(response.new_tool_use_by_name?.Agent ?? 0);
		totalSubagentSpawns += spawns;
		maxSubagentSpawns = Math.max(maxSubagentSpawns, spawns);
		const stop = response.stop_reason ?? "unknown";
		stopReasons[stop] = (stopReasons[stop] ?? 0) + 1;
		if (stop === "end_turn" && newCalls === 0) textOnlyResponses++;
		if (stop === "error") {
			const type = response.error_type || "unclassified_upstream_error";
			errors[type] = (errors[type] ?? 0) + 1;
			if (response.error_code)
				errorCodes[response.error_code] =
					(errorCodes[response.error_code] ?? 0) + 1;
			if (response.error_status)
				errorStatuses[response.error_status] =
					(errorStatuses[response.error_status] ?? 0) + 1;
		}
		const input = response.input_tokens ?? 0;
		const hasCacheRead =
			response.cache_measurement_available !== false &&
			typeof response.input_tokens === "number" &&
			typeof response.cache_read_input_tokens === "number";
		const cacheRead = hasCacheRead
			? Math.min(Math.max(response.cache_read_input_tokens ?? 0, 0), input)
			: 0;
		if (response.usage_measurement_available === false) {
			usage.unavailableResponses++;
		} else if (typeof response.input_tokens === "number") {
			usage.availableResponses++;
			usage.inputTokens += input;
			usage.outputTokens += response.output_tokens ?? 0;
			if (hasMeasuredCacheWrite(response)) {
				usage.cacheCreationInputTokens +=
					response.cache_creation_input_tokens ?? 0;
			}
		} else {
			usage.unavailableResponses++;
		}
		usage.cacheReadInputTokens += cacheRead;
		if (hasCacheRead) cacheMeasuredInputTokens += input;
		if (hasCacheRead && cacheRead === 0) zeroCacheResponses++;
		if (typeof response.cache_hit_pct === "number")
			cachePcts.push(response.cache_hit_pct);
		const utilization = response.context_utilization_pct;
		const contextBand =
			typeof utilization !== "number"
				? contextBands.unavailable
				: utilization < 50
					? contextBands.under50
					: utilization < 80
						? contextBands.from50To80
						: utilization < 95
							? contextBands.from80To95
							: contextBands.atLeast95;
		contextBand.responses++;
		contextBand.terminals[stop] = (contextBand.terminals[stop] ?? 0) + 1;
		if (hasCacheRead) {
			if (cacheRead === 0) contextBand.zeroCacheResponses++;
			contextBand.inputTokens += input;
			contextBand.cacheReadInputTokens += cacheRead;
		}
		const keySet = response.attempt_id
			? (responsesByAttemptId.get(response.attempt_id)?.length ?? 0) === 1
				? requestKeySetByAttemptId.get(response.attempt_id)
				: undefined
			: response.request_id &&
					(legacyResponsesByLogicalId.get(response.request_id)?.length ?? 0) ===
						1
				? legacyRequestKeySetByLogicalId.get(response.request_id)
				: undefined;
		if (keySet === undefined) unjoinedResponses++;
		else
			cohortSamples[keySet ? "keyOn" : "keyOff"].push({
				pct:
					typeof response.cache_hit_pct === "number"
						? response.cache_hit_pct
						: null,
				inputTokens: input,
			});
		const duplicateCounts = new Map<string, number>();
		for (const call of response.new_tool_calls ?? [])
			duplicateCounts.set(
				keyOf(call),
				(duplicateCounts.get(keyOf(call)) ?? 0) + 1,
			);
		let hasRespawn = false;
		for (const [tool, count] of duplicateCounts)
			if (count > 1) {
				hasRespawn = true;
				worstRespawns.push({
					request_id: response.request_id ?? null,
					tool,
					count,
				});
			}
		if (hasRespawn) respawnResponses++;
	}
	timestamps.sort();
	worstRespawns.sort((a, b) => b.count - a.count);
	const topSessions = [...sessions.entries()]
		.map(([session, requests]) => ({ session, requests }))
		.sort((a, b) => b.requests - a.requests)
		.slice(0, 5);
	return {
		requests: requestRecords.length,
		responses: responseRecords.length,
		logicalRequests:
			logicalIds.size +
			requestRecords.filter((record) => !record.request_id).length,
		attempts: requestRecords.length,
		joins: {
			missing: missingJoins,
			ambiguous: ambiguousJoins,
			schema9MissingAttemptId,
		},
		cacheDenominators: {
			attemptInclusive: measuredStats(attemptInclusiveResponses),
			finalResponseOnly: measuredStats(finalResponses),
		},
		readiness: {
			maxRequestsPerKeyMinute,
			keysOver15RequestsPerMinute: concentration.filter((count) => count > 15)
				.length,
		},
		continuity,
		span: { first: timestamps[0], last: timestamps.at(-1) },
		request: {
			maxHistoryToolCalls,
			maxInputItems,
			maxApproxInputChars,
			totalNudges,
			distinctSessions: sessions.size,
			topSessions,
			fingerprintCoverage,
			...transitions,
		},
		response: {
			totalNewToolCalls,
			maxNewFanOut,
			totalSubagentSpawns,
			maxSubagentSpawns,
			cacheCohorts: {
				keyOn: cohortStats(cohortSamples.keyOn),
				keyOff: cohortStats(cohortSamples.keyOff),
			},
			unjoinedResponses,
			newFanOutHistogram,
			newToolUseByName,
			stopReasons,
			textOnlyResponses,
			errors,
			errorCodes,
			errorStatuses,
			cacheHitPctAvg: average(cachePcts),
			weightedCacheReusePct:
				cacheMeasuredInputTokens > 0
					? Math.round(
							(1000 * usage.cacheReadInputTokens) / cacheMeasuredInputTokens,
						) / 10
					: null,
			zeroCacheResponses,
			contextBands: {
				under50: finishContextBand(contextBands.under50),
				from50To80: finishContextBand(contextBands.from50To80),
				from80To95: finishContextBand(contextBands.from80To95),
				atLeast95: finishContextBand(contextBands.atLeast95),
				unavailable: finishContextBand(contextBands.unavailable),
			},
			usage,
			respawnResponses,
			worstRespawns: worstRespawns.slice(0, 15),
		},
	};
}

export function parseTraceJsonl(text: string): TraceRecord[] {
	const records: TraceRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Array.isArray(parsed)
			) {
				continue;
			}
			records.push(parsed as TraceRecord);
		} catch {
			/* skip malformed lines */
		}
	}
	return records;
}

export function formatReport(report: TraceReport): string {
	const lines = [
		`FINGERPRINT AVAILABILITY: usable=${report.request.fingerprintCoverage.usable} missing=${report.request.fingerprintCoverage.missing} truncated=${report.request.fingerprintCoverage.truncated}`,
		`span              : ${report.span.first ?? "?"} -> ${report.span.last ?? "?"}`,
		`logical requests  : ${report.logicalRequests}`,
		`physical attempts : ${report.attempts}`,
		`request records   : ${report.requests}`,
		`response records  : ${report.responses}`,
		`joins             : missing=${report.joins.missing} ambiguous=${report.joins.ambiguous} schema9-missing-attempt-id=${report.joins.schema9MissingAttemptId}`,
		`cache denominators: final=${JSON.stringify(report.cacheDenominators.finalResponseOnly)} attempts=${JSON.stringify(report.cacheDenominators.attemptInclusive)}`,
		`key concentration : max=${report.readiness.maxRequestsPerKeyMinute}/min keys-over-15=${report.readiness.keysOver15RequestsPerMinute}`,
		"",
		"REQUEST (historical replay load, NOT new fan-out):",
		`  max history tool calls/req : ${report.request.maxHistoryToolCalls}`,
		`  max input items/req        : ${report.request.maxInputItems}`,
		`  max approx input chars/req : ${report.request.maxApproxInputChars}`,
		`  nudges injected            : ${report.request.totalNudges}`,
		`  prefix transitions         : ${JSON.stringify(report.request.prefixTransitions)}`,
		`  instruction stability      : ${JSON.stringify(report.request.instructionStability)}`,
		`  tool stability             : ${JSON.stringify(report.request.toolStability)}`,
		"",
		"RESPONSE (newly emitted this turn, the real fan-out signal):",
		`  total new tool calls       : ${report.response.totalNewToolCalls}`,
		`  max NEW fan-out / response : ${report.response.maxNewFanOut}`,
		`  new fan-out histogram      : ${JSON.stringify(report.response.newFanOutHistogram)}`,
		`  new tool use by name       : ${JSON.stringify(report.response.newToolUseByName)}`,
		`  stop_reason distribution   : ${JSON.stringify(report.response.stopReasons)}`,
		`  text-only responses        : ${report.response.textOnlyResponses}`,
		`  context bands              : ${JSON.stringify(report.response.contextBands)}`,
		`  upstream errors            : ${JSON.stringify(report.response.errors)}`,
		`  upstream error codes       : ${JSON.stringify(report.response.errorCodes)}`,
		`  upstream error statuses    : ${JSON.stringify(report.response.errorStatuses)}`,
		`  avg cache hit %            : ${report.response.cacheHitPctAvg ?? "n/a"}`,
		`  weighted cache reuse %     : ${report.response.weightedCacheReusePct ?? "n/a"}`,
		`  zero-cache responses       : ${report.response.zeroCacheResponses}`,
		`  usage totals               : ${JSON.stringify(report.response.usage)}`,
		`  subagent spawns            : total ${report.response.totalSubagentSpawns}, max/response ${report.response.maxSubagentSpawns}`,
		"  CACHE COHORTS (by prompt_cache_key on request):",
		`    key ON : ${JSON.stringify(report.response.cacheCohorts.keyOn)}`,
		`    key OFF: ${JSON.stringify(report.response.cacheCohorts.keyOff)}`,
		`    unjoined responses: ${report.response.unjoinedResponses}`,
		`  sessions                   : ${report.request.distinctSessions} distinct; top ${report.request.topSessions
			.map((session) => `${session.session.slice(0, 8)}=${session.requests}`)
			.join(", ")}`,
		`  RE-SPAWN responses         : ${report.response.respawnResponses}`,
		"",
		"CACHE KEY CONTINUITY PROVENANCE:",
		...report.continuity.rows.map((row) => `  ${JSON.stringify(row)}`),
	];
	if (report.response.worstRespawns.length > 0) {
		lines.push("  worst within-response re-spawns:");
		for (const respawn of report.response.worstRespawns) {
			lines.push(
				`    x${respawn.count}  req=${respawn.request_id ?? "?"}  ${respawn.tool}`,
			);
		}
	}
	return lines.join("\n");
}

/**
 * Format only aggregate cache-experiment metrics. Unlike the legacy diagnostic
 * report, this intentionally has no request IDs, cohort hashes, cache keys, or
 * tool-call previews.
 */
export function formatCacheExperimentReport(
	report: CodexCacheExperimentReport,
): string {
	const lines = [
		"CODEX CACHE EXPERIMENTS",
		`attribution: unit=${report.attribution.unit} scope=${report.attribution.responseScope} elapsed=${report.attribution.elapsed} gap=${report.attribution.gap} pacing_wait_ms=${report.attribution.pacingWaitMs}`,
	];
	lines.push("", "CACHE PACING (all observed Codex attempts):");
	for (const row of report.pacing.rows) lines.push(`  ${JSON.stringify(row)}`);
	lines.push(
		"",
		`PROMPT KEY CONCENTRATION: ${JSON.stringify(report.promptKeyConcentration)}`,
	);
	return lines.join("\n");
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const cacheExperiments = args.includes("--cache-experiments");
	const files = args.filter((arg) => arg && arg !== "--cache-experiments");
	const file = files[0];
	if (!file || files.length !== 1) {
		console.error(
			"usage: bun run analyze-trace.ts [--cache-experiments] <codex-trace.jsonl>",
		);
		process.exit(1);
	}
	const records = parseTraceJsonl(readFileSync(file, "utf8"));
	console.log(
		cacheExperiments
			? formatCacheExperimentReport(analyzeCodexCacheExperiments(records))
			: formatReport(analyzeCodexTrace(records)),
	);
}
