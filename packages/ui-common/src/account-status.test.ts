import { expect, test } from "bun:test";
import type {
	Account,
	AccountDisplay,
	AccountResponse,
} from "@better-ccflare/types";
import { classifyAccountStatus } from "./account-status";
import { AccountPresenter } from "./presenters";

const now = 100000;
test("normal, soft and unknown observations never claim rejection", () => {
	for (const status of ["OK", "ok (12m)", "Allowed", "allowed (1m)"])
		expect(classifyAccountStatus({ rateLimitStatus: status }, now).reason).toBe(
			"normal",
		);
	for (const status of ["allowed_warning", "queueing_soft (2m)"]) {
		const s = classifyAccountStatus({ rateLimitStatus: status }, now);
		expect(s.reason).toBe("normal");
		expect(s.notices).toContain("soft-warning");
		expect(s.overview).toBe(false);
	}
	const s = classifyAccountStatus({ rateLimitStatus: "future_value" }, now);
	expect(s.reason).toBe("unknown");
	expect(s.reportedStatus).toBe("future_value");
	expect(s.overview).toBe(false);
});
test("precedence, independent signals and frozen clear-cooldown predicate", () => {
	const a = {
		rateLimitStatus: "usage_exhausted (90m)",
		rateLimitedUntil: now + 10,
		usageThrottledUntil: now + 20,
		usageRateLimitedUntil: now + 30,
	};
	expect(classifyAccountStatus(a, now).reason).toBe("cooldown");
	expect(classifyAccountStatus({ ...a, paused: true }, now).reason).toBe(
		"paused",
	);
	expect(
		classifyAccountStatus({ ...a, paused: true, requiresReauth: true }, now)
			.reason,
	).toBe("reauth");
	const exhausted = classifyAccountStatus(
		{ ...a, rateLimitedUntil: null },
		now,
	);
	expect(exhausted.reason).toBe("exhausted");
	expect(exhausted.clearCooldown).toBe(false);
	expect(exhausted.capacityAttention).toBe(true);
	expect(exhausted.refreshDelayed).toBe(true);
	for (const status of [
		"rate_limited",
		"blocked",
		"queueing_hard",
		"payment_required",
	])
		expect(
			classifyAccountStatus({ rateLimitStatus: status }, now).clearCooldown,
		).toBe(true);
	expect(
		classifyAccountStatus({ rateLimitStatus: "Rate limited (2m)" }, now)
			.clearCooldown,
	).toBe(false);
});
test("API-generated cooldown labels expire with their numeric deadline", () => {
	const snapshot = {
		rateLimitStatus: "Rate limited (1m)",
		rateLimitedUntil: now + 30_000,
	};
	expect(classifyAccountStatus(snapshot, now).reason).toBe("cooldown");
	for (const clock of [
		snapshot.rateLimitedUntil,
		snapshot.rateLimitedUntil + 1,
	]) {
		const status = classifyAccountStatus(snapshot, clock);
		expect(status.reason).toBe("normal");
		expect(status.label).toBe("Not blocked");
		expect(status.capacityAttention).toBe(false);
		expect(status.overview).toBe(false);
		expect(status.clearCooldown).toBe(false);
		expect(status.reportedStatus).toBe(snapshot.rateLimitStatus);
	}
	expect(
		classifyAccountStatus(
			{ ...snapshot, usageThrottledUntil: now + 60_000 },
			snapshot.rateLimitedUntil,
		).reason,
	).toBe("pacing");
});
test("cooldown expiry preserves independent hard statuses and unknown deadlines", () => {
	for (const rateLimitStatus of [
		"rate_limited (1m)",
		"blocked",
		"queueing_hard",
		"payment_required",
		"Rate limited",
		"Rate limited until tomorrow",
	]) {
		const status = classifyAccountStatus(
			{ rateLimitStatus, rateLimitedUntil: now },
			now,
		);
		expect(status.reason).toBe("hard-limit");
		expect(status.capacityAttention).toBe(true);
	}
	for (const rateLimitedUntil of [undefined, null, NaN, Infinity]) {
		expect(
			classifyAccountStatus(
				{
					rateLimitStatus: "Rate limited (1m)",
					rateLimitedUntil,
				},
				now,
			).reason,
		).toBe("hard-limit");
	}
});
test("finite future clocks only, no utilization-derived exhaustion", () => {
	for (const until of [now, now - 1, NaN, Infinity]) {
		const s = classifyAccountStatus(
			{
				usageThrottledUntil: until,
				usageRateLimitedUntil: until,
				rateLimitedUntil: until,
			},
			now,
		);
		expect(s.reason).toBe("normal");
		expect(s.refreshDelayed).toBe(false);
	}
	expect(
		classifyAccountStatus({ usageRateLimitedUntil: now + 1 }, now).overview,
	).toBe(false);
	expect(
		classifyAccountStatus({ usageThrottledUntil: now + 1 }, now).reason,
	).toBe("pacing");
});
test("presenter supports raw, response and display inputs without rewriting raw strings", () => {
	for (const account of [
		{ paused: false, rate_limited_until: now + 1, pause_reason: null },
		{ paused: false, rateLimitStatus: "allowed", rateLimitedUntil: now + 1 },
		{ paused: false, rateLimitStatus: "queueing_soft" },
	]) {
		const p = new AccountPresenter(
			account as Account | AccountResponse | AccountDisplay,
			now,
		);
		expect(typeof p.rateLimitStatus).toBe("string");
		expect(p.status.reason).toBe(
			"rate_limited_until" in account || "rateLimitedUntil" in account
				? "cooldown"
				: "normal",
		);
	}
});
