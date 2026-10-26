import { readFileSync } from "node:fs";

/**
 * Running Linux totals that say what held the main thread during an event-loop
 * stall (#606). The stall monitor samples them every tick and reports how much
 * each grew over a stalled one. A counter is absent when its /proc file is.
 */
export interface HostCounters {
	/** Main thread time on a CPU (/proc/thread-self/schedstat), ms. */
	threadCpuMs?: number;
	/** Main thread time runnable but waiting for a CPU, ms. */
	threadWaitMs?: number;
	/** Main thread page faults that read a page back from disk or swap. */
	threadMajorFaults?: number;
	/** Host time with at least one task stalled on CPU (/proc/pressure), ms. */
	cpuSomeMs?: number;
	/** Host time with at least one task stalled on memory reclaim or swap-in, ms. */
	memorySomeMs?: number;
	/** Host time with every runnable task stalled on memory, ms. */
	memoryFullMs?: number;
	/** Host time with at least one task waiting on disk, ms. */
	ioSomeMs?: number;
	/** Host time with every runnable task waiting on disk, ms. */
	ioFullMs?: number;
}

const COUNTER_KEYS = [
	"threadCpuMs",
	"threadWaitMs",
	"threadMajorFaults",
	"cpuSomeMs",
	"memorySomeMs",
	"memoryFullMs",
	"ioSomeMs",
	"ioFullMs",
] as const satisfies ReadonlyArray<keyof HostCounters>;

interface CounterSource {
	path: string;
	parse: (text: string, into: HostCounters) => void;
}

function fields(text: string, minimum: number): number[] {
	const values = text.trim().split(/\s+/).map(Number);
	if (
		values.length < minimum ||
		values.some((value) => !Number.isFinite(value))
	)
		throw new Error("unexpected format");
	return values;
}

function pressureTotalMs(text: string, kind: "some" | "full"): number {
	const match = new RegExp(`^${kind} .*\\btotal=(\\d+)`, "m").exec(text);
	if (!match) throw new Error(`no ${kind} line`);
	return Number(match[1]) / 1000;
}

const SOURCES: readonly CounterSource[] = [
	{
		// "<ns on cpu> <ns waiting on a runqueue> <timeslices>"
		path: "/proc/thread-self/schedstat",
		parse: (text, into) => {
			const [cpuNs, waitNs] = fields(text, 2);
			into.threadCpuMs = (cpuNs as number) / 1e6;
			into.threadWaitMs = (waitNs as number) / 1e6;
		},
	},
	{
		// Fields after the command name, which can hold spaces and ')', start at
		// field 3 (state); majflt is field 12.
		path: "/proc/thread-self/stat",
		parse: (text, into) => {
			const afterName = text.slice(text.lastIndexOf(")") + 1);
			const majflt = afterName.trim().split(/\s+/)[9];
			if (
				text.lastIndexOf(")") < 0 ||
				majflt === undefined ||
				!/^\d+$/.test(majflt)
			)
				throw new Error("unexpected format");
			into.threadMajorFaults = Number(majflt);
		},
	},
	{
		path: "/proc/pressure/cpu",
		parse: (text, into) => {
			into.cpuSomeMs = pressureTotalMs(text, "some");
		},
	},
	{
		path: "/proc/pressure/memory",
		parse: (text, into) => {
			into.memorySomeMs = pressureTotalMs(text, "some");
			into.memoryFullMs = pressureTotalMs(text, "full");
		},
	},
	{
		path: "/proc/pressure/io",
		parse: (text, into) => {
			into.ioSomeMs = pressureTotalMs(text, "some");
			into.ioFullMs = pressureTotalMs(text, "full");
		},
	},
];

/**
 * Returns a sampler of the counters this host has. A file that fails to read or
 * parse once (no /proc, a kernel without pressure stall information) is not
 * read again; the sampler returns null once none are left.
 */
export function createHostCounterReader(
	readText: (path: string) => string = (path) => readFileSync(path, "utf8"),
): () => HostCounters | null {
	let live = [...SOURCES];
	return () => {
		if (live.length === 0) return null;
		const counters: HostCounters = {};
		const failed: CounterSource[] = [];
		for (const source of live) {
			const partial: HostCounters = {};
			try {
				source.parse(readText(source.path), partial);
				Object.assign(counters, partial);
			} catch {
				failed.push(source);
			}
		}
		if (failed.length > 0) {
			live = live.filter((source) => !failed.includes(source));
			if (live.length === 0) return null;
		}
		return counters;
	};
}

/** How much each counter grew; counters missing from either sample are left out. */
export function diffHostCounters(
	before: HostCounters,
	after: HostCounters,
): HostCounters {
	const grown: HostCounters = {};
	for (const key of COUNTER_KEYS) {
		const start = before[key];
		const end = after[key];
		if (start !== undefined && end !== undefined)
			grown[key] = Math.max(0, end - start);
	}
	return grown;
}
