import { describe, expect, it } from "bun:test";
import type { BankedResetsSummary as BankedResetsSummaryData } from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
import {
	BankedResetsSummary,
	formatBankedResetExpiry,
	formatBankedResetExpiryLabel,
	formatBankedResetObserved,
} from "./BankedResetsSummary";

const NOV_30 = Date.UTC(2026, 10, 30);
const NOW = Date.UTC(2026, 10, 2, 18, 30);
const BANNED = /applies now|bonus|free|claim|ready|recommended|today|you can/i;
/** Any wording built on OpenAI's applicable count, which does not tell whether a reset will work (#772). */
const APPLICABILITY =
	/would help|expected to help|expect a reset|help not reported|usable|applies|applicable|would work/i;

function summary(
	overrides: Partial<BankedResetsSummaryData> = {},
): BankedResetsSummaryData {
	return {
		totalAvailable: 6,
		soonestExpiresAt: NOV_30,
		appliesNow: [],
		anyStale: false,
		trackedAccounts: 3,
		...overrides,
	};
}

const reported = (name: string, count: number, stale = false) => ({
	accountId: name,
	accountName: name,
	applicableCount: count,
	stale,
});

function render(data: BankedResetsSummaryData | undefined): string {
	return renderToStaticMarkup(<BankedResetsSummary summary={data} now={NOW} />);
}

