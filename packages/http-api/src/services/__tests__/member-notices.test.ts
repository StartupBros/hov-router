import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@better-ccflare/config";
import { DatabaseOperations } from "@better-ccflare/database";
import {
	detectMemberNotices,
	type MemberNoticeFetch,
	renderEarlyResetNotice,
	renderGrantNotice,
	renderReminderNotice,
	runMemberNoticePass,
} from "../member-notices";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const GRANT = Date.parse("2026-11-01T20:04:05.000Z");
const WAVE = "codex:2026-11-01T20:04Z";
const EXPIRY = Date.parse("2026-11-30T20:04:05.000Z");
const T = Date.parse("2026-11-03T10:00:00.000Z");

const ACCOUNTS = [
	{ id: "acct-codex-1", name: "pro-primary-bros", provider: "codex" },
	{ id: "acct-codex-2", name: "member-email@example.com", provider: "codex" },
	{ id: "acct-codex-3", name: "pro-secondary-wmgm", provider: "codex" },
	{ id: "acct-claude-1", name: "claude-max-alpha", provider: "anthropic" },
	{ id: "acct-claude-2", name: "claude-max-bravo", provider: "anthropic" },
	{ id: "acct-claude-3", name: "claude-max-charlie", provider: "claude-oauth" },
	{ id: "acct-claude-4", name: "claude-max-delta", provider: "anthropic" },
	{ id: "acct-xai-1", name: "grok-heavy", provider: "xai" },
	{ id: "acct-xai-2", name: "grok-light", provider: "xai" },
];

const MEMBER_URL =
	"https://discord.com/api/webhooks/1400000000000000001/member-token-abc";
const ALERT_URL =
	"https://discord.com/api/webhooks/1399999999999999999/alert-token";

let dbOps: DatabaseOperations;

async function seedCredit(
	accountId: string,
	creditId: string,
	options: {
		firstSeenAt: number;
		expiresAt?: number | null;
		isBaseline?: boolean;
		vanishedAt?: number;
		vanishReason?: string;
	},
) {
	await dbOps.getCodexResetCreditsRepository().insertCreditIfAbsent({
		accountId,
		creditId,
		resetType: "rate_limit",
		status: options.vanishedAt === undefined ? "available" : "redeemed",
		grantedAt: GRANT,
		expiresAt: options.expiresAt === undefined ? EXPIRY : options.expiresAt,
		title: "Rate limit reset",
		description: null,
		firstSeenAt: options.firstSeenAt,
		lastSeenAt: options.firstSeenAt,
		isBaseline: options.isBaseline ?? false,
		waveId: WAVE,
		vanishedAt: options.vanishedAt ?? null,
		vanishReason: options.vanishReason ?? null,
	});
}

async function seedRedemption(
	accountId: string,
	state: string,
	attemptedAt: number,
) {
	await dbOps
		.getAdapter()
		.run(
			`INSERT INTO codex_reset_redemptions (request_id, account_id, credit_id, state, requested_at, attempted_at) VALUES (?, ?, ?, ?, ?, ?)`,
			[randomUUID(), accountId, "credit-x", state, attemptedAt, attemptedAt],
		);
}

/**
 * A weekly window that rolled over early, as the ledger records it: the
 * previous row closes at the poll that saw the new cluster (`openedAt`) and
 * the early row starts at the provider's anchor, usually just before it.
 */
async function seedEarlyReset(
	accountId: string,
	options: { openedAt: number; previousStartedAt?: number; anchor?: number },
) {
	const anchor = options.anchor ?? options.openedAt - 2 * MINUTE;
	const previousStartedAt = options.previousStartedAt ?? anchor - 3 * DAY;
	const insert = `INSERT INTO usage_windows (id, account_id, window_key, started_at, resets_at, closed_at, grant_type) VALUES (?, ?, 'seven_day', ?, ?, ?, ?)`;
	await dbOps
		.getAdapter()
		.run(insert, [
			randomUUID(),
			accountId,
			previousStartedAt,
			previousStartedAt + 7 * DAY,
			options.openedAt,
			"natural",
		]);
	await dbOps
		.getAdapter()
		.run(insert, [
			randomUUID(),
			accountId,
			anchor,
			anchor + 7 * DAY,
			null,
			"early_reset",
		]);
}

