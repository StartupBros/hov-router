import { randomUUID } from "node:crypto";
import type { Config } from "@better-ccflare/config";
import { PRODUCT_NAME } from "@better-ccflare/core/product-identity";
import type {
	DatabaseOperations,
	MemberNoticeAttemptResult,
	MemberNoticeRow,
} from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import type { MemberNoticeState } from "@better-ccflare/types";
import {
	ALERT_WEBHOOK_USER_AGENT,
	getMemberNoticeDestination,
	isDiscordWebhookUrl,
} from "./alerts";

/**
 * Member notices: account-free posts to the members' channel when a Codex
 * reset wave arrives (KTD17), before a wave expires (KTD18), and when several
 * accounts' weekly limits reset early (KTD19). Each notice is a claimed row
 * (KTD16) delivered under a lease (KTD20) by one pass a minute (KTD21).
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
export type MemberNoticeReminderLead = (typeof REMINDER_LEADS)[number]["lead"];
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

export type MemberNoticeProviderName = "Codex" | "Claude";

/** Account providers whose weekly rollovers count, by member-facing group. */
const EARLY_RESET_GROUPS: ReadonlyMap<
	string,
	{ group: string; providerName: MemberNoticeProviderName }
> = new Map([
	["codex", { group: "codex", providerName: "Codex" }],
	["anthropic", { group: "claude", providerName: "Claude" }],
	["claude-oauth", { group: "claude", providerName: "Claude" }],
]);

