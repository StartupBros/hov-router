import {
	LONG_CONTEXT_PROMPT_TOKENS,
	type LongContextTokenSubset,
	type WindowTokenAggregate,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type {
	AgentAttributionSource,
	ProjectAttributionSource,
	RequestAccountingContext,
	RouteProvenance,
} from "@better-ccflare/types";
import {
	type QualityDecisionRecord,
	type RequestRoutingAttemptSummary,
	sanitizeQualityDecision,
	sanitizeRequestRoutingAttemptSummary,
} from "@better-ccflare/types/request";
import { getCleanupBatchSize } from "../adapters/bun-sql-adapter";
import { type CleanupPacer, deleteInBatches } from "../cleanup-pacing";
import { decryptPayload, encryptPayload } from "../payload-encryption";
import { BaseRepository } from "./base.repository";

const log = new Logger("RequestRepository");

/** Upper bound for a stored client session id. Generous for real ids
 * (`user_<hash>_account_<hash>_session_<uuid>` is well under 200), tight
 * enough that a hostile or buggy client cannot grow every row without limit. */
const CLIENT_SESSION_ID_MAX_LEN = 200;

/**
 * The client session id comes straight from the request body
 * (`metadata.user_id`) and is only checked for non-emptiness upstream, because
 * it was previously used for in-memory routing only. Persisting it makes the
 * absent bounds matter: an oversized or control-character-laden value would
 * otherwise be written to every row, bloat the database and break log and CSV
 * output. Mirrors what `sanitizeProjectName` already does for the other
 * client-supplied string this table stores.
 *
 * Sanitizing on WRITE rather than at the source is deliberate: session-affinity
 * routing keys on the raw value, and truncating there could collide two
 * distinct sessions onto one account.
 */
function sanitizeClientSessionId(
	raw: string | null | undefined,
): string | null {
	if (!raw) return null;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
	const cleaned = raw.replace(/[\x00-\x1F\x7F]/g, "").trim();
	if (!cleaned) return null;
	return cleaned.length > CLIENT_SESSION_ID_MAX_LEN
		? cleaned.slice(0, CLIENT_SESSION_ID_MAX_LEN)
		: cleaned;
}

// Source-authority ranks for the UPSERT conflict resolution below. Higher
// number = higher authority. NULL and "none" both fall through to the ELSE
// branch (rank 0) since neither is an explicit attribution.
//
// Project: header (explicit client header) > path (workspace path in the
// system prompt) > heading (inferred from an H1 heading) > none.
const PROJECT_SOURCE_RANK_SQL = `CASE %COL%
	WHEN 'header_project' THEN 3
	WHEN 'path_project' THEN 2
	WHEN 'heading_project' THEN 1
	ELSE 0
END`;
// Agent: header (explicit client header) > prompt (inferred from the prompt) > none.
const AGENT_SOURCE_RANK_SQL = `CASE %COL%
	WHEN 'header_agent' THEN 2
	WHEN 'prompt_agent' THEN 1
	ELSE 0
END`;

function projectRank(col: string): string {
	return PROJECT_SOURCE_RANK_SQL.replace("%COL%", col);
}

function agentRank(col: string): string {
	return AGENT_SOURCE_RANK_SQL.replace("%COL%", col);
}

/**
 * Decrypt a stored payload for a list endpoint, swallowing per-row errors
 * so a single corrupted/tampered row cannot take down the whole list.
 *
 * The error is logged so misconfiguration is still observable, and a JSON
 * placeholder is substituted that the dashboard can render as "unreadable".
 *
 * Single-row reads (`getPayload`) MUST stay strict and let the error
 * propagate — there's no fallback that makes sense for a single row.
 */
async function decryptForList(id: string, json: string): Promise<string> {
	try {
		return await decryptPayload(json);
	} catch (err) {
		log.error(`Failed to decrypt payload ${id}:`, err);
		return JSON.stringify({
			error: "Payload could not be decrypted",
			id,
		});
	}
}

export interface RequestData {
	routingAttemptSummary?: RequestRoutingAttemptSummary | null;
	qualityDecision?: QualityDecisionRecord | null;
	/** Bounded JSON of anthropic-ratelimit-unified-* headers (Fable 2xx only). */
	unifiedRatelimitHeaders?: string | null;
	accounting?: RequestAccountingContext;
	id: string;
	method: string;
	path: string;
	accountUsed: string | null;
	statusCode: number | null;
	success: boolean;
	errorMessage: string | null;
	responseTime: number;
	failoverAttempts: number;
	agentUsed?: string;
	apiKeyId?: string;
	apiKeyName?: string;
	project?: string | null;
	billingType?: string;
	comboName?: string | null;
	/**
	 * Model the client originally requested and the model actually sent
	 * upstream, when an agent-preference rewrite (`isRewriteTargetServable`
	 * guard notwithstanding) changed it. Both are only populated when a swap
	 * actually occurred; leave both `undefined`/null when no rewrite happened
	 * so the columns stay unpopulated rather than duplicating the `model`
	 * column with an unchanged value.
	 */
	originalModel?: string | null;
	appliedModel?: string | null;
	projectAttributionSource?: ProjectAttributionSource | null;
	agentAttributionSource?: AgentAttributionSource | null;
	/** Client-supplied session id (body `metadata.user_id`), used for attribution. */
	clientSessionId?: string | null;
	// (sanitized on write — see sanitizeClientSessionId)
	routeProvenance?: RouteProvenance | null;
	/**
	 * Real SSE termination state for Anthropic-Messages-shaped streams. One of
	 * "complete" | "recovered" | "error" | "truncated" | "client_cancelled" |
	 * null/undefined. Undefined/null for non-streaming responses or streams
	 * not wrapped by the terminal-recovery observer. See
	 * packages/proxy/src/anthropic-terminal-recovery.ts for the producer.
	 */
	streamTerminalState?:
		| "complete"
		| "recovered"
		| "error"
		| "truncated"
		| "client_cancelled"
		| null;
	usage?: {
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		costUsd?: number;
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
		tokensPerSecond?: number;
		// Advisor-iteration tokens (R14), separate from the executor columns above.
		advisorUsage?: AdvisorModelUsage[];
	};
}

/** One advisor model's billable token totals within a request (R14). */
export interface AdvisorModelUsage {
	/** Null when the iterations named no model; window value counts it unpriced. */
	model: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
}

const ADVISOR_TOKEN_FIELDS = [
	"inputTokens",
	"outputTokens",
	"cacheReadInputTokens",
	"cacheCreationInputTokens",
] as const;

/** Reads a stored `advisor_usage` value. Anything this repository would not
 * have written is left out of `entries` and reported through `malformed`. */
function parseAdvisorUsage(raw: string): {
	entries: AdvisorModelUsage[];
	malformed: boolean;
} {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { entries: [], malformed: true };
	}
	if (!Array.isArray(parsed)) return { entries: [], malformed: true };
	const entries: AdvisorModelUsage[] = [];
	let malformed = false;
	for (const entry of parsed) {
		const fields =
			typeof entry === "object" && entry !== null
				? (entry as Record<string, unknown>)
				: undefined;
		const model = fields?.model ?? null;
		if (!fields || (model !== null && typeof model !== "string")) {
			malformed = true;
			continue;
		}
		const usage: AdvisorModelUsage = {
			model,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
		};
		for (const field of ADVISOR_TOKEN_FIELDS) {
			const value = fields[field];
			if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
				usage[field] = value;
			} else {
				malformed = true;
			}
		}
		entries.push(usage);
	}
	return { entries, malformed };
}

