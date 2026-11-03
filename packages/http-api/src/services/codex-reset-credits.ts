import type {
	CodexResetCreditRow,
	CodexResetCreditState,
	CodexResetCreditVanishReason,
	DatabaseOperations,
} from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import {
	type CodexResetCredit,
	type CodexResetCreditListResult,
	hashChatGptAccountId,
	nonNegativeIntegerOrNull,
} from "@better-ccflare/providers";

const log = new Logger("CodexResetCredits");

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const RESET_COUNTS_STALE_AFTER_MS = 10 * MINUTE_MS;
const RESET_LIST_STALE_AFTER_MS = 12 * HOUR_MS;
const LIST_REFRESH_AFTER_MS = 6 * HOUR_MS;
const LIST_RETRY_AFTER_MS = 15 * MINUTE_MS;
const WAVE_JOIN_WINDOW_MS = HOUR_MS;

/** Reads one router account's credit list; the server owns token handling. */
export type CodexResetCreditListReader = (
	accountId: string,
) => Promise<CodexResetCreditListResult>;

/** Names the ChatGPT account a router account's stored credential belongs to. */
export type CodexResetCreditIdentityReader = (
	accountId: string,
) => Promise<string | null>;

export interface ObservedCounts {
	present: boolean;
	availableCount: number | null;
	applicableCount: number | null;
}

export function readResetCreditCounts(data: unknown): ObservedCounts {
	const record =
		data && typeof data === "object" ? (data as Record<string, unknown>) : {};
	if (record.reset_credits_present !== true) {
		return { present: false, availableCount: null, applicableCount: null };
	}
	return {
		present: true,
		availableCount: nonNegativeIntegerOrNull(
			record.reset_credits_available_count,
		),
		applicableCount: nonNegativeIntegerOrNull(
			record.reset_credits_applicable_count,
		),
	};
}

function codexWaveId(at: number): string {
	return `codex:${new Date(at).toISOString().slice(0, 16)}Z`;
}

/** Soonest expiry among available credits, optionally only those after `after`. */
function soonestAvailableExpiry(
	credits: CodexResetCreditRow[],
	after: number | null = null,
): number | null {
	let soonest: number | null = null;
	for (const credit of credits) {
		if (credit.vanishedAt != null || credit.status !== "available") continue;
		if (credit.expiresAt == null) continue;
		if (after !== null && credit.expiresAt <= after) continue;
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
	// Only an expiry that passed since the last read triggers one: a credit
	// OpenAI still lists after its expiry must not make every poll re-read.
	const soonest = soonestAvailableExpiry(live, previous.lastListSuccessAt);
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
		private readonly readIdentity?: CodexResetCreditIdentityReader,
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
			await this.repo.recordCounts(accountId, {
				availableCount: previous.availableCount,
				applicableCount: previous.applicableCount,
				countsPresent: false,
				observedAt: previous.countsObservedAt ?? at,
			});
		}

		const listDue = shouldReadList(previous, counts, live, at);
		const accountChanged =
			!listDue &&
			(await this.credentialAccountChanged(accountId, previous, counts));
		// No await between the check and the claim: one read per account.
		if (this.inFlight.has(accountId)) return;
		if (!listDue && !accountChanged) return;
		this.inFlight.add(accountId);
		try {
			await this.readAndApply(accountId, counts);
		} finally {
			this.inFlight.delete(accountId);
		}
	}

	/**
	 * True when the stored credential now names a different ChatGPT account
	 * than the last list read did, as after a reauthentication with unchanged
	 * counts. A failing list keeps its retry floor instead.
	 */
	private async credentialAccountChanged(
		accountId: string,
		previous: CodexResetCreditState | null,
		counts: ObservedCounts,
	): Promise<boolean> {
		if (!this.readIdentity || !counts.present) return false;
		if (
			previous?.chatgptAccountHash == null ||
			previous.listFailingSince != null
		) {
			return false;
		}
		let chatgptAccountId: string | null;
		try {
			chatgptAccountId = await this.readIdentity(accountId);
		} catch (error) {
			log.warn(
				`Could not read the ChatGPT account for account ${accountId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
		return (
			chatgptAccountId != null &&
			hashChatGptAccountId(chatgptAccountId) !== previous.chatgptAccountHash
		);
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
		const stored = await this.repo.listCredits(accountId, {
			includeVanished: true,
		});
		const known = new Set(stored.map((c) => c.creditId));
		let live = stored.filter((c) => c.vanishedAt == null);
		let baselineAt: number | null = null;
		if (
			hash != null &&
			state?.chatgptAccountHash != null &&
			state.chatgptAccountHash !== hash
		) {
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
			redeemed_by_router: [],
			account_changed: [],
		};
		const gone = live.filter((credit) => !listedIds.has(credit.creditId));
		// A router redemption OpenAI reported as spending the credit explains
		// its departure better than the expiry or "somewhere else".
		const byRouter = new Set(
			await this.dbOps
				.getCodexResetRedemptionsRepository()
				.findRouterRedeemedCreditIds(
					accountId,
					gone.map((credit) => credit.creditId),
				),
		);
		for (const credit of gone) {
			const reason = byRouter.has(credit.creditId)
				? "redeemed_by_router"
				: credit.expiresAt != null && credit.expiresAt <= at
					? "expired"
					: "redeemed_elsewhere";
			vanished[reason].push(credit.creditId);
		}
		for (const reason of [
			"expired",
			"redeemed_elsewhere",
			"redeemed_by_router",
		] as const) {
			await this.repo.markVanished(accountId, vanished[reason], at, reason);
		}

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
