import { classifyAccountStatus } from "@better-ccflare/ui-common";
import type { Account } from "../../api";
import { providerShowsWeeklyUsage } from "../../utils/provider-utils";
import type { AccountFamilyRoutingState } from "./account-routing";
import { accountUsageWindows } from "./account-usage-windows";
import { displayLabel } from "./rate-limit-helpers";
export const ACCOUNT_SORTS = [
	["priority", "Routing priority"],
	["name", "Name A–Z"],
	["next-reset", "Next reset (soonest)"],
	["weekly-reset", "Weekly reset (soonest)"],
	["five-hour-reset", "5-hour reset (soonest)"],
	["weekly-remaining", "Weekly used (lowest first)"],
	["five-hour-remaining", "5-hour used (lowest first)"],
] as const;
export type AccountListSort = (typeof ACCOUNT_SORTS)[number][0];
export function accountSortWindow(
	account: Account,
	sort: AccountListSort,
	now = Date.now(),
) {
	const { usages } = accountUsageWindows(
		{
			resetIso: account.rateLimitReset,
			usageUtilization: account.usageUtilization,
			usageWindow: account.usageWindow,
			usageData: account.usageData,
			provider: account.provider,
			showWeekly: providerShowsWeeklyUsage(account.provider),
			compact: true,
		},
		now,
	);
	const remaining = sort.endsWith("remaining");
	return (
		usages
			.filter((row) => {
				if (!row.window) return false;
				if (
					sort.startsWith("weekly") &&
					!["seven_day", "weekly", "tokens_limit_weekly"].includes(row.window)
				)
					return false;
				if (
					sort.startsWith("five-hour") &&
					!["five_hour", "tokens_limit"].includes(row.window)
				)
					return false;
				const reset = row.resetTime ? Date.parse(row.resetTime) : NaN;
				return (
					Number.isFinite(reset) &&
					reset > now &&
					(!remaining ||
						(typeof row.utilization === "number" &&
							Number.isFinite(row.utilization) &&
							row.utilization >= 0))
				);
			})
			.map((row) => ({
				label: displayLabel(row),
				resetTime: row.resetTime ?? "",
				value: remaining
					? Math.max(0, Math.min(100, row.utilization ?? 0))
					: Date.parse(row.resetTime ?? ""),
			}))
			.sort((a, b) => a.value - b.value)[0] ?? null
	);
}

export type AccountListStatus = "all" | "attention" | "paused";
type AttentionReason = "reconnect" | "limited" | "refresh" | "routing";

function accountAttentionReason(
	account: Account,
	routing: readonly AccountFamilyRoutingState[] = [],
	now = Date.now(),
): AttentionReason | null {
	const status = classifyAccountStatus(account, now);
	if (status.reauth) return "reconnect";
	if (status.capacityAttention) return "limited";
	if (status.refreshDelayed) return "refresh";
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
		sort?: AccountListSort;
	} = {},
	routing: Readonly<Record<string, readonly AccountFamilyRoutingState[]>> = {},
	now = Date.now(),
) {
	const search = filters.search?.trim().toLowerCase() ?? "";
	const attentionReasons = { reconnect: 0, limited: 0, refresh: 0, routing: 0 };
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
				attentionReasons.refresh +
				attentionReasons.routing,
			paused: accounts.filter((a) => a.paused).length,
		},
		attentionReasons,
		providers: [...new Set(accounts.map((a) => a.provider))].sort(),
		accounts: accounts
			.filter(
				(a) =>
					(!search ||
						`${a.name}\n${a.provider}`.toLowerCase().includes(search)) &&
					(!filters.provider || a.provider === filters.provider) &&
					(filters.status === "attention"
						? needsAccountAttention(a, routing[a.id], now)
						: filters.status === "paused"
							? a.paused
							: true),
			)
			.sort((a, b) => {
				const sort = filters.sort ?? "priority";
				if (sort === "priority") return 0;
				if (sort === "name")
					return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
				const left = accountSortWindow(a, sort, now)?.value;
				const right = accountSortWindow(b, sort, now)?.value;
				return left == null
					? right == null
						? 0
						: 1
					: right == null
						? -1
						: left - right;
			}),
	};
}