/** An aggregate line as `aggregateTokensByModel` builds it: the long-context
 * subset is always present (optional only on the public type). */
type LedgerAggregate = WindowTokenAggregate & {
	longContext: LongContextTokenSubset;
};

interface TokenAggregateRow {
	model: string;
	request_count: number;
	input_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
	output_tokens: number;
	long_context_request_count: number;
	long_context_input_tokens: number;
	long_context_cache_read_input_tokens: number;
	long_context_cache_creation_input_tokens: number;
	long_context_output_tokens: number;
}

export class RequestRepository extends BaseRepository<RequestData> {
	async listAffinityLaneSummariesSince(
		sinceMs: number,
		limit: number,
	): Promise<{ summaries: string[]; capReached: boolean }> {
		// REPLACE matches the literal, case-sensitive key on both TEXT backends.
		// Keep malformed JSON for the restore parser rather than parsing in SQL.
		const rows = await this.queryOffThread<{ routing_attempt_summary: string }>(
			`SELECT routing_attempt_summary FROM requests
			 WHERE timestamp >= ?
			   AND REPLACE(routing_attempt_summary, '"affinityLane"', '') <> routing_attempt_summary
			 ORDER BY timestamp DESC LIMIT ?`,
			[sinceMs, limit + 1],
		);
		return {
			summaries: rows.slice(0, limit).map((row) => row.routing_attempt_summary),
			capReached: rows.length > limit,
		};
	}

