import { describe, expect, test } from "bun:test";
import {
	buildCacheParityDriftReport,
	CACHE_PARITY_ACKNOWLEDGED_DEVIATIONS,
	CACHE_PARITY_DECLARED_DEFAULTS,
} from "../cache-parity-expectations";

describe("buildCacheParityDriftReport", () => {
	test("reports no deviations when the live policy matches declared defaults", () => {
		const report = buildCacheParityDriftReport(CACHE_PARITY_DECLARED_DEFAULTS);
		expect(report.deviations).toEqual([]);
		expect(report.declaredDefaults).toEqual(CACHE_PARITY_DECLARED_DEFAULTS);
	});

	test("removed turnStatePercent at its constant has no drift", () => {
		const report = buildCacheParityDriftReport({
			...CACHE_PARITY_DECLARED_DEFAULTS,
			turnStatePercent: 0,
			turnStateObserveOnly: false,
		});
		expect(
			report.deviations.find(
				(deviation) => deviation.lever === "turnStatePercent",
			),
		).toBeUndefined();
		expect(report.deviations).toEqual([]);
	});

	test("an undeclared deviation reports as unacknowledged", () => {
		const report = buildCacheParityDriftReport({
			...CACHE_PARITY_DECLARED_DEFAULTS,
			webSocketPercent: 25,
		});
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
			const report = buildCacheParityDriftReport({
				...CACHE_PARITY_DECLARED_DEFAULTS,
				webSocketPercent: 25,
			});
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
		const report = buildCacheParityDriftReport({
			...CACHE_PARITY_DECLARED_DEFAULTS,
			explicitBreakpointSuppressedScopes: 26,
		});
		expect(
			report.deviations.some(
				(deviation) =>
					// @ts-expect-error — deliberately probing an excluded key
					deviation.lever === "explicitBreakpointSuppressedScopes",
			),
		).toBe(false);
	});

	test("reports only declared defaults and deviations", () => {
		// The 75% / 12% parity floor and its floorHeld flag were removed:
		// nothing read them.
		const report = buildCacheParityDriftReport(CACHE_PARITY_DECLARED_DEFAULTS);
		expect(Object.keys(report).sort()).toEqual([
			"declaredDefaults",
			"deviations",
		]);
	});
});
