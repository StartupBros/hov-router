/** Presentation only: observations are not routing eligibility guarantees. */
export interface AccountStatusInput {
	rateLimitStatus?: string | null;
	paused?: boolean;
	requiresReauth?: boolean;
	pauseReason?: string | null;
	rateLimitedUntil?: number | null;
	usageRateLimitedUntil?: number | null;
	usageThrottledUntil?: number | null;
}
export type AccountStatusReason =
	| "reauth"
	| "paused"
	| "cooldown"
	| "exhausted"
	| "hard-limit"
	| "pacing"
	| "unknown"
	| "normal";
export function isFutureDeadline(
	value: number | null | undefined,
	now: number,
): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > now;
}
export function classifyAccountStatus(input: AccountStatusInput, now: number) {
	const reportedStatus = input.rateLimitStatus ?? "OK";
	const base = reportedStatus
		.trim()
		.replace(/\s*\(\d+m\)$/, " ")
		.trim()
		.toLowerCase();
	const reauth =
		!!input.requiresReauth || input.pauseReason === "oauth_invalid_grant";
	const cooldown = isFutureDeadline(input.rateLimitedUntil, now);
	const pacing = isFutureDeadline(input.usageThrottledUntil, now);
	const refreshDelayed = isFutureDeadline(input.usageRateLimitedUntil, now);
	const exhausted = /^(usage_exhausted|usage exhausted)(?:$|\s)/.test(base);
	const clearableHard = [
		"rate_limited",
		"blocked",
		"queueing_hard",
		"payment_required",
	].some((p) => reportedStatus.toLowerCase().startsWith(p));
	const hard =
		clearableHard ||
		/^(rate limited|rate limited until|queueing hard|payment required)(?:$|\s)/.test(
			base,
		);
	const soft = base === "allowed_warning" || base === "queueing_soft";
	const normal = ["ok", "allowed", "paused", ""].includes(base) || soft;
	let reason: AccountStatusReason;
	if (reauth) reason = "reauth";
	else if (input.paused) reason = "paused";
	else if (cooldown) reason = "cooldown";
	else if (exhausted) reason = "exhausted";
	else if (hard) reason = "hard-limit";
	else if (pacing) reason = "pacing";
	else if (!normal) reason = "unknown";
	else reason = "normal";
	const labels: Record<AccountStatusReason, string> = {
		reauth: "Reconnect required",
		paused: "Paused",
		cooldown: "Cooling down",
		exhausted: "Usage exhausted",
		"hard-limit": "Reported hard limit",
		pacing: "Pacing active",
		unknown: "Status unknown",
		normal: "Not blocked",
	};
	const notices: ("soft-warning" | "usage-refresh" | "pacing")[] = [];
	if (soft) notices.push("soft-warning");
	if (refreshDelayed) notices.push("usage-refresh");
	if (pacing) notices.push("pacing");
	return {
		reason,
		label: labels[reason],
		tone: (["reauth", "exhausted", "hard-limit"].includes(reason)
			? "bad"
			: ["cooldown", "pacing", "unknown"].includes(reason)
				? "warning"
				: "muted") as "bad" | "warning" | "muted",
		reportedStatus,
		notices,
		refreshDelayed,
		pacing,
		reauth,
		cooldown,
		capacityAttention: cooldown || exhausted || hard || pacing,
		overview: cooldown || exhausted || hard || pacing,
		clearCooldown: (clearableHard || cooldown) && !input.paused,
		canResume: !reauth,
		routerRetryAt: cooldown ? input.rateLimitedUntil : null,
	};
}
