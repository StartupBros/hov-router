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
										`${view.attentionReasons.reconnect} to reconnect`,
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
						Review accounts
					</button>
				</section>
			)}
			<div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
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
					className="flex min-w-0 flex-wrap items-center gap-1 xl:col-span-full"
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
					Sorting changes this view, not routing priority.
					{sort.endsWith("reset") &&
						" The highlighted reset determines the order. Missing or past resets appear last."}
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
					className="hidden grid-cols-[minmax(0,1.6fr)_minmax(0,3.2fr)_minmax(0,0.9fr)_11rem] gap-3 border-b bg-muted/20 px-3 py-3 text-xs text-muted-foreground xl:grid"
				>
					<span>Account</span>
					<span>Usage · resets in</span>
					<span>Router status</span>
					<span>Actions</span>
				</div>
				{accountListItems({ ...props, accounts: view.accounts }, sort)}
			</div>
			<details className="text-xs text-muted-foreground">
				<summary className="flex min-h-11 cursor-pointer items-center">
					About usage and routing
				</summary>
				<p>
					Lower priority numbers route first among eligible accounts. Router
					status shows local blocks, not guaranteed provider capacity. Clear
					cooldown removes a router block; it does not reset provider usage. A
					provider reset and a router retry are separate timers. Missing usage
					is not zero or unlimited. Model-specific limits may run out before the
					account-wide limit. Manage model-family assignments and routing
					notices in Combos.
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
