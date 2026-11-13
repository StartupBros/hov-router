import type { BankedResetsSummary as BankedResetsSummaryData } from "@better-ccflare/types";
import { ChevronDown } from "lucide-react";
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
	if (!summary || summary.trackedAccounts === 0)
		return (
			<details
				aria-label="Banked resets"
				className="text-xs text-muted-foreground"
			>
				<summary className="min-h-11 cursor-pointer py-3">
					Banked resets · {summary ? "Not tracked" : "not read yet"}
				</summary>
				<p className="max-w-prose pb-3">
					{summary
						? "No accounts currently report banked resets."
						: "Waiting for banked reset data. Missing data is not a zero balance."}{" "}
					A banked reset restores usage limits early. Using one is optional,
					asks for confirmation and cannot be undone.
				</p>
			</details>
		);
	// Applicability stays in the API but predicts nothing about a reset working.
	const { totalAvailable, soonestExpiresAt, anyStale } = summary;
	const explanation = (
		<p className="max-w-prose text-sm text-muted-foreground">
			A banked reset is a saved reset that restores an account's usage limits
			ahead of schedule. Each account's limit also resets on its own timer.
			Using a banked reset is always your choice.
		</p>
	);

	return (
		<details
			aria-label="Banked resets"
			className="group min-w-0 text-muted-foreground"
		>
			<summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 text-xs [&::-webkit-details-marker]:hidden">
				<span className="font-medium">Banked resets</span>
				<span className="font-semibold tabular-nums">{totalAvailable}</span>
				<span className="text-sm text-muted-foreground">total</span>
				{anyStale && (
					<span className={`${STATUS_PILL_CLASS} ${STATUS_TONE_CLASS.warning}`}>
						Includes last known values
					</span>
				)}
				<span>
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
				</span>
				<ChevronDown
					aria-hidden="true"
					className="h-4 w-4 shrink-0 group-open:rotate-180"
				/>
			</summary>
			<div className="max-w-prose space-y-2 py-2">
				{explanation}
				{anyStale && (
					<p className="text-xs text-muted-foreground">
						Some accounts have not reported recently. Their last known counts
						are included, so the real total may differ.
					</p>
				)}
				{totalAvailable > 0 && (
					<p
						data-testid="banked-resets-howto"
						className="text-xs text-muted-foreground"
					>
						If you choose to use one, press Use reset on that account below. It
						asks you to confirm first, and using a reset cannot be undone. The
						Codex CLI signed in to that account can also redeem one: run{" "}
						<code>/usage</code> and choose <code>Redeem reset</code>.
					</p>
				)}
			</div>
		</details>
	);
}
