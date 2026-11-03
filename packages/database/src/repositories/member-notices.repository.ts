import { BaseRepository } from "./base.repository";

export type MemberNoticeKind = "grant" | "reminder" | "early_reset";

export interface MemberNoticeRow {
	/**
	 * `grant:<wave id>`, `remind:<wave id>:3d|1d`, or
	 * `early:<provider>:after:<previous early notice's claim minute|none>`.
	 */
	noticeKey: string;
	kind: MemberNoticeKind;
	provider: string;
	/** The rendered, account-free notice text. */
	content: string;
	claimedAt: number;
	/** After this time the notice gives up unsent. */
	expiresAt: number;
	nextAttemptAt: number;
	/** Sends attempted so far; a lease counts one. */
	attempts: number;
	leaseOwner: string | null;
	leaseExpiresAt: number | null;
	deliveredAt: number | null;
	gaveUpAt: number | null;
	/** An HTTP status code or a fixed reason; never an error message. */
	lastStatus: string | null;
}

export interface ClaimMemberNoticeInput {
	noticeKey: string;
	kind: MemberNoticeKind;
	provider: string;
	content: string;
	claimedAt: number;
	expiresAt: number;
}

export type MemberNoticeAttemptResult =
	| { outcome: "delivered"; at: number; status: string }
	| { outcome: "retry"; nextAttemptAt: number; status: string }
	| { outcome: "gave_up"; at: number; status: string };

type Raw = Record<string, unknown>;

function numOrNull(value: unknown): number | null {
	return value == null ? null : Number(value);
}

function toRow(row: Raw): MemberNoticeRow {
	return {
		noticeKey: String(row.notice_key),
		kind: String(row.kind) as MemberNoticeKind,
		provider: String(row.provider),
		content: String(row.content),
		claimedAt: Number(row.claimed_at),
		expiresAt: Number(row.expires_at),
		nextAttemptAt: Number(row.next_attempt_at),
		attempts: Number(row.attempts),
		leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
		leaseExpiresAt: numOrNull(row.lease_expires_at),
		deliveredAt: numOrNull(row.delivered_at),
		gaveUpAt: numOrNull(row.gave_up_at),
		lastStatus: row.last_status == null ? null : String(row.last_status),
	};
}

/** A row still waiting to be sent. */
const OPEN = "delivered_at IS NULL AND gave_up_at IS NULL";

/**
 * One row per member notice (KTD16, KTD20). A claim is an insert that
 * ignores conflicts, so a restart or a second process cannot claim a notice
 * twice. A send happens only under a lease, and its result is written only
 * while the same lease owner still holds the row, so a late result from an
 * expired lease cannot overwrite a newer attempt.
 */
export class MemberNoticesRepository extends BaseRepository<never> {
	/** True when this call created the row. */
	async claim(input: ClaimMemberNoticeInput): Promise<boolean> {
		const changes = await this.runWithChanges(
			`INSERT INTO member_notices (
				notice_key, kind, provider, content, claimed_at, expires_at,
				next_attempt_at, attempts
			) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
			ON CONFLICT DO NOTHING`,
			[
				input.noticeKey,
				input.kind,
				input.provider,
				input.content,
				input.claimedAt,
				input.expiresAt,
				input.claimedAt,
			],
		);
		return changes === 1;
	}

	async findByKey(noticeKey: string): Promise<MemberNoticeRow | null> {
		const row = await this.get<Raw>(
			`SELECT * FROM member_notices WHERE notice_key = ?`,
			[noticeKey],
		);
		return row ? toRow(row) : null;
	}

	/** The most recently claimed notice of this kind and provider, if any. */
	async latestClaim(
		kind: MemberNoticeKind,
		provider: string,
	): Promise<{ noticeKey: string; claimedAt: number } | null> {
		const row = await this.get<Raw>(
			`SELECT notice_key, claimed_at FROM member_notices
			 WHERE kind = ? AND provider = ?
			 ORDER BY claimed_at DESC, notice_key DESC
			 LIMIT 1`,
			[kind, provider],
		);
		return row
			? { noticeKey: String(row.notice_key), claimedAt: Number(row.claimed_at) }
			: null;
	}

	/** Open, unexpired notices whose next attempt is due, oldest first. */
	async listDue(now: number, limit: number): Promise<MemberNoticeRow[]> {
		const rows = await this.query<Raw>(
			`SELECT * FROM member_notices
			 WHERE ${OPEN} AND next_attempt_at <= ? AND expires_at > ?
			 ORDER BY next_attempt_at, notice_key
			 LIMIT ?`,
			[now, now, limit],
		);
		return rows.map(toRow);
	}

	/**
	 * Take the send lease on one open, due, unexpired row that no live lease
	 * holds. Counts one attempt. True when this owner won.
	 */
	async lease(
		noticeKey: string,
		owner: string,
		now: number,
		leaseMs: number,
	): Promise<boolean> {
		const changes = await this.runWithChanges(
			`UPDATE member_notices
			 SET lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1
			 WHERE notice_key = ? AND ${OPEN}
			   AND next_attempt_at <= ? AND expires_at > ?
			   AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
			[owner, now + leaseMs, noticeKey, now, now, now],
		);
		return changes === 1;
	}

	/**
	 * Write one send's result and release the lease. Writes nothing unless
	 * `owner` still holds the row.
	 */
	async finishAttempt(
		noticeKey: string,
		owner: string,
		result: MemberNoticeAttemptResult,
	): Promise<boolean> {
		const where = `WHERE notice_key = ? AND lease_owner = ? AND ${OPEN}`;
		const release = "lease_owner = NULL, lease_expires_at = NULL";
		let changes: number;
		switch (result.outcome) {
			case "delivered":
				changes = await this.runWithChanges(
					`UPDATE member_notices
					 SET delivered_at = ?, last_status = ?, ${release} ${where}`,
					[result.at, result.status, noticeKey, owner],
				);
				break;
			case "retry":
				changes = await this.runWithChanges(
					`UPDATE member_notices
					 SET next_attempt_at = ?, last_status = ?, ${release} ${where}`,
					[result.nextAttemptAt, result.status, noticeKey, owner],
				);
				break;
			case "gave_up":
				changes = await this.runWithChanges(
					`UPDATE member_notices
					 SET gave_up_at = ?, last_status = ?, ${release} ${where}`,
					[result.at, result.status, noticeKey, owner],
				);
				break;
		}
		return changes === 1;
	}

	/**
	 * Give up every open notice whose expiry has passed and that no live
	 * lease holds. Returns how many gave up.
	 */
	async expireDue(now: number): Promise<number> {
		return this.runWithChanges(
			`UPDATE member_notices
			 SET gave_up_at = ?, last_status = 'expired'
			 WHERE ${OPEN} AND expires_at <= ?
			   AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
			[now, now, now],
		);
	}
}