const USAGE_COMMAND: Record<MemberNoticeProviderName, string> = {
	Codex: "/usage in the Codex CLI",
	Claude: "/usage in Claude Code",
};

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/** "November 30, 2026 at 20:04 UTC", built by hand so no locale data is needed. */
function formatUtc(ms: number): string {
	const date = new Date(ms);
	const hours = String(date.getUTCHours()).padStart(2, "0");
	const minutes = String(date.getUTCMinutes()).padStart(2, "0");
	return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()} at ${hours}:${minutes} UTC`;
}

function utcMinute(ms: number): string {
	return `${new Date(ms).toISOString().slice(0, 16)}Z`;
}

function signed(lines: string[]): string {
	return `${lines.join(" ")}\n— ${PRODUCT_NAME}`;
}

// Templates take only a provider name, a date and a lead time (KTD15), so a
// notice can never carry an account name, id, email or count.

export function renderGrantNotice(input: {
	providerName: MemberNoticeProviderName;
	expiresAt: number | null;
}): string {
	const lines = [
		`New ${input.providerName} banked resets may be on your account.`,
		"To use one, open /usage in the Codex CLI and choose Redeem reset.",
	];
	if (input.expiresAt !== null) {
		lines.push(`This wave expires ${formatUtc(input.expiresAt)}.`);
	}
	return signed(lines);
}

export function renderReminderNotice(input: {
	providerName: MemberNoticeProviderName;
	expiresAt: number;
	lead: MemberNoticeReminderLead;
}): string {
	const left = input.lead === "3d" ? "3 days" : "1 day";
	return signed([
		`${input.providerName} banked resets from a recent wave expire in ${left}, on ${formatUtc(input.expiresAt)}.`,
		"If you still have one, open /usage in the Codex CLI and choose Redeem reset before then.",
	]);
}

export function renderEarlyResetNotice(input: {
	providerName: MemberNoticeProviderName;
}): string {
	return signed([
		`${input.providerName} weekly limits appear to have reset early.`,
		`Check your own limits with ${USAGE_COMMAND[input.providerName]}.`,
	]);
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
			await claim({
				noticeKey: `grant:${wave.waveId}`,
				kind: "grant",
				provider: "codex",
				content: renderGrantNotice({
					providerName: "Codex",
					expiresAt: wave.expiresAt,
				}),
				claimedAt: now,
				expiresAt: now + GRANT_NOTICE_TTL_MS,
			});
		}
		if (wave.expiresAt === null) continue;
		for (const { lead, ms } of REMINDER_LEADS) {
			const from = wave.expiresAt - ms;
			if (now < from || now >= from + REMINDER_WINDOW_MS) continue;
			await claim({
				noticeKey: `remind:${wave.waveId}:${lead}`,
				kind: "reminder",
				provider: "codex",
				content: renderReminderNotice({
					providerName: "Codex",
					expiresAt: wave.expiresAt,
					lead,
				}),
				claimedAt: now,
				expiresAt: from + REMINDER_WINDOW_MS,
			});
		}
	}

	for (const event of await findEarlyResets(dbOps, now)) {
		if (
			await notices.hasClaimSince(
				"early_reset",
				event.group,
				now - EARLY_REPEAT_MS,
			)
		) {
			continue;
		}
		await claim({
			noticeKey: `early:${event.group}:${utcMinute(event.earliestStartedAt)}`,
			kind: "early_reset",
			provider: event.group,
			content: renderEarlyResetNotice({ providerName: event.providerName }),
			claimedAt: now,
			expiresAt: now + EARLY_NOTICE_TTL_MS,
		});
	}
	return claimed;
}

/**
 * Provider groups where at least two accounts' weekly windows rolled over
 * early with nothing on the account to explain it. A rollover counts once it
 * is 10 minutes old and until it is 60, so two accounts pair only when their
 * rollovers were seen within about 50 minutes of each other.
 */
async function findEarlyResets(
	dbOps: NoticeStore,
	now: number,
): Promise<
	{
		group: string;
		providerName: MemberNoticeProviderName;
		earliestStartedAt: number;
	}[]
> {
	// The ledger dates an early row from its reset anchor, at most a week
	// before the poll that saw it, so this bound misses no recent rollover.
	const candidates = await dbOps
		.getUsageWindowsRepository()
		.listEarlyResetCandidates(now - WEEK_MS - EARLY_OPENED_WITHIN_MS);
	const credits = dbOps.getCodexResetCreditsRepository();
	const redemptions = dbOps.getCodexResetRedemptionsRepository();
	const groups = new Map<
		string,
		{
			providerName: MemberNoticeProviderName;
			accounts: Set<string>;
			earliestStartedAt: number;
		}
	>();
	for (const candidate of candidates) {
		const mapping = EARLY_RESET_GROUPS.get(candidate.provider);
		if (!mapping) continue;
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
		const entry = groups.get(mapping.group) ?? {
			providerName: mapping.providerName,
			accounts: new Set<string>(),
			earliestStartedAt: candidate.startedAt,
		};
		entry.accounts.add(candidate.accountId);
		entry.earliestStartedAt = Math.min(
			entry.earliestStartedAt,
			candidate.startedAt,
		);
		groups.set(mapping.group, entry);
	}
	return [...groups]
		.filter(([, entry]) => entry.accounts.size >= EARLY_MIN_ACCOUNTS)
		.map(([group, entry]) => ({
			group,
			providerName: entry.providerName,
			earliestStartedAt: entry.earliestStartedAt,
		}));
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
 * Post one notice. The address carries the webhook's secret token, so it,
 * any error message (which can embed it) and the response body stay out of
 * every log and stored status.
 */
async function sendMemberNotice(
	address: string,
	notice: MemberNoticeRow,
	fetchImpl: MemberNoticeFetch,
	now: () => number,
): Promise<SendOutcome> {
	let url: URL;
	try {
		url = new URL(address);
	} catch {
		return { outcome: "gave_up", status: "invalid_address" };
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		return { outcome: "gave_up", status: "invalid_address" };
	}
	const body = isDiscordWebhookUrl(url)
		? { content: notice.content, allowed_mentions: { parse: [] } }
		: { kind: notice.kind, text: notice.content };
	let response: Response;
	try {
		response = await fetchImpl(address, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"User-Agent": ALERT_WEBHOOK_USER_AGENT,
			},
			body: JSON.stringify(body),
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
	if (destination.state !== "on" || destination.url === null) return result;
	const address = destination.url;
	const owner = deps.owner ?? randomUUID();
	const notices = deps.dbOps.getMemberNoticesRepository();

	result.claimed = await detectMemberNotices(deps.dbOps, deps.now());
	result.expired = await notices.expireDue(deps.now());
	for (const notice of await notices.listDue(deps.now(), DELIVERY_BATCH)) {
		if (!(await notices.lease(notice.noticeKey, owner, deps.now(), LEASE_MS))) {
			continue;
		}
		const sent = await sendMemberNotice(address, notice, deps.fetch, deps.now);
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
 * is called. It lives here rather than in server.ts so it can be tested.
 */
export function startMemberNoticeScheduler(
	pass: () => Promise<unknown>,
	options: {
		initialDelayMs?: number;
		intervalMs?: number;
		log?: { error(message: string): void };
	} = {},
): () => void {
	const log = options.log ?? new Logger("MemberNotices");
	let running = false;
	let stopped = false;
	const tick = async () => {
		if (running || stopped) return;
		running = true;
		try {
			await pass();
		} catch (error) {
			// The error message can embed the member address; log its name only.
			log.error(
				`Member notice pass failed (${error instanceof Error ? error.name : "non-error value"})`,
			);
		} finally {
			running = false;
		}
	};
	const initial = setTimeout(tick, options.initialDelayMs ?? 30_000);
	const interval = setInterval(tick, options.intervalMs ?? MINUTE_MS);
	return () => {
		stopped = true;
		clearTimeout(initial);
		clearInterval(interval);
	};
}
