import type { AnthropicUsageData, FullUsageData } from "@better-ccflare/types";
import { normalizeResetMs } from "../../lib/pool-usage";
import { providerShowsWeeklyUsage } from "../../utils/provider-utils";
import {
	collectAnthropicUsageRows,
	isUsageWindow,
	type UsageDisplay,
} from "./rate-limit-helpers";

interface CodexUsageExtras {
	code_review_used_percent?: number | null;
	code_review_resets_at?: string | null;
}
export function resetIsoValue(
	value: string | number | null | undefined,
): string | null {
	const ms = normalizeResetMs(value);
	return ms != null && Number.isFinite(ms) && Math.abs(ms) <= 8640000000000000
		? new Date(ms).toISOString()
		: null;
}
export function accountUsageWindows(
	{
		resetIso,
		usageUtilization,
		usageWindow,
		usageData,
		provider,
		showWeekly = false,
	}: {
		resetIso: string | null;
		usageUtilization?: number | null;
		usageWindow?: string | null;
		usageData?: FullUsageData | null;
		provider: string;
		showWeekly?: boolean;
		compact?: boolean;
	},
	now = Date.now(),
) {
	const isCodex = provider === "codex";

	// Determine which usage windows to display
	const usages: UsageDisplay[] = [];

	// Check if this is NanoGPT usage data (has 'active' and 'daily' properties)
	const isNanoGPTData =
		usageData &&
		"active" in usageData &&
		"daily" in usageData &&
		"monthly" in usageData;

	// Check if this is Zai usage data (has 'time_limit' and 'tokens_limit' properties)
	const isZaiData =
		usageData &&
		("time_limit" in usageData ||
			"tokens_limit" in usageData ||
			"tokens_limit_weekly" in usageData);

	// Check if this is xAI/Grok usage data
	const isXaiData = usageData && "credits" in usageData;

	// Check if this is Alibaba Coding Plan usage data
	const isAlibabaData =
		usageData && "five_hour" in usageData && "weekly" in usageData;

	// Check if this is MiniMax Token Plan usage data. The fetcher normalizes
	// MiniMax's native `weekly_*` fields into a canonical `seven_day` window
	// (see minimax-usage-fetcher.ts) with camelCase `resetAt` (epoch ms) on the
	// inner object — distinct from Anthropic-style snake_case `resets_at`
	// (ISO string). We disambiguate by inspecting the inner shape, not the
	// provider name, so this also tolerates any future fetcher that adopts the
	// same canonical convention. Without this guard a MiniMax payload falls
	// into the Anthropic render branch below, `isUsageWindow` rejects both
	// inner windows (no `resets_at`), and the 7d row collapses to "N/A".
	const isMinimaxData = (() => {
		if (!usageData || typeof usageData !== "object") return false;
		if (!("five_hour" in usageData) && !("seven_day" in usageData)) {
			return false;
		}
		// Anthropic-style: snake_case `resets_at` (string). MiniMax: camelCase
		// `resetAt` (number, epoch ms). Require every present inner window
		// to match the MiniMax shape — rejects payloads where one window
		// looks like MiniMax and another looks like Anthropic, and rejects
		// empty-object inner windows that would otherwise render "undefined%".
		for (const key of ["five_hour", "seven_day"] as const) {
			const obj = (usageData as Record<string, unknown>)[key];
			if (obj === undefined || obj === null) continue;
			if (typeof obj !== "object") return false;
			const o = obj as Record<string, unknown>;
			if (!("resetAt" in o) || "resets_at" in o) return false;
		}
		return true;
	})();

	// Anthropic-style quota data is shared by Anthropic and Codex; detect by shape, not provider name.
	const hasAnthropicStyleData =
		usageData != null &&
		// Legacy flat windows OR the new generic limits[] array. Never NanoGPT's
		// object-shaped `limits` — disambiguated with Array.isArray.
		("five_hour" in usageData ||
			"seven_day" in usageData ||
			Object.entries(usageData).some(
				([key, value]) => key.startsWith("seven_day_") && isUsageWindow(value),
			) ||
			Array.isArray((usageData as { limits?: unknown }).limits)) &&
		!isAlibabaData &&
		!isMinimaxData &&
		!isZaiData &&
		!isNanoGPTData;

	if (isAlibabaData && showWeekly) {
		const alibabaData = usageData as {
			five_hour: { percentUsed: number; resetAt: number | null };
			weekly: { percentUsed: number; resetAt: number | null };
			monthly: { percentUsed: number; resetAt: number | null };
		};
		usages.push({
			utilization: alibabaData.five_hour?.percentUsed ?? null,
			window: "five_hour",
			resetTime: alibabaData.five_hour?.resetAt
				? resetIsoValue(alibabaData.five_hour?.resetAt)
				: null,
		});
		usages.push({
			utilization: alibabaData.weekly?.percentUsed ?? null,
			window: "weekly",
			resetTime: alibabaData.weekly?.resetAt
				? resetIsoValue(alibabaData.weekly?.resetAt)
				: null,
		});
		usages.push({
			utilization: alibabaData.monthly?.percentUsed ?? null,
			window: "monthly",
			resetTime: alibabaData.monthly?.resetAt
				? resetIsoValue(alibabaData.monthly?.resetAt)
				: null,
		});
	} else if (isMinimaxData && showWeekly) {
		// MiniMax Token Plan usage data — show 5-hour and 7-day windows from
		// each window's own `utilization` and `resetAt` (camelCase, epoch ms).
		// Do NOT collapse to a single `usageUtilization` row: that fallback
		// takes the most-restrictive window across all accounts and hides
		// the second window entirely.
		const minimaxData = usageData as {
			five_hour?: {
				utilization: number | null;
				resetAt: number | null;
			} | null;
			seven_day?: {
				utilization: number | null;
				resetAt: number | null;
			} | null;
		};
		const fiveHourUtil = minimaxData.five_hour?.utilization;
		if (minimaxData.five_hour != null) {
			usages.push({
				utilization: fiveHourUtil ?? null,
				window: "five_hour",
				resetTime:
					minimaxData.five_hour &&
					typeof minimaxData.five_hour.resetAt === "number"
						? resetIsoValue(minimaxData.five_hour.resetAt)
						: null,
			});
		}
		const sevenDayUtil = minimaxData.seven_day?.utilization;
		if (minimaxData.seven_day != null) {
			usages.push({
				utilization: sevenDayUtil ?? null,
				window: "seven_day",
				resetTime:
					minimaxData.seven_day &&
					typeof minimaxData.seven_day.resetAt === "number"
						? resetIsoValue(minimaxData.seven_day.resetAt)
						: null,
			});
		}
	} else if (isXaiData && showWeekly) {
		// xAI/Grok usage data - show Grok Build credits utilization.
		const xaiData = usageData as {
			credits?: { utilization: number; resets_at: string | null };
		};
		if (xaiData.credits) {
			usages.push({
				utilization: xaiData.credits.utilization,
				window: "credits",
				resetTime: xaiData.credits.resets_at,
			});
		}
	} else if (isZaiData && showWeekly) {
		// Zai usage data - show tokens_limit (5-hour token quota) and time_limit (peak-hour limit)
		const zaiData = usageData as {
			time_limit?: { percentage: number; resetAt: number } | null;
			tokens_limit?: { percentage: number; resetAt: number } | null;
			tokens_limit_weekly?: { percentage: number; resetAt: number } | null;
		};

		// Tokens limit usage (5-hour token quota)
		if (zaiData.tokens_limit) {
			usages.push({
				utilization: zaiData.tokens_limit.percentage,
				window: "tokens_limit",
				resetTime: zaiData.tokens_limit.resetAt
					? resetIsoValue(zaiData.tokens_limit.resetAt)
					: null,
			});
		}

		// Weekly token quota (absent on single-window plans)
		if (zaiData.tokens_limit_weekly) {
			usages.push({
				utilization: zaiData.tokens_limit_weekly.percentage,
				window: "tokens_limit_weekly",
				resetTime: zaiData.tokens_limit_weekly.resetAt
					? resetIsoValue(zaiData.tokens_limit_weekly.resetAt)
					: null,
			});
		}

		// Time limit usage (peak-hour quota)
		if (zaiData.time_limit) {
			usages.push({
				utilization: zaiData.time_limit.percentage,
				window: "time_limit",
				resetTime: zaiData.time_limit.resetAt
					? resetIsoValue(zaiData.time_limit.resetAt)
					: null,
			});
		}
	} else if (isNanoGPTData && showWeekly) {
		// NanoGPT usage data - show daily and monthly windows
		const nanogptData = usageData as {
			active: boolean;
			daily: { percentUsed: number; resetAt: number };
			monthly: { percentUsed: number; resetAt: number };
		};

		// Only show usage if subscription is active
		if (nanogptData.active !== false) {
			// Daily usage
			if (nanogptData.daily) {
				usages.push({
					utilization: nanogptData.daily.percentUsed * 100, // Convert 0-1 to 0-100
					window: "daily",
					resetTime: resetIsoValue(nanogptData.daily.resetAt),
				});
			}

			// Monthly usage
			if (nanogptData.monthly) {
				usages.push({
					utilization: nanogptData.monthly.percentUsed * 100, // Convert 0-1 to 0-100
					window: "monthly",
					resetTime: resetIsoValue(nanogptData.monthly.resetAt),
				});
			}
		} else {
			// PayG mode - show that no subscription is active
			usages.push({
				utilization: null,
				window: "daily",
				resetTime: null,
			});
		}
	} else if (hasAnthropicStyleData && showWeekly) {
		// Anthropic usage data - show 5-hour, weekly, and any per-model weekly
		// tier (opus, sonnet, and future tiers such as Fable) generically.
		const rows = collectAnthropicUsageRows(
			usageData as unknown as AnthropicUsageData,
			{
				// The flat summary describes its named window, not necessarily 5h.
				utilization:
					usageWindow === "five_hour" ? (usageUtilization ?? null) : null,
				resetTime: usageWindow === "five_hour" ? resetIso : null,
			},
			true,
		);
		// Codex: drop the 5-hour row entirely. Its percentage is either absent or
		// borrowed from the time-elapsed fallback, so the bar showed how much of
		// the window had passed as if it were consumption. The weekly window is
		// what actually limits a Codex account, and it is the only bar kept here.
		usages.push(
			...(isCodex ? rows.filter((row) => row.window !== "five_hour") : rows),
		);
	} else if (
		providerShowsWeeklyUsage(provider) &&
		((usageUtilization !== null && usageUtilization !== undefined) ||
			resetIsoValue(resetIso) != null) &&
		usageWindow &&
		// Never let the 5-hour window back in for Codex through this fallback.
		!(isCodex && usageWindow === "five_hour")
	) {
		// Fallback: show only the most restrictive window
		usages.push({
			utilization: usageUtilization ?? null,
			window: usageWindow,
			resetTime: resetIso,
		});
	} else if (isCodex) {
		// Back door closed: the time-based bar below is hardcoded to a 5-hour
		// window, so without this branch removing the Codex 5h row above would just
		// bring it back through here whenever data is missing. Show the weekly
		// window as unavailable instead — the render path already prints "N/A" and
		// "Data unavailable" for a null utilization.
		usages.push({ utilization: null, window: "seven_day", resetTime: null });
	} else if (provider === "anthropic") {
		usages.push(
			...collectAnthropicUsageRows(undefined, {
				utilization: null,
				resetTime: usageWindow === "five_hour" ? resetIso : null,
			}),
		);
	} else {
		// No quota data: the only evidence is a cooldown reset. Without one there
		// is nothing to show (an elapsed time measured from "now" read as 100%
		// used). With one, the row is time elapsed, not consumption, so it is
		// marked synthetic and never counts as a window at its limit.
		const resetValue = resetIsoValue(resetIso);
		if (resetValue != null) {
			const windowMs = 5 * 60 * 60 * 1000;
			const percentage = Math.min(
				100,
				Math.max(
					0,
					((now - (Date.parse(resetValue) - windowMs)) / windowMs) * 100,
				),
			);
			usages.push({
				utilization: percentage,
				window: null,
				resetTime: resetIso,
				synthetic: true,
			});
		}
	}

	// Codex code-review quota: a flat scalar pair on usageData (NOT a
	// window-shaped object -- see api-usage.ts), rendered as its own row
	// styled like the other window bars. Absent whenever the wham/usage
	// poller hasn't reported it yet or a live-traffic snapshot dropped it.
	if (provider === "codex" && showWeekly && usageData) {
		const codexExtras = usageData as CodexUsageExtras;
		if (
			(typeof codexExtras.code_review_used_percent === "number" &&
				Number.isFinite(codexExtras.code_review_used_percent)) ||
			resetIsoValue(codexExtras.code_review_resets_at) != null
		) {
			usages.push({
				utilization: codexExtras.code_review_used_percent ?? null,
				window: "code_review",
				resetTime: codexExtras.code_review_resets_at ?? null,
				label: "Code Review",
			});
		}
	}

	if (isCodex && !usages.some((row) => row.window === "seven_day")) {
		usages.unshift({ window: "seven_day", utilization: null, resetTime: null });
	}
	return {
		usages: (provider === "anthropic"
			? usages.filter((row) => !row.synthetic)
			: usages
		).map((row) => ({
			...row,
			utilization:
				typeof row.utilization === "number" &&
				Number.isFinite(row.utilization) &&
				row.utilization >= 0
					? row.utilization
					: null,
			resetTime: resetIsoValue(row.resetTime),
		})),
		isNanoGPTData,
		hasAnthropicStyleData,
	};
}
