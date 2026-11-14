import { expect, test } from "bun:test";
import type { Account } from "../../api";
import {
	accountListView,
	accountSortWindow,
	needsAccountAttention,
} from "./account-list-view";

const account = (id: string, patch: Partial<Account> = {}) =>
	({
		id,
		name: id,
		provider: "codex",
		paused: false,
		rateLimitStatus: "OK",
		priority: 0,
		...patch,
	}) as Account;

test("provider epoch windows share display normalization and generic resets include daily/monthly", () => {
	const now = Date.now();
	const reset = now + 3600000;
	const cases: [string, unknown, string | null, string | null][] = [
		[
			"minimax",
			{
				five_hour: { utilization: 20, resetAt: reset + 1 },
				seven_day: { utilization: 30, resetAt: reset },
			},
			"Weekly",
			"5-hour",
		],
		[
			"zai",
			{
				tokens_limit: { percentage: 20, resetAt: reset + 1 },
				tokens_limit_weekly: { percentage: 30, resetAt: reset },
				time_limit: { percentage: 90, resetAt: reset + 2 },
			},
			"Weekly",
			"5-hour",
		],
		[
			"alibaba-coding-plan",
			{
				five_hour: { percentUsed: 20, resetAt: reset + 1 },
				weekly: { percentUsed: 30, resetAt: reset },
				monthly: { percentUsed: 40, resetAt: reset + 2 },
			},
			"Weekly",
			"5-hour",
		],
		[
			"nanogpt",
			{
				active: true,
				daily: { percentUsed: 0.2, resetAt: reset },
				monthly: { percentUsed: 0.4, resetAt: reset + 2 },
			},
			null,
			null,
		],
		[
			"xai",
			{
				credits: { utilization: 30, resets_at: new Date(reset).toISOString() },
			},
			null,
			null,
		],
	];
	for (const [provider, usageData, weekly, five] of cases) {
		const a = account(provider, {
			provider,
			usageData: usageData as Account["usageData"],
		});
		expect(accountSortWindow(a, "next-reset", now)?.resetTime).toBe(
			new Date(reset).toISOString(),
		);
		if (weekly === null)
			expect(accountSortWindow(a, "weekly-reset", now)).toBeNull();
		else expect(accountSortWindow(a, "weekly-reset", now)?.label).toBe(weekly);
		if (five === null)
			expect(accountSortWindow(a, "five-hour-reset", now)).toBeNull();
		else expect(accountSortWindow(a, "five-hour-reset", now)?.label).toBe(five);
	}
});

test("limits primary keeps scoped and code-review reset evidence out of account-wide weekly sorts", () => {
	const now = Date.now();
	const iso = (delta: number) => new Date(now + delta).toISOString();
	const a = account("a", {
		provider: "anthropic",
		usageData: {
			five_hour: { utilization: 0, resets_at: iso(1) },
			seven_day: { utilization: 0, resets_at: iso(1) },
			limits: [
				{ kind: "session", percent: 50, resets_at: iso(2000) },
				{ kind: "weekly_all", percent: 60, resets_at: iso(3000) },
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: iso(1000),
					scope: { model: { display_name: "Fable" } },
				},
			],
		} as unknown as Account["usageData"],
	});
	expect(accountSortWindow(a, "next-reset", now)?.label).toBe("Fable (Weekly)");
	expect(accountSortWindow(a, "weekly-reset", now)?.resetTime).toBe(iso(3000));
	expect(accountSortWindow(a, "weekly-remaining", now)?.value).toBe(60);
	const codex = account("codex", {
		usageData: {
			...a.usageData,
			code_review_used_percent: 10,
			code_review_resets_at: iso(500),
		} as unknown as Account["usageData"],
	});
	expect(accountSortWindow(codex, "next-reset", now)?.label).toBe(
		"Code Review",
	);
	expect(accountSortWindow(codex, "five-hour-remaining", now)).toBeNull();
});