	/**
	 * Each Claude Code session's newest committed request inside the window, for
	 * restoring route-profile bindings at startup. "Newest" is by start time
	 * (`timestamp` is written at completion), and only rows that selected an
	 * account count, because only those can commit a binding. Sessions whose
	 * newest such row carried no route profile are omitted: they were native.
	 * SQLite returns the bare `route_profile_id` from the row holding MAX(started).
	 */
	async listRouteBindingSessionsSince(
		sinceMs: number,
		limit: number,
	): Promise<{
		sessions: Array<{
			apiKeyId: string;
			sessionId: string;
			routeProfileId: string;
			lastStartedAt: number;
		}>;
		capReached: boolean;
	}> {
		const rows = await this.queryOffThread<{
			api_key_id: string;
			session_id: string;
			route_profile_id: string;
			last_started: number;
		}>(
			`SELECT api_key_id, session_id, route_profile_id, last_started FROM (
				SELECT api_key_id, session_id, route_profile_id, MAX(started) AS last_started
				FROM (
					SELECT api_key_id,
						CASE WHEN json_valid(client_session_id) THEN
							CASE WHEN json_type(client_session_id, '$.session_id') = 'text'
								THEN json_extract(client_session_id, '$.session_id') END
						END AS session_id,
						route_profile_id,
						timestamp - COALESCE(response_time_ms, 0) AS started
					FROM requests
					WHERE timestamp >= ?
					  -- An expression, not "api_key_id IS NOT NULL": that column test
					  -- lets the planner read the partial api-key index for every key
					  -- and all of history instead of the timestamp range.
					  AND COALESCE(api_key_id, '') <> ''
					  AND client_session_id IS NOT NULL
					  AND account_used IS NOT NULL
					  AND path = '/v1/messages'
					  AND COALESCE(internal_origin, 0) = 0
				)
				WHERE session_id IS NOT NULL AND session_id <> ''
				GROUP BY api_key_id, session_id
			)
			WHERE route_profile_id IS NOT NULL AND route_profile_id <> ''
			ORDER BY last_started DESC LIMIT ?`,
			[sinceMs, limit + 1],
		);
		return {
			sessions: rows.slice(0, limit).map((row) => ({
				apiKeyId: row.api_key_id,
				sessionId: row.session_id,
				routeProfileId: row.route_profile_id,
				lastStartedAt: Number(row.last_started),
			})),
			capReached: rows.length > limit,
		};
	}

