import { expect, test } from "bun:test";
import type { Account } from "../../api";
import { accountListView, needsAccountAttention } from "./account-list-view";

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