test("missing, partial and nonfinite utilization never become inferred remaining capacity", () => {
	const now = Date.now();
	const reset = new Date(now + 3600000).toISOString();
	for (const utilization of [null, undefined, NaN, Infinity]) {
		const a = account("a", {
			provider: "anthropic",
			usageData: {
				seven_day: { utilization, resets_at: reset },
			} as unknown as Account["usageData"],
		});
		expect(accountSortWindow(a, "weekly-reset", now)?.resetTime).toBe(reset);
		expect(accountSortWindow(a, "weekly-remaining", now)).toBeNull();
	}
	const a = account("a", { provider: "anthropic", rateLimitReset: reset });
	expect(accountSortWindow(a, "five-hour-remaining", now)).toBeNull();
	const equal = [
		account("first", { name: "Same" }),
		account("second", { name: "same" }),
	];
	expect(accountListView(equal, { sort: "name" }).accounts[0]).toBe(equal[0]);
	expect(accountListView(equal, { sort: "weekly-reset" }).accounts[1]).toBe(
		equal[1],
	);
});
test("search trims and matches name/provider without changing input order", () => {
	const accounts = [
		account("Beta"),
		account("alpha"),
		account("Other", { provider: "anthropic" }),
	];
	expect(
		accountListView(accounts, { search: " CODEX " }).accounts.map((a) => a.id),
	).toEqual(["Beta", "alpha"]);
	expect(
		accountListView(accounts, { search: " ALP " }).accounts.map((a) => a.id),
	).toEqual(["alpha"]);
	expect(accounts.map((a) => a.id)).toEqual(["Beta", "alpha", "Other"]);
});
test("filters intersect, counts always cover all accounts", () => {
	const accounts = [
		account("paused", { paused: true }),
		account("auth", { requiresReauth: true }),
		account("other", { provider: "anthropic" }),
	];
	const view = accountListView(accounts, {
		provider: "codex",
		status: "attention",
		search: "auth",
	});
	expect(view.accounts.map((a) => a.id)).toEqual(["auth"]);
	expect(view.counts).toEqual({ all: 3, attention: 1, paused: 1 });
	expect(accountListView(accounts, { search: "missing" }).accounts).toEqual([]);
});
test("reviewing attention restores the global set and paused includes reauth pauses", () => {
	const accounts = [
		account("auth", { paused: true, requiresReauth: true }),
		account("lock", { provider: "anthropic", rateLimitStatus: "blocked" }),
		account("manual", { paused: true }),
	];
	const filtered = accountListView(accounts, {
		search: "missing",
		provider: "zai",
	});
	expect(filtered.counts).toEqual({ all: 3, attention: 2, paused: 2 });
	expect(
		accountListView(accounts, {
			search: "",
			provider: "",
			status: "attention",
		}).accounts.map((a) => a.id),
	).toEqual(["auth", "lock"]);
	expect(
		accountListView(accounts, { status: "paused" }).accounts.map((a) => a.id),
	).toEqual(["auth", "manual"]);
});
test("attention reasons count each account once and ignore view filters", () => {
	const view = accountListView(
		[
			account("auth", { requiresReauth: true, rateLimitStatus: "blocked" }),
			account("legacy-auth", {
				pauseReason: "oauth_invalid_grant",
				paused: true,
			}),
			account("throttle", { usageThrottledUntil: 101 }),
			account("routing"),
			account("manual", { paused: true }),
		],
		{ search: "missing" },
		{ routing: [{ availability: "model_exhausted" } as never] },
		100,
	);
	expect(view.accounts).toEqual([]);
	expect(view.counts.attention).toBe(4);
	expect(view.attentionReasons).toEqual({
		reconnect: 2,
		limited: 1,
		refresh: 0,
		routing: 1,
	});
});

test("attention respects real locks, throttling, auth and routing notices", () => {
	for (const patch of [
		{ pauseReason: "oauth_invalid_grant" },
		{ rateLimitStatus: "rate_limited" },
		{ rateLimitedUntil: 101 },
		{ usageRateLimitedUntil: 101 },
		{ usageThrottledUntil: 101 },
	])
		expect(needsAccountAttention(account("a", patch), [], 100)).toBe(true);
	for (const patch of [
		{},
		{ priority: 0 },
		{ rateLimitStatus: "allowed_warning" },
		{ rateLimitedUntil: 99 },
		{ paused: true },
	])
		expect(needsAccountAttention(account("a", patch), [], 100)).toBe(false);
	for (const state of [
		{ reason: "ambiguous" },
		{ reason: "new_billing_class" },
		{ managedRouteAvailable: true },
		{ availability: "model_exhausted" },
	])
		expect(needsAccountAttention(account("a"), [state as never], 100)).toBe(
			true,
		);
	expect(
		needsAccountAttention(account("a"), [{ availability: null } as never], 100),
	).toBe(false);
});

