import { createHash } from "node:crypto";
import type {
	CodexResetCreditRow,
	CodexResetCreditState,
	CodexResetCreditVanishReason,
	DatabaseOperations,
} from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import type {
	CodexResetCredit,
	CodexResetCreditListResult,
} from "@better-ccflare/providers";

const log = new Logger("CodexResetCredits");

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Counts older than this no longer describe the account. */
export const RESET_COUNTS_STALE_AFTER_MS = 10 * MINUTE_MS;
/** List reads failing for longer than this make the stored credits stale. */
export const RESET_LIST_STALE_AFTER_MS = 12 * HOUR_MS;
/** Unchanged counts still re-read the list this often, to catch swaps. */
const LIST_REFRESH_AFTER_MS = 6 * HOUR_MS;
/** A failed list read is retried no sooner than this, unless counts change. */
const LIST_RETRY_AFTER_MS = 15 * MINUTE_MS;
/** A new credit joins a wave holding a credit granted within this distance. */
const WAVE_JOIN_WINDOW_MS = HOUR_MS;

/** Reads one router account's credit list; the server owns token handling. */
export type CodexResetCreditListReader = (
	accountId: string,
) => Promise<CodexResetCreditListResult>;

interface ObservedCounts {
	present: boolean;
	availableCount: number | null;
	applicableCount: number | null;
}

/** Counts from a Codex usage-data object; absent unless the poll carried them. */
export function readResetCreditCounts(data: unknown): ObservedCounts {
	const record =
		data && typeof data === "object" ? (data as Record<string, unknown>) : {};
	if (record.reset_credits_present !== true) {
		return { present: false, availableCount: null, applicableCount: null };
	}
	const count = (value: unknown) =>
		typeof value === "number" && Number.isInteger(value) && value >= 0
			? value
			: null;
	return {
		present: true,
		availableCount: count(record.reset_credits_available_count),
		applicableCount: count(record.reset_credits_applicable_count),
	};
}

/** Wave key for a grant time: the grant's minute in UTC. */
export function codexWaveId(at: number): string {
	return `codex:${new Date(at).toISOString().slice(0, 16)}Z`;
}

function hashChatGptAccountId(id: string): string {
	return createHash("sha256").update(id).digest("hex");
}

/** Soonest expiry among available credits; null when none has an expiry. */
function soonestAvailableExpiry(credits: CodexResetCreditRow[]): number | null {
	let soonest: number | null = null;
	for (const credit of credits) {
		if (credit.vanishedAt != null || credit.status !== "available") continue;
		if (credit.expiresAt == null) continue;
		if (soonest === null || credit.expiresAt < soonest) {
			soonest = credit.expiresAt;
		}
	}
	return soonest;
}

export interface BankedResetsAssessment {
	availableCount: number | null;
	applicableCount: number | null;
	/** Soonest expiry among available credits, or null. */
	soonestExpiresAt: number | null;
	/** True when available credits are listed and none of them expires. */
	doesNotExpire: boolean;
	/** A reset would clear a limit on this account right now. */
	appliesNow: boolean;
	stale: boolean;
	observedAt: number | null;
}

/**
 * The account's banked resets as shown to a reader at `now`. Stale values are
 * kept, never zeroed: counts are stale when the last poll lacked them or they
 * are older than 10 minutes, and the list is stale after 12 hours of failed
 * reads.
 */
export function assessBankedResets(
	state: CodexResetCreditState,
	credits: CodexResetCreditRow[],
	now: number,
): BankedResetsAssessment {
	const available = credits.filter(
		(c) => c.vanishedAt == null && c.status === "available",
	);
	const soonestExpiresAt = soonestAvailableExpiry(available);
	const countsStale =
		!state.countsPresent ||
		state.countsObservedAt == null ||
		now - state.countsObservedAt > RESET_COUNTS_STALE_AFTER_MS;
	const listStale =
		state.listFailingSince != null &&
		now - state.listFailingSince > RESET_LIST_STALE_AFTER_MS;
	return {
		availableCount: state.availableCount,
		applicableCount: state.applicableCount,
		soonestExpiresAt,
		doesNotExpire: available.length > 0 && soonestExpiresAt === null,
		appliesNow: (state.applicableCount ?? 0) > 0,
		stale: countsStale || listStale,
		observedAt: state.countsObservedAt,
	};
}

/** Whether this observation should read the credit list. */
function shouldReadList(
	previous: CodexResetCreditState | null,
	counts: ObservedCounts,
	live: CodexResetCreditRow[],
	now: number,
): boolean {
	if (!counts.present) return false;
	if (previous?.listFailingSince != null) {
		const countsChanged =
			previous.availableCount !== counts.availableCount ||
			previous.applicableCount !== counts.applicableCount;
		return (
			countsChanged ||
			previous.lastListAttemptAt == null ||
			now - previous.lastListAttemptAt >= LIST_RETRY_AFTER_MS
		);
	}
	if (previous?.lastListSuccessAt == null) return true;
	if (
		previous.listedAvailableCount !== counts.availableCount ||
		previous.listedApplicableCount !== counts.applicableCount
	) {
		return true;
	}
	if (now - previous.lastListSuccessAt >= LIST_REFRESH_AFTER_MS) return true;
	const soonest = soonestAvailableExpiry(live);
	return soonest !== null && soonest <= now;
}

/**
 * Turns each Codex usage observation into stored counts, credits, waves and
 * vanish reasons. Counts are recorded on every observation; the credit list is
 * read only when the counts or the clock say it may have changed, at most once
 * at a time per account.
 */
export class CodexResetCreditObserver {
	private readonly inFlight = new Set<string>();

