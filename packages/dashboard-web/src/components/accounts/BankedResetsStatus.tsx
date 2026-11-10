import type { BankedResets } from "@better-ccflare/types";
import { useId } from "react";
import { Button } from "../ui/button";
import {
	bankedResetExpiryParts,
	describeBankedResetExpiry,
	formatBankedResetObserved,
} from "./BankedResetsSummary";
import {
	applicabilitySentence,
	resetActionAvailability,
} from "./reset-redemption-flow";
import { STATUS_PILL_CLASS, STATUS_TONE_CLASS } from "./status-tones";

export type BankedResetsRowKind =
	| "not_tracked"
	| "unknown"
	| "none"
	| "applicable"
	| "not_applicable";

export interface BankedResetsRowState {
	kind: BankedResetsRowKind;
	/** The values are the last known ones; only shown for none, applicable and not_applicable. */
	stale: boolean;
}

/**
 * What one account's banked-resets line says. The count decides first, so
 * OpenAI's applicable count only matters when at least one reset is held.
 * It is relayed as OpenAI's expectation, never as whether a reset can be
 * used: Use reset works on any held reset, as in the Codex CLI (#772).
 */
export function bankedResetsRowState(
	resets: BankedResets,
): BankedResetsRowState {
	const stale = resets.stale;
	if (!resets.tracked) return { kind: "not_tracked", stale };
	if (resets.availableCount === null) return { kind: "unknown", stale };
	if (resets.availableCount === 0) return { kind: "none", stale };
	return { kind: resets.appliesNow ? "applicable" : "not_applicable", stale };
}

function applicablePillText(resets: BankedResets, stale: boolean): string {
	if (stale) return "Would help at last check (OpenAI)";
	const { applicableCount, availableCount } = resets;
	if (applicableCount !== null && applicableCount !== availableCount) {
		return `Would help now: ${applicableCount} of ${availableCount} (OpenAI)`;
	}
	return "Would help now (OpenAI)";
}

function notApplicablePillText(resets: BankedResets, stale: boolean): string {
	if (resets.applicableCount === null) {
		return stale
			? "Help not reported at last check (OpenAI)"
			: "Help not reported (OpenAI)";
	}
	return stale
		? "Not expected to help at last check (OpenAI)"
		: "Not expected to help now (OpenAI)";
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
	const holdsResets = kind === "applicable" || kind === "not_applicable";

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
		case "applicable":
			value = String(count);
			detail =
				"OpenAI says a reset would work on this account right now. Using one is optional and cannot be undone.";
			break;
		case "not_applicable":
			value = String(count);
			detail = `${applicabilitySentence(resets)} Using one is still allowed, as in the Codex CLI: OpenAI decides what it resets, and the router then shows whether one was spent. It cannot be undone.`;
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
				{kind === "applicable" && (
					<span className={`${STATUS_PILL_CLASS} ${STATUS_TONE_CLASS.muted}`}>
						{applicablePillText(resets, stale)}
					</span>
				)}
				{kind === "not_applicable" && (
					<span className={`${STATUS_PILL_CLASS} ${STATUS_TONE_CLASS.muted}`}>
						{notApplicablePillText(resets, stale)}
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
