import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Config } from "@better-ccflare/config";
import type {
	DatabaseOperations,
	MemberNoticeAttemptResult,
	MemberNoticeKind,
	MemberNoticeRow,
} from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import type { MemberNoticeState } from "@better-ccflare/types";
import { ALERT_WEBHOOK_USER_AGENT, getMemberNoticeDestination } from "./alerts";

/**
 * Member notices: account-free reset events for HoV members, sent to BroBot,
 * which reviews them and posts the member cards. An event is claimed when a
 * Codex reset wave arrives (KTD17), before a wave expires (KTD18), and when
 * several accounts' weekly limits reset early (KTD19). Each event is a claimed
 * row (KTD16) delivered under a lease (KTD20) by one pass a minute (KTD21).
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** A wave is announced once no credit has joined it for this long. */
const GRANT_QUIET_MS = 30 * MINUTE_MS;
/** Waves whose newest credit is older than this are never announced. */
const GRANT_ELIGIBLE_MS = DAY_MS;
const GRANT_NOTICE_TTL_MS = DAY_MS;

const REMINDER_LEADS = [
	{ lead: "3d", ms: 3 * DAY_MS },
	{ lead: "1d", ms: DAY_MS },
] as const;
type ReminderLead = (typeof REMINDER_LEADS)[number]["lead"];
/** A reminder is claimed only this soon after its lead point, never late. */
const REMINDER_WINDOW_MS = 6 * HOUR_MS;

/** Rollovers seen at the poll more than this long ago are ignored. */
const EARLY_OPENED_WITHIN_MS = 60 * MINUTE_MS;
/** A rollover waits this long so a second account can pair with it. */
const EARLY_SETTLE_MS = 10 * MINUTE_MS;
const EARLY_MIN_ACCOUNTS = 2;
const EARLY_REPEAT_MS = 6 * HOUR_MS;
const EARLY_NOTICE_TTL_MS = HOUR_MS;

const LEASE_MS = 60_000;
const SEND_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = MINUTE_MS;
const BACKOFF_CAP_MS = 30 * MINUTE_MS;
const DELIVERY_BATCH = 20;

/** The member-facing provider an event is about. */
type NoticeProvider = "codex" | "claude";

/** Account providers whose weekly rollovers count, by member-facing provider. */
const EARLY_RESET_PROVIDERS: ReadonlyMap<string, NoticeProvider> = new Map([
	["codex", "codex"],
	["anthropic", "claude"],
	["claude-oauth", "claude"],
]);

function utcMinute(ms: number): string {
	return `${new Date(ms).toISOString().slice(0, 16)}Z`;
}

/**
 * The body of one event, built when the notice is claimed and stored as the
 * row's content, so every retry sends the same bytes. The fields are BroBot's
 * contract (version 1) in a fixed order, and the only inputs are a key, a
 * kind, a provider, dates and a lead time (KTD15): an event can never carry an
 * account name, id, email or count.
 */
function memberNoticeEvent(event: {
	noticeKey: string;
	kind: MemberNoticeKind;
	provider: NoticeProvider;
	detectedAt: number;
	waveExpiresAt: number | null;
	lead: ReminderLead | null;
}): string {
	return JSON.stringify({
		version: 1,
		noticeKey: event.noticeKey,
		kind: event.kind,
		provider: event.provider,
		detectedAt: new Date(event.detectedAt).toISOString(),
		waveExpiresAt:
			event.waveExpiresAt === null
				? null
				: new Date(event.waveExpiresAt).toISOString(),
		lead: event.lead,
	});
}

/**
 * BroBot's v1 request signature: `v1=` and the hex HMAC-SHA256, under the
 * shared secret, of the method, path, millisecond timestamp, request id and
 * the body's SHA-256 hex, one per line. It must match
 * `generateRequestSignature` in BroBot's `packages/shared`, which the golden
 * vector in the tests pins.
 */
