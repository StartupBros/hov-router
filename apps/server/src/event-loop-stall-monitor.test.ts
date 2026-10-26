import { describe, expect, it } from "bun:test";
import type { SqlWindowSummary } from "@better-ccflare/database";
import {
	EventLoopStallMonitor,
	type EventLoopStallReport,
	formatEventLoopStallReport,
} from "./event-loop-stall-monitor";
import type { HostCounters } from "./host-counters";

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
				host: null,
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

	it("reports how much the main-thread and host counters grew over the stalled tick", () => {
		let t = 0;
		const samples: Array<HostCounters | null> = [
			{ threadCpuMs: 1_000, threadMajorFaults: 10, ioSomeMs: 5_000 },
			{ threadCpuMs: 1_400, threadMajorFaults: 12, ioSomeMs: 5_010 },
			{ threadCpuMs: 3_500, threadMajorFaults: 1_212, ioSomeMs: 35_010 },
		];
		const reports: EventLoopStallReport[] = [];
		const monitor = new EventLoopStallMonitor({
			intervalMs: 1000,
			now: () => t,
			uptimeMs: () => t,
			drainSql: () => EMPTY_SQL,
			sampleHost: () => samples.shift() ?? null,
			report: (report) => reports.push(report),
		});
		monitor.start();
		// An on-time tick still advances the baseline the stall is measured from.
		t += 1_000;
		monitor.tick();
		t += 31_000;
		monitor.tick();
		monitor.stop();
		expect(reports).toHaveLength(1);
		expect(reports[0]?.host).toEqual({
			threadCpuMs: 2_100,
			threadMajorFaults: 1_200,
			ioSomeMs: 30_000,
		});
	});

	it("reports no host figures when the sampler is missing, empty or throws", () => {
		let t = 0;
		let calls = 0;
		const reports: EventLoopStallReport[] = [];
		const monitor = new EventLoopStallMonitor({
			intervalMs: 1000,
			now: () => t,
			uptimeMs: () => t,
			drainSql: () => EMPTY_SQL,
			sampleHost: () => {
				calls++;
				if (calls === 2) throw new Error("procfs gone");
				if (calls === 3) return null;
				return { threadCpuMs: calls * 100 };
			},
			report: (report) => reports.push(report),
		});
		monitor.start();
		for (let i = 0; i < 3; i++) {
			t += 2_000;
			monitor.tick();
		}
		monitor.stop();
		// Each tick needs a sample at both ends; a failed one blanks two windows.
		expect(reports.map((report) => report.host)).toEqual([null, null, null]);

		const h = harness([EMPTY_SQL]);
		h.monitor.start();
		h.advance(2_000);
		h.monitor.tick();
		h.monitor.stop();
		expect(h.reports[0]?.host).toBeNull();
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
				host: null,
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
				host: null,
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
				host: null,
			}),
		).toBe(
			"Event loop stall: 1000ms late (tick took 2000ms, began 5.0s after process start); main-thread SQL not measured",
		);
	});

	it("says where the main thread's time went and what the host was stalled on", () => {
		expect(
			formatEventLoopStallReport({
				lagMs: 33_140,
				tickMs: 34_140,
				uptimeAtStartSec: 1_234.5,
				stalled: true,
				sql: { count: 1, totalMs: 31_410, top: [] },
				host: {
					threadCpuMs: 2_100.4,
					threadWaitMs: 30,
					threadMajorFaults: 1_200,
					cpuSomeMs: 5.2,
					memorySomeMs: 300,
					memoryFullMs: 280,
					ioSomeMs: 900,
					ioFullMs: 850,
				},
			}),
		).toBe(
			"Event loop stall: 33140ms late (tick took 34140ms, began 1234.5s after process start); " +
				"main-thread SQL in that tick: 1 statements, 31410ms; " +
				"main thread: 2100ms on CPU, 30ms waiting for a CPU, 32010ms off CPU, 1200 major faults; " +
				"host stalled on io 900ms (all tasks 850ms), memory 300ms (all tasks 280ms), cpu 5ms",
		);
	});

	it("prints only the host figures it has", () => {
		const base = {
			lagMs: 1_000,
			tickMs: 2_000,
			uptimeAtStartSec: 5,
			stalled: true,
			sql: null,
		};
		expect(
			formatEventLoopStallReport({
				...base,
				host: { ioSomeMs: 1_500, memorySomeMs: 0 },
			}),
		).toBe(
			"Event loop stall: 1000ms late (tick took 2000ms, began 5.0s after process start); " +
				"main-thread SQL not measured; host stalled on io 1500ms, memory 0ms",
		);
		expect(
			formatEventLoopStallReport({
				...base,
				host: { threadCpuMs: 1_900, threadMajorFaults: 0 },
			}),
		).toBe(
			"Event loop stall: 1000ms late (tick took 2000ms, began 5.0s after process start); " +
				"main-thread SQL not measured; main thread: 1900ms on CPU, 0 major faults",
		);
		expect(formatEventLoopStallReport({ ...base, host: {} })).toBe(
			"Event loop stall: 1000ms late (tick took 2000ms, began 5.0s after process start); " +
				"main-thread SQL not measured",
		);
	});
});
