import { BaseRepository } from "./base.repository";

export type CodexResetCreditVanishReason =
	| "redeemed_elsewhere"
	| "expired"
	| "account_changed";

export interface CodexResetCreditState {
	accountId: string;
	availableCount: number | null;
	applicableCount: number | null;
	countsPresent: boolean;
	countsObservedAt: number | null;
	listedAvailableCount: number | null;
	listedApplicableCount: number | null;
	lastListSuccessAt: number | null;
	lastListAttemptAt: number | null;
	listFailingSince: number | null;
	baselineAt: number | null;
	chatgptAccountHash: string | null;
	updatedAt: number;
}

export interface CodexResetCreditRow {
	accountId: string;
	creditId: string;
	resetType: string | null;
	status: string;
	grantedAt: number | null;
	expiresAt: number | null;
	title: string | null;
	description: string | null;
	firstSeenAt: number;
	lastSeenAt: number;
	isBaseline: boolean;
	waveId: string | null;
	vanishedAt: number | null;
	vanishReason: string | null;
}

// Raw rows: PostgreSQL's driver can hand BIGINT back as a string, so every
// numeric column is normalised through num()/numOrNull() in the mappers.
type Raw = Record<string, unknown>;

function numOrNull(value: unknown): number | null {
	return value == null ? null : Number(value);
}

function num(value: unknown): number {
	return Number(value);
}

function toState(row: Raw): CodexResetCreditState {
	return {
		accountId: String(row.account_id),
		availableCount: numOrNull(row.available_count),
		applicableCount: numOrNull(row.applicable_available_count),
		countsPresent: Number(row.counts_present) !== 0,
		countsObservedAt: numOrNull(row.counts_observed_at),
		listedAvailableCount: numOrNull(row.listed_available_count),
		listedApplicableCount: numOrNull(row.listed_applicable_count),
		lastListSuccessAt: numOrNull(row.last_list_success_at),
		lastListAttemptAt: numOrNull(row.last_list_attempt_at),
		listFailingSince: numOrNull(row.list_failing_since),
		baselineAt: numOrNull(row.baseline_at),
		chatgptAccountHash:
			row.chatgpt_account_hash == null
				? null
				: String(row.chatgpt_account_hash),
		updatedAt: num(row.updated_at),
	};
}

function toCredit(row: Raw): CodexResetCreditRow {
	const text = (v: unknown) => (v == null ? null : String(v));
	return {
		accountId: String(row.account_id),
		creditId: String(row.credit_id),
		resetType: text(row.reset_type),
		status: String(row.status),
		grantedAt: numOrNull(row.granted_at),
		expiresAt: numOrNull(row.expires_at),
		title: text(row.title),
		description: text(row.description),
		firstSeenAt: num(row.first_seen_at),
		lastSeenAt: num(row.last_seen_at),
		isBaseline: Number(row.is_baseline) !== 0,
		waveId: text(row.wave_id),
		vanishedAt: numOrNull(row.vanished_at),
		vanishReason: text(row.vanish_reason),
	};
}

export class CodexResetCreditsRepository extends BaseRepository<never> {
	async getState(accountId: string): Promise<CodexResetCreditState | null> {
		const row = await this.get<Raw>(
			`SELECT * FROM codex_reset_credit_state WHERE account_id = ?`,
			[accountId],
		);
		return row ? toState(row) : null;
	}

	async listAllStates(): Promise<CodexResetCreditState[]> {
		const rows = await this.query<Raw>(
			`SELECT * FROM codex_reset_credit_state ORDER BY account_id`,
		);
		return rows.map(toState);
	}

	/** Upsert touching only the counts group; other fields stay as they were. */
	async recordCounts(
		accountId: string,
		input: {
			availableCount: number | null;
			applicableCount: number | null;
			countsPresent: boolean;
			observedAt: number;
		},
	): Promise<number> {
		return this.runWithChanges(
			`INSERT INTO codex_reset_credit_state (
				account_id, available_count, applicable_available_count,
				counts_present, counts_observed_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (account_id) DO UPDATE SET
				available_count = excluded.available_count,
				applicable_available_count = excluded.applicable_available_count,
				counts_present = excluded.counts_present,
				counts_observed_at = excluded.counts_observed_at,
				updated_at = excluded.updated_at`,
			[
				accountId,
				input.availableCount,
				input.applicableCount,
				input.countsPresent ? 1 : 0,
				input.observedAt,
				input.observedAt,
			],
		);
	}

