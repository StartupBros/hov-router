import { describe, expect, test } from "bun:test";
import { isZaiPeakHour } from "../auto-refresh-scheduler";

// Z.ai peak is Monday to Friday 14:00-18:00 Singapore time (UTC+8). The
// weekday is the Singapore weekday, so it is taken after the +8h shift.
describe("isZaiPeakHour", () => {
	test("is true on a weekday inside 14:00-18:00 SGT", () => {
		// Friday 2026-10-30 15:00 SGT = 07:00 UTC
		expect(isZaiPeakHour(Date.parse("2026-10-30T07:00:00Z"))).toBe(true);
	});

	test("is false on a Saturday inside 14:00-18:00 SGT", () => {
		// Saturday 2026-10-31 15:00 SGT = 07:00 UTC
		expect(isZaiPeakHour(Date.parse("2026-10-31T07:00:00Z"))).toBe(false);
	});

	test("is false on a Sunday inside 14:00-18:00 SGT", () => {
		// Sunday 2026-11-01 15:00 SGT = 07:00 UTC
		expect(isZaiPeakHour(Date.parse("2026-11-01T07:00:00Z"))).toBe(false);
	});

	test("is false outside the hour window on a weekday", () => {
		// Friday 13:59 SGT and 18:00 SGT
		expect(isZaiPeakHour(Date.parse("2026-10-30T05:59:00Z"))).toBe(false);
		expect(isZaiPeakHour(Date.parse("2026-10-30T10:00:00Z"))).toBe(false);
	});

	test("takes the weekday after the +8h shift, not the UTC weekday", () => {
		// Sunday 17:00 UTC is Monday 01:00 SGT: weekday, but outside the hours.
		expect(isZaiPeakHour(Date.parse("2026-11-01T17:00:00Z"))).toBe(false);
		// Friday 16:00 UTC is Saturday 00:00 SGT: weekend.
		expect(isZaiPeakHour(Date.parse("2026-10-30T16:00:00Z"))).toBe(false);
		// Monday 2026-11-02 14:00 SGT = Monday 06:00 UTC, in peak.
		expect(isZaiPeakHour(Date.parse("2026-11-02T06:00:00Z"))).toBe(true);
	});
});
