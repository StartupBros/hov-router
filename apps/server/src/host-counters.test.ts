import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import {
	createHostCounterReader,
	diffHostCounters,
	type HostCounters,
} from "./host-counters";

const PROC_SCHEDSTAT = "/proc/thread-self/schedstat";

const PROC: Record<string, string> = {
	[PROC_SCHEDSTAT]: "31200000000 30000000 4567\n",
	// The command name can hold spaces and parentheses; fields count from the last ')'.
	"/proc/thread-self/stat":
		"2468140 (bun (main) x) S 1 2 3 0 -1 4194304 15041 0 171 0 5 8 0 0 25 5\n",
	"/proc/pressure/cpu":
		"some avg10=0.04 avg60=0.22 avg300=0.22 total=108198989682\n" +
		"full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
	"/proc/pressure/memory":
		"some avg10=0.26 avg60=1.03 avg300=1.13 total=65438374373\n" +
		"full avg10=0.26 avg60=1.01 avg300=1.11 total=60878003195\n",
	"/proc/pressure/io":
		"some avg10=4.89 avg60=6.50 avg300=5.15 total=153124667151\n" +
		"full avg10=4.61 avg60=6.13 avg300=4.89 total=136642742392\n",
};

describe("createHostCounterReader", () => {
	it("reads main-thread CPU, faults and host pressure as running totals in ms", () => {
		const read = createHostCounterReader((path) => {
			const text = PROC[path];
			if (text === undefined) throw new Error(`ENOENT ${path}`);
			return text;
		});
		expect(read()).toEqual({
			threadCpuMs: 31_200,
			threadWaitMs: 30,
			threadMajorFaults: 171,
			cpuSomeMs: 108_198_989.682,
			memorySomeMs: 65_438_374.373,
			memoryFullMs: 60_878_003.195,
			ioSomeMs: 153_124_667.151,
			ioFullMs: 136_642_742.392,
		});
	});

	it("stops reading a file that failed once and returns null when none are left", () => {
		const reads: string[] = [];
		const read = createHostCounterReader((path) => {
			reads.push(path);
			if (path.startsWith("/proc/pressure/")) throw new Error("ENOENT");
			if (path === "/proc/thread-self/stat") return "garbage";
			return PROC[path] ?? "";
		});
		expect(read()).toEqual({ threadCpuMs: 31_200, threadWaitMs: 30 });
		expect(read()).toEqual({ threadCpuMs: 31_200, threadWaitMs: 30 });
		expect(reads.filter((path) => path !== PROC_SCHEDSTAT)).toHaveLength(4);

		const nothing = createHostCounterReader(() => {
			throw new Error("ENOENT");
		});
		expect(nothing()).toBeNull();
		expect(nothing()).toBeNull();
	});

	it("reads this host's own counters where /proc has them", () => {
		const counters = createHostCounterReader()();
		if (existsSync(PROC_SCHEDSTAT)) {
			expect(counters?.threadCpuMs).toBeGreaterThan(0);
			expect(counters?.threadWaitMs).toBeGreaterThanOrEqual(0);
		}
		if (existsSync("/proc/thread-self/stat")) {
			expect(counters?.threadMajorFaults).toBeGreaterThanOrEqual(0);
		}
		if (existsSync("/proc/pressure/io")) {
			expect(counters?.ioSomeMs).toBeGreaterThanOrEqual(0);
		}
		if (!existsSync("/proc")) expect(counters).toBeNull();
	});
});

describe("diffHostCounters", () => {
	it("returns how much each counter grew, leaving out counters either side lacks", () => {
		const before: HostCounters = {
			threadCpuMs: 1_000,
			threadWaitMs: 5,
			threadMajorFaults: 10,
			ioSomeMs: 2_000,
		};
		const after: HostCounters = {
			threadCpuMs: 3_100,
			threadWaitMs: 35,
			threadMajorFaults: 1_210,
			ioSomeMs: 2_900,
			ioFullMs: 850,
		};
		expect(diffHostCounters(before, after)).toEqual({
			threadCpuMs: 2_100,
			threadWaitMs: 30,
			threadMajorFaults: 1_200,
			ioSomeMs: 900,
		});
	});
});