	async save(data: RequestData): Promise<void> {
		const { usage } = data;
		const decision = sanitizeQualityDecision(data.qualityDecision);
		const attemptSummary = sanitizeRequestRoutingAttemptSummary(
			data.routingAttemptSummary,
		);
		const projectRankIncoming = projectRank(
			"EXCLUDED.project_attribution_source",
		);
		const projectRankExisting = projectRank(
			"requests.project_attribution_source",
		);
		const agentRankIncoming = agentRank("EXCLUDED.agent_attribution_source");
		const agentRankExisting = agentRank("requests.agent_attribution_source");
		// An incoming project/agent pair wins the conflict only when it carries a
		// non-null value AND its source is at least as authoritative as the
		// existing one. Equal rank still wins (keeps legacy no-source callers,
		// where both sides rank 0, overwriting as before; and lets a fresh
		// same-authority re-derivation replace a stale one). Strictly lower rank
		// never wins, so an omitted/`none`/lower-authority source can no longer
		// erase or downgrade a higher-authority attribution (e.g. header_*).
		const projectWinsIncoming = `EXCLUDED.project IS NOT NULL AND ${projectRankIncoming} >= ${projectRankExisting}`;
		const agentWinsIncoming = `EXCLUDED.agent_used IS NOT NULL AND ${agentRankIncoming} >= ${agentRankExisting}`;
		await this.run(
			`
			INSERT INTO requests (
				id, timestamp, method, path, account_used,
				status_code, success, error_message, response_time_ms, failover_attempts,
				model, prompt_tokens, completion_tokens, total_tokens, cost_usd,
				input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens,
				agent_used, output_tokens_per_second, api_key_id, api_key_name, project,
				billing_type, combo_name, original_model, applied_model,
				project_attribution_source, agent_attribution_source,
				stream_terminal_state, client_session_id,
				route_profile_id, requested_route_model, routed_provider, routed_model,
				route_fallback_rung, route_home_action, route_repin_reason, route_candidate_id,
				account_generation, cache_health_native, internal_origin, quality_decision, routing_attempt_summary,
				advisor_usage, unified_ratelimit_headers
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET
				timestamp = EXCLUDED.timestamp,
				method = EXCLUDED.method,
				path = EXCLUDED.path,
				account_used = CASE WHEN requests.routing_attempt_summary IS NOT NULL THEN requests.account_used ELSE EXCLUDED.account_used END,
				status_code = CASE WHEN requests.routing_attempt_summary IS NOT NULL THEN requests.status_code ELSE EXCLUDED.status_code END,
				success = CASE WHEN requests.routing_attempt_summary IS NOT NULL THEN requests.success ELSE EXCLUDED.success END,
				error_message = CASE WHEN requests.routing_attempt_summary IS NOT NULL THEN requests.error_message ELSE EXCLUDED.error_message END,
				response_time_ms = EXCLUDED.response_time_ms,
				failover_attempts = CASE WHEN requests.routing_attempt_summary IS NOT NULL THEN requests.failover_attempts ELSE EXCLUDED.failover_attempts END,
				model = EXCLUDED.model,
				prompt_tokens = EXCLUDED.prompt_tokens,
				completion_tokens = EXCLUDED.completion_tokens,
				total_tokens = EXCLUDED.total_tokens,
				cost_usd = EXCLUDED.cost_usd,
				input_tokens = EXCLUDED.input_tokens,
				cache_read_input_tokens = EXCLUDED.cache_read_input_tokens,
				cache_creation_input_tokens = EXCLUDED.cache_creation_input_tokens,
				output_tokens = EXCLUDED.output_tokens,
				output_tokens_per_second = EXCLUDED.output_tokens_per_second,
				api_key_id = EXCLUDED.api_key_id,
				api_key_name = EXCLUDED.api_key_name,
				billing_type = COALESCE(EXCLUDED.billing_type, requests.billing_type),
				combo_name = COALESCE(EXCLUDED.combo_name, requests.combo_name),
				original_model = COALESCE(EXCLUDED.original_model, requests.original_model),
				applied_model = COALESCE(EXCLUDED.applied_model, requests.applied_model),
				-- (project, project_attribution_source) and (agent_used, agent_attribution_source)
				-- move in LOCKSTEP and are resolved by SOURCE AUTHORITY, not preserve-first or
				-- unconditional-overwrite (see projectRank/agentRank above). The incoming pair
				-- replaces the existing pair only when it has a non-null value AND a source rank
				-- >= the existing source rank; otherwise the existing pair is kept verbatim. This
				-- stops a re-save with an omitted/none/lower-authority source (e.g. a heading
				-- re-derived on a later request) from erasing or downgrading a higher-authority
				-- attribution (e.g. header_project) recorded earlier for the same request id.
				project = CASE WHEN ${projectWinsIncoming} THEN EXCLUDED.project ELSE requests.project END,
				project_attribution_source = CASE WHEN ${projectWinsIncoming} THEN EXCLUDED.project_attribution_source ELSE requests.project_attribution_source END,
				agent_used = CASE WHEN ${agentWinsIncoming} THEN EXCLUDED.agent_used ELSE requests.agent_used END,
				agent_attribution_source = CASE WHEN ${agentWinsIncoming} THEN EXCLUDED.agent_attribution_source ELSE requests.agent_attribution_source END,
				-- Attempt-summary rows retain the first terminal state, including
				-- an unknown/null state; late usage or a conflicting complete save
				-- cannot rewrite a failed stream. Legacy rows keep their existing
				-- nullable enrichment behavior.
				stream_terminal_state = CASE WHEN requests.routing_attempt_summary IS NOT NULL THEN requests.stream_terminal_state ELSE COALESCE(EXCLUDED.stream_terminal_state, requests.stream_terminal_state) END,
				-- The client session id is fixed for a given request id, and the
				-- error paths that re-save a row do not carry it. Preserve-first,
				-- so a later save without it cannot blank out what the main path
				-- recorded.
				client_session_id = COALESCE(EXCLUDED.client_session_id, requests.client_session_id),
				route_profile_id = CASE WHEN requests.routing_attempt_summary IS NOT NULL THEN requests.route_profile_id ELSE COALESCE(EXCLUDED.route_profile_id, requests.route_profile_id) END,
				requested_route_model = CASE WHEN requests.routing_attempt_summary IS NOT NULL THEN requests.requested_route_model ELSE COALESCE(EXCLUDED.requested_route_model, requests.requested_route_model) END,
				routed_provider = CASE WHEN requests.routing_attempt_summary IS NOT NULL THEN requests.routed_provider ELSE COALESCE(EXCLUDED.routed_provider, requests.routed_provider) END,
				routed_model = CASE WHEN requests.routing_attempt_summary IS NOT NULL THEN requests.routed_model ELSE COALESCE(EXCLUDED.routed_model, requests.routed_model) END,
				route_fallback_rung = CASE WHEN requests.routing_attempt_summary IS NOT NULL THEN requests.route_fallback_rung ELSE COALESCE(EXCLUDED.route_fallback_rung, requests.route_fallback_rung) END,
				route_home_action = CASE WHEN requests.routing_attempt_summary IS NOT NULL THEN requests.route_home_action ELSE COALESCE(EXCLUDED.route_home_action, requests.route_home_action) END,
				route_repin_reason = CASE WHEN requests.routing_attempt_summary IS NOT NULL THEN requests.route_repin_reason ELSE COALESCE(EXCLUDED.route_repin_reason, requests.route_repin_reason) END,
				route_candidate_id = CASE WHEN requests.routing_attempt_summary IS NOT NULL THEN requests.route_candidate_id ELSE COALESCE(EXCLUDED.route_candidate_id, requests.route_candidate_id) END,
				account_generation = COALESCE(requests.account_generation, EXCLUDED.account_generation),
				cache_health_native = COALESCE(requests.cache_health_native, EXCLUDED.cache_health_native),
				internal_origin = COALESCE(requests.internal_origin, EXCLUDED.internal_origin),
 quality_decision = COALESCE(requests.quality_decision, EXCLUDED.quality_decision),
 routing_attempt_summary = COALESCE(requests.routing_attempt_summary, EXCLUDED.routing_attempt_summary),
				advisor_usage = EXCLUDED.advisor_usage,
				unified_ratelimit_headers = COALESCE(requests.unified_ratelimit_headers, EXCLUDED.unified_ratelimit_headers)
		`,
			[
				data.id,
				Date.now(),
				data.method,
				data.path,
				data.accountUsed,
				data.statusCode,
				data.success,
				data.errorMessage,
				data.responseTime,
				data.failoverAttempts,
				usage?.model || null,
				usage?.promptTokens ?? null,
				usage?.completionTokens ?? null,
				usage?.totalTokens ?? null,
				usage?.costUsd ?? null,
				usage?.inputTokens ?? null,
				usage?.cacheReadInputTokens ?? null,
				usage?.cacheCreationInputTokens ?? null,
				usage?.outputTokens ?? null,
				data.agentUsed || null,
				usage?.tokensPerSecond ?? null,
				data.apiKeyId || null,
				data.apiKeyName || null,
				data.project || null,
				data.billingType || null,
				data.comboName || null,
				data.originalModel || null,
				data.appliedModel || null,
				data.projectAttributionSource || null,
				data.agentAttributionSource || null,
				data.streamTerminalState ?? null,
				sanitizeClientSessionId(data.clientSessionId),
				data.routeProvenance?.profileId ?? null,
				data.routeProvenance?.requestedModel ?? null,
				data.accounting?.provider ??
					data.routeProvenance?.routedProvider ??
					null,
				data.accounting?.model ?? data.routeProvenance?.routedModel ?? null,
				data.routeProvenance?.fallbackRung ?? null,
				data.routeProvenance?.homeAction ?? null,
				data.routeProvenance?.repinReason ?? null,
				data.routeProvenance?.candidateId ?? null,
				data.accounting?.accountGeneration ?? null,
				data.accounting ? (data.accounting.nativeCache ? 1 : 0) : null,
				data.accounting ? (data.accounting.internal ? 1 : 0) : null,
				decision ? JSON.stringify(decision) : null,
				attemptSummary ? JSON.stringify(attemptSummary) : null,
				usage?.advisorUsage?.length ? JSON.stringify(usage.advisorUsage) : null,
				data.unifiedRatelimitHeaders || null,
			],
		);
	}