export function signMemberNoticeRequest(
	secret: string,
	request: {
		method: string;
		pathname: string;
		timestamp: number;
		requestId: string;
		body: string;
	},
): string {
	const bodyHash = createHash("sha256").update(request.body).digest("hex");
	const message = [
		request.method,
		request.pathname,
		String(request.timestamp),
		request.requestId,
		bodyHash,
	].join("\n");
	return `v1=${createHmac("sha256", secret).update(message).digest("hex")}`;
}

type NoticeStore = Pick<
	DatabaseOperations,
	| "getMemberNoticesRepository"
	| "getCodexResetCreditsRepository"
	| "getCodexResetRedemptionsRepository"
	| "getUsageWindowsRepository"
>;

/**
 * Claim every notice that is due at `now`. Returns the keys this call
 * claimed; a key another pass or process already claimed is not returned.
 */
export async function detectMemberNotices(
	dbOps: NoticeStore,
	now: number,
): Promise<string[]> {
	const notices = dbOps.getMemberNoticesRepository();
	const claimed: string[] = [];
	const claim = async (input: Parameters<typeof notices.claim>[0]) => {
		if (await notices.claim(input)) claimed.push(input.noticeKey);
	};

	const waves = await dbOps
		.getCodexResetCreditsRepository()
		.listWaveSummaries(now - GRANT_ELIGIBLE_MS, now);
	for (const wave of waves) {
		const sinceNewest = now - wave.newestFirstSeenAt;
		if (
			wave.hasNonBaseline &&
			sinceNewest >= GRANT_QUIET_MS &&
			sinceNewest < GRANT_ELIGIBLE_MS
		) {
			const noticeKey = `grant:${wave.waveId}`;
			await claim({
				noticeKey,
				kind: "grant",
				provider: "codex",
				content: memberNoticeEvent({
					noticeKey,
					kind: "grant",
					provider: "codex",
					detectedAt: now,
					waveExpiresAt: wave.expiresAt,
					lead: null,
				}),
				claimedAt: now,
				expiresAt: now + GRANT_NOTICE_TTL_MS,
			});
		}
		if (wave.expiresAt === null) continue;
		for (const { lead, ms } of REMINDER_LEADS) {
			const from = wave.expiresAt - ms;
			if (now < from || now >= from + REMINDER_WINDOW_MS) continue;
			const noticeKey = `remind:${wave.waveId}:${lead}`;
			await claim({
				noticeKey,
				kind: "reminder",
				provider: "codex",
				content: memberNoticeEvent({
					noticeKey,
					kind: "reminder",
					provider: "codex",
					detectedAt: now,
					waveExpiresAt: wave.expiresAt,
					lead,
				}),
				claimedAt: now,
				expiresAt: from + REMINDER_WINDOW_MS,
			});
		}
	}

	for (const provider of await findEarlyResets(dbOps, now)) {
		const previous = await notices.latestClaim("early_reset", provider);
		if (previous !== null && previous.claimedAt > now - EARLY_REPEAT_MS) {
			continue;
		}
		// The key names the provider's previous early-reset notice, not the
		// rollovers, which change as the hour slides. Passes in two processes
		// that see the same previous notice try the same key, and the unique
		// key lets only one of them claim it.
		const after = previous === null ? "none" : utcMinute(previous.claimedAt);
		const noticeKey = `early:${provider}:after:${after}`;
		await claim({
			noticeKey,
			kind: "early_reset",
			provider,
			content: memberNoticeEvent({
				noticeKey,
				kind: "early_reset",
				provider,
				detectedAt: now,
				waveExpiresAt: null,
				lead: null,
			}),
			claimedAt: now,
			expiresAt: now + EARLY_NOTICE_TTL_MS,
		});
	}
	return claimed;
}

/**
 * Member-facing providers where at least two accounts' weekly windows rolled
 * over early with nothing on the account to explain it. A rollover counts
 * once it is 10 minutes old and until it is 60, so two accounts pair only
 * when their rollovers were seen within about 50 minutes of each other.
 */