const notice = (key: string) =>
	dbOps.getMemberNoticesRepository().findByKey(key);

async function allNotices() {
	return dbOps
		.getAdapter()
		.query<{ notice_key: string; content: string }>(
			`SELECT notice_key, content FROM member_notices ORDER BY notice_key`,
		);
}

beforeEach(async () => {
	dbOps = new DatabaseOperations(":memory:", { walMode: false });
	for (const account of ACCOUNTS) {
		await dbOps
			.getAdapter()
			.run(
				`INSERT INTO accounts (id, name, provider, created_at) VALUES (?, ?, ?, ?)`,
				[account.id, account.name, account.provider, 0],
			);
	}
});

afterEach(async () => {
	await dbOps.dispose();
});

describe("grant notices", () => {
	it("claims one notice for credits arriving on three accounts over 17 minutes, after the quiet period, and never again (AE7)", async () => {
		await seedCredit("acct-codex-1", "c1", { firstSeenAt: GRANT + MINUTE });
		await seedCredit("acct-codex-2", "c2", {
			firstSeenAt: GRANT + 9 * MINUTE,
		});
		// Mid-wave: the third account has not reported yet.
		expect(await detectMemberNotices(dbOps, GRANT + 10 * MINUTE)).toEqual([]);
		await seedCredit("acct-codex-3", "c3", {
			firstSeenAt: GRANT + 18 * MINUTE,
		});
		const newest = GRANT + 18 * MINUTE;
		expect(await detectMemberNotices(dbOps, newest + 29 * MINUTE)).toEqual([]);

		const claimedAt = newest + 30 * MINUTE;
		expect(await detectMemberNotices(dbOps, claimedAt)).toEqual([
			`grant:${WAVE}`,
		]);
		// A restart re-runs detection over the same rows.
		expect(await detectMemberNotices(dbOps, claimedAt)).toEqual([]);
		expect(await detectMemberNotices(dbOps, claimedAt + 2 * HOUR)).toEqual([]);

		const row = await notice(`grant:${WAVE}`);
		expect(row).toMatchObject({
			kind: "grant",
			provider: "codex",
			claimedAt,
			expiresAt: claimedAt + DAY,
			nextAttemptAt: claimedAt,
			attempts: 0,
			deliveredAt: null,
		});
		expect(row?.content).toContain("Codex");
		expect(row?.content).toContain("/usage");
		expect(row?.content).toContain("Redeem reset");
		expect(row?.content).toContain("November 30, 2026");
		expect(await allNotices()).toHaveLength(1);
	});

	it("claims nothing for a wave seen only in the first baseline read (AE4)", async () => {
		for (const [index, account] of ["acct-codex-1", "acct-codex-2"].entries()) {
			await seedCredit(account, `c${index}`, {
				firstSeenAt: GRANT + HOUR,
				isBaseline: true,
			});
		}
		expect(await detectMemberNotices(dbOps, GRANT + 2 * HOUR)).toEqual([]);
		expect(await detectMemberNotices(dbOps, GRANT + 12 * HOUR)).toEqual([]);
	});

	it("claims no grant notice once the wave's newest sighting is 24 hours old", async () => {
		await seedCredit("acct-codex-1", "c1", { firstSeenAt: GRANT + MINUTE });
		expect(await detectMemberNotices(dbOps, GRANT + MINUTE + DAY)).toEqual([]);
		expect(await allNotices()).toEqual([]);
	});
});