test("a weekly fallback never masquerades as a missing five-hour window", () => {
	const now = Date.now();
	const reset = new Date(now + 3600000).toISOString();
	const weeklyOnly = account("weekly-only", {
		provider: "anthropic",
		usageWindow: "seven_day",
		usageUtilization: 40,
		rateLimitReset: reset,
		usageData: {
			seven_day: { utilization: 40, resets_at: reset },
		} as Account["usageData"],
	});
	expect(accountSortWindow(weeklyOnly, "five-hour-reset", now)).toBeNull();
	expect(accountSortWindow(weeklyOnly, "five-hour-remaining", now)).toBeNull();
	expect(accountSortWindow(weeklyOnly, "weekly-reset", now)?.resetTime).toBe(
		reset,
	);
	expect(
		accountSortWindow(
			account("retry-only", { provider: "anthropic", rateLimitReset: reset }),
			"next-reset",
			now,
		),
	).toBeNull();
});

test("negative quota percentages do not imply spare capacity", () => {
	const now = Date.now();
	const reset = new Date(now + 3600000).toISOString();
	const invalid = account("invalid", {
		provider: "anthropic",
		usageData: {
			five_hour: { utilization: -1, resets_at: reset },
			seven_day: { utilization: -1, resets_at: reset },
		},
	});
	expect(accountSortWindow(invalid, "weekly-remaining", now)).toBeNull();
	expect(accountSortWindow(invalid, "five-hour-remaining", now)).toBeNull();
});

test("view sorts are stable, filtered, immutable and default to input order", () => {
	const input = [account("Zulu"), account("alpha"), account("Alpha")];
	expect(
		accountListView(input, { sort: "name" }).accounts.map((a) => a.id),
	).toEqual(["alpha", "Alpha", "Zulu"]);
	expect(accountListView(input).accounts).toEqual(input);
	expect(
		accountListView(input, { sort: "name", search: "alpha" }).counts.all,
	).toBe(3);
	expect(input.map((a) => a.id)).toEqual(["Zulu", "alpha", "Alpha"]);
});
test("reset and remaining sorts reject stale and invalid data and exclude scoped weekly", () => {
	const now = Date.now();
	const make = (id: string, reset: string, utilization: number) =>
		account(id, {
			provider: "anthropic",
			usageData: {
				five_hour: { utilization, resets_at: reset },
				seven_day: { utilization, resets_at: reset },
			},
		});
	const input = [
		make("expired", new Date(now - 1).toISOString(), 0),
		make("later", new Date(now + 7200000).toISOString(), 20),
		make("soon", new Date(now + 3600000).toISOString(), 80),
		make("invalid", "bad", NaN),
	];
	for (const sort of ["next-reset", "weekly-reset", "five-hour-reset"] as const)
		expect(
			accountListView(input, { sort }, {}, now).accounts.map((a) => a.id),
		).toEqual(["soon", "later", "expired", "invalid"]);
	for (const sort of ["weekly-remaining", "five-hour-remaining"] as const)
		expect(
			accountListView(input, { sort }, {}, now).accounts.map((a) => a.id),
		).toEqual(["later", "soon", "expired", "invalid"]);
});

test("attention separates exhausted capacity from usage refresh and expires locally", () => {
	const now = 100000;
	const exhausted = account("exhausted", {
		rateLimitStatus: "usage_exhausted (20m)",
	});
	const refresh = account("refresh", { usageRateLimitedUntil: now + 1 });
	expect(needsAccountAttention(exhausted, [], now)).toBe(true);
	expect(
		accountListView([refresh], {}, {}, now).attentionReasons,
	).toMatchObject({ refresh: 1, limited: 0 });
	expect(needsAccountAttention(refresh, [], now + 1)).toBe(false);
	for (const rateLimitStatus of ["queueing_soft", "unknown future"])
		expect(
			needsAccountAttention(account("soft", { rateLimitStatus }), [], now),
		).toBe(false);
});