	// Payload management
	async savePayload(id: string, data: unknown): Promise<void> {
		const json = JSON.stringify(data);
		const stored = await encryptPayload(json);
		const ts = Date.now();
		await this.run(
			`INSERT INTO request_payloads (id, json, timestamp) VALUES (?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json, timestamp = EXCLUDED.timestamp`,
			[id, stored, ts],
		);
	}

	async savePayloadRaw(id: string, json: string): Promise<void> {
		const stored = await encryptPayload(json);
		const ts = Date.now();
		await this.run(
			`INSERT INTO request_payloads (id, json, timestamp) VALUES (?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json, timestamp = EXCLUDED.timestamp`,
			[id, stored, ts],
		);
	}

	async getPayload(id: string): Promise<unknown | null> {
		const row = await this.get<{ json: string }>(
			`SELECT json FROM request_payloads WHERE id = ?`,
			[id],
		);

		if (!row) return null;

		// Decryption errors must propagate — they indicate tampering, a wrong key,
		// or a missing key for an encrypted row. Silently returning null would
		// hide real misconfiguration. Only JSON parse errors are tolerated, since
		// historical rows may contain malformed payloads.
		const decoded = await decryptPayload(row.json);
		try {
			return JSON.parse(decoded);
		} catch {
			return null;
		}
	}

