import type { BankedResets } from "@better-ccflare/types";
import { useId } from "react";
import { Button } from "../ui/button";
import {
	bankedResetExpiryParts,
	describeBankedResetExpiry,
	formatBankedResetObserved,
} from "./BankedResetsSummary";
import { resetActionAvailability } from "./reset-redemption-flow";
import { STATUS_PILL_CLASS, STATUS_TONE_CLASS } from "./status-tones";

export type BankedResetsRowKind = "not_tracked" | "unknown" | "none" | "held";

export interface BankedResetsRowState {
	kind: BankedResetsRowKind;
	/** The values are the last known ones; only shown for none and held. */
	stale: boolean;
}

/**
 * What one account's banked-resets line says: tracking, then the held count.
 * OpenAI's applicable count is not shown. It read 0 on a full account whose
 * reset then worked, and OpenAI's own apps show only the held count (#772).
 */
export function bankedResetsRowState(
	resets: BankedResets,
): BankedResetsRowState {
	const stale = resets.stale;
	if (!resets.tracked) return { kind: "not_tracked", stale };
	if (resets.availableCount === null) return { kind: "unknown", stale };
	if (resets.availableCount === 0) return { kind: "none", stale };
	return { kind: "held", stale };
}

/**
 * The expiry chunk. It may wrap on a narrow screen, but only between its
 * parts: the date and the countdown each stay on one line.
 */
function ExpiryChunk({ resets, now }: { resets: BankedResets; now: number }) {
	const { soonestExpiresAt, doesNotExpire, availableCount } = resets;
	if (soonestExpiresAt === null) {
		return (
			<span className="whitespace-nowrap text-muted-foreground">
				{doesNotExpire ? "Does not expire" : "Expiry not reported"}
			</span>
		);
	}
	const { date, note } = bankedResetExpiryParts(soonestExpiresAt, now);
	return (
		<span
			className="text-muted-foreground"
			title={describeBankedResetExpiry(soonestExpiresAt)}
		>
			{availableCount === 1 ? "Expires" : "Soonest expires"}{" "}
			<span className="whitespace-nowrap">{date}</span>
			{note && (
				<>
					{" "}
					<span className="whitespace-nowrap">({note})</span>
				</>
			)}
			{doesNotExpire && "; at least one does not expire"}
		</span>
	);
}

function staleDetail(observedAt: number | null): string {
	return observedAt === null
		? "Last known values. The router has not been able to refresh them."
		: `Last read ${formatBankedResetObserved(observedAt)}. The router has not been able to refresh it.`;
}

/**
 * One Codex account's banked resets, in its own block below the status line.
 * Every explanation is visible text; nothing here is green, because a held
 * reset is information, not a prompt to spend it. With `onUseReset`, an
 * account holding resets also gets a Use reset button, enabled whenever the
 * router would send the request: on any fresh count (R8, #772).
 */
export function BankedResetsStatus({
	resets,
	accountName,
	now = Date.now(),
	onUseReset,
}: {
	resets: BankedResets;
	accountName: string;
	now?: number;
	onUseReset?: () => void;
}) {
	const detailId = useId();
	const { kind, stale } = bankedResetsRowState(resets);
	const action = onUseReset ? resetActionAvailability(resets) : null;
	const count = resets.availableCount;
	const showsStale = stale && count !== null && kind !== "not_tracked";
	const holdsResets = kind === "held";

	let value: string;
	let detail: string;
	switch (kind) {
		case "not_tracked":
			value = "not tracked";
			detail = "Custom endpoint accounts do not report banked resets.";
			break;
		case "unknown":
			value = "not read yet";
			detail = "Waiting for the first usage check.";
			break;
		case "none":
			value = "0";
			detail = "None held.";
			break;
		case "held":
			value = String(count);
			detail =
				"Using one resets this account's usage limits early. It is optional and cannot be undone.";
			break;
	}
	// A stale count keeps its last known number, flagged once by the amber pill
	// right after it, and the detail line says when it was read.
	if (showsStale) detail = staleDetail(resets.observedAt);
	if (action?.shown && action.note) detail = `${detail} ${action.note}`;

	return (
		// A fieldset is a native group; min-w-0 drops its min-content width so the
		// header row can still wrap on a narrow screen.
		<fieldset
			aria-label={`Banked resets for ${accountName}`}
			className="min-w-0 space-y-1 text-sm"
		>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
				<span className="whitespace-nowrap text-xs text-muted-foreground">
					Banked resets:
				</span>
				<span className="whitespace-nowrap font-medium tabular-nums">
					{value}
				</span>
				{showsStale && (
					<span className={`${STATUS_PILL_CLASS} ${STATUS_TONE_CLASS.warning}`}>
						Last known
					</span>
				)}
				{holdsResets && <ExpiryChunk resets={resets} now={now} />}
				{action?.shown && (
					<Button
						variant="outline"
						size="sm"
						className="ml-auto h-7"
						disabled={!action.enabled}
						aria-describedby={detailId}
						onClick={onUseReset}
					>
						Use reset
					</Button>
				)}
			</div>
			<p id={detailId} className="text-xs text-muted-foreground">
				{detail}
			</p>
		</fieldset>
	);
}