	/** Upsert touching only list bookkeeping; a null baselineAt keeps the old one. */
	async recordListSuccess(
		accountId: string,
		input: {
			at: number;
			listedAvailableCount: number | null;
			listedApplicableCount: number | null;
			chatgptAccountHash: string | null;
			baselineAt: number | null;
		},
	): Promise<number> {
		return this.runWithChanges(
			`INSERT INTO codex_reset_credit_state (
				account_id, listed_available_count, listed_applicable_count,
				last_list_success_at, last_list_attempt_at, list_failing_since,
				baseline_at, chatgpt_account_hash, updated_at
			) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
			ON CONFLICT (account_id) DO UPDATE SET
				listed_available_count = excluded.listed_available_count,
				listed_applicable_count = excluded.listed_applicable_count,
				last_list_success_at = excluded.last_list_success_at,
				last_list_attempt_at = excluded.last_list_attempt_at,
				list_failing_since = NULL,
				baseline_at = COALESCE(excluded.baseline_at, codex_reset_credit_state.baseline_at),
				chatgpt_account_hash = excluded.chatgpt_account_hash,
				updated_at = excluded.updated_at`,
			[
				accountId,
				input.listedAvailableCount,
				input.listedApplicableCount,
				input.at,
				input.at,
				input.baselineAt,
				input.chatgptAccountHash,
				input.at,
			],
		);
	}

	async recordListFailure(accountId: string, at: number): Promise<number> {
		return this.runWithChanges(
			`INSERT INTO codex_reset_credit_state (
				account_id, last_list_attempt_at, list_failing_since, updated_at
			) VALUES (?, ?, ?, ?)
			ON CONFLICT (account_id) DO UPDATE SET
				last_list_attempt_at = excluded.last_list_attempt_at,
				list_failing_since = COALESCE(codex_reset_credit_state.list_failing_since, excluded.list_failing_since),
				updated_at = excluded.updated_at`,
			[accountId, at, at, at],
		);
	}

	async listCredits(
		accountId: string,
		options: { includeVanished: boolean },
	): Promise<CodexResetCreditRow[]> {
		const rows = await this.query<Raw>(
			`SELECT * FROM codex_reset_credits
			 WHERE account_id = ?${options.includeVanished ? "" : " AND vanished_at IS NULL"}
			 ORDER BY first_seen_at, credit_id`,
			[accountId],
		);
		return rows.map(toCredit);
	}

	async listLiveCredits(): Promise<CodexResetCreditRow[]> {
		const rows = await this.query<Raw>(
			`SELECT * FROM codex_reset_credits WHERE vanished_at IS NULL
			 ORDER BY account_id, first_seen_at, credit_id`,
		);
		return rows.map(toCredit);
	}

	/** Returns 1 when inserted, 0 when the (account, credit) key already existed. */
	async insertCreditIfAbsent(row: CodexResetCreditRow): Promise<number> {
		return this.runWithChanges(
			`INSERT INTO codex_reset_credits (
				account_id, credit_id, reset_type, status, granted_at, expires_at,
				title, description, first_seen_at, last_seen_at, is_baseline,
				wave_id, vanished_at, vanish_reason
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (account_id, credit_id) DO NOTHING`,
			[
				row.accountId,
				row.creditId,
				row.resetType,
				row.status,
				row.grantedAt,
				row.expiresAt,
				row.title,
				row.description,
				row.firstSeenAt,
				row.lastSeenAt,
				row.isBaseline ? 1 : 0,
				row.waveId,
				row.vanishedAt,
				row.vanishReason,
			],
		);
	}

	/** Refreshes a credit seen again; first_seen_at, is_baseline and wave_id stay. */
	async updateSeenCredit(
		accountId: string,
		creditId: string,
		input: {
			status: string;
			resetType: string | null;
			grantedAt: number | null;
			expiresAt: number | null;
			title: string | null;
			description: string | null;
			lastSeenAt: number;
		},
	): Promise<number> {
		return this.runWithChanges(
			`UPDATE codex_reset_credits SET
				status = ?, reset_type = ?, granted_at = ?, expires_at = ?,
				title = ?, description = ?, last_seen_at = ?,
				vanished_at = NULL, vanish_reason = NULL
			 WHERE account_id = ? AND credit_id = ?`,
			[
				input.status,
				input.resetType,
				input.grantedAt,
				input.expiresAt,
				input.title,
				input.description,
				input.lastSeenAt,
				accountId,
				creditId,
			],
		);
	}

	async markVanished(
		accountId: string,
		creditIds: string[],
		at: number,
		reason: CodexResetCreditVanishReason,
	): Promise<number> {
		if (creditIds.length === 0) return 0;
		const placeholders = creditIds.map(() => "?").join(",");
		return this.runWithChanges(
			`UPDATE codex_reset_credits SET vanished_at = ?, vanish_reason = ?
			 WHERE account_id = ? AND vanished_at IS NULL
			   AND credit_id IN (${placeholders})`,
			[at, reason, accountId, ...creditIds],
		);
	}

	/** Wave id of the credit (any account) granted nearest to grantedAt, within windowMs. */
	async findWaveIdNearGrant(
		grantedAt: number,
		windowMs: number,
	): Promise<string | null> {
		const row = await this.get<{ wave_id: string }>(
			`SELECT wave_id FROM codex_reset_credits
			 WHERE wave_id IS NOT NULL AND granted_at IS NOT NULL
			   AND ABS(granted_at - CAST(? AS BIGINT)) <= CAST(? AS BIGINT)
			 ORDER BY ABS(granted_at - CAST(? AS BIGINT)), wave_id
			 LIMIT 1`,
			[grantedAt, windowMs, grantedAt],
		);
		return row ? row.wave_id : null;
	}
}