	async listPayloadsWithAccountNames(limit = 50): Promise<
		Array<{
			id: string;
			json: string | null;
			timestamp: number;
			account_name: string | null;
			quality_decision: string | null;
		}>
	> {
		const rows = await this.query<{
			id: string;
			json: string | null;
			timestamp: number;
			account_name: string | null;
			quality_decision: string | null;
		}>(
			`
			SELECT r.id, r.timestamp, rp.json, a.name as account_name, r.quality_decision
			FROM requests r
			LEFT JOIN request_payloads rp ON rp.id = r.id
			LEFT JOIN accounts a ON r.account_used = a.id
			ORDER BY r.timestamp DESC
			LIMIT ?
		`,
			[limit],
		);
		return Promise.all(
			rows.map(async (row) => ({
				id: row.id,
				timestamp: row.timestamp,
				json: row.json ? await decryptForList(row.id, row.json) : null,
				account_name: row.account_name,
				quality_decision: row.quality_decision,
			})),
		);
	}

	// Analytics queries
	async getRecentRequests(limit = 100): Promise<
		Array<{
			id: string;
			timestamp: number;
			method: string;
			path: string;
			account_used: string | null;
			status_code: number | null;
			success: boolean;
			response_time_ms: number | null;
		}>
	> {
		const rows = await this.query<{
			id: string;
			timestamp: number;
			method: string;
			path: string;
			account_used: string | null;
			status_code: number | null;
			success: 0 | 1;
			response_time_ms: number | null;
		}>(
			`
			SELECT id, timestamp, method, path, account_used, status_code, success, response_time_ms
			FROM requests
			ORDER BY timestamp DESC
			LIMIT ?
		`,
			[limit],
		);
		return rows.map((row) => ({
			...row,
			success: !!row.success,
		}));
	}

