import { describe, expect, test } from "bun:test";
import { isAnthropicPeakHour, isZaiPeakHour } from "./provider-utils";

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
		// Monday 2026-11-02 14:00 SGT = Monday 06:00 UTC, in peak.
		expect(isZaiPeakHour(Date.parse("2026-11-02T06:00:00Z"))).toBe(true);
	});
});

// Anthropic peak is Monday to Friday 05:00-11:00 in America/Los_Angeles, so
// in UTC the window is 12:00-18:00 during PDT and 13:00-19:00 during PST.
describe("dashboard isAnthropicPeakHour", () => {
	test("follows PDT in summer: 12:00-18:00 UTC", () => {
		// Wednesday 2026-07-15
		expect(isAnthropicPeakHour(Date.parse("2026-07-15T11:59:00Z"))).toBe(false);
		expect(isAnthropicPeakHour(Date.parse("2026-07-15T12:00:00Z"))).toBe(true);
		expect(isAnthropicPeakHour(Date.parse("2026-07-15T17:59:00Z"))).toBe(true);
		expect(isAnthropicPeakHour(Date.parse("2026-07-15T18:00:00Z"))).toBe(false);
		expect(isAnthropicPeakHour(Date.parse("2026-07-15T18:30:00Z"))).toBe(false);
	});

	test("follows PST in winter: 13:00-19:00 UTC", () => {
		// Wednesday 2026-12-02
		expect(isAnthropicPeakHour(Date.parse("2026-12-02T12:59:00Z"))).toBe(false);
		expect(isAnthropicPeakHour(Date.parse("2026-12-02T13:00:00Z"))).toBe(true);
		expect(isAnthropicPeakHour(Date.parse("2026-12-02T18:59:00Z"))).toBe(true);
		expect(isAnthropicPeakHour(Date.parse("2026-12-02T19:00:00Z"))).toBe(false);
	});

	test("is false on Pacific weekends", () => {
		// Saturday 2026-07-18 and Sunday 2026-07-19 at 14:00 UTC
		expect(isAnthropicPeakHour(Date.parse("2026-07-18T14:00:00Z"))).toBe(false);
		expect(isAnthropicPeakHour(Date.parse("2026-07-19T14:00:00Z"))).toBe(false);
	});

	test("takes the weekday in Pacific time, not UTC", () => {
		// Monday 2026-07-13 04:00 UTC is Sunday 21:00 PDT: off-peak either way,
		// but Friday 2026-07-17 17:59 UTC is Friday 10:59 PDT: still peak.
		expect(isAnthropicPeakHour(Date.parse("2026-07-17T17:59:00Z"))).toBe(true);
		// Saturday 2026-07-18 00:00 UTC is Friday 17:00 PDT: a weekday, off hours.
		expect(isAnthropicPeakHour(Date.parse("2026-07-18T00:00:00Z"))).toBe(false);
	});
});
