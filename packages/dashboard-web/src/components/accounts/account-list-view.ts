import type { Account } from "../../api";
import type { AccountFamilyRoutingState } from "./account-routing";
import { pauseStatusDisplay } from "./pause-status";

export type AccountListStatus = "all" | "attention" | "paused";
type AttentionReason = "reconnect" | "limited" | "routing";

function accountAttentionReason(
	account: Account,
	routing: readonly AccountFamilyRoutingState[] = [],
	now = Date.now(),
): AttentionReason | null {
	if (
		account.requiresReauth ||
		pauseStatusDisplay(account.pauseReason).reauthRequired
	)
		return "reconnect";
	if (
		/^(rate_limited|blocked|queueing_hard|payment_required)/i.test(
			account.rateLimitStatus ?? "",
		) ||
		[
			account.rateLimitedUntil,
			account.usageRateLimitedUntil,
			account.usageThrottledUntil,
		].some((until) => typeof until === "number" && until > now)
	)
		return "limited";
	if (
		routing.some(
			(state) =>
				state.reason === "ambiguous" ||
				state.reason === "new_billing_class" ||
				state.managedRouteAvailable ||
				(state.availability !== null &&
					state.availability !== "available" &&
					state.availability !== "paused"),
		)
	)
		return "routing";
	return null;
}

export function needsAccountAttention(
	account: Account,
	routing: readonly AccountFamilyRoutingState[] = [],
	now = Date.now(),
): boolean {
	return accountAttentionReason(account, routing, now) !== null;
}

export function accountListView(
	accounts: readonly Account[],
	filters: {
		search?: string;
		provider?: string;
		status?: AccountListStatus;
	} = {},
	routing: Readonly<Record<string, readonly AccountFamilyRoutingState[]>> = {},
	now = Date.now(),
) {
	const search = filters.search?.trim().toLowerCase() ?? "";
	const attentionReasons = { reconnect: 0, limited: 0, routing: 0 };
	for (const account of accounts) {
		const reason = accountAttentionReason(account, routing[account.id], now);
		if (reason) attentionReasons[reason]++;
	}
	return {
		counts: {
			all: accounts.length,
			attention:
				attentionReasons.reconnect +
				attentionReasons.limited +
				attentionReasons.routing,
			paused: accounts.filter((a) => a.paused).length,
		},
		attentionReasons,
		providers: [...new Set(accounts.map((a) => a.provider))].sort(),
		accounts: accounts.filter(
			(a) =>
				(!search ||
					`${a.name}\n${a.provider}`.toLowerCase().includes(search)) &&
				(!filters.provider || a.provider === filters.provider) &&
				(filters.status === "attention"
					? needsAccountAttention(a, routing[a.id], now)
					: filters.status === "paused"
						? a.paused
						: true),
		),
	};
}