	/**
	 * Per-model token/request totals for `accountId` in `[fromMs, toMs)`,
	 * scoped to plan-billed Messages traffic — the input to the Window Value
	 * Ledger's valuation step (see `valueWindowAggregates` in
	 * @better-ccflare/core). `path = '/v1/messages'` is an EXACT match,
	 * deliberately excluding `/v1/messages/count_tokens` (a distinct,
	 * non-billed endpoint that happens to share the prefix). Only
	 * `billing_type = 'plan'` rows count toward a window's value — pay-as-you-go
	 * ('api') usage doesn't consume the subscription window's capacity.
	 * NULL token columns (never populated, e.g. an errored request) are
	 * treated as 0 via COALESCE rather than excluding the row or poisoning
	 * the SUM with NULL.
	 *
	 * Each line also carries `longContext`: the subset of its totals from
	 * requests whose prompt (input + cache read + cache creation) exceeded
	 * LONG_CONTEXT_PROMPT_TOKENS (strictly greater; exactly the threshold is
	 * base tier), so window valuation can apply a long-context tier without
	 * per-request rows. Always defined on lines this method returns.
	 *
	 * Limitation: an `advisor_usage` entry sums a request's advisor
	 * iterations per model (usage-collector.ts), so its prompt total is the
	 * only size available. An entry over the threshold may be several
	 * sub-threshold calls; preserving per-iteration prompt sizes is tracked
	 * in issue #519.
	 */
	async aggregateTokensByModel(
		accountId: string,
		fromMs: number,
		toMs: number,
	): Promise<LedgerAggregate[]> {
		// Interpolated, not bound: LONG_CONTEXT_PROMPT_TOKENS is a trusted
		// integer module constant, never user input.
		const promptTokens =
			"(COALESCE(input_tokens, 0) + COALESCE(cache_read_input_tokens, 0) + COALESCE(cache_creation_input_tokens, 0))";
		const overThreshold = `${promptTokens} > ${LONG_CONTEXT_PROMPT_TOKENS}`;
		// Same rows as `billing_type = 'plan'`, but wrapped so no index can
		// serve it, which keeps both statements below on
		// idx_requests_account_timestamp. Unwrapped, the planner rates the
		// billing_type and account indexes the same, with no statistics and with
		// production's: PRAGMA optimize samples ~400 rows per index
		// (analysis_limit, incremental-vacuum-worker.ts) and records 401 rows
		// per value for both. It took the billing_type index, walked every
		// account's plan rows in the window and read each one's table page:
		// 3.9 GiB per public-value refresh in production on 2026-11-04, against
		// 510 MiB on the account index (#710).
		const planBilled = "COALESCE(billing_type, '') = 'plan'";
		const rows = await this.queryOffThread<TokenAggregateRow>(
			`
			SELECT
				COALESCE(model, '') as model,
				SUM(is_request) as request_count,
				SUM(COALESCE(input_tokens, 0)) as input_tokens,
				SUM(COALESCE(cache_read_input_tokens, 0)) as cache_read_input_tokens,
				SUM(COALESCE(cache_creation_input_tokens, 0)) as cache_creation_input_tokens,
				SUM(COALESCE(output_tokens, 0)) as output_tokens,
				SUM(CASE WHEN ${overThreshold} THEN is_request ELSE 0 END) as long_context_request_count,
				SUM(CASE WHEN ${overThreshold} THEN COALESCE(input_tokens, 0) ELSE 0 END) as long_context_input_tokens,
				SUM(CASE WHEN ${overThreshold} THEN COALESCE(cache_read_input_tokens, 0) ELSE 0 END) as long_context_cache_read_input_tokens,
				SUM(CASE WHEN ${overThreshold} THEN COALESCE(cache_creation_input_tokens, 0) ELSE 0 END) as long_context_cache_creation_input_tokens,
				SUM(CASE WHEN ${overThreshold} THEN COALESCE(output_tokens, 0) ELSE 0 END) as long_context_output_tokens
			FROM (
 SELECT model,input_tokens,cache_read_input_tokens,cache_creation_input_tokens,output_tokens,1 AS is_request FROM requests
 WHERE account_used=? AND path='/v1/messages' AND ${planBilled} AND timestamp>=? AND timestamp<?
 UNION ALL
 SELECT model,input_tokens,cache_read_input_tokens,0 AS cache_creation_input_tokens,output_tokens,0 AS is_request FROM external_usage_events
 WHERE account_id=? AND event_ts>=? AND event_ts<?
 ) usage_rows
			GROUP BY model
		`,
			[accountId, fromMs, toMs, accountId, fromMs, toMs],
		);
		// Advisor iterations (R14): advisor_usage holds per-model token totals
		// as JSON. Each entry joins its own model's line and adds no request
		// count. An entry with no model joins the '' line, as an executor row
		// with no model does, so window value reports it unpriced rather than
		// dropping it.
		const advisorRows = await this.queryOffThread<{
			id: string;
			advisor_usage: string;
		}>(
			`
			SELECT id, advisor_usage
			FROM requests
			WHERE account_used = ?
			  AND path = '/v1/messages'
			  AND ${planBilled}
			  AND timestamp >= ? AND timestamp < ?
			  AND advisor_usage IS NOT NULL
		`,
			[accountId, fromMs, toMs],
		);
		const aggregates: LedgerAggregate[] = this.mapTokenAggregateRows(rows);
		const malformedAdvisorIds: string[] = [];
		for (const row of advisorRows) {
			const { entries, malformed } = parseAdvisorUsage(row.advisor_usage);
			if (malformed) malformedAdvisorIds.push(row.id);
			for (const usage of entries) {
				const advisorModel = usage.model ?? "";
				let target = aggregates.find((entry) => entry.model === advisorModel);
				if (!target) {
					target = {
						model: advisorModel,
						requestCount: 0,
						inputTokens: 0,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						outputTokens: 0,
						longContext: {
							requestCount: 0,
							inputTokens: 0,
							cacheReadInputTokens: 0,
							cacheCreationInputTokens: 0,
							outputTokens: 0,
						},
					};
					aggregates.push(target);
				}
				target.inputTokens += usage.inputTokens;
				target.cacheReadInputTokens += usage.cacheReadInputTokens;
				target.cacheCreationInputTokens += usage.cacheCreationInputTokens;
				target.outputTokens += usage.outputTokens;
				const prompt =
					usage.inputTokens +
					usage.cacheReadInputTokens +
					usage.cacheCreationInputTokens;
				if (prompt > LONG_CONTEXT_PROMPT_TOKENS) {
					// Advisor entries add no request count anywhere.
					target.longContext.inputTokens += usage.inputTokens;
					target.longContext.cacheReadInputTokens += usage.cacheReadInputTokens;
					target.longContext.cacheCreationInputTokens +=
						usage.cacheCreationInputTokens;
					target.longContext.outputTokens += usage.outputTokens;
				}
			}
		}
		if (malformedAdvisorIds.length > 0) {
			// Only save() writes advisor_usage, so these rows were altered
			// elsewhere; whatever could not be read is missing from window value.
			log.warn("Skipped malformed advisor_usage in window aggregate", {
				accountId,
				count: malformedAdvisorIds.length,
				requestIds: malformedAdvisorIds.slice(0, 10),
			});
		}
		return aggregates;
	}

