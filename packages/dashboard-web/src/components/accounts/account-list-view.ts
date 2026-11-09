import type { Account } from "../../api";
import type { AccountFamilyRoutingState } from "./account-routing";
import { pauseStatusDisplay } from "./pause-status";

export type AccountListStatus = "all" | "attention" | "paused";
export function needsAccountAttention(
	account: Account,
	routing: readonly AccountFamilyRoutingState[] = [],
	now = Date.now(),
): boolean {
	return Boolean(
		account.requiresReauth ||
			pauseStatusDisplay(account.pauseReason).reauthRequired ||
			/^(rate_limited|blocked|queueing_hard|payment_required)/i.test(
				account.rateLimitStatus ?? "",
			) ||
			[
				account.rateLimitedUntil,
				account.usageRateLimitedUntil,
				account.usageThrottledUntil,
			].some((until) => typeof until === "number" && until > now) ||
			routing.some(
				(state) =>
					state.reason === "ambiguous" ||
					state.reason === "new_billing_class" ||
					state.managedRouteAvailable ||
					(state.availability !== null &&
						state.availability !== "available" &&
						state.availability !== "paused"),
			),
	);
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
	const attention = (account: Account) =>
		needsAccountAttention(account, routing[account.id], now);
	return {
		counts: {
			all: accounts.length,
			attention: accounts.filter(attention).length,
			paused: accounts.filter((a) => a.paused).length,
		},
		providers: [...new Set(accounts.map((a) => a.provider))].sort(),
		accounts: accounts.filter(
			(a) =>
				(!search ||
					`${a.name}\n${a.provider}`.toLowerCase().includes(search)) &&
				(!filters.provider || a.provider === filters.provider) &&
				(filters.status === "attention"
					? attention(a)
					: filters.status === "paused"
						? a.paused
						: true),
		),
	};
}