	constructor(
		private readonly dbOps: DatabaseOperations,
		private readonly readList: CodexResetCreditListReader,
		private readonly now: () => number = Date.now,
	) {}

	private get repo() {
		return this.dbOps.getCodexResetCreditsRepository();
	}

	/** Entry point from the usage poller; other providers are ignored. */
	async observeSnapshot(payload: {
		accountId: string;
		provider: string;
		data: unknown;
	}): Promise<void> {
		if (payload.provider !== "codex") return;
		await this.observeUsageData(payload.accountId, payload.data);
	}

	/** Entry point for a fresh Codex usage-data object. */
	async observeUsageData(accountId: string, data: unknown): Promise<void> {
		const counts = readResetCreditCounts(data);
		const at = this.now();
		const previous = await this.repo.getState(accountId);
		const live = await this.repo.listCredits(accountId, {
			includeVanished: false,
		});
		if (counts.present || !previous) {
			await this.repo.recordCounts(accountId, {
				availableCount: counts.availableCount,
				applicableCount: counts.applicableCount,
				countsPresent: counts.present,
				observedAt: at,
			});
		} else {
			// The poll lacked the fields: keep the last values and when they
			// were seen, and mark them absent so readers show them as stale.
			await this.repo.recordCounts(accountId, {
				availableCount: previous.availableCount,
				applicableCount: previous.applicableCount,
				countsPresent: false,
				observedAt: previous.countsObservedAt ?? at,
			});
		}

		// No await between the check and the claim: one read per account.
		if (this.inFlight.has(accountId)) return;
		if (!shouldReadList(previous, counts, live, at)) return;
		this.inFlight.add(accountId);
		try {
			await this.readAndApply(accountId, counts);
		} finally {
			this.inFlight.delete(accountId);
		}
	}

	private async readAndApply(
		accountId: string,
		counts: ObservedCounts,
	): Promise<void> {
		let result: CodexResetCreditListResult;
		try {
			result = await this.readList(accountId);
		} catch (error) {
			log.warn(
				`Reset credit list read failed for account ${accountId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			await this.repo.recordListFailure(accountId, this.now());
			return;
		}
		const at = this.now();
		if (!result.ok) {
			log.warn(
				`Reset credit list read failed for account ${accountId}: ${result.reason}${result.status == null ? "" : ` ${result.status}`}`,
			);
			await this.repo.recordListFailure(accountId, at);
			return;
		}

		const state = await this.repo.getState(accountId);
		const hash =
			result.chatgptAccountId == null
				? null
				: hashChatGptAccountId(result.chatgptAccountId);
		let live = await this.repo.listCredits(accountId, {
			includeVanished: false,
		});
		let baselineAt: number | null = null;
		if (
			hash != null &&
			state?.chatgptAccountHash != null &&
			state.chatgptAccountHash !== hash
		) {
			// The router account now points at a different ChatGPT account:
			// its old credits are not redemptions, and its new ones are not
			// grants.
			await this.repo.markVanished(
				accountId,
				live.map((c) => c.creditId),
				at,
				"account_changed",
			);
			live = [];
			baselineAt = at;
		} else if (state?.baselineAt == null) {
			baselineAt = at;
		}

		const known = new Set(
			(await this.repo.listCredits(accountId, { includeVanished: true })).map(
				(c) => c.creditId,
			),
		);
		const listedIds = new Set<string>();
		for (const credit of result.credits) {
			listedIds.add(credit.id);
			if (known.has(credit.id)) {
				await this.repo.updateSeenCredit(accountId, credit.id, {
					status: credit.status,
					resetType: credit.resetType,
					grantedAt: credit.grantedAt,
					expiresAt: credit.expiresAt,
					title: credit.title,
					description: credit.description,
					lastSeenAt: at,
				});
			} else {
				await this.insertNewCredit(accountId, credit, at, baselineAt !== null);
			}
		}

		const vanished: Record<CodexResetCreditVanishReason, string[]> = {
			expired: [],
			redeemed_elsewhere: [],
			account_changed: [],
		};
		for (const credit of live) {
			if (listedIds.has(credit.creditId)) continue;
			const reason =
				credit.expiresAt != null && credit.expiresAt <= at
					? "expired"
					: "redeemed_elsewhere";
			vanished[reason].push(credit.creditId);
		}
		await this.repo.markVanished(accountId, vanished.expired, at, "expired");
		await this.repo.markVanished(
			accountId,
			vanished.redeemed_elsewhere,
			at,
			"redeemed_elsewhere",
		);

		await this.repo.recordListSuccess(accountId, {
			at,
			listedAvailableCount: counts.availableCount,
			listedApplicableCount: counts.applicableCount,
			chatgptAccountHash: hash ?? state?.chatgptAccountHash ?? null,
			baselineAt,
		});
	}

	private async insertNewCredit(
		accountId: string,
		credit: CodexResetCredit,
		at: number,
		isBaseline: boolean,
	): Promise<void> {
		const nearWave =
			credit.grantedAt == null
				? null
				: await this.repo.findWaveIdNearGrant(
						credit.grantedAt,
						WAVE_JOIN_WINDOW_MS,
					);
		await this.repo.insertCreditIfAbsent({
			accountId,
			creditId: credit.id,
			resetType: credit.resetType,
			status: credit.status,
			grantedAt: credit.grantedAt,
			expiresAt: credit.expiresAt,
			title: credit.title,
			description: credit.description,
			firstSeenAt: at,
			lastSeenAt: at,
			isBaseline,
			waveId: nearWave ?? codexWaveId(credit.grantedAt ?? at),
			vanishedAt: null,
			vanishReason: null,
		});
	}
}
