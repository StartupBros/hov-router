import { BaseRepository } from "./base.repository";

/** Mirrors `CodexResetRedemptionState` in @better-ccflare/types. */
export type CodexResetRedemptionRowState =
	| "pending"
	| "unknown"
	| "retryable"
	| "done"
	| "refused"
	| "abandoned";

/** States that hold the account's single open slot. */
export const OPEN_REDEMPTION_STATES = [
	"pending",
	"unknown",
	"retryable",
] as const;

export interface CodexResetRedemptionRow {
	requestId: string;
	accountId: string;
	creditId: string | null;
	/** The ChatGPT account the request was confirmed for, hashed; null when the token named none. */
	chatgptAccountHash: string | null;
	state: CodexResetRedemptionRowState;
	code: string | null;
	windowsReset: number | null;
	httpStatus: number | null;
	availableBefore: number | null;
	availableAfter: number | null;
	requestedAt: number;
	/** When the latest attempt was claimed; the 60-second rule reads this. */
	attemptedAt: number;
	completedAt: number | null;
	attempts: number;
}

/**
 * `created`: this call opened the row. `exists`: the row was already there
 * for the same account and credit. `conflict`: the request id names a
 * different account or credit. `lost`: the account already had another open
 * request; `row` is that open row, or null if it closed in between.
 */
export type InsertPendingResult =
	| { result: "created" | "exists"; row: CodexResetRedemptionRow }
	| { result: "conflict"; row: CodexResetRedemptionRow }
	| { result: "lost"; row: CodexResetRedemptionRow | null };

type Raw = Record<string, unknown>;

function numOrNull(value: unknown): number | null {
	return value == null ? null : Number(value);
}

function toRow(row: Raw): CodexResetRedemptionRow {
	const text = (v: unknown) => (v == null ? null : String(v));
	return {
		requestId: String(row.request_id),
		accountId: String(row.account_id),
		creditId: text(row.credit_id),
		chatgptAccountHash: text(row.chatgpt_account_hash),
		state: String(row.state) as CodexResetRedemptionRowState,
		code: text(row.code),
		windowsReset: numOrNull(row.windows_reset),
		httpStatus: numOrNull(row.http_status),
		availableBefore: numOrNull(row.available_before),
		availableAfter: numOrNull(row.available_after),
		requestedAt: Number(row.requested_at),
		attemptedAt: Number(row.attempted_at),
		completedAt: numOrNull(row.completed_at),
		attempts: Number(row.attempts),
	};
}

const OPEN_STATES_SQL = "('pending', 'unknown', 'retryable')";

/**
 * One row per redemption request id (KTD8). Every state change is
 * conditional on the stored state and attempt time, so two processes can
 * never both move one row.
 */
export class CodexResetRedemptionsRepository extends BaseRepository<never> {
	async findByRequestId(
		requestId: string,
	): Promise<CodexResetRedemptionRow | null> {
		const row = await this.get<Raw>(
			`SELECT * FROM codex_reset_redemptions WHERE request_id = ?`,
			[requestId],
		);
		return row ? toRow(row) : null;
	}

	async findOpenForAccount(
		accountId: string,
	): Promise<CodexResetRedemptionRow | null> {
		const row = await this.get<Raw>(
			`SELECT * FROM codex_reset_redemptions
			 WHERE account_id = ? AND state IN ${OPEN_STATES_SQL}`,
			[accountId],
		);
		return row ? toRow(row) : null;
	}

	/**
	 * Open a `pending` row. The insert ignores every conflict: the primary
	 * key (same request id) and the partial unique index (another open row on
	 * the account). The affected-row count picks the winner.
	 */
	async insertPending(input: {
		requestId: string;
		accountId: string;
		creditId: string | null;
		chatgptAccountHash: string | null;
		availableBefore: number | null;
		at: number;
	}): Promise<InsertPendingResult> {
		const changes = await this.runWithChanges(
			`INSERT INTO codex_reset_redemptions (
				request_id, account_id, credit_id, chatgpt_account_hash, state,
				available_before, requested_at, attempted_at, attempts
			) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, 1)
			ON CONFLICT DO NOTHING`,
			[
				input.requestId,
				input.accountId,
				input.creditId,
				input.chatgptAccountHash,
				input.availableBefore,
				input.at,
				input.at,
			],
		);
		const existing = await this.findByRequestId(input.requestId);
		if (existing) {
			if (changes === 1) return { result: "created", row: existing };
			const same =
				existing.accountId === input.accountId &&
				existing.creditId === input.creditId;
			return same
				? { result: "exists", row: existing }
				: { result: "conflict", row: existing };
		}
		return {
			result: "lost",
			row: await this.findOpenForAccount(input.accountId),
		};
	}

	/**
	 * Take an open row back to `pending` for one more attempt. Only the caller
	 * whose expected state and attempt time still match wins.
	 */
	async claimResend(
		requestId: string,
		input: {
			expectedState: CodexResetRedemptionRowState;
			expectedAttemptedAt: number;
			at: number;
		},
	): Promise<number> {
		return this.runWithChanges(
			`UPDATE codex_reset_redemptions
			 SET state = 'pending', attempted_at = ?, attempts = attempts + 1
			 WHERE request_id = ? AND state = ? AND attempted_at = ?
			   AND state IN ${OPEN_STATES_SQL}`,
			[input.at, requestId, input.expectedState, input.expectedAttemptedAt],
		);
	}

	/**
	 * Record what the attempt claimed at `attemptedAt` learned. Applies only
	 * while the row is still `pending` from that same attempt. `abandoned`
	 * closes a row the attempt found it must not send.
	 */
	async recordOutcome(
		requestId: string,
		input: {
			attemptedAt: number;
			state: "unknown" | "retryable" | "done" | "refused" | "abandoned";
			code: string | null;
			windowsReset: number | null;
			httpStatus: number | null;
			at: number;
		},
	): Promise<number> {
		const terminal =
			input.state === "done" ||
			input.state === "refused" ||
			input.state === "abandoned";
		return this.runWithChanges(
			`UPDATE codex_reset_redemptions
			 SET state = ?, code = ?, windows_reset = ?, http_status = ?,
			     completed_at = ?
			 WHERE request_id = ? AND state = 'pending' AND attempted_at = ?`,
			[
				input.state,
				input.code,
				input.windowsReset,
				input.httpStatus,
				terminal ? input.at : null,
				requestId,
				input.attemptedAt,
			],
		);
	}

	/** The count before is written once, at insert, and never here. */
	async recordAvailableAfter(
		requestId: string,
		availableAfter: number,
	): Promise<number> {
		return this.runWithChanges(
			`UPDATE codex_reset_redemptions SET available_after = ?
			 WHERE request_id = ? AND state = 'done'`,
			[availableAfter, requestId],
		);
	}

	/** Credits among `creditIds` that a router redemption reported spending. */
	async findRouterRedeemedCreditIds(
		accountId: string,
		creditIds: string[],
	): Promise<string[]> {
		if (creditIds.length === 0) return [];
		const placeholders = creditIds.map(() => "?").join(", ");
		const rows = await this.query<Raw>(
			`SELECT DISTINCT credit_id FROM codex_reset_redemptions
			 WHERE account_id = ? AND state = 'done'
			   AND code IN ('reset', 'already_redeemed')
			   AND credit_id IN (${placeholders})`,
			[accountId, ...creditIds],
		);
		return rows.map((r) => String(r.credit_id));
	}
}
