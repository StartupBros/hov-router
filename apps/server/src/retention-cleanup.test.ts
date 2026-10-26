import { describe, expect, it, mock } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import type { Logger } from "@better-ccflare/logger";
import {
	describeRetentionSweepStop,
	RETENTION_PAUSE_MAX_MS,
	RETENTION_PAUSE_MIN_MS,
	RetentionSweepPacer,
	RetentionSweeps,
	retentionPauseMs,
	scheduleAdaptiveVacuumAfterRetentionCleanup,
	sleepUnlessAborted,
} from "./retention-cleanup";

function fakeClock() {
	const sleeps: number[] = [];
	const clock = {
		at: 0,
		now: () => clock.at,
		sleep: async (ms: number, _signal: AbortSignal) => {
			sleeps.push(ms);
			clock.at += ms;
		},
	};
	return { clock, sleeps };
}

describe("retentionPauseMs", () => {
	it("pauses at least the minimum, five batch-lengths after a slow batch, and never past the cap", () => {
		expect(RETENTION_PAUSE_MIN_MS).toBe(150);
		expect(RETENTION_PAUSE_MAX_MS).toBe(2_000);
		expect(retentionPauseMs(0)).toBe(150);
		expect(retentionPauseMs(20)).toBe(150);
		expect(retentionPauseMs(40)).toBe(200);
		expect(retentionPauseMs(197)).toBe(985);
		expect(retentionPauseMs(1_670)).toBe(2_000);
	});
});

describe("RetentionSweepPacer", () => {
	it("pauses after each batch and refuses once the budget is spent, for every later table too", async () => {
		const { clock, sleeps } = fakeClock();
		const pacer = new RetentionSweepPacer(
			new AbortController().signal,
			1_000,
			clock,
		);

		expect(pacer.mayRunBatch("requests")).toBe(true);
		await pacer.afterBatch("requests", 10);
		expect(pacer.mayRunBatch("requests")).toBe(true);
		await pacer.afterBatch("requests", 160);
		expect(sleeps).toEqual([150, 800]);
		expect(pacer.mayRunBatch("requests")).toBe(true);
		clock.at = 1_000;
		expect(pacer.mayRunBatch("requests")).toBe(false);
		expect(pacer.mayRunBatch("routing_attempts")).toBe(false);
		expect(pacer.stoppedBy).toBe("budget");
		expect(pacer.stoppedIn).toBe("requests");
	});

	it("refuses the next batch once its signal aborts", () => {
		const { clock } = fakeClock();
		const abort = new AbortController();
		const pacer = new RetentionSweepPacer(abort.signal, 1_000, clock);

		expect(pacer.mayRunBatch("request_payloads")).toBe(true);
		abort.abort();
		expect(pacer.mayRunBatch("request_payloads")).toBe(false);
		expect(pacer.stoppedBy).toBe("stopped");
		expect(pacer.stoppedIn).toBe("request_payloads");
	});
});

describe("describeRetentionSweepStop", () => {
	it("names the reason and table only when the sweep stopped early", () => {
		const { clock } = fakeClock();
		const abort = new AbortController();
		const pacer = new RetentionSweepPacer(abort.signal, 1_000, clock);
		expect(describeRetentionSweepStop(pacer)).toBeNull();

		clock.at = 1_000;
		pacer.mayRunBatch("usage_snapshots");
		expect(describeRetentionSweepStop(pacer)).toBe(
			"Retention sweep used its 1000ms budget in usage_snapshots; the next sweep continues",
		);

		const stopped = new RetentionSweepPacer(abort.signal, 1_000, clock);
		abort.abort();
		stopped.mayRunBatch("requests");
		expect(describeRetentionSweepStop(stopped)).toBe(
			"Retention sweep stopped in requests: backend is shutting down",
		);
	});
});

describe("sleepUnlessAborted", () => {
	it("resolves as soon as the signal aborts instead of waiting out the pause", async () => {
		const abort = new AbortController();
		const started = performance.now();
		const sleeping = sleepUnlessAborted(10_000, abort.signal);
		setTimeout(() => abort.abort(), 5);
		await sleeping;
		expect(performance.now() - started).toBeLessThan(1_000);
		const alreadyAborted = performance.now();
		await sleepUnlessAborted(10_000, abort.signal);
		expect(performance.now() - alreadyAborted).toBeLessThan(100);
	});
});

describe("RetentionSweeps", () => {
	it("gives every sweep a fresh budget", async () => {
		const { clock } = fakeClock();
		const sweeps = new RetentionSweeps(1_000, clock);

		await sweeps.run(async (pacer) => {
			clock.at += 1_000;
			expect(pacer.mayRunBatch("requests")).toBe(false);
		});
		await sweeps.run(async (pacer) => {
			expect(pacer.mayRunBatch("requests")).toBe(true);
		});
	});

	it("stop() ends an in-flight sweep at its next batch and waits for it to return", async () => {
		const sweeps = new RetentionSweeps(60_000);
		const tables: string[] = [];
		let finished = false;
		let paused!: () => void;
		const pausing = new Promise<void>((resolve) => {
			paused = resolve;
		});

		const sweep = sweeps.run(async (pacer) => {
			while (pacer.mayRunBatch("requests")) {
				tables.push("requests");
				const pause = pacer.afterBatch("requests", 1_000);
				paused();
				await pause;
			}
			finished = true;
			return pacer.stoppedBy;
		});
		await pausing;
		const started = performance.now();
		await sweeps.stop();

		expect(finished).toBe(true);
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(tables).toEqual(["requests"]);
		expect(await sweep).toBe("stopped");
	});

	it("runs no batch in a sweep that starts after stop()", async () => {
		const sweeps = new RetentionSweeps(60_000);
		await sweeps.stop();
		const ran = await sweeps.run(async (pacer) =>
			pacer.mayRunBatch("requests"),
		);
		expect(ran).toBe(false);
	});

	it("stop() still settles when the sweep throws", async () => {
		const sweeps = new RetentionSweeps(60_000);
		const failing = sweeps.run(async () => {
			throw new Error("disk full");
		});
		await expect(failing).rejects.toThrow("disk full");
		await sweeps.stop();
	});
});

describe("scheduleAdaptiveVacuumAfterRetentionCleanup", () => {
	it("logs and starts adaptive vacuum when routing attempts are the only expired data", () => {
		const incrementalVacuumAdaptive = mock(async () => ({
			reclaimedPages: 0,
			chunks: 0,
		}));
		const info = mock(() => {});
		const error = mock(() => {});

		const scheduled = scheduleAdaptiveVacuumAfterRetentionCleanup(
			{
				removedRequests: 0,
				removedPayloads: 0,
				removedRoutingAttempts: 3,
			},
			{ incrementalVacuumAdaptive } as unknown as DatabaseOperations,
			{ info, error } as unknown as Logger,
			25,
		);

		expect(scheduled).toBe(true);
		expect(info).toHaveBeenCalledWith(
			"Periodic cleanup: removed 0 requests, 0 payloads, 3 routing attempts in 25ms",
		);
		expect(incrementalVacuumAdaptive).toHaveBeenCalledTimes(1);
	});
});
