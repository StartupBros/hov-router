import type {
	UpstreamTransportHealth,
	UpstreamTransportProviderHealth,
} from "@better-ccflare/types";

/**
 * Process-local record of whether upstream HTTP fetches get an answer, per
 * account provider. It exists because on 2026-11-02 the host lost outbound
 * TCP for 45 minutes: every Anthropic fetch failed with "Unable to connect"
 * while /health reported ok with every account routable, so nothing short of
 * grepping the journal showed that the network, not the accounts, was down.
 *
 * An answer is any HTTP response, whatever its status: a 429 or 529 still
 * proves the path to the upstream works. A failure is a fetch that rejected
 * on its own (DNS, connect, TLS, reset, header timeout). makeProxyRequest
 * does not report fetches the client or router aborted, so they count as
 * neither.
 *
 * Aggregate-only: labels are provider names, never hosts or URLs, and the
 * failure code is a short token, never an error message, because /health is
 * unauthenticated.
 */

export const UPSTREAM_TRANSPORT_WINDOW_MS = 5 * 60_000;
const BUCKET_MS = 30_000;
/**
 * Failures in a row, with no answer between them, before a provider reads
 * unreachable. During the 2026-11-02 outage each request walked every
 * Anthropic account, so this is reached within one or two requests; at
 * baseline, fetch-level failures run at about one or two an hour.
 */
export const UPSTREAM_UNREACHABLE_AFTER = 5;
const MAX_LABELS = 32;
const OTHER_LABEL = "other";
const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const CODE_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

interface Bucket {
	start: number;
	responses: number;
	failures: number;
}

interface ProviderState {
	buckets: Bucket[];
	consecutiveFailures: number;
	lastResponseAt: number | null;
	lastFailureAt: number | null;
	lastFailureCode: string | null;
}

export interface UpstreamTransportTrackerOptions {
	now?: () => number;
}

function failureCode(error: unknown): string {
	if (error && typeof error === "object") {
		const { code, name } = error as { code?: unknown; name?: unknown };
		if (typeof code === "string" && CODE_PATTERN.test(code)) return code;
		if (typeof name === "string" && CODE_PATTERN.test(name)) return name;
	}
	return "unknown";
}

function toIso(ms: number | null): string | null {
	return ms === null ? null : new Date(ms).toISOString();
}

export class UpstreamTransportTracker {
	private readonly providers = new Map<string, ProviderState>();
	private readonly now: () => number;

	constructor(options: UpstreamTransportTrackerOptions = {}) {
		this.now = options.now ?? Date.now;
	}

	/** The upstream sent an HTTP answer (any status). */
	recordResponse(provider: string): void {
		const now = this.now();
		const state = this.stateFor(provider);
		this.bucketAt(state, now).responses++;
		state.consecutiveFailures = 0;
		state.lastResponseAt = now;
	}

	/** The fetch rejected before any HTTP answer, for a reason of its own. */
	recordFailure(provider: string, error: unknown): void {
		const now = this.now();
		const state = this.stateFor(provider);
		this.bucketAt(state, now).failures++;
		state.consecutiveFailures++;
		state.lastFailureAt = now;
		state.lastFailureCode = failureCode(error);
	}

	snapshot(): UpstreamTransportHealth {
		const now = this.now();
		const windowStart = now - UPSTREAM_TRANSPORT_WINDOW_MS;
		const providers: Record<string, UpstreamTransportProviderHealth> = {};
		const unreachable: string[] = [];
		for (const [label, state] of this.providers) {
			this.prune(state, now);
			let responses = 0;
			let failures = 0;
			for (const bucket of state.buckets) {
				responses += bucket.responses;
				failures += bucket.failures;
			}
			const isUnreachable =
				state.consecutiveFailures >= UPSTREAM_UNREACHABLE_AFTER &&
				state.lastFailureAt !== null &&
				state.lastFailureAt > windowStart;
			const isReachable =
				!isUnreachable &&
				state.lastResponseAt !== null &&
				state.lastResponseAt > windowStart;
			if (isUnreachable) unreachable.push(label);
			providers[label] = {
				state: isUnreachable
					? "unreachable"
					: isReachable
						? "reachable"
						: "unknown",
				responses,
				failures,
				consecutiveFailures: state.consecutiveFailures,
				lastResponseAt: toIso(state.lastResponseAt),
				lastFailureAt: toIso(state.lastFailureAt),
				lastFailureCode: state.lastFailureCode,
			};
		}
		unreachable.sort();
		return {
			windowMs: UPSTREAM_TRANSPORT_WINDOW_MS,
			unreachableAfter: UPSTREAM_UNREACHABLE_AFTER,
			unreachable,
			providers,
		};
	}

	/** Forget everything (tests). */
	reset(): void {
		this.providers.clear();
	}

	private stateFor(provider: string): ProviderState {
		const normalized = provider.trim().toLowerCase();
		let label = LABEL_PATTERN.test(normalized) ? normalized : OTHER_LABEL;
		if (
			!this.providers.has(label) &&
			label !== OTHER_LABEL &&
			this.providers.size >= MAX_LABELS
		) {
			label = OTHER_LABEL;
		}
		let state = this.providers.get(label);
		if (!state) {
			state = {
				buckets: [],
				consecutiveFailures: 0,
				lastResponseAt: null,
				lastFailureAt: null,
				lastFailureCode: null,
			};
			this.providers.set(label, state);
		}
		return state;
	}

	private bucketAt(state: ProviderState, now: number): Bucket {
		this.prune(state, now);
		const start = now - (now % BUCKET_MS);
		const last = state.buckets.at(-1);
		if (last && last.start === start) return last;
		const bucket: Bucket = { start, responses: 0, failures: 0 };
		state.buckets.push(bucket);
		return bucket;
	}

	/** Drop buckets that end at or before the window start. */
	private prune(state: ProviderState, now: number): void {
		const windowStart = now - UPSTREAM_TRANSPORT_WINDOW_MS;
		let drop = 0;
		while (
			drop < state.buckets.length &&
			(state.buckets[drop] as Bucket).start + BUCKET_MS <= windowStart
		) {
			drop++;
		}
		if (drop > 0) state.buckets.splice(0, drop);
	}
}

/** The process-wide tracker makeProxyRequest reports into. */
export const upstreamTransportTracker = new UpstreamTransportTracker();
