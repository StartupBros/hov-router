import { describe, expect, test } from "bun:test";
import { isZaiPeakHour } from "./provider-utils";

describe("dashboard isZaiPeakHour", () => {
	test("is true on a weekday inside 14:00-18:00 SGT", () => {
		// Friday 2026-10-30 15:00 SGT = 07:00 UTC
		expect(isZaiPeakHour(Date.parse("2026-10-30T07:00:00Z"))).toBe(true);
	});

	test("is false on a Saturday and a Sunday inside 14:00-18:00 SGT", () => {
		expect(isZaiPeakHour(Date.parse("2026-10-31T07:00:00Z"))).toBe(false);
		expect(isZaiPeakHour(Date.parse("2026-11-01T07:00:00Z"))).toBe(false);
	});

	test("takes the weekday after the +8h shift", () => {
		// Friday 2026-10-30 16:00 UTC is Saturday 00:00 SGT, and Sunday 17:00 UTC
		// is Monday 01:00 SGT; both are outside the hours either way, so probe the
		// edge that matters: Monday 14:00 SGT = Monday 06:00 UTC is peak.
		expect(isZaiPeakHour(Date.parse("2026-11-02T06:00:00Z"))).toBe(true);
	});
});
