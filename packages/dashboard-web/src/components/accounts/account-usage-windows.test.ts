import { expect, test } from "bun:test";
import type { FullUsageData } from "@better-ccflare/types";
import { accountUsageWindows } from "./account-usage-windows";

const reset = "2030-01-01T00:00:00.000Z";
function rows(data: unknown, compact: boolean, provider = "anthropic") {
	return accountUsageWindows({
		provider,
		resetIso: reset,
		usageWindow: "seven_day",
		usageUtilization: 55,
		usageData: data as FullUsageData,
		showWeekly: true,
		compact,
	}).usages;
}
test("weekly-only evidence is identical in both layouts without synthetic 5h", () => {
	const data = { seven_day: { utilization: 55, resets_at: reset } };
	expect(rows(data, false)).toEqual(rows(data, true));
	expect(rows(data, false).map((r) => r.window)).toEqual(["seven_day"]);
});
test("reported unknown and invalid generic limits retain identity and resets", () => {
	for (const percent of [null, -1, NaN, Infinity]) {
		const data = {
			limits: [
				{ kind: "weekly_all", percent, resets_at: reset, is_active: false },
			],
			five_hour: { utilization: 5, resets_at: reset },
		};
		for (const compact of [false, true])
			expect(rows(data, compact)).toMatchObject([
				{ window: "seven_day", utilization: null, resetTime: reset },
			]);
	}
});
test("empty or unrecognized generic rows fall back, code review reset-only remains", () => {
	expect(
		rows(
			{ limits: [], seven_day: { utilization: 20, resets_at: reset } },
			false,
		).map((r) => r.window),
	).toEqual(["seven_day"]);
	const data = {
		seven_day: { utilization: 25, resets_at: reset },
		code_review_used_percent: null,
		code_review_resets_at: reset,
	};
	expect(rows(data, false, "codex")).toEqual(rows(data, true, "codex"));
	expect(
		rows(data, false, "codex").find((r) => r.window === "code_review")
			?.resetTime,
	).toBe(reset);
});
test("providers the router never polls get no invented usage row without a reset", () => {
	const now = Date.parse("2029-12-31T22:00:00.000Z");
	for (const provider of [
		"openai-compatible",
		"openrouter",
		"anthropic-compatible",
	])
		expect(
			accountUsageWindows({ provider, resetIso: null }, now).usages,
		).toEqual([]);
});
test("an elapsed-time row from a cooldown reset is marked synthetic, never a quota window", () => {
	const now = Date.parse("2029-12-31T22:00:00.000Z");
	const { usages } = accountUsageWindows(
		{ provider: "openai-compatible", resetIso: reset },
		now,
	);
	expect(usages).toHaveLength(1);
	expect(usages[0]).toMatchObject({
		window: null,
		synthetic: true,
		resetTime: reset,
	});
});