	private mapTokenAggregateRows(rows: TokenAggregateRow[]): LedgerAggregate[] {
		return rows.map((row) => ({
			// Coerce COUNT()/SUM() to Number so the return type stays a plain number.
			model: row.model,
			requestCount: Number(row.request_count) || 0,
			inputTokens: Number(row.input_tokens) || 0,
			cacheReadInputTokens: Number(row.cache_read_input_tokens) || 0,
			cacheCreationInputTokens: Number(row.cache_creation_input_tokens) || 0,
			outputTokens: Number(row.output_tokens) || 0,
			longContext: {
				requestCount: Number(row.long_context_request_count) || 0,
				inputTokens: Number(row.long_context_input_tokens) || 0,
				cacheReadInputTokens:
					Number(row.long_context_cache_read_input_tokens) || 0,
				cacheCreationInputTokens:
					Number(row.long_context_cache_creation_input_tokens) || 0,
				outputTokens: Number(row.long_context_output_tokens) || 0,
			},
		}));
	}

	async deleteOlderThan(
		cutoffTs: number,
		pacer?: CleanupPacer,
	): Promise<number> {
		// The covering index idx_requests_cleanup makes each batch faster.
		// Batch size is configurable via BETTER_CCFLARE_DB_CLEANUP_BATCH_SIZE
		// (default 200) — lower it if rows are large and batches are timing
		// out against statement_timeout (#412).
		const BATCH_SIZE = getCleanupBatchSize();
		return deleteInBatches(
			"requests",
			BATCH_SIZE,
			() =>
				this.runWithChanges(
					`DELETE FROM requests WHERE id IN (
						SELECT id FROM requests WHERE timestamp < ? LIMIT ?
					)`,
					[cutoffTs, BATCH_SIZE],
				),
			pacer,
		);
	}

	async deleteOrphanedPayloads(pacer?: CleanupPacer): Promise<number> {
		// Batched like deleteOlderThan/deletePayloadsOlderThan above — an unbounded
		// DELETE here can run too long once the table is large.
		// LEFT JOIN instead of NOT IN (SELECT ...) avoids the slow anti-join plan
		// NOT IN produces against a large subquery on SQLite.
		// Batch size is configurable via BETTER_CCFLARE_DB_CLEANUP_BATCH_SIZE
		// (default 200) — lower it if rows are large (#412).
		const BATCH_SIZE = getCleanupBatchSize();
		return deleteInBatches(
			"orphaned_payloads",
			BATCH_SIZE,
			() =>
				this.runWithChanges(
					`DELETE FROM request_payloads WHERE id IN (
						SELECT rp.id FROM request_payloads rp
						LEFT JOIN requests r ON r.id = rp.id
						WHERE r.id IS NULL
						LIMIT ?
					)`,
					[BATCH_SIZE],
				),
			pacer,
		);
	}

	async deletePayloadsOlderThan(
		cutoffTs: number,
		pacer?: CleanupPacer,
	): Promise<number> {
		// The covering index idx_request_payloads_cleanup makes each batch faster.
		// Batch size is configurable via BETTER_CCFLARE_DB_CLEANUP_BATCH_SIZE
		// (default 200) — lower it if rows are large (e.g. TOASTed payload JSON)
		// and batches are timing out against statement_timeout (#412).
		const BATCH_SIZE = getCleanupBatchSize();
		return deleteInBatches(
			"request_payloads",
			BATCH_SIZE,
			() =>
				// Direct timestamp-based deletion — avoids expensive subquery through requests table
				this.runWithChanges(
					`DELETE FROM request_payloads WHERE id IN (
						SELECT id FROM request_payloads WHERE timestamp IS NOT NULL AND timestamp < ? LIMIT ?
					)`,
					[cutoffTs, BATCH_SIZE],
				),
			pacer,
		);
	}
}
