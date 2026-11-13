import { AlertCircle, Search, X } from "lucide-react";
import { useState } from "react";
import type { Account } from "../../api";
import { AccountListItem } from "./AccountListItem";
import {
	ACCOUNT_SORTS,
	type AccountListSort,
	type AccountListStatus,
	accountListView,
	accountSortWindow,
} from "./account-list-view";
import type { AccountFamilyRoutingState } from "./account-routing";

interface AccountListProps {
	settingsErrors?: Readonly<Record<string, string | null>>;
	onClearSettingsError?: (accountId: string) => void;
	accounts: Account[] | undefined;
	routingByAccountId?: Readonly<
		Record<string, readonly AccountFamilyRoutingState[]>
	>;
	onPauseToggle: (account: Account) => void;
	onForceResetRateLimit: (account: Account) => void;
	onRefreshUsage: (account: Account) => Promise<void>;
	onRemove: (account: Account) => void;
	onRename: (account: Account) => void;
	onPriorityChange: (account: Account) => void;
	onAutoFallbackToggle: (account: Account) => void;
	onBillingTypeToggle: (account: Account) => void;
	onAutoPauseOnOverageToggle?: (account: Account) => void;
	onCodexCreditDrainToggle?: (account: Account) => void;
	onPublicValueToggle?: (account: Account) => void;
	onPublicValueEditLabel?: (account: Account) => void;
	onPeakHoursPauseToggle?: (account: Account) => void;
	onCustomEndpointChange?: (account: Account) => void;
	onModelMappingsChange?: (account: Account) => void;
	onReauth?: (account: Account) => void;
	onAnthropicReauth?: (account: Account) => void;
	onCodexReauth?: (account: Account) => void;
	onUseReset?: (account: Account) => void;
}