describe("expiry reminders", () => {
	it("claims a 3-day and a 1-day reminder for a wave expiring 2026-11-30, though the router redeemed its own credit (AE8)", async () => {
		await seedCredit("acct-codex-1", "c1", {
			firstSeenAt: GRANT + MINUTE,
			vanishedAt: GRANT + 2 * DAY,
			vanishReason: "redeemed_by_router",
		});
		await seedCredit("acct-codex-2", "c2", { firstSeenAt: GRANT + MINUTE });

		const threeDays = EXPIRY - 3 * DAY;
		expect(await detectMemberNotices(dbOps, threeDays)).toEqual([
			`remind:${WAVE}:3d`,
		]);
		expect(await detectMemberNotices(dbOps, threeDays + 5 * HOUR)).toEqual([]);
		const oneDay = EXPIRY - DAY;
		expect(await detectMemberNotices(dbOps, oneDay + 30 * MINUTE)).toEqual([
			`remind:${WAVE}:1d`,
		]);

		const early = await notice(`remind:${WAVE}:3d`);
		expect(early).toMatchObject({
			kind: "reminder",
			provider: "codex",
			expiresAt: threeDays + 6 * HOUR,
		});
		expect(early?.content).toContain("3 days");
		expect(early?.content).toContain("November 30, 2026");
		const late = await notice(`remind:${WAVE}:1d`);
		expect(late?.expiresAt).toBe(oneDay + 6 * HOUR);
		expect(late?.content).toContain("1 day");
		expect(late?.content).not.toContain("1 days");
	});

	it("claims no reminder for credits with no expiry", async () => {
		await seedCredit("acct-codex-1", "c1", {
			firstSeenAt: GRANT + MINUTE,
			expiresAt: null,
			isBaseline: true,
		});
		const claimed: string[] = [];
		for (let at = GRANT; at <= GRANT + 40 * DAY; at += 3 * HOUR) {
			claimed.push(...(await detectMemberNotices(dbOps, at)));
		}
		expect(claimed).toEqual([]);
	});

	it("skips the 3-day reminder when the destination turns on 36 hours before expiry, then claims the 1-day one", async () => {
		await seedCredit("acct-codex-1", "c1", { firstSeenAt: GRANT + MINUTE });
		expect(await detectMemberNotices(dbOps, EXPIRY - 36 * HOUR)).toEqual([]);
		expect(await detectMemberNotices(dbOps, EXPIRY - DAY)).toEqual([
			`remind:${WAVE}:1d`,
		]);
		expect(await notice(`remind:${WAVE}:3d`)).toBeNull();
	});

	it("does not send a 3-day reminder late after the router was down through its claim window", async () => {
		await seedCredit("acct-codex-1", "c1", { firstSeenAt: GRANT + MINUTE });
		expect(
			await detectMemberNotices(dbOps, EXPIRY - 3 * DAY + 7 * HOUR),
		).toEqual([]);
	});
});

