import { describe, expect, test } from "bun:test";
import type { CacheParityMetrics } from "@better-ccflare/types";
import {
	buildCacheParityDriftReport,
	CACHE_PARITY_ACKNOWLEDGED_DEVIATIONS,
	CACHE_PARITY_DECLARED_DEFAULTS,
	CACHE_PARITY_DECLARED_FLOOR,
} from "../cache-parity-expectations";

function metrics(
	partial: Partial<CacheParityMetrics> = {},
): CacheParityMetrics {
	return {
		totalRequests: 1_000,
		successfulRequests: 1_000,
		successRatePercent: 100,
		fallbackRequests: 0,
		fallbackRatePercent: 0,
		contextOverflowRequests: 0,
		contextOverflowRatePercent: 0,
		measuredResponses: 1_000,
		unavailableResponses: 0,
		totalInputTokens: 20_000_000,
		cacheReadInputTokens: 15_800_000,
		weightedCacheReadPercent: 79,
		medianCacheReadPercent: 79,
		p25CacheReadPercent: 70,
		p75CacheReadPercent: 88,
		positiveHitResponses: 909,
		positiveHitRatePercent: 90.9,
		zeroHitResponses: 91,
		zeroHitRatePercent: 9.1,
		...partial,
	};
}

describe("buildCacheParityDriftReport", () => {
	test("reports no deviations when the live policy matches declared defaults", () => {
		const report = buildCacheParityDriftReport(
			CACHE_PARITY_DECLARED_DEFAULTS,
			metrics(),
		);
		expect(report.deviations).toEqual([]);
		expect(report.declaredDefaults).toEqual(CACHE_PARITY_DECLARED_DEFAULTS);
	});

	test("removed turnStatePercent at its constant has no drift", () => {
		const report = buildCacheParityDriftReport(
			{
				...CACHE_PARITY_DECLARED_DEFAULTS,
				turnStatePercent: 0,
				turnStateObserveOnly: false,
			},
			metrics(),
		);
		expect(
			report.deviations.find(
				(deviation) => deviation.lever === "turnStatePercent",
			),
		).toBeUndefined();
		expect(report.deviations).toEqual([]);
	});

	test("an undeclared deviation reports as unacknowledged", () => {
		const report = buildCacheParityDriftReport(
			{ ...CACHE_PARITY_DECLARED_DEFAULTS, webSocketPercent: 25 },
			metrics(),
		);
		const entry = report.deviations.find(
			(deviation) => deviation.lever === "webSocketPercent",
		);
		expect(entry).toBeDefined();
		expect(entry?.acknowledged).toBe(false);
		expect(entry?.acknowledgement).toBeNull();
	});

	test("a deviation listed in the acknowledgement map reports as acknowledged", () => {
		// The map ships empty since turn-state replay (#199) was removed, so add
		// one entry for this test and remove it again afterwards.
		const acknowledgement = { issue: 730, note: "test-only acknowledgement" };
		CACHE_PARITY_ACKNOWLEDGED_DEVIATIONS.webSocketPercent = acknowledgement;
		try {
			const report = buildCacheParityDriftReport(
				{ ...CACHE_PARITY_DECLARED_DEFAULTS, webSocketPercent: 25 },
				metrics(),
			);
			const entry = report.deviations.find(
				(deviation) => deviation.lever === "webSocketPercent",
			);
			expect(entry?.acknowledged).toBe(true);
			expect(entry?.acknowledgement).toEqual(acknowledgement);
		} finally {
			delete CACHE_PARITY_ACKNOWLEDGED_DEVIATIONS.webSocketPercent;
		}
		expect(CACHE_PARITY_ACKNOWLEDGED_DEVIATIONS).toEqual({});
	});

	test("excludes the explicitBreakpointSuppressedScopes counter from drift, even when nonzero", () => {
		const report = buildCacheParityDriftReport(
			{
				...CACHE_PARITY_DECLARED_DEFAULTS,
				explicitBreakpointSuppressedScopes: 26,
			},
			metrics(),
		);
		expect(
			report.deviations.some(
				(deviation) =>
					// @ts-expect-error — deliberately probing an excluded key
					deviation.lever === "explicitBreakpointSuppressedScopes",
			),
		).toBe(false);
	});

	test("reports the floor as held when Codex follow-up metrics meet it", () => {
		const report = buildCacheParityDriftReport(
			CACHE_PARITY_DECLARED_DEFAULTS,
			metrics({ weightedCacheReadPercent: 79.1, zeroHitRatePercent: 9.1 }),
		);
		expect(report.floor).toEqual(CACHE_PARITY_DECLARED_FLOOR);
		expect(report.floorHeld).toBe(true);
	});

	test("reports a floor breach when weighted cache-read regresses below the floor", () => {
		const report = buildCacheParityDriftReport(
			CACHE_PARITY_DECLARED_DEFAULTS,
			metrics({ weightedCacheReadPercent: 60, zeroHitRatePercent: 9 }),
		);
		expect(report.floorHeld).toBe(false);
	});

	test("reports a floor breach when the zero-hit rate regresses above the ceiling", () => {
		const report = buildCacheParityDriftReport(
			CACHE_PARITY_DECLARED_DEFAULTS,
			metrics({ weightedCacheReadPercent: 85, zeroHitRatePercent: 15 }),
		);
		expect(report.floorHeld).toBe(false);
	});

	test("holds at exactly the declared floor (75% weighted, 12% zero-hit)", () => {
		const report = buildCacheParityDriftReport(
			CACHE_PARITY_DECLARED_DEFAULTS,
			metrics({ weightedCacheReadPercent: 75, zeroHitRatePercent: 12 }),
		);
		expect(report.floor).toEqual({
			weightedCacheReadPercent: 75,
			zeroHitRatePercent: 12,
		});
		expect(report.floorHeld).toBe(true);
	});

	test("breaches just below the declared weighted floor (74.9% < 75%)", () => {
		const report = buildCacheParityDriftReport(
			CACHE_PARITY_DECLARED_DEFAULTS,
			metrics({ weightedCacheReadPercent: 74.9, zeroHitRatePercent: 9.1 }),
		);
		expect(report.floorHeld).toBe(false);
	});

	test("breaches just above the declared zero-hit ceiling (12.1% > 12%)", () => {
		const report = buildCacheParityDriftReport(
			CACHE_PARITY_DECLARED_DEFAULTS,
			metrics({ weightedCacheReadPercent: 79.1, zeroHitRatePercent: 12.1 }),
		);
		expect(report.floorHeld).toBe(false);
	});

	test("does not report the floor as held when Codex has no qualified follow-up metrics", () => {
		const report = buildCacheParityDriftReport(
			CACHE_PARITY_DECLARED_DEFAULTS,
			undefined,
		);
		expect(report.floorHeld).toBe(false);
	});
});
