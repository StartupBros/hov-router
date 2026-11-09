import { Search, X } from "lucide-react";
import { useState } from "react";
import type { Account } from "../../api";
import { AccountListItem } from "./AccountListItem";
import { type AccountListStatus, accountListView } from "./account-list-view";
import type { AccountFamilyRoutingState } from "./account-routing";

interface AccountListProps {
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
	const [search, setSearch] = useState("");
	const [provider, setProvider] = useState("");
	const [status, setStatus] = useState<AccountListStatus>("all");
	const view = accountListView(
		accounts ?? [],
		{ search, provider, status },
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
			<div className="space-y-3 rounded-lg border bg-muted/20 p-3">
				<div className="flex flex-col gap-3 sm:flex-row">
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
				<fieldset
					className="flex min-w-0 flex-wrap items-center gap-2"
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
							className={`min-h-11 rounded-md border px-3 text-sm ${status === value ? "border-foreground/30 bg-background font-medium" : "border-transparent text-muted-foreground hover:bg-muted"}`}
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
			{accountListItems({ ...props, accounts: view.accounts })}
		</div>
	);
}

/** Keep immutable keys and routing lookup together when filters change. */
export function accountListItems({
	accounts,
	routingByAccountId,
	...handlers
}: AccountListProps) {
	return (accounts ?? []).map((account) => (
		<AccountListItem
			key={account.id}
			account={account}
			routingStates={routingByAccountId?.[account.id]}
			isPrimary={account.isPrimary}
			{...handlers}
		/>
	));
}