/** The visible text of rendered markup, with React's entity escapes decoded. */
function text(html: string): string {
	return html
		.replace(/<[^>]+>/g, "")
		.replace(/&#x27;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&");
}

function howto(html: string): string | null {
	const match = html.match(
		/<p data-testid="banked-resets-howto"[^>]*>([\s\S]*?)<\/p>/,
	);
	return match ? match[1] : null;
}

describe("formatBankedResetExpiryLabel", () => {
	it("adds the countdown to a future date", () => {
		expect(formatBankedResetExpiryLabel(NOV_30, NOW)).toBe(
			"Nov 30, 2026 UTC (in 27d 5h)",
		);
	});

	it("says a past date has passed instead of reading like a future one", () => {
		expect(formatBankedResetExpiryLabel(NOV_30, NOV_30 + 1000)).toBe(
			"Nov 30, 2026 UTC (date passed)",
		);
	});

	it("shows only the date under a minute out, never in 0m", () => {
		const label = formatBankedResetExpiryLabel(NOV_30, NOV_30 - 30_000);
		expect(label).toBe("Nov 30, 2026 UTC");
		expect(label).not.toContain("in 0m");
	});

	it("keeps the countdown at exactly one minute out", () => {
		expect(formatBankedResetExpiryLabel(NOV_30, NOV_30 - 60_000)).toBe(
			"Nov 30, 2026 UTC (in 1m)",
		);
	});

	it("uses the UTC date at the end of a UTC day", () => {
		const lateNov30 = Date.UTC(2026, 10, 30, 23, 59);
		expect(formatBankedResetExpiryLabel(lateNov30, NOW)).toStartWith(
			"Nov 30, 2026 UTC",
		);
	});

	it("leaves the bare date formatter unchanged", () => {
		expect(formatBankedResetExpiry(NOV_30)).toBe("Nov 30, 2026");
	});

	it("formats the last-read time in UTC", () => {
		expect(formatBankedResetObserved(Date.UTC(2026, 10, 3, 14, 5))).toBe(
			"Nov 3, 14:05 UTC",
		);
	});
});

describe("BankedResetsSummary", () => {
	it("keeps held resets, expiry and stale warnings visible without opening a disclosure", () => {
		const html = render(summary({ anyStale: true }));
		expect(html).toContain("<details");
		expect(html.slice(0, html.indexOf("</summary>"))).toContain(
			"Includes last known values",
		);
		expect(html).toContain("Banked resets");
		expect(html).toContain("Includes last known values");
		expect(html).toContain("Soonest expires");
	});
	it("shows the fleet total without repeating the word resets", () => {
		const html = render(summary());
		expect(html).toContain(">Banked resets<");
		expect(html).toContain(">6<");
		expect(html).toContain(">total<");
		expect(text(html)).not.toContain("Includes last known values");
	});

	it("explains what a banked reset is in visible text", () => {
		expect(text(render(summary()))).toContain(
			"A banked reset is a saved reset that restores an account's usage limits ahead of schedule.",
		);
	});

	it("shows the soonest expiry with UTC and a countdown", () => {
		expect(text(render(summary()))).toContain(
			"Soonest expires Nov 30, 2026 UTC (in 27d 5h)",
		);
	});

	it("says nothing about OpenAI's applicable count, whatever it reads (#772)", () => {
		const cases = [
			summary(),
			summary({ anyStale: true }),
			summary({
				appliesNow: [
					reported("codex-pro-1", 2),
					reported("codex-pro-2", 1, true),
				],
			}),
			summary({
				anyStale: true,
				appliesNow: [reported("codex-pro-1", 2, true)],
			}),
			summary({ totalAvailable: 0, soonestExpiresAt: null }),
		];
		for (const data of cases) {
			const visible = text(render(data));
			expect(visible).not.toMatch(APPLICABILITY);
			expect(visible).not.toContain("codex-pro-1");
			expect(visible).not.toContain("per OpenAI");
		}
	});

	it("gives the same card whether or not OpenAI counts a reset as applying", () => {
		expect(render(summary({ appliesNow: [reported("codex-pro-1", 2)] }))).toBe(
			render(summary()),
		);
	});

	it("flags last known values when some accounts are stale", () => {
		const visible = text(render(summary({ anyStale: true })));
		expect(visible).toContain("Includes last known values");
		expect(visible).toContain(
			"Some accounts have not reported recently. Their last known counts are included, so the real total may differ.",
		);
	});

	it("says no resets are held and offers no how-to at zero", () => {
		const html = render(summary({ totalAvailable: 0, soonestExpiresAt: null }));
		const visible = text(html);
		expect(visible).toContain("No banked resets held.");
		expect(howto(html)).toBeNull();
	});

	it("keeps an empty fresh balance compact without hiding stale-value warnings", () => {
		const empty = render(
			summary({ totalAvailable: 0, soonestExpiresAt: null }),
		);
		expect(empty).toStartWith("<details");
		expect(empty).not.toMatch(/^<details[^>]*\bopen/);
		const header = empty.slice(0, empty.indexOf("</summary>"));
		expect(header).toContain("Banked resets");
		expect(header).toContain("No banked resets held.");
		const stale = render(
			summary({ totalAvailable: 0, soonestExpiresAt: null, anyStale: true }),
		);
		expect(stale).toStartWith("<details");
		expect(stale).toContain("Includes last known values");
	});

	it("says when the expiry was not reported", () => {
		expect(text(render(summary({ soonestExpiresAt: null })))).toContain(
			"Expiry not reported",
		);
	});

	it("points to Use reset, with the Codex CLI as the other way, whenever resets are held, as plain text", () => {
		const cases = [
			summary(),
			summary({ appliesNow: [reported("codex-pro-1", 2)] }),
			summary({
				anyStale: true,
				appliesNow: [reported("codex-pro-1", 2, true)],
			}),
		];
		for (const data of cases) {
			const block = howto(render(data));
			expect(block).not.toBeNull();
			const visible = text(block ?? "");
			expect(visible).toContain("/usage");
			expect(visible).toContain("Redeem reset");
			expect(visible).toContain(
				"If you choose to use one, press Use reset on that account below. It asks you to confirm first, and using a reset cannot be undone.",
			);
			expect(visible).not.toContain("no Use reset button");
			expect(visible).not.toMatch(BANNED);
			expect(block).not.toMatch(/<(a|button)\b|role="(button|link)"/);
		}
	});

	it("uses none of the banned words anywhere in the card", () => {
		const visible = text(
			render(
				summary({
					anyStale: true,
					appliesNow: [
						reported("codex-pro-1", 2),
						reported("codex-pro-2", 1, true),
					],
				}),
			),
		);
		expect(visible).not.toMatch(BANNED);
	});

	it("distinguishes untracked accounts and unknown summary from fresh zero", () => {
		expect(
			render(summary({ trackedAccounts: 0, totalAvailable: 0 })),
		).toContain("Not tracked");
		const unknown = render(undefined);
		expect(unknown).toContain("not read yet");
		expect(unknown).not.toContain("No banked resets held");
	});
});
