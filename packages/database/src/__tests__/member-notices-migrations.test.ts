import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../migrations";
import {
	type ClaimMemberNoticeInput,
	MemberNoticesRepository,
} from "../repositories/member-notices.repository";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const AT = Date.parse("2026-11-03T12:00:00.000Z");

const notice = (
	noticeKey: string,
	overrides: Partial<ClaimMemberNoticeInput> = {},
): ClaimMemberNoticeInput => ({
	noticeKey,
	kind: "grant",
	provider: "codex",
	content: "New Codex resets may be available.",
	claimedAt: AT,
	expiresAt: AT + 24 * HOUR,
	...overrides,
});

describe("member_notices table", () => {
	let db: Database;
	let repo: MemberNoticesRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		ensureSchema(db);
		runMigrations(db);
		repo = new MemberNoticesRepository(new BunSqlAdapter(db));
	});

	afterEach(() => db.close());

	it("creates the table keyed by notice key, with the due index", () => {
		const cols = db.query(`PRAGMA table_info(member_notices)`).all() as {
			name: string;
			pk: number;
		}[];
		expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual([
			"notice_key",
		]);
		expect(cols.map((c) => c.name)).toEqual(
			expect.arrayContaining([
				"kind",
				"provider",
				"content",
				"claimed_at",
				"expires_at",
				"next_attempt_at",
				"attempts",
				"lease_owner",
				"lease_expires_at",
				"delivered_at",
				"gave_up_at",
				"last_status",
			]),
		);
		const index = db
			.query(
				`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_member_notices_due'`,
			)
			.get() as { sql: string } | null;
		expect(index?.sql).toContain("delivered_at, next_attempt_at");
	});

	it("upgrades a database that lacks the table", () => {
		const old = new Database(":memory:");
		ensureSchema(old);
		runMigrations(old);
		old.exec("DROP TABLE member_notices");
		runMigrations(old);
		expect(
			old
				.query(
					`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'member_notices'`,
				)
				.get(),
		).toEqual({ name: "member_notices" });
		old.close();
	});

	it("rejects a kind outside the known set", () => {
		expect(() =>
			db
				.prepare(
					`INSERT INTO member_notices (notice_key, kind, provider, content, claimed_at, expires_at, next_attempt_at)
					 VALUES ('k', 'bogus', 'codex', 'c', 1, 2, 1)`,
				)
				.run(),
		).toThrow();
	});

	it("claims a key once; a second claim loses and leaves one row", async () => {
		expect(await repo.claim(notice("grant:codex:2026-10-31T20:04Z"))).toBe(
			true,
		);
		expect(
			await repo.claim(
				notice("grant:codex:2026-10-31T20:04Z", { content: "other" }),
			),
		).toBe(false);
		const rows = db.query(`SELECT * FROM member_notices`).all();
		expect(rows).toHaveLength(1);
		expect(await repo.findByKey("grant:codex:2026-10-31T20:04Z")).toEqual({
			noticeKey: "grant:codex:2026-10-31T20:04Z",
			kind: "grant",
			provider: "codex",
			content: "New Codex resets may be available.",
			claimedAt: AT,
			expiresAt: AT + 24 * HOUR,
			nextAttemptAt: AT,
			attempts: 0,
			leaseOwner: null,
			leaseExpiresAt: null,
			deliveredAt: null,
			gaveUpAt: null,
			lastStatus: null,
		});
	});

	it("lets exactly one of two concurrent claims of one key win", async () => {
		const results = await Promise.all([
			repo.claim(notice("remind:codex:2026-10-31T20:04Z:3d")),
			repo.claim(notice("remind:codex:2026-10-31T20:04Z:3d")),
		]);
		expect(results.sort()).toEqual([false, true]);
	});

	it("lets exactly one of two concurrent leases of one row succeed", async () => {
		await repo.claim(notice("k1"));
		const leases = await Promise.all([
			repo.lease("k1", "owner-a", AT, MINUTE),
			repo.lease("k1", "owner-b", AT, MINUTE),
		]);
		expect(leases.sort()).toEqual([false, true]);
		const row = await repo.findByKey("k1");
		expect(row?.attempts).toBe(1);
		expect(["owner-a", "owner-b"]).toContain(row?.leaseOwner ?? "");
		expect(row?.leaseExpiresAt).toBe(AT + MINUTE);
	});

	it("leases only a due, live, unleased row", async () => {
		await repo.claim(notice("k1"));
		expect(await repo.lease("k1", "a", AT - 1, MINUTE)).toBe(false);
		expect(await repo.lease("k1", "a", AT, MINUTE)).toBe(true);
		expect(await repo.lease("k1", "b", AT + MINUTE - 1, MINUTE)).toBe(false);
		expect(
			await repo.finishAttempt("k1", "a", {
				outcome: "delivered",
				at: AT + 1,
				status: "204",
			}),
		).toBe(true);
		expect(await repo.lease("k1", "b", AT + 2 * MINUTE, MINUTE)).toBe(false);

		await repo.claim(notice("k2", { expiresAt: AT + MINUTE }));
		expect(await repo.lease("k2", "a", AT + MINUTE, MINUTE)).toBe(false);
	});

	it("rejects a result from an expired lease once a newer lease holds the row", async () => {
		await repo.claim(notice("k1"));
		expect(await repo.lease("k1", "old", AT, MINUTE)).toBe(true);
		expect(await repo.lease("k1", "new", AT + MINUTE, MINUTE)).toBe(true);
		expect(
			await repo.finishAttempt("k1", "old", {
				outcome: "gave_up",
				at: AT + MINUTE + 1,
				status: "404",
			}),
		).toBe(false);
		expect(await repo.findByKey("k1")).toMatchObject({
			leaseOwner: "new",
			gaveUpAt: null,
			lastStatus: null,
			attempts: 2,
		});
		expect(
			await repo.finishAttempt("k1", "new", {
				outcome: "delivered",
				at: AT + MINUTE + 2,
				status: "200",
			}),
		).toBe(true);
		expect(await repo.findByKey("k1")).toMatchObject({
			deliveredAt: AT + MINUTE + 2,
			lastStatus: "200",
			leaseOwner: null,
			leaseExpiresAt: null,
		});
	});

	it("records a retry that clears the lease and moves the next attempt", async () => {
		await repo.claim(notice("k1"));
		await repo.lease("k1", "a", AT, MINUTE);
		expect(
			await repo.finishAttempt("k1", "a", {
				outcome: "retry",
				nextAttemptAt: AT + 2 * MINUTE,
				status: "503",
			}),
		).toBe(true);
		expect(await repo.findByKey("k1")).toMatchObject({
			nextAttemptAt: AT + 2 * MINUTE,
			lastStatus: "503",
			leaseOwner: null,
			leaseExpiresAt: null,
			deliveredAt: null,
			attempts: 1,
		});
		expect(await repo.lease("k1", "b", AT + MINUTE, MINUTE)).toBe(false);
		expect(await repo.lease("k1", "b", AT + 2 * MINUTE, MINUTE)).toBe(true);
	});

	it("gives up expired notices, leaving leased and finished rows alone", async () => {
		await repo.claim(notice("expired", { expiresAt: AT + MINUTE }));
		await repo.claim(notice("leased", { expiresAt: AT + MINUTE }));
		await repo.claim(notice("delivered", { expiresAt: AT + MINUTE }));
		await repo.claim(notice("live", { expiresAt: AT + HOUR }));
		await repo.lease("leased", "a", AT, 5 * MINUTE);
		await repo.lease("delivered", "a", AT, MINUTE);
		await repo.finishAttempt("delivered", "a", {
			outcome: "delivered",
			at: AT + 1,
			status: "204",
		});

		expect(await repo.expireDue(AT + 2 * MINUTE)).toBe(1);
		expect(await repo.findByKey("expired")).toMatchObject({
			gaveUpAt: AT + 2 * MINUTE,
			lastStatus: "expired",
			attempts: 0,
		});
		expect((await repo.findByKey("leased"))?.gaveUpAt).toBeNull();
		expect((await repo.findByKey("delivered"))?.lastStatus).toBe("204");
		expect((await repo.findByKey("live"))?.gaveUpAt).toBeNull();
	});

	it("lists due, unfinished, unexpired notices by next attempt time", async () => {
		await repo.claim(notice("later", { claimedAt: AT + MINUTE }));
		await repo.claim(notice("first", { claimedAt: AT - MINUTE }));
		await repo.claim(notice("future", { claimedAt: AT + HOUR }));
		await repo.claim(
			notice("expired", { claimedAt: AT - HOUR, expiresAt: AT }),
		);
		await repo.claim(notice("done", { claimedAt: AT - HOUR }));
		await repo.lease("done", "a", AT - HOUR, MINUTE);
		await repo.finishAttempt("done", "a", {
			outcome: "delivered",
			at: AT - HOUR,
			status: "204",
		});

		const due = await repo.listDue(AT + MINUTE, 10);
		expect(due.map((r) => r.noticeKey)).toEqual(["first", "later"]);
		expect(
			(await repo.listDue(AT + MINUTE, 1)).map((r) => r.noticeKey),
		).toEqual(["first"]);
	});

	it("finds a claim of one kind and provider since a time", async () => {
		await repo.claim(
			notice("early:claude:2026-11-03T10:00Z", {
				kind: "early_reset",
				provider: "claude",
				claimedAt: AT - 5 * HOUR,
			}),
		);
		expect(
			await repo.hasClaimSince("early_reset", "claude", AT - 6 * HOUR),
		).toBe(true);
		expect(
			await repo.hasClaimSince("early_reset", "claude", AT - 4 * HOUR),
		).toBe(false);
		expect(
			await repo.hasClaimSince("early_reset", "codex", AT - 6 * HOUR),
		).toBe(false);
	});
});
