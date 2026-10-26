import { describe, expect, it } from "bun:test";
import type { SqlWindowSummary } from "@better-ccflare/database";
import {
	EventLoopStallMonitor,
	type EventLoopStallReport,
	formatEventLoopStallReport,
} from "./event-loop-stall-monitor";

const EMPTY_SQL: SqlWindowSummary = { count: 0, totalMs: 0, top: [] };

function harness(sqlWindows: Array<SqlWindowSummary | null> = []) {
	let t = 0;
	let uptime = 60_000;
	const reports: EventLoopStallReport[] = [];
	let drains = 0;
	const monitor = new EventLoopStallMonitor({
		intervalMs: 1000,
		stallThresholdMs: 250,
		sqlSaturationMs: 500,
		now: () => t,
		uptimeMs: () => uptime,
		drainSql: () => {
			drains++;
			return sqlWindows.shift() ?? EMPTY_SQL;
		},
		report: (report) => reports.push(report),
	});
	return {
		monitor,
		reports,
		drains: () => drains,
		advance(ms: number) {
			t += ms;
			uptime += ms;
		},
	};
}

describe("EventLoopStallMonitor", () => {
	it("discards the SQL window that built up before it started", () => {
		const startupMigrations: SqlWindowSummary = {
			count: 40,
			totalMs: 9_000,
			top: [
				{
					fingerprint: "ALTER TABLE x",
					count: 1,
					totalMs: 9_000,
					maxMs: 9_000,
				},
			],
		};
		const h = harness([startupMigrations]);
		h.monitor.start();
		h.advance(1000);
		h.monitor.tick();
		h.monitor.stop();
		expect(h.drains()).toBe(2);
		expect(h.reports).toEqual([]);
	});

	it("reports a late tick with its lag, start time and the SQL that ran in it", () => {
		const sql: SqlWindowSummary = {
			count: 412,
			totalMs: 21_877,
			top: [
				{
					fingerprint: "DELETE FROM requests WHERE timestamp < ?",
					count: 1,
					totalMs: 20_512,
					maxMs: 20_512,
				},
			],
		};
		const h = harness([EMPTY_SQL, sql]);
		h.monitor.start();
		h.advance(23_140);
		h.monitor.tick();
		h.monitor.stop();
		expect(h.reports).toEqual([
			{
				lagMs: 22_140,
				tickMs: 23_140,
				// Process uptime when the tick that ran long began.
				uptimeAtStartSec: 60,
				stalled: true,
				sql,
			},
		]);
	});

	it("stays quiet for an on-time tick with little SQL", () => {
		const h = harness([
			EMPTY_SQL,
			{
				count: 3,
				totalMs: 40,
				top: [{ fingerprint: "SELECT 1", count: 3, totalMs: 40, maxMs: 20 }],
			},
		]);
		h.monitor.start();
		h.advance(1_249);
		h.monitor.tick();
		h.monitor.stop();
		expect(h.reports).toEqual([]);
	});

	it("reports SQL saturation even when each task yields and the tick is on time", () => {
		const busy: SqlWindowSummary = {
			count: 60,
			totalMs: 640,
			top: [
				{
					fingerprint: "SELECT * FROM accounts",
					count: 60,
					totalMs: 640,
					maxMs: 15,
				},
			],
		};
		const h = harness([EMPTY_SQL, busy]);
		h.monitor.start();
		h.advance(1_010);
		h.monitor.tick();
		h.monitor.stop();
		expect(h.reports).toHaveLength(1);
		expect(h.reports[0]?.stalled).toBe(false);
		expect(h.reports[0]?.sql).toEqual(busy);
	});

	it("measures each tick from the previous one, not from start", () => {
		const h = harness();
		h.monitor.start();
		h.advance(1_000);
		h.monitor.tick();
		h.advance(1_600);
		h.monitor.tick();
		h.monitor.stop();
		expect(h.reports.map((report) => report.lagMs)).toEqual([600]);
	});

	it("still reports a stall when SQL timing is unavailable or its drain throws", () => {
		let calls = 0;
		const reports: EventLoopStallReport[] = [];
		let t = 0;
		const monitor = new EventLoopStallMonitor({
			intervalMs: 1000,
			stallThresholdMs: 250,
			sqlSaturationMs: 500,
			now: () => t,
			uptimeMs: () => 5_000 + t,
			drainSql: () => {
				calls++;
				if (calls === 2) return null;
				throw new Error("drain unavailable");
			},
			report: (report) => reports.push(report),
		});
		monitor.start();
		t += 2_000;
		monitor.tick();
		t += 3_000;
		monitor.tick();
		monitor.stop();
		expect(reports.map((report) => [report.lagMs, report.sql])).toEqual([
			[1_000, null],
			[2_000, null],
		]);
	});
});

describe("formatEventLoopStallReport", () => {
	it("names the stall, when it began and the heaviest statements", () => {
		expect(
			formatEventLoopStallReport({
				lagMs: 22_140.4,
				tickMs: 23_140.4,
				uptimeAtStartSec: 31.24,
				stalled: true,
				sql: {
					count: 412,
					totalMs: 21_877.2,
					top: [
						{
							fingerprint: "DELETE FROM requests WHERE timestamp < ?",
							count: 1,
							totalMs: 20_512.3,
							maxMs: 20_512.3,
						},
						{
							fingerprint: "INSERT INTO requests VALUES (?)",
							count: 300,
							totalMs: 900,
							maxMs: 12,
						},
					],
				},
			}),
		).toBe(
			"Event loop stall: 22140ms late (tick took 23140ms, began 31.2s after process start); " +
				"main-thread SQL in that tick: 412 statements, 21877ms; " +
				"top: 20512ms ×1 (max 20512ms) DELETE FROM requests WHERE timestamp < ? | " +
				"900ms ×300 (max 12ms) INSERT INTO requests VALUES (?)",
		);
	});

	it("labels saturation without a stall and says when SQL was not measured", () => {
		expect(
			formatEventLoopStallReport({
				lagMs: 10,
				tickMs: 1_010,
				uptimeAtStartSec: 100,
				stalled: false,
				sql: { count: 60, totalMs: 640, top: [] },
			}),
		).toBe(
			"Main-thread SQL saturation: 10ms late (tick took 1010ms, began 100.0s after process start); " +
				"main-thread SQL in that tick: 60 statements, 640ms",
		);
		expect(
			formatEventLoopStallReport({
				lagMs: 1_000,
				tickMs: 2_000,
				uptimeAtStartSec: 5,
				stalled: true,
				sql: null,
			}),
		).toBe(
			"Event loop stall: 1000ms late (tick took 2000ms, began 5.0s after process start); main-thread SQL not measured",
		);
	});
});
