import type { BankedResetsSummary as BankedResetsSummaryData } from "@better-ccflare/types";

const EXPIRY_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});

/** A reset's expiry date in UTC, the same in every browser time zone. */
export function formatBankedResetExpiry(atMs: number): string {
	return EXPIRY_DATE_FORMATTER.format(atMs);
}

/** Full local expiry time, for hover text. */
export function describeBankedResetExpiry(atMs: number): string {
	return `Expires ${new Date(atMs).toLocaleString()} (your local time)`;
}

const STALE_PILL_CLASS =
	"inline-flex items-center whitespace-nowrap rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400";

/**
 * Fleet view of banked Codex resets, above the account list. Renders nothing
 * until the summary loads or when no Codex account is tracked.
 */
export function BankedResetsSummary({
	summary,
}: {
	summary: BankedResetsSummaryData | undefined;
}) {
	if (!summary || summary.trackedAccounts === 0) return null;
	const { totalAvailable, soonestExpiresAt, appliesNow, anyStale } = summary;
	return (
		<section
			aria-label="Banked resets"
			className="mb-4 space-y-2 rounded-lg border border-border p-4"
		>
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<h3 className="text-sm font-medium">Banked resets</h3>
				<span className="text-2xl font-semibold tabular-nums">
					{totalAvailable}
				</span>
				{anyStale && (
					<span
						className={STALE_PILL_CLASS}
						title="At least one account has not reported recently, so the total includes its last known values"
					>
						includes stale values
					</span>
				)}
			</div>
			<p className="text-sm text-muted-foreground">
				{soonestExpiresAt !== null ? (
					<span title={describeBankedResetExpiry(soonestExpiresAt)}>
						Soonest expiry {formatBankedResetExpiry(soonestExpiresAt)}
					</span>
				) : totalAvailable > 0 ? (
					"No expiry reported"
				) : (
					"No banked resets held"
				)}
			</p>
			{appliesNow.length > 0 ? (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
					<span className="text-xs text-muted-foreground">Applies now:</span>
					{appliesNow.map((entry) => (
						<span key={entry.accountId} className="whitespace-nowrap">
							<span className="font-medium">{entry.accountName}</span>{" "}
							<span className="tabular-nums text-muted-foreground">
								({entry.applicableCount})
							</span>
							{entry.stale && (
								<span className="ml-1 text-xs text-amber-600">stale</span>
							)}
						</span>
					))}
				</div>
			) : (
				<p className="text-xs text-muted-foreground">
					No account has a reset that applies now.
				</p>
			)}
		</section>
	);
}
