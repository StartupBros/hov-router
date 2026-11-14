import { describe, expect, it } from "bun:test";
import type { AccountResponse } from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
import { RateLimitInfo } from "./RateLimitInfo";

function mkAccount(partial: Partial<AccountResponse>): AccountResponse {
	return {
		id: partial.id ?? "id",
		name: partial.name ?? "acc",
		provider: "anthropic",
		requestCount: 0,
		totalRequests: 0,
		lastUsed: null,
		created: new Date().toISOString(),
		paused: false,
		requiresReauth: false,
		pauseReason: null,
		tokenStatus: "valid",
		tokenExpiresAt: null,
		rateLimitStatus: "OK",
		rateLimitReset: null,
		rateLimitRemaining: null,
		rateLimitedUntil: null,
		rateLimitedReason: null,
		rateLimitedAt: null,
		sessionInfo: "",
		priority: 0,
		autoFallbackEnabled: false,
		autoPauseOnOverageEnabled: false,
		peakHoursPauseEnabled: false,
		customEndpoint: null,
		modelMappings: null,
		usageUtilization: null,
		usageWindow: null,
		usageData: null,
		usageRateLimitedUntil: null,
		usageThrottledUntil: null,
		usageThrottledWindows: [],
		hasRefreshToken: true,
		crossRegionMode: null,
		modelFallbacks: null,
		billingType: null,
		sessionStats: null,
		isPrimary: false,
		...partial,
	};
}

describe("RateLimitInfo", () => {
	it("hides a reset time that has already passed instead of rendering 'Resets in m'", () => {
		const html = renderToStaticMarkup(
			<RateLimitInfo
				accounts={[
					mkAccount({
						name: "grok",
						rateLimitStatus: "usage_exhausted (2687m)",
						rateLimitReset: new Date(Date.now() - 60 * 60_000).toISOString(),
					}),
				]}
			/>,
		);

		expect(html).toContain("grok");
		expect(html).not.toContain("Resets in");
		expect(html).not.toContain("(local)");
	});

	it("shows a future reset as a readable duration", () => {
		const html = renderToStaticMarkup(
			<RateLimitInfo
				accounts={[
					mkAccount({
						rateLimitStatus: "rate_limited (45m)",
						rateLimitReset: new Date(
							Date.now() + 45 * 60_000 - 1_000,
						).toISOString(),
					}),
				]}
			/>,
		);

		expect(html).toContain("Resets in 45m");
		expect(html).toContain("(local)");
	});

	it("formats the status like the accounts page does", () => {
		const html = renderToStaticMarkup(
			<RateLimitInfo
				accounts={[mkAccount({ rateLimitStatus: "usage_exhausted (2687m)" })]}
			/>,
		);

		expect(html).toContain("Usage exhausted");
		expect(html).toContain("See usage windows for reset times");
		expect(html).not.toContain("44h 47m");
		expect(html).not.toContain("usage_exhausted");
	});

	it("renders nothing when no account is limited", () => {
		const html = renderToStaticMarkup(
			<RateLimitInfo accounts={[mkAccount({ rateLimitStatus: "OK" })]} />,
		);

		expect(html).toBe("");
	});
});
it("shares cooldown evidence and excludes soft, unknown and refresh-only observations", () => {
	const html = renderToStaticMarkup(
		<RateLimitInfo
			accounts={[
				mkAccount({
					id: "cool",
					name: "cool",
					rateLimitStatus: "allowed",
					rateLimitedUntil: Date.now() + 60000,
				}),
				mkAccount({
					id: "soft",
					name: "soft-only",
					rateLimitStatus: "queueing_soft",
				}),
				mkAccount({
					id: "unknown",
					name: "unknown-only",
					rateLimitStatus: "new_status",
				}),
				mkAccount({
					id: "refresh",
					name: "refresh-only",
					usageRateLimitedUntil: Date.now() + 60000,
				}),
			]}
		/>,
	);
	expect(html).toContain("Cooling down");
	expect(html).toContain("Router retry");
	for (const name of ["soft-only", "unknown-only", "refresh-only"])
		expect(html).not.toContain(name);
});
it("never pairs usage exhaustion with an unrelated header reset", () => {
	const html = renderToStaticMarkup(
		<RateLimitInfo
			accounts={[
				mkAccount({
					rateLimitStatus: "usage_exhausted",
					rateLimitReset: new Date(Date.now() + 60000).toISOString(),
				}),
			]}
		/>,
	);
	expect(html).toContain("Usage exhausted");
	expect(html).not.toContain("Resets in");
	expect(html).not.toContain("(local)");
});
