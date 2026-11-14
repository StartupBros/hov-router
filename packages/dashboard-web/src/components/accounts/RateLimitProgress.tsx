import { computeWindowStartMs, registerUIRefresh } from "@better-ccflare/core";
import type { FullUsageData } from "@better-ccflare/types";
import { isFutureDeadline } from "@better-ccflare/ui-common";
import { useEffect, useId, useState } from "react";
import { formatRelativeReset } from "../../lib/pool-usage";
import { cn, formatShortDuration } from "../../lib/utils";
import {
	isAnthropicPeakHour,
	isZaiPeakHour,
	providerHasNoQuotaTracking,
	providerShowsCreditsBalance,
} from "../../utils/provider-utils";
import { LiveCountdown } from "../LiveCountdown";
import { Progress } from "../ui/progress";
import { accountUsageWindows } from "./account-usage-windows";
import {
	displayLabel,
	formatWindowName,
	isWeeklyWindow,
	severityColor,
} from "./rate-limit-helpers";

interface RateLimitProgressProps {
	bindingWindow?: string | null;
	compact?: boolean;
	highlightReset?: { label: string; resetTime: string } | null;
	resetIso: string | null;
	usageUtilization?: number | null; // Actual utilization from API (0-100)
	usageWindow?: string | null; // Window name (e.g., "five_hour")
	usageData?: FullUsageData | null; // Full usage data from API
	usageRateLimitedUntil?: number | null; // Timestamp (ms) until usage API 429 clears
	usageThrottledUntil?: number | null; // Timestamp (ms) until proactive usage throttling clears
	usageThrottledWindows?: string[]; // Exact usage windows currently being throttled
	provider: string;
	className?: string;
	showWeekly?: boolean; // Whether to show weekly usage as well
}

function computeExpectedPct(
	resetTime: string | null,
	window: string | null,
	now: number,
): number | null {
	if (!resetTime || !window) return null;
	const resetMs = new Date(resetTime).getTime();
	const startMs = computeWindowStartMs(resetMs, window);
	if (startMs === null) return null;
	const durationMs = resetMs - startMs;
	const elapsed = now - startMs;
	return Math.min(100, Math.max(0, (elapsed / durationMs) * 100));
}

function computeWindowThrottleUntil(
	resetTime: string | null,
	window: string | null,
	percentage: number | null,
	now: number,
): number | null {
	if (!resetTime || !window || percentage === null) return null;

	const resetMs = new Date(resetTime).getTime();
	if (!Number.isFinite(resetMs) || resetMs <= now) return null;

	const startMs = computeWindowStartMs(resetMs, window);
	if (startMs === null || startMs >= resetMs) return null;

	const durationMs = resetMs - startMs;
	const elapsedMs = now - startMs;
	if (elapsedMs <= 0) return null;

	const expectedPct = Math.min(
		100,
		Math.max(0, (elapsedMs / durationMs) * 100),
	);
	if (percentage <= expectedPct) return null;

	const resumeAt = Math.min(startMs + (percentage / 100) * durationMs, resetMs);
	return resumeAt > now ? resumeAt : null;
}

function formatThrottledUntil(throttledUntilMs: number, now: number): string {
	const remainingMs = throttledUntilMs - now;
	if (remainingMs < 60 * 1000) {
		return "Less than 1 minute";
	}

	const roundedUpToMinuteMs = Math.ceil(throttledUntilMs / 60000) * 60000;
	return new Date(roundedUpToMinuteMs).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	});
}

// Map an Anthropic severity (or a >=100% fallback) to a Progress indicator class.
function severityIndicatorClass(
	severity: string | undefined,
	utilization: number | null,
): string | undefined {
	const c = severityColor(severity, utilization);
	if (c === "critical") return "bg-red-500 dark:bg-red-400";
	if (c === "warning") return "bg-amber-500 dark:bg-amber-400";
	return undefined;
}

function computeProjectedMessage(
	resetTime: string | null,
	window: string | null,
	percentage: number | null,
	now: number,
): string | null {
	if (!resetTime || !window || percentage === null) return null;
	const resetMs = new Date(resetTime).getTime();
	const startMs = computeWindowStartMs(resetMs, window);
	if (startMs === null) return null;
	const elapsed = now - startMs;
	const remaining = resetMs - now;
	if (elapsed <= 0 || remaining <= 0) return null;
	const f = percentage / 100;
	if (f <= 0) return "No usage recorded yet in this window";
	const timeToExhaustMs = ((1 - f) / f) * elapsed;
	if (timeToExhaustMs < remaining) {
		return `Runs out ${formatShortDuration(remaining - timeToExhaustMs)} before reset`;
	}
	return `Resets ${formatShortDuration(timeToExhaustMs - remaining)} before exhaustion`;
}