describe("early reset notices", () => {
	it("claims one Claude notice when two Anthropic accounts roll over early within the hour, and none for one account (AE10)", async () => {
		await seedEarlyReset("acct-claude-1", { openedAt: T });
		await seedEarlyReset("acct-xai-1", { openedAt: T + 5 * MINUTE });
		await seedEarlyReset("acct-xai-2", { openedAt: T + 6 * MINUTE });
		// One account alone is not an event.
		expect(await detectMemberNotices(dbOps, T + 15 * MINUTE)).toEqual([]);

		await seedEarlyReset("acct-claude-3", { openedAt: T + 20 * MINUTE });
		const claimedAt = T + 30 * MINUTE;
		expect(await detectMemberNotices(dbOps, claimedAt)).toEqual([
			"early:claude:2026-11-03T09:58Z",
		]);
		expect(await detectMemberNotices(dbOps, claimedAt + MINUTE)).toEqual([]);

		const row = await notice("early:claude:2026-11-03T09:58Z");
		expect(row).toMatchObject({
			kind: "early_reset",
			provider: "claude",
			expiresAt: claimedAt + HOUR,
		});
		expect(row?.content).toContain("Claude");
		expect(row?.content).not.toContain("Codex");
	});

	it("waits until the newer rollover is 10 minutes old and ignores rollovers opened over an hour ago", async () => {
		await seedEarlyReset("acct-claude-1", { openedAt: T });
		await seedEarlyReset("acct-claude-2", { openedAt: T + 5 * MINUTE });
		expect(await detectMemberNotices(dbOps, T + 12 * MINUTE)).toEqual([]);
		expect(await detectMemberNotices(dbOps, T + 15 * MINUTE)).toHaveLength(1);

		await seedEarlyReset("acct-codex-1", { openedAt: T + HOUR });
		await seedEarlyReset("acct-codex-2", { openedAt: T + 2 * HOUR });
		// The first Codex rollover is 65 minutes old by the time the second
		// one has settled.
		expect(
			await detectMemberNotices(dbOps, T + 2 * HOUR + 10 * MINUTE),
		).toEqual([]);
	});

	it("claims nothing when a router redemption or a credit redeemed from the Codex CLI explains each rollover (AE9)", async () => {
		await seedRedemption("acct-codex-1", "done", T - 2 * HOUR);
		await seedCredit("acct-codex-2", "c2", {
			firstSeenAt: GRANT + MINUTE,
			isBaseline: true,
			vanishedAt: T - HOUR,
			vanishReason: "redeemed_elsewhere",
		});
		await seedEarlyReset("acct-codex-1", { openedAt: T });
		await seedEarlyReset("acct-codex-2", { openedAt: T + 5 * MINUTE });
		expect(await detectMemberNotices(dbOps, T + 20 * MINUTE)).toEqual([]);
	});

	it("counts a refused redemption as no explanation and an abandoned one as an explanation", async () => {
		await seedRedemption("acct-codex-1", "refused", T - HOUR);
		await seedRedemption("acct-codex-2", "abandoned", T - HOUR);
		await seedEarlyReset("acct-codex-1", { openedAt: T });
		await seedEarlyReset("acct-codex-2", { openedAt: T });
		expect(await detectMemberNotices(dbOps, T + 15 * MINUTE)).toEqual([]);

		await seedEarlyReset("acct-codex-3", {
			openedAt: T + 5 * MINUTE,
			anchor: T + 4 * MINUTE,
		});
		expect(await detectMemberNotices(dbOps, T + 20 * MINUTE)).toEqual([
			"early:codex:2026-11-03T09:58Z",
		]);
	});

	it("still explains rollovers of accounts redeemed, left idle 30 hours, then used (AE9)", async () => {
		const redeemedAt = T - 30 * HOUR;
		for (const account of ["acct-codex-1", "acct-codex-2"]) {
			await seedRedemption(account, "done", redeemedAt);
			await seedEarlyReset(account, {
				previousStartedAt: redeemedAt - 2 * DAY,
				anchor: T,
				openedAt: T + 3 * MINUTE,
			});
		}
		expect(await detectMemberNotices(dbOps, T + 20 * MINUTE)).toEqual([]);
	});

	it("explains a rollover with a credit that vanished as redeemed at the same poll", async () => {
		for (const [index, account] of ["acct-codex-1", "acct-codex-2"].entries()) {
			await seedCredit(account, `c${index}`, {
				firstSeenAt: GRANT + MINUTE,
				isBaseline: true,
				vanishedAt: T,
				vanishReason: "redeemed_elsewhere",
			});
			await seedEarlyReset(account, { openedAt: T });
		}
		expect(await detectMemberNotices(dbOps, T + 15 * MINUTE)).toEqual([]);
	});

	it("does not count a redemption from before the previous window began", async () => {
		await seedRedemption("acct-codex-1", "done", T - 4 * DAY);
		await seedEarlyReset("acct-codex-1", {
			openedAt: T,
			previousStartedAt: T - 3 * DAY,
		});
		await seedEarlyReset("acct-codex-2", { openedAt: T + 5 * MINUTE });
		expect(await detectMemberNotices(dbOps, T + 20 * MINUTE)).toHaveLength(1);
	});

	it("claims no second early notice for a provider within 6 hours", async () => {
		await seedEarlyReset("acct-claude-1", { openedAt: T });
		await seedEarlyReset("acct-claude-2", { openedAt: T + 5 * MINUTE });
		expect(await detectMemberNotices(dbOps, T + 20 * MINUTE)).toHaveLength(1);

		await seedEarlyReset("acct-claude-3", { openedAt: T + 3 * HOUR });
		await seedEarlyReset("acct-claude-4", { openedAt: T + 3 * HOUR });
		expect(
			await detectMemberNotices(dbOps, T + 3 * HOUR + 15 * MINUTE),
		).toEqual([]);
	});
});

