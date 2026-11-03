import type { BankedResetsSummary as BankedResetsSummaryData } from "@better-ccflare/types";
import { formatRelativeReset } from "../../lib/pool-usage";
import { STATUS_PILL_CLASS, STATUS_TONE_CLASS } from "./status-tones";

const EXPIRY_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});

const OBSERVED_FORMATTER = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
	timeZone: "UTC",
});

/** Below this much runway the countdown would read "in 0m", so only the date is shown. */
const COUNTDOWN_MIN_MS = 60_000;

/** A reset's expiry date in UTC, the same in every browser time zone. */
export function formatBankedResetExpiry(atMs: number): string {
	return EXPIRY_DATE_FORMATTER.format(atMs);
}

export function describeBankedResetExpiry(atMs: number): string {
	return `Expires ${new Date(atMs).toLocaleString()} (your local time)`;
}

/**
 * An expiry as its UTC date ("Nov 30, 2026 UTC") and a note ("in 27d 5h").
 * The countdown is left off under a minute, and a date already passed says
 * so instead of reading like a future one.
 */
export function bankedResetExpiryParts(
	atMs: number,
	now: number = Date.now(),
): { date: string; note: string | null } {
	const date = `${formatBankedResetExpiry(atMs)} UTC`;
	const remainingMs = atMs - now;
	if (remainingMs <= 0) return { date, note: "date passed" };
	if (remainingMs < COUNTDOWN_MIN_MS) return { date, note: null };
	return { date, note: formatRelativeReset(atMs, now) };
}

/** "Nov 30, 2026 UTC (in 27d 5h)"; see bankedResetExpiryParts. */
export function formatBankedResetExpiryLabel(
	atMs: number,
	now: number = Date.now(),
): string {
	const { date, note } = bankedResetExpiryParts(atMs, now);
	return note ? `${date} (${note})` : date;
}

/** When the router last read an account's banked resets: "Nov 3, 14:05 UTC". */
export function formatBankedResetObserved(atMs: number): string {
	return `${OBSERVED_FORMATTER.format(atMs)} UTC`;
}

export function BankedResetsSummary({
	summary,
	now = Date.now(),
}: {
	summary: BankedResetsSummaryData | undefined;
	now?: number;
}) {
	if (!summary || summary.trackedAccounts === 0) return null;
	const { totalAvailable, soonestExpiresAt, appliesNow, anyStale } = summary;
	const allUsableStale =
		appliesNow.length > 0 && appliesNow.every((entry) => entry.stale);

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
				<span className="text-sm text-muted-foreground">total</span>
				{anyStale && (
					<span className={`${STATUS_PILL_CLASS} ${STATUS_TONE_CLASS.warning}`}>
						Includes last known values
					</span>
				)}
			</div>
			<p className="max-w-prose text-sm text-muted-foreground">
				A banked reset is a saved reset that restores an account's usage limits
				ahead of schedule. Each account's limit also resets on its own timer.
				Using a banked reset is always your choice.
			</p>
			<p className="text-sm text-muted-foreground">
				{soonestExpiresAt !== null ? (
					<span title={describeBankedResetExpiry(soonestExpiresAt)}>
						Soonest expires{" "}
						{formatBankedResetExpiryLabel(soonestExpiresAt, now)}
					</span>
				) : totalAvailable > 0 ? (
					"Expiry not reported"
				) : (
					"No banked resets held."
				)}
			</p>
			{appliesNow.length > 0 ? (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
					<span className="text-xs text-muted-foreground">
						{allUsableStale
							? "Usable at last check, per OpenAI:"
							: "Usable now, per OpenAI:"}
					</span>
					{appliesNow.map((entry) => (
						<span key={entry.accountId} className="whitespace-nowrap">
							<span className="font-medium">{entry.accountName}</span>{" "}
							<span className="tabular-nums text-muted-foreground">
								({entry.applicableCount}
								<span className="sr-only"> usable</span>)
							</span>
							{entry.stale && (
								<span
									className={`ml-1.5 ${STATUS_PILL_CLASS} ${STATUS_TONE_CLASS.warning}`}
								>
									last known
								</span>
							)}
						</span>
					))}
				</div>
			) : (
				totalAvailable > 0 && (
					<p className="text-sm text-muted-foreground">
						{anyStale
							? "At last check, OpenAI reported no reset usable on any account."
							: "OpenAI reports no reset can be used on any account right now."}
					</p>
				)
			)}
			{anyStale && (
				<p className="text-xs text-muted-foreground">
					Some accounts have not reported recently. Their last known counts are
					included, so the real total may differ.
				</p>
			)}
			{totalAvailable > 0 && (
				<p
					data-testid="banked-resets-interim-howto"
					className="text-xs text-muted-foreground"
				>
					There is no Use reset button yet. If you choose to use one, open the
					Codex CLI signed in to that account, run <code>/usage</code> and
					choose <code>Redeem reset</code>. It cannot be undone.
				</p>
			)}
		</section>
	);
}
