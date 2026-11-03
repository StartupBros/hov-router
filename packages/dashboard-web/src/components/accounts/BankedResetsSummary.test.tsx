import { describe, expect, it } from "bun:test";
import type { BankedResetsSummary as BankedResetsSummaryData } from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
import { BankedResetsSummary } from "./BankedResetsSummary";

const NOV_30 = Date.UTC(2026, 10, 30);

function summary(
	overrides: Partial<BankedResetsSummaryData> = {},
): BankedResetsSummaryData {
	return {
		totalAvailable: 5,
		soonestExpiresAt: NOV_30,
		appliesNow: [],
		anyStale: false,
		trackedAccounts: 3,
		...overrides,
	};
}

function render(data: BankedResetsSummaryData | undefined): string {
	return renderToStaticMarkup(<BankedResetsSummary summary={data} />);
}

describe("BankedResetsSummary", () => {
	it("shows the fleet total and the soonest expiry", () => {
		const html = render(summary());
		expect(html).toContain("Banked resets");
		expect(html).toContain(">5<");
		expect(html).toContain("Nov 30, 2026");
		expect(html).not.toContain("includes stale values");
	});

	it("lists the accounts where a reset applies now", () => {
		const html = render(
			summary({
				appliesNow: [
					{
						accountId: "a",
						accountName: "codex-pro-1",
						applicableCount: 2,
						stale: false,
					},
					{
						accountId: "b",
						accountName: "codex-pro-2",
						applicableCount: 1,
						stale: true,
					},
				],
			}),
		);
		expect(html).toContain("Applies now");
		expect(html).toContain("codex-pro-1");
		expect(html).toContain("codex-pro-2");
		expect(html).not.toContain("No account has a reset that applies now");
	});

	it("says when no account has a reset that applies now", () => {
		expect(render(summary())).toContain(
			"No account has a reset that applies now",
		);
	});

	it("marks the total as including stale values when any account is stale", () => {
		expect(render(summary({ anyStale: true }))).toContain(
			"includes stale values",
		);
	});

	it("renders nothing without tracked Codex accounts or before data loads", () => {
		expect(render(summary({ trackedAccounts: 0, totalAvailable: 0 }))).toBe("");
		expect(render(undefined)).toBe("");
	});
});
