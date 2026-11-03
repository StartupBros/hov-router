import { describe, expect, test } from "bun:test";
import { parseHealthVerdict } from "../health-verdict";

const POOL = {
	configured: 2,
	routable: 0,
	paused: 0,
	rate_limited: 2,
	usage_exhausted: 0,
	next_available_at: "2026-11-02T15:45:00.000Z",
};

describe("parseHealthVerdict", () => {
	test("accepts a server verdict and keeps pool and runtime", () => {
		const runtime = {
			asyncWriter: { healthy: true, failureCount: 0, queuedJobs: 0 },
			usageWorker: { state: "ready" },
		};
		expect(
			parseHealthVerdict({
				status: "degraded",
				timestamp: "2026-11-02T15:00:00.000Z",
				pool: POOL,
				runtime,
			}),
		).toEqual({ status: "degraded", pool: POOL, runtime });
	});

	test("accepts a verdict without runtime", () => {
		expect(parseHealthVerdict({ status: "ok", pool: POOL })).toEqual({
			status: "ok",
			pool: POOL,
		});
	});

	test("rejects the guard's drain body, which has no verdict", () => {
		// scripts/ccflare-guard.mjs answers /health itself during a drain.
		expect(
			parseHealthVerdict({
				error: "service_unavailable",
				message: "HoV Router is restarting",
			}),
		).toBeNull();
	});

	test("rejects an unknown status", () => {
		expect(parseHealthVerdict({ status: "fine", pool: POOL })).toBeNull();
	});

	test("rejects a verdict with no pool or a malformed one", () => {
		expect(parseHealthVerdict({ status: "ok" })).toBeNull();
		expect(
			parseHealthVerdict({ status: "ok", pool: { configured: "2" } }),
		).toBeNull();
	});

	test("rejects non-objects", () => {
		expect(parseHealthVerdict(null)).toBeNull();
		expect(parseHealthVerdict("ok")).toBeNull();
		expect(parseHealthVerdict(503)).toBeNull();
	});
});