/** Compact empty state: untracked by design reads differently from missing data. */
function MissingQuota({ provider }: { provider: string }) {
	return providerHasNoQuotaTracking(provider) ? (
		<p
			className="text-xs text-muted-foreground"
			title="The router doesn't poll this provider for quota or credit usage."
		>
			Quota not tracked
		</p>
	) : (
		<p className="text-xs text-muted-foreground">Usage unavailable</p>
	);
}

export function RateLimitProgress({
	resetIso,
	usageUtilization,
	usageWindow,
	usageData,
	usageRateLimitedUntil,
	usageThrottledUntil,
	usageThrottledWindows = [],
	provider,
	className,
	showWeekly = false,
	compact = false,
	highlightReset,
	bindingWindow,
}: RateLimitProgressProps) {
	const refreshId = useId();
	const [now, setNow] = useState(Date.now());

	useEffect(() => {
		const unregisterInterval = registerUIRefresh({
			id: `rate-limit-progress-update-${refreshId}`,
			callback: () => setNow(Date.now()),
			seconds: 30,
			description: "Rate limit progress UI update",
		});
		return unregisterInterval;
	}, [refreshId]);

	const isCodex = provider === "codex";
	const refreshDelayed = isFutureDeadline(usageRateLimitedUntil, now);
	const pacingActive = isFutureDeadline(usageThrottledUntil, now);

	// Allow null resetIso for providers that show usage data (like NanoGPT in PayG mode)
	// but still render null if there's no resetIso and no usage data to show
	if (
		!compact &&
		!isCodex &&
		!resetIso &&
		!usageData &&
		!refreshDelayed &&
		!pacingActive
	)
		return null;

	// Kilo Gateway: show credit balance in USD instead of a utilization window
	if (!compact && providerShowsCreditsBalance(provider) && usageData) {
		const kiloData = usageData as {
			remainingUsd?: number;
			totalMicrodollarsAcquired?: number;
		};
		if (typeof kiloData.remainingUsd === "number") {
			const hasCredits = (kiloData.totalMicrodollarsAcquired ?? 0) > 0;
			return (
				<div className={cn("space-y-2", className)}>
					<div className="flex items-center justify-between">
						<span className="text-xs text-muted-foreground">
							Kilo Gateway credits
						</span>
						<span className="text-xs font-medium text-muted-foreground">
							{hasCredits
								? `$${kiloData.remainingUsd.toFixed(2)} remaining`
								: "No credits"}
						</span>
					</div>
				</div>
			);
		}
	}

	const { usages, isNanoGPTData, hasAnthropicStyleData } = accountUsageWindows(
		{
			resetIso,
			usageUtilization,
			usageWindow,
			usageData,
			provider,
			showWeekly,
			compact,
		},
		now,
	);

	const inactiveNanoGPT =
		isNanoGPTData && (usageData as { active?: boolean }).active === false;
	const isZaiPeak = provider === "zai" && isZaiPeakHour(now);
	const isAnthropicPeak = provider === "anthropic" && isAnthropicPeakHour(now);
	const throttledWindowSet = new Set(usageThrottledWindows);

	// The throttle notice normally rides along inside the throttled window's row.
	// Codex no longer renders a 5-hour row, and throttling on that window still
	// delays real requests — so surface any throttled window that has no row of
	// its own as a standalone line. Without this, dropping the bar would also
	// silently drop the warning.
	const renderedWindows = new Set(
		usages
			.map((usage) => usage.window)
			.filter((window): window is string => window != null),
	);
	// Scoped to Codex on purpose: it is the only provider here that deliberately
	// suppresses a window's row, so it is the only one that can orphan a notice.
	const hasOrphanThrottledWindow =
		isCodex &&
		pacingActive &&
		usageThrottledWindows.some((window) => !renderedWindows.has(window));

	return (
		<div
			className={cn(
				compact ? "@container min-w-0 space-y-1.5" : "space-y-3",
				className,
			)}
		>
			{!compact && provider === "zai" && (
				<div className="flex items-center gap-2">
					<span
						className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full ${
							isZaiPeak
								? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"
								: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
						}`}
					>
						<span
							className={`h-1.5 w-1.5 rounded-full ${isZaiPeak ? "bg-orange-500" : "bg-green-500"}`}
						/>
						{isZaiPeak ? "Peak hours (14:00–18:00 SGT)" : "Off-peak hours"}
					</span>
				</div>
			)}
			{!compact && provider === "anthropic" && (
				<div className="flex items-center gap-2">
					<span
						className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full ${
							isAnthropicPeak
								? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"
								: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
						}`}
					>
						<span
							className={`h-1.5 w-1.5 rounded-full ${isAnthropicPeak ? "bg-orange-500" : "bg-green-500"}`}
						/>
						{isAnthropicPeak
							? "Peak hours (5–11am PT, weekdays)"
							: "Off-peak hours"}
					</span>
				</div>
			)}
			{!compact && hasOrphanThrottledWindow && usageThrottledUntil != null && (
				<div className="flex items-center justify-between">
					<span className="text-xs text-amber-700 dark:text-amber-400">
						Pacing active; affected windows may delay requests
					</span>
					<span className="text-xs text-amber-700 dark:text-amber-400">
						{(() => {
							const throttledLabel = formatThrottledUntil(
								usageThrottledUntil,
								now,
							);
							return throttledLabel.startsWith("Less than")
								? throttledLabel
								: `Until ${throttledLabel}`;
						})()}
					</span>
				</div>
			)}
			{compact && (
				<p className="text-xs text-muted-foreground xl:hidden">
					Usage · resets in
				</p>
			)}
			{compact && usages.length === 0 && <MissingQuota provider={provider} />}
			{refreshDelayed && usageRateLimitedUntil != null && (
				<p className="col-span-2 text-xs text-amber-700 dark:text-amber-400">
					Usage refresh delayed — retry after{" "}
					{new Date(usageRateLimitedUntil).toLocaleTimeString()}
				</p>
			)}
			{compact && pacingActive && usageThrottledUntil != null && (
				<p className="col-span-2 text-xs text-amber-700 dark:text-amber-400">
					Pacing active; affected windows may delay requests.{" "}
					{formatThrottledUntil(usageThrottledUntil, now).startsWith(
						"Less than",
					)
						? formatThrottledUntil(usageThrottledUntil, now)
						: `Until ${formatThrottledUntil(usageThrottledUntil, now)}`}
				</p>
			)}
			{compact && providerShowsCreditsBalance(provider) && (
				<div className="col-span-2">
					{!usageData || !("remainingUsd" in usageData) ? (
						<p className="text-xs text-muted-foreground">Credits unavailable</p>
					) : (
						<RateLimitProgress
							resetIso={resetIso}
							usageData={usageData}
							provider={provider}
						/>
					)}
				</div>
			)}
			{usages.map((usage, _index) => {
				if (compact) {
					if (providerShowsCreditsBalance(provider)) return null;
					if (inactiveNanoGPT && usage.window === "daily")
						return (
							<p key="payg" className="text-xs text-muted-foreground">
								No subscription (PayG mode)
							</p>
						);
					if (!usage.window)
						return <MissingQuota key="unavailable" provider={provider} />;
					const percentage = usage.utilization;
					const known =
						percentage != null &&
						Number.isFinite(percentage) &&
						percentage >= 0;
					const exhausted = known && percentage >= 100;
					const label = displayLabel(usage);
					const binding = usage.isActive || usage.window === bindingWindow;
					const highlighted =
						highlightReset?.label === label &&
						highlightReset.resetTime === usage.resetTime;
					return (
						<fieldset
							key={`${usage.window}:${usage.label ?? "default"}`}
							aria-label={`${label} used`}
							className="grid min-w-0 grid-cols-[minmax(0,7rem)_minmax(2rem,1fr)_2.5rem] items-center gap-x-2 gap-y-1 text-xs @[28rem]:grid-cols-[minmax(0,7rem)_minmax(2rem,1fr)_2.5rem_4.75rem]"
						>
							<span
								className={cn(
									"text-muted-foreground",
									binding && "font-medium text-foreground",
								)}
							>
								{label}
								{(exhausted || binding) && (
									<span
										className="ml-1"
										title={`${exhausted ? "Exhausted. " : ""}${binding ? "Currently limiting. " : ""}${usage.window?.startsWith("seven_day_") ? "This limit applies to this model, separately from account-wide usage." : "Account-wide limit."}`}
									>
										<span aria-hidden="true">{exhausted ? "!" : "•"}</span>
										<span className="sr-only">
											{exhausted ? "Exhausted; " : ""}
											{binding ? "currently limiting; " : ""}
											{usage.window?.startsWith("seven_day_")
												? "limit for this model"
												: "account-wide limit"}
										</span>
									</span>
								)}
							</span>
							{known ? (
								<>
									<Progress
										value={Math.min(100, percentage)}
										aria-label={`${label} used`}
										className="h-1 min-w-0"
										indicatorClassName={
											exhausted ? "bg-destructive" : "bg-muted-foreground"
										}
									/>
									<span
										className={cn(
											"text-right tabular-nums",
											exhausted && "font-medium",
										)}
									>
										{Math.round(percentage)}%
									</span>
								</>
							) : (
								<span className={cn("col-span-2 text-muted-foreground")}>
									Not reported
								</span>
							)}
							{usage.resetTime ? (
								<time
									className={cn(
										"col-span-full text-muted-foreground tabular-nums @[28rem]:col-span-1 @[28rem]:text-right",
										highlighted && "font-semibold text-foreground",
									)}
									dateTime={usage.resetTime}
									title={new Date(usage.resetTime).toLocaleString()}
								>
									<span className="sr-only">
										{highlighted ? "Sort key; " : ""}
										{new Date(usage.resetTime).toLocaleString()} local time;
										Resets{" "}
									</span>
									{Date.parse(usage.resetTime) <= now
										? "Due"
										: formatRelativeReset(Date.parse(usage.resetTime), now)}
								</time>
							) : (
								<span className="col-span-full text-muted-foreground @[28rem]:col-span-1 @[28rem]:text-right">
									<span className="sr-only">Reset </span>unknown
								</span>
							)}
						</fieldset>
					);
				}

				const percentage = usage.utilization;
				// `!= null`, not `!== null`: usage data crosses a JSON boundary through
				// a cast, so a window missing its percentage field yields `undefined`.
				// Strict inequality called such a row available and printed
				// "undefined%" instead of "N/A".
				const isAvailable = percentage != null;

				// Group header shown before the first row of each group (limits[] rows).
				const showGroupHeader =
					usage.group != null && usage.group !== usages[_index - 1]?.group;
				const groupTitle = usage.group === "session" ? "Session" : "Weekly";

				if (inactiveNanoGPT) {
					return (
						<div
							key={`${usage.window ?? "row"}:${usage.label ?? "default"}`}
							className="space-y-2"
						>
							<div className="flex items-center justify-between">
								<span className="text-xs text-muted-foreground">
									No subscription (PayG mode)
								</span>
							</div>
						</div>
					);
				}

				return (
					<div
						key={`${usage.window ?? "row"}:${usage.label ?? "default"}`}
						className="space-y-2"
					>
						{showGroupHeader && (
							<div className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
								{groupTitle}
							</div>
						)}
						{(() => {
							const expectedPct = computeExpectedPct(
								usage.resetTime,
								usage.window,
								now,
							);
							const isOverPacing =
								expectedPct !== null && (percentage ?? 0) > expectedPct;
							const flaggedWindow = usage.window
								? throttledWindowSet.has(usage.window)
								: false;
							const windowThrottleUntil = flaggedWindow
								? computeWindowThrottleUntil(
										usage.resetTime,
										usage.window,
										percentage ?? null,
										now,
									)
								: null;
							const throttleDisplayUntil =
								windowThrottleUntil ??
								(pacingActive ? usageThrottledUntil : null);
							const isWindowThrottled =
								flaggedWindow && throttleDisplayUntil != null;
							const windowLabel = usage.window
								? displayLabel(usage)
								: "Rate limit";
							const projectedMessage = computeProjectedMessage(
								usage.resetTime,
								usage.window,
								percentage ?? null,
								now,
							);
							return (
								<>
									<div className="flex items-center justify-between">
										<span className="text-xs text-muted-foreground">
											{usage.window
												? (usage.label ??
													`Usage (${formatWindowName(usage.window)})`)
												: "Rate limit window"}
										</span>
										<span
											className={cn(
												"text-xs font-medium text-muted-foreground",
												isWindowThrottled &&
													"text-amber-700 dark:text-amber-400",
											)}
										>
											{isAvailable ? `${percentage?.toFixed(0)}%` : "N/A"}
											{usage.isActive && (
												<span className="ml-1.5 text-[11px] font-medium uppercase tracking-wide text-red-700 dark:text-red-400">
													limiting
												</span>
											)}
										</span>
									</div>
									<div className="group relative">
										<div
											className="pointer-events-none absolute bottom-full z-10 mb-2 hidden w-max max-w-xs -translate-x-1/2 rounded bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md group-hover:block"
											style={{ left: `clamp(10%, ${expectedPct ?? 50}%, 90%)` }}
										>
											<div className="mb-1 font-medium">
												{windowLabel} usage
											</div>
											{projectedMessage && (
												<div
													className={
														(percentage ?? 0) <= 0
															? "text-muted-foreground"
															: isOverPacing
																? "text-red-400"
																: "text-green-400"
													}
												>
													{projectedMessage}
												</div>
											)}
										</div>
										<Progress
											value={isAvailable ? percentage : null}
											aria-label={`${windowLabel} usage`}
											className="h-2"
											indicatorClassName={
												isWindowThrottled
													? "bg-amber-500 dark:bg-amber-400"
													: severityIndicatorClass(
															usage.severity,
															// Time-based fallback row (window == null) uses elapsed
															// time as its bar %, not usage -- never color it by that.
															usage.window == null
																? null
																: (percentage ?? null),
														)
											}
										/>
										{expectedPct !== null && (
											<div
												className="absolute w-0.5 pointer-events-none"
												style={{
													left: `${expectedPct}%`,
													top: "-3px",
													height: "14px",
													zIndex: 10,
													backgroundColor: "rgba(255,255,255,0.95)",
													boxShadow:
														"1px 0 2px rgba(0,0,0,0.5), -1px 0 2px rgba(0,0,0,0.5)",
												}}
											/>
										)}
									</div>
									{isWindowThrottled && throttleDisplayUntil && (
										<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
											<span className="text-xs text-amber-700 dark:text-amber-400">
												Pacing active; affected windows may delay requests
											</span>
											<span className="text-xs text-amber-700 dark:text-amber-400">
												{(() => {
													const throttledLabel = formatThrottledUntil(
														throttleDisplayUntil,
														now,
													);
													return throttledLabel.startsWith("Less than")
														? throttledLabel
														: `Until ${throttledLabel}`;
												})()}
											</span>
										</div>
									)}
								</>
							);
						})()}
						{usage.resetTime && (
							<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
								<LiveCountdown
									target={usage.resetTime}
									suffix=" until reset"
									className="text-xs text-muted-foreground"
								/>
								<span className="text-xs text-muted-foreground">
									{(usage.window && isWeeklyWindow(usage.window)) ||
									usage.window === "weekly" ||
									usage.window === "monthly" ||
									usage.window === "time_limit" ||
									usage.window === "tokens_limit"
										? `Resets ${new Date(usage.resetTime).toLocaleString(
												undefined,
												{
													month: "short",
													day: "numeric",
													hour: "2-digit",
													minute: "2-digit",
												},
											)} (local)`
										: `Resets ${new Date(usage.resetTime).toLocaleTimeString(
												undefined,
												{
													hour: "2-digit",
													minute: "2-digit",
												},
											)} (local)`}
									{(() => {
										const relativeReset = formatRelativeReset(
											new Date(usage.resetTime).getTime(),
											now,
										);
										return relativeReset != null ? ` · ${relativeReset}` : "";
									})()}
								</span>
							</div>
						)}
						{!usage.resetTime && (
							<p className="text-xs text-muted-foreground">
								{!isAvailable && "Data unavailable · "}Reset unknown
							</p>
						)}
					</div>
				);
			})}
			{hasAnthropicStyleData &&
				(() => {
					const spend = (
						usageData as {
							spend?: {
								enabled?: boolean;
								percent?: number | null;
								used?: {
									amount_minor: number;
									currency: string;
									exponent?: number;
								} | null;
								currency?: string | null;
							};
						}
					).spend;
					if (!spend?.enabled) return null;
					const used = spend.used;
					const exponent = used?.exponent ?? 2;
					const rawAmount =
						used != null ? used.amount_minor / 10 ** exponent : null;
					const amount =
						rawAmount != null && Number.isFinite(rawAmount) ? rawAmount : null;
					const cur = used?.currency ?? spend.currency ?? "USD";
					const pct = spend.percent ?? null;
					return (
						<div className={compact ? "col-span-2 space-y-2" : "space-y-2"}>
							<div className="flex items-center justify-between">
								<span className="text-xs text-muted-foreground">
									Extra usage spent
								</span>
								<span className="text-xs font-medium text-muted-foreground">
									{amount != null
										? `${cur} ${amount.toFixed(2)}`
										: pct != null
											? `${pct.toFixed(0)}%`
											: "—"}
								</span>
							</div>
							{pct != null && (
								<Progress
									value={Math.min(100, Math.max(0, pct))}
									aria-label="Extra usage spent"
									className="h-2"
								/>
							)}
						</div>
					);
				})()}
		</div>
	);
}