describe("destination gate", () => {
	const ENV_KEYS = ["MEMBER_NOTICE_WEBHOOK_URL", "ALERT_WEBHOOK_URL"] as const;
	let directory: string;
	let saved: Record<string, string | undefined>;
	let config: Config;

	beforeEach(() => {
		saved = {};
		for (const key of ENV_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		directory = mkdtempSync(join(tmpdir(), "member-notice-gate-"));
		config = new Config(join(directory, "config.json"));
	});
	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	const refusingFetch: MemberNoticeFetch = async () => {
		throw new Error("no request may leave a gated pass");
	};

	it("claims and sends nothing while the destination is off or blocked", async () => {
		await seedCredit("acct-codex-1", "c1", { firstSeenAt: GRANT + MINUTE });
		const now = GRANT + HOUR;
		config.setAlertWebhookUrl(ALERT_URL);

		const off = await runMemberNoticePass({
			dbOps,
			config,
			now: () => now,
			fetch: refusingFetch,
			onDeliveryFailed: async () => {},
		});
		expect(off.state).toBe("off");

		config.set(
			"member_notice_webhook_url",
			ALERT_URL.replace("discord.com", "discordapp.com"),
		);
		const blocked = await runMemberNoticePass({
			dbOps,
			config,
			now: () => now,
			fetch: refusingFetch,
			onDeliveryFailed: async () => {},
		});
		expect(blocked.state).toBe("blocked_same_as_alert_webhook");
		expect(await allNotices()).toEqual([]);

		config.set("member_notice_webhook_url", MEMBER_URL);
		const sent: string[] = [];
		const on = await runMemberNoticePass({
			dbOps,
			config,
			now: () => now,
			fetch: async (url) => {
				sent.push(url);
				return new Response(null, { status: 204 });
			},
			onDeliveryFailed: async () => {},
		});
		expect(on).toMatchObject({ state: "on", claimed: [`grant:${WAVE}`] });
		expect(sent).toEqual([MEMBER_URL]);
	});
});

describe("notice text", () => {
	it("never names an account, an email, an account id or a count (AE11)", async () => {
		for (const [index, account] of [
			"acct-codex-1",
			"acct-codex-2",
			"acct-codex-3",
		].entries()) {
			await seedCredit(account, `c${index}`, {
				firstSeenAt: GRANT + index * 8 * MINUTE,
			});
		}
		await detectMemberNotices(dbOps, GRANT + HOUR);
		await detectMemberNotices(dbOps, EXPIRY - 3 * DAY);
		await detectMemberNotices(dbOps, EXPIRY - DAY);
		await seedEarlyReset("acct-claude-1", { openedAt: T });
		await seedEarlyReset("acct-claude-2", { openedAt: T });
		await seedEarlyReset("acct-codex-1", { openedAt: T });
		await seedEarlyReset("acct-codex-3", { openedAt: T });
		await detectMemberNotices(dbOps, T + 15 * MINUTE);

		const rows = await allNotices();
		expect(rows.map((row) => row.notice_key)).toEqual([
			"early:claude:2026-11-03T09:58Z",
			"early:codex:2026-11-03T09:58Z",
			`grant:${WAVE}`,
			`remind:${WAVE}:1d`,
			`remind:${WAVE}:3d`,
		]);
		const texts = [
			...rows.map((row) => row.content),
			renderGrantNotice({ providerName: "Codex", expiresAt: null }),
		];
		for (const text of texts) {
			for (const account of ACCOUNTS) {
				expect(text).not.toContain(account.id);
				expect(text).not.toContain(account.name);
			}
			expect(text).not.toContain("@");
			expect(text).not.toMatch(/\b\d+\s+(accounts?|credits?|resets?)\b/i);
		}
	});

	it("renders each notice from the provider name, expiry date and lead time only", () => {
		expect(
			renderGrantNotice({ providerName: "Codex", expiresAt: EXPIRY }),
		).toContain("This wave expires November 30, 2026 at 20:04 UTC.");
		expect(
			renderGrantNotice({ providerName: "Codex", expiresAt: null }),
		).not.toContain("expires");
		expect(
			renderReminderNotice({
				providerName: "Codex",
				expiresAt: EXPIRY,
				lead: "1d",
			}),
		).toContain("1 day");
		expect(renderEarlyResetNotice({ providerName: "Claude" })).toContain(
			"Claude",
		);
		for (const text of [
			renderGrantNotice({ providerName: "Codex", expiresAt: EXPIRY }),
			renderEarlyResetNotice({ providerName: "Codex" }),
		]) {
			expect(text).toContain("HoV Router");
		}
	});
});
