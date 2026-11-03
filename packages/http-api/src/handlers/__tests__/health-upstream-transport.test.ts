import { describe, expect, it } from "bun:test";
import type {
	Account,
	HealthResponse,
	UpstreamTransportHealth,
} from "@better-ccflare/types";
import { createHealthHandler } from "../health";

/**
 * Incident 2026-11-02 22:31-23:16 EST: every Anthropic request failed with
 * "Unable to connect" (the host could not open new outbound TCP connections),
 * while /health answered 200 `ok` with all ten accounts routable. The
 * runtime.upstreamTransport block makes that visible. It must not change the
 * status code: the guard's replacement readiness probe, deploy-ccflare.sh and
 * run-ccflare-stack.sh all require 200, so a network outage turning /health
 * into 503 would also block deploys and recycles of a working router.
 */

const db = {
	getAllAccounts: async () =>
		[
			{
				id: "a1",
				name: "max-1",
				provider: "anthropic",
				paused: false,
				rate_limited_until: null,
			},
			{
				id: "a2",
				name: "max-2",
				provider: "anthropic",
				paused: false,
				rate_limited_until: null,
			},
		] as Account[],
} as unknown as import("@better-ccflare/database").DatabaseOperations;

const config = {
	getStrategy: () => "session",
	getHealthDetailEnabled: () => false,
} as unknown as import("@better-ccflare/config").Config;

const anthropicUnreachable: UpstreamTransportHealth = {
	windowMs: 300_000,
	unreachableAfter: 5,
	unreachable: ["anthropic"],
	providers: {
		anthropic: {
			state: "unreachable",
			responses: 0,
			failures: 381,
			consecutiveFailures: 381,
			lastResponseAt: "2026-11-03T03:30:32.475Z",
			lastFailureAt: "2026-11-03T04:16:30.000Z",
			lastFailureCode: "ConnectionRefused",
		},
		"openai-compatible": {
			state: "reachable",
			responses: 26,
			failures: 0,
			consecutiveFailures: 0,
			lastResponseAt: "2026-11-03T04:16:00.000Z",
			lastFailureAt: null,
			lastFailureCode: null,
		},
	},
};

describe("health runtime.upstreamTransport", () => {
	it("reports the snapshot without turning a network outage into a 503", async () => {
		const handler = createHealthHandler(db, config, {
			getAccountUsageInfo: () => null,
			getUpstreamTransportHealth: () => anthropicUnreachable,
		});
		const response = await handler(new URL("http://localhost/health"));
		const body = (await response.json()) as HealthResponse;

		expect(response.status).toBe(200);
		expect(body.status).toBe("ok");
		expect(body.pool?.routable).toBe(2);
		expect(body.runtime?.upstreamTransport).toEqual(anthropicUnreachable);
	});

	it("omits the block when no tracker is wired", async () => {
		const handler = createHealthHandler(db, config, {
			getAccountUsageInfo: () => null,
		});
		const response = await handler(new URL("http://localhost/health"));
		const body = (await response.json()) as HealthResponse;
		expect(body.runtime?.upstreamTransport).toBeUndefined();
	});
});