async function findEarlyResets(
	dbOps: NoticeStore,
	now: number,
): Promise<NoticeProvider[]> {
	// The ledger dates an early row from its reset anchor, at most a week
	// before the poll that saw it, so this bound misses no recent rollover.
	const candidates = await dbOps
		.getUsageWindowsRepository()
		.listEarlyResetCandidates(now - WEEK_MS - EARLY_OPENED_WITHIN_MS);
	const credits = dbOps.getCodexResetCreditsRepository();
	const redemptions = dbOps.getCodexResetRedemptionsRepository();
	const accountsByProvider = new Map<NoticeProvider, Set<string>>();
	for (const candidate of candidates) {
		const provider = EARLY_RESET_PROVIDERS.get(candidate.provider);
		if (!provider) continue;
		const openedAt = candidate.previousClosedAt ?? candidate.startedAt;
		if (
			openedAt <= now - EARLY_OPENED_WITHIN_MS ||
			openedAt > now - EARLY_SETTLE_MS
		) {
			continue;
		}
		// A redemption or a redeemed credit since the previous window began
		// explains the rollover, however long the account then sat idle.
		const since = candidate.previousStartedAt ?? candidate.startedAt - WEEK_MS;
		if (
			(await redemptions.hasAttemptSince(candidate.accountId, since)) ||
			(await credits.hasRedeemedVanishSince(candidate.accountId, since))
		) {
			continue;
		}
		const accounts = accountsByProvider.get(provider) ?? new Set<string>();
		accounts.add(candidate.accountId);
		accountsByProvider.set(provider, accounts);
	}
	return [...accountsByProvider]
		.filter(([, accounts]) => accounts.size >= EARLY_MIN_ACCOUNTS)
		.map(([provider]) => provider);
}

export type MemberNoticeFetch = (
	url: string,
	init: RequestInit,
) => Promise<Response>;

type SendOutcome =
	| { outcome: "delivered"; status: string }
	| { outcome: "retry"; status: string; retryAfterMs: number | null }
	| { outcome: "gave_up"; status: string };

function parseRetryAfter(value: string | null, now: number): number | null {
	if (value === null) return null;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
	const date = Date.parse(trimmed);
	return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function backoffMs(attempt: number): number {
	return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
}

/**
 * Post one stored event to BroBot's intake, signed now, so each attempt has
 * its own timestamp and request id while the body stays the bytes claimed.
 * The secret goes into the signature only, never a header. The address, any
 * error message (which can embed it) and the response body stay out of every
 * log and stored status.
 */
async function sendMemberNotice(
	destination: { url: string; secret: string },
	notice: MemberNoticeRow,
	fetchImpl: MemberNoticeFetch,
	now: () => number,
): Promise<SendOutcome> {
	const body = notice.content;
	const timestamp = now();
	const requestId = randomUUID();
	const signature = signMemberNoticeRequest(destination.secret, {
		method: "POST",
		pathname: new URL(destination.url).pathname,
		timestamp,
		requestId,
		body,
	});
	let response: Response;
	try {
		response = await fetchImpl(destination.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"User-Agent": ALERT_WEBHOOK_USER_AGENT,
				"X-Request-Signature": signature,
				"X-Request-Timestamp": String(timestamp),
				"X-Request-Id": requestId,
				"X-Key-Version": "1",
			},
			body,
			// A followed redirect turns the POST into a GET of some other page,
			// whose 200 would count an unsent notice as delivered.
			redirect: "manual",
			signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
		});
	} catch {
		return { outcome: "retry", status: "network_error", retryAfterMs: null };
	}
	await response.body?.cancel().catch(() => {});
	const status = String(response.status);
	if (response.status >= 200 && response.status < 300) {
		return { outcome: "delivered", status };
	}
	if (response.status === 429) {
		return {
			outcome: "retry",
			status,
			retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), now()),
		};
	}
	if (response.status >= 500) {
		return { outcome: "retry", status, retryAfterMs: null };
	}
	return { outcome: "gave_up", status };
}