export function AccountList(props: AccountListProps) {
	const { accounts, routingByAccountId } = props;
	const [sort, setSort] = useState<AccountListSort>("priority");
	const [search, setSearch] = useState("");
	const [provider, setProvider] = useState("");
	const [status, setStatus] = useState<AccountListStatus>("all");
	const view = accountListView(
		accounts ?? [],
		{ search, provider, status, sort },
		routingByAccountId,
	);
	const clear = () => {
		setSearch("");
		setProvider("");
		setStatus("all");
	};
	if (!accounts)
		return (
			<p className="text-muted-foreground" role="status">
				Account data unavailable.
			</p>
		);
	if (accounts.length === 0) {
		return (
			<p className="text-muted-foreground">
				No accounts yet. Add one to start routing requests.
			</p>
		);
	}

	return (
		<div className="min-w-0 space-y-3">
			{view.counts.attention > 0 && (
				<section
					aria-label="Attention across all accounts"
					className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-2"
				>
					<div className="flex min-w-0 items-center gap-2">
						<AlertCircle
							aria-hidden="true"
							className="h-4 w-4 shrink-0 text-destructive"
						/>
						<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
							<p className="text-sm font-medium">
								{view.counts.attention}{" "}
								{view.counts.attention === 1 ? "needs" : "need"} attention
							</p>
							<p className="text-xs text-muted-foreground">
								{[
									view.attentionReasons.reconnect &&
										`${view.attentionReasons.reconnect} reconnect`,
									view.attentionReasons.limited &&
										`${view.attentionReasons.limited} limited or throttled`,
									view.attentionReasons.routing &&
										`${view.attentionReasons.routing} routing notice${view.attentionReasons.routing === 1 ? "" : "s"}`,
								]
									.filter(Boolean)
									.join(" · ")}
							</p>
						</div>
					</div>
					<button
						type="button"
						className="min-h-11 px-3 text-sm"
						onClick={() => {
							setSearch("");
							setProvider("");
							setStatus("attention");
						}}
					>
						Review issues
					</button>
				</section>
			)}
			<div className="flex flex-col gap-3 xl:flex-row xl:items-center">
				<div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row">
					<label className="relative flex min-w-0 flex-1 items-center">
						<Search
							aria-hidden="true"
							className="absolute left-3 h-4 w-4 text-muted-foreground"
						/>
						<span className="sr-only">Search accounts</span>
						<input
							type="search"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="Search name or provider"
							className="h-11 w-full min-w-0 rounded-md border bg-background pl-9 pr-11 text-sm"
						/>
						{search && (
							<button
								type="button"
								aria-label="Clear search"
								onClick={() => setSearch("")}
								className="absolute right-0 flex h-11 w-11 items-center justify-center"
							>
								<X className="h-4 w-4" />
							</button>
						)}
					</label>
					<label className="flex min-w-0 items-center gap-2 text-sm">
						<span>Provider</span>
						<select
							value={provider}
							onChange={(e) => setProvider(e.target.value)}
							className="h-11 min-w-0 flex-1 rounded-md border bg-background px-3 sm:w-44"
						>
							<option value="">All providers</option>
							{view.providers.map((p) => (
								<option key={p} value={p}>
									{p}
								</option>
							))}
						</select>
					</label>
				</div>
				<label className="flex min-w-0 items-center gap-2 text-sm">
					<span>Sort</span>
					<select
						value={sort}
						onChange={(e) => setSort(e.target.value as AccountListSort)}
						className="h-11 min-w-0 rounded-md border bg-background px-2"
					>
						{ACCOUNT_SORTS.map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
				</label>
				<fieldset
					className="flex min-w-0 flex-wrap items-center gap-1 xl:shrink-0"
					aria-label="Filter by account status"
				>
					{(
						[
							["all", "All"],
							["attention", "Needs attention"],
							["paused", "Paused"],
						] as const
					).map(([value, label]) => (
						<button
							type="button"
							key={value}
							aria-pressed={status === value}
							onClick={() => setStatus(value)}
							className={`min-h-11 whitespace-nowrap rounded-md border px-2 text-xs ${status === value ? "border-foreground/30 bg-background font-medium" : "border-transparent text-muted-foreground hover:bg-muted"}`}
						>
							{label}{" "}
							<span className="ml-1 tabular-nums">{view.counts[value]}</span>
						</button>
					))}
				</fieldset>
			</div>
			<div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
				<p role="status">
					Showing {view.accounts.length} of {accounts.length} accounts
				</p>
				{(search || provider || status !== "all") && (
					<button
						type="button"
						onClick={clear}
						className="min-h-11 px-2 underline underline-offset-4"
					>
						Clear filters
					</button>
				)}
			</div>
			{sort !== "priority" && (
				<p className="text-xs text-muted-foreground">
					View order only — routing priority is unchanged.
					{sort.endsWith("reset") &&
						" Reset sort key is emphasized; unknown or elapsed resets come last."}
				</p>
			)}
			{view.accounts.length === 0 && (
				<div className="rounded-lg border border-dashed p-6 text-center">
					<p className="font-medium">No matching accounts</p>
					<p className="mt-1 text-sm text-muted-foreground">
						Try another name, provider, or status.
					</p>
					<button
						type="button"
						onClick={clear}
						className="min-h-11 px-3 text-sm underline"
					>
						Clear filters
					</button>
				</div>
			)}
			<div className="overflow-hidden rounded-md border">
				<div
					aria-hidden="true"
					className="hidden grid-cols-[minmax(0,1.6fr)_minmax(0,1.1fr)_minmax(15rem,1.5fr)_3rem_minmax(0,1.25fr)] gap-4 border-b bg-muted/20 px-3 py-3 text-xs text-muted-foreground xl:grid"
				>
					<span>Account</span>
					<span>Operational status</span>
					<div>
						Limits<span className="block font-normal">Used · resets in</span>
					</div>
					<span>Priority</span>
					<span>Actions</span>
				</div>
				{accountListItems({ ...props, accounts: view.accounts }, sort)}
			</div>
			<details className="text-xs text-muted-foreground">
				<summary className="flex min-h-11 cursor-pointer items-center">
					How routing works
				</summary>
				<p>
					Lower priority numbers route first among eligible accounts. Allowed
					means no local block, not guaranteed provider capacity. Force Reset
					clears only local state, not provider quota. Local retry and provider
					reset times are separate. Missing usage is not zero. Family membership
					determines eligible routes; temporary availability does not change
					membership. Binding limits can differ from account-wide routing
					utilization. Review actionable family notices in Combos.
				</p>
			</details>
		</div>
	);
}

/** Keep immutable keys and routing lookup together when filters change. */
export function accountListItems(
	{
		settingsErrors,
		accounts,
		routingByAccountId,
		...handlers
	}: AccountListProps,
	sort: AccountListSort = "priority",
) {
	return (accounts ?? []).map((account) => (
		<AccountListItem
			key={account.id}
			account={account}
			sortReset={
				sort.endsWith("reset") ? accountSortWindow(account, sort) : undefined
			}
			settingsError={settingsErrors?.[account.id]}
			routingStates={routingByAccountId?.[account.id]}
			isPrimary={account.isPrimary}
			{...handlers}
		/>
	));
}
