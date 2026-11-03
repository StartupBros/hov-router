import { describe, expect, test } from "bun:test";
import type { PoolStatus } from "@better-ccflare/types";
import type { HealthVerdict } from "../../../../lib/health-verdict";
import { describeSystemStatus } from "../describeSystemStatus";

function pool(overrides: Partial<PoolStatus> = {}): PoolStatus {
	return {
		configured: 3,
		routable: 3,
		paused: 0,
		rate_limited: 0,
		usage_exhausted: 0,
		next_available_at: null,
		...overrides,
	};
}

function verdict(
	status: HealthVerdict["status"],
	poolOverrides: Partial<PoolStatus> = {},
	runtime?: HealthVerdict["runtime"],
): HealthVerdict {
	return {
		status,
		pool: pool(poolOverrides),
		...(runtime ? { runtime } : {}),
	};
}

describe("describeSystemStatus", () => {
	test("loading is neutral, never a claim that all is well", () => {
		const view = describeSystemStatus(undefined);
		expect(view.tone).toBe("neutral");
		expect(view.title).toBe("Checking status");
	});

	test("no verdict is neutral and says it is retrying", () => {
		const view = describeSystemStatus(null);
		expect(view.tone).toBe("neutral");
		expect(view.title).toBe("Status unknown");
		expect(view.detail).toContain("30 seconds");
	});

	test("ok reports how many accounts are available", () => {
		const view = describeSystemStatus(verdict("ok"));
		expect(view).toEqual({
			tone: "ok",
			title: "Routing normally",
			detail: "3 of 3 accounts available.",
		});
	});

	test("ok names paused, rate-limited and exhausted accounts", () => {
		const view = describeSystemStatus(
			verdict("ok", {
				configured: 5,
				routable: 2,
				paused: 2,
				rate_limited: 1,
				usage_exhausted: 1,
			}),
		);
		expect(view.tone).toBe("ok");
		expect(view.detail).toBe(
			"2 of 5 accounts available (2 paused, 1 rate-limited); 1 at its usage limit.",
		);
	});

	test("ok with one account uses the singular", () => {
		const view = describeSystemStatus(
			verdict("ok", { configured: 1, routable: 1 }),
		);
		expect(view.detail).toBe("1 of 1 account available.");
	});

	test("degraded warns and gives the recovery time as a clock time", () => {
		const at = "2026-11-02T15:45:00.000Z";
		const view = describeSystemStatus(
			verdict("degraded", {
				routable: 0,
				rate_limited: 3,
				next_available_at: at,
			}),
		);
		const time = new Intl.DateTimeFormat(undefined, {
			hour: "numeric",
			minute: "2-digit",
		}).format(new Date(at));
		expect(view.tone).toBe("warning");
		expect(view.title).toBe("No account can route right now");
		expect(view.detail).toBe(`The next account frees up at ${time}.`);
	});

	test("degraded with an unparseable time says none is known", () => {
		const view = describeSystemStatus(
			verdict("degraded", { routable: 0, next_available_at: "soon" }),
		);
		expect(view.tone).toBe("warning");
		expect(view.detail).toBe("No recovery time is known.");
	});

	test("unhealthy with no accounts asks for one", () => {
		const view = describeSystemStatus(
			verdict("unhealthy", { configured: 0, routable: 0 }),
		);
		expect(view).toEqual({
			tone: "warning",
			title: "No accounts configured",
			detail: "Add an account to start routing requests.",
		});
	});

	test("unhealthy with every account paused is down and says why", () => {
		const view = describeSystemStatus(
			verdict("unhealthy", { configured: 2, routable: 0, paused: 2 }),
		);
		expect(view).toEqual({
			tone: "down",
			title: "No account can route requests",
			detail: "2 paused. No recovery time is known.",
		});
	});

	test("a failing request writer is named before pool state", () => {
		const view = describeSystemStatus(
			verdict(
				"unhealthy",
				{ configured: 0, routable: 0 },
				{
					asyncWriter: { healthy: false, failureCount: 4, queuedJobs: 12 },
					usageWorker: { state: "ready" },
				},
			),
		);
		expect(view).toEqual({
			tone: "down",
			title: "The request writer is failing",
			detail: "Request history may not be saved.",
		});
	});

	test("both runtime parts failing are named together", () => {
		const view = describeSystemStatus(
			verdict("unhealthy", undefined, {
				asyncWriter: { healthy: false, failureCount: 1, queuedJobs: 0 },
				usageWorker: { state: "error" },
			}),
		);
		expect(view.tone).toBe("down");
		expect(view.title).toBe("The request writer and usage worker are failing");
		expect(view.detail).toBe(
			"Request history may not be saved, and account usage may be out of date.",
		);
	});

	test("unhealthy for an unrecognised reason is still down", () => {
		const view = describeSystemStatus(verdict("unhealthy"));
		expect(view.tone).toBe("down");
		expect(view.title).toBe("The router reports a problem");
	});
});