export interface MemberNoticePassDeps {
	dbOps: NoticeStore;
	config: Config;
	now: () => number;
	fetch: MemberNoticeFetch;
	/** The lease owner for this pass; a fresh id when omitted. */
	owner?: string;
	/**
	 * Once aborted, the pass leases no further notice. A send already in
	 * flight still finishes and records its result.
	 */
	signal?: AbortSignal;
	/** Called once per notice given up for a reason other than expiry. */
	onDeliveryFailed: (status: string) => Promise<void> | void;
}

export interface MemberNoticePassResult {
	state: MemberNoticeState;
	claimed: string[];
	delivered: number;
	retried: number;
	gaveUp: number;
	expired: number;
}

/**
 * One scheduler pass: claim due notices, expire stale ones, then send each
 * due notice under its own lease. Does nothing unless the destination is
 * `on`, so no notice is claimed while members could not receive it.
 */
export async function runMemberNoticePass(
	deps: MemberNoticePassDeps,
): Promise<MemberNoticePassResult> {
	const destination = getMemberNoticeDestination(deps.config);
	const result: MemberNoticePassResult = {
		state: destination.state,
		claimed: [],
		delivered: 0,
		retried: 0,
		gaveUp: 0,
		expired: 0,
	};
	if (destination.state !== "on") return result;
	const owner = deps.owner ?? randomUUID();
	const notices = deps.dbOps.getMemberNoticesRepository();

	result.claimed = await detectMemberNotices(deps.dbOps, deps.now());
	result.expired = await notices.expireDue(deps.now());
	for (const notice of await notices.listDue(deps.now(), DELIVERY_BATCH)) {
		if (deps.signal?.aborted) break;
		if (!(await notices.lease(notice.noticeKey, owner, deps.now(), LEASE_MS))) {
			continue;
		}
		const sent = await sendMemberNotice(
			destination,
			notice,
			deps.fetch,
			deps.now,
		);
		const at = deps.now();
		const attempt = notice.attempts + 1;
		const attemptResult: MemberNoticeAttemptResult =
			sent.outcome === "retry"
				? {
						outcome: "retry",
						status: sent.status,
						nextAttemptAt: at + (sent.retryAfterMs ?? backoffMs(attempt)),
					}
				: { outcome: sent.outcome, status: sent.status, at };
		// A late result from a lease another pass has since taken writes nothing.
		if (
			!(await notices.finishAttempt(notice.noticeKey, owner, attemptResult))
		) {
			continue;
		}
		if (sent.outcome === "delivered") result.delivered++;
		else if (sent.outcome === "retry") result.retried++;
		else {
			result.gaveUp++;
			await deps.onDeliveryFailed(sent.status);
		}
	}
	return result;
}

/**
 * Run `pass` once a minute, one at a time, until the returned stop function
 * is called. Stop aborts the signal handed to `pass`, so it starts no further
 * send, and resolves once the running pass has finished. Shutdown awaits it,
 * so a notice BroBot accepted is recorded as delivered before the
 * database closes, rather than posted again after restart. It lives here
 * rather than in server.ts so it can be tested.
 */
export function startMemberNoticeScheduler(
	pass: (signal: AbortSignal) => Promise<unknown>,
	options: {
		initialDelayMs?: number;
		intervalMs?: number;
		log?: { error(message: string): void };
	} = {},
): () => Promise<void> {
	const log = options.log ?? new Logger("MemberNotices");
	const stopping = new AbortController();
	let running: Promise<void> | null = null;
	const runOnce = async () => {
		try {
			await pass(stopping.signal);
		} catch (error) {
			// The error message can embed the member address; log its name only.
			log.error(
				`Member notice pass failed (${error instanceof Error ? error.name : "non-error value"})`,
			);
		}
	};
	const tick = () => {
		if (running || stopping.signal.aborted) return;
		const current = runOnce();
		running = current;
		void current.then(() => {
			if (running === current) running = null;
		});
	};
	const initial = setTimeout(tick, options.initialDelayMs ?? 30_000);
	const interval = setInterval(tick, options.intervalMs ?? MINUTE_MS);
	return async () => {
		stopping.abort();
		clearTimeout(initial);
		clearInterval(interval);
		await running;
	};
}
