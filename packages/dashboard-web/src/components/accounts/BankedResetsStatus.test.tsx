import { describe, expect, it } from "bun:test";
import type { BankedResets } from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
import { BankedResetsStatus, bankedResetsRowState } from "./BankedResetsStatus";
import { STATUS_TONE_CLASS } from "./status-tones";

const NOV_30 = Date.UTC(2026, 10, 30);
const NOW = Date.UTC(2026, 10, 2, 18, 30);
const OBSERVED = Date.UTC(2026, 10, 3, 14, 5);
const BANNED = /applies now|bonus|free|claim|ready|recommended/i;
/** Any wording built on OpenAI's applicable count, which predicts nothing (#772). */
const APPLICABILITY =
	/would help|expected to help|help not reported|usable|applies|applicable|would work/i;
const HELD_DETAIL =
	"Using one resets this account's usage limits early. It is optional and cannot be undone.";

const held: BankedResets = {
	tracked: true,
	availableCount: 2,
	applicableCount: 2,
	soonestExpiresAt: NOV_30,
	doesNotExpire: false,
	appliesNow: true,
	stale: false,
	observedAt: OBSERVED,
};

function render(resets: BankedResets): string {
	return renderToStaticMarkup(
		<BankedResetsStatus resets={resets} accountName="codex-pro-1" now={NOW} />,
	);
}

/** The visible text of rendered markup, with React's entity escapes decoded. */
function text(html: string): string {
	return html
		.replace(/<[^>]+>/g, " ")
		.replace(/&#x27;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}

/** Markup with tags removed and nothing put in their place, for text that runs across inline spans. */
function inline(html: string): string {
	return html.replace(/<[^>]+>/g, "");
}

describe("BankedResetsStatus expiry wrapping", () => {
	it("keeps the date and the countdown each on one line, but lets the chunk wrap", () => {
		const html = render(held);
		expect(html).toContain(
			'<span class="whitespace-nowrap">Nov 30, 2026 UTC</span>',
		);
		expect(html).toContain(
			'<span class="whitespace-nowrap">(in 27d 5h)</span>',
		);
		expect(html).not.toMatch(/whitespace-nowrap[^"]*"[^>]*>Soonest expires/);
	});
});

describe("bankedResetsRowState", () => {
	it("decides from tracking, then the count, never from OpenAI's applicable count", () => {
		expect(bankedResetsRowState({ ...held, tracked: false })).toEqual({
			kind: "not_tracked",
			stale: false,
		});
		expect(bankedResetsRowState({ ...held, availableCount: null })).toEqual({
			kind: "unknown",
			stale: false,
		});
		expect(bankedResetsRowState({ ...held, availableCount: 0 })).toEqual({
			kind: "none",
			stale: false,
		});
		expect(bankedResetsRowState(held)).toEqual({
			kind: "held",
			stale: false,
		});
		expect(
			bankedResetsRowState({ ...held, applicableCount: 0, appliesNow: false }),
		).toEqual({
			kind: "held",
			stale: false,
		});
	});

	it("ignores OpenAI's flag when no reset is held or the count is unknown", () => {
		expect(
			bankedResetsRowState({ ...held, availableCount: 0, appliesNow: true })
				.kind,
		).toBe("none");
		expect(
			bankedResetsRowState({ ...held, availableCount: null, appliesNow: true })
				.kind,
		).toBe("unknown");
	});

	it("carries the stale flag through", () => {
		expect(bankedResetsRowState({ ...held, stale: true })).toEqual({
			kind: "held",
			stale: true,
		});
	});
});

describe("BankedResetsStatus", () => {
	it("is a labelled group", () => {
		const html = render(held);
		expect(html).toStartWith(
			'<fieldset aria-label="Banked resets for codex-pro-1"',
		);
	});

	it("shows the held count, its expiry and what using one does, in plain words", () => {
		const visible = text(render(held));
		expect(visible).toContain("Banked resets: 2");
		expect(visible).toContain("Soonest expires Nov 30, 2026 UTC (in 27d 5h)");
		expect(visible).toContain(HELD_DETAIL);
		expect(visible).not.toMatch(BANNED);
	});

	it("says nothing about OpenAI's applicable count, whatever it reads (#772)", () => {
		for (const [applicableCount, appliesNow] of [
			[2, true],
			[1, true],
			[0, false],
			[null, false],
		] as const) {
			for (const stale of [false, true]) {
				const visible = text(
					render({ ...held, applicableCount, appliesNow, stale }),
				);
				expect(visible).toContain("Banked resets: 2");
				expect(visible).not.toMatch(APPLICABILITY);
			}
		}
	});

	it("never colours a held reset green", () => {
		for (const resets of [held, { ...held, appliesNow: false }]) {
			expect(render(resets)).not.toMatch(/bg-green|text-green/);
		}
	});

	it("gives the same line whether or not OpenAI counts a reset as applying", () => {
		expect(
			text(render({ ...held, applicableCount: 0, appliesNow: false })),
		).toBe(text(render(held)));
	});

	it("says Expires, not Soonest expires, for a single reset", () => {
		const visible = text(
			render({ ...held, availableCount: 1, applicableCount: 1 }),
		);
		expect(visible).toContain("Expires Nov 30, 2026 UTC (in 27d 5h)");
		expect(visible).not.toContain("Soonest expires");
	});

	it("shows a stale account's last known values with when they were read", () => {
		const html = render({ ...held, stale: true });
		const visible = text(html);
		expect(visible).toContain("Banked resets: 2 Last known");
		expect(visible).toContain("Soonest expires Nov 30, 2026 UTC");
		expect(visible).toContain(
			"Last read Nov 3, 14:05 UTC. The router has not been able to refresh it.",
		);
		expect(visible).not.toMatch(/Banked resets: 0\b/);
		// Said once, by the amber pill, not repeated on every chunk.
		expect(visible.match(/last known/gi)).toHaveLength(1);
		expect(html).toContain(`${STATUS_TONE_CLASS.warning}">Last known<`);
	});

	it("falls back when a stale account has no read time", () => {
		expect(text(render({ ...held, stale: true, observedAt: null }))).toContain(
			"Last known values. The router has not been able to refresh them.",
		);
	});

	it("shows a stale zero as last known, not as a present fact", () => {
		const visible = text(
			render({
				...held,
				availableCount: 0,
				applicableCount: 0,
				soonestExpiresAt: null,
				appliesNow: false,
				stale: true,
			}),
		);
		expect(visible).toContain("Banked resets: 0 Last known");
		expect(visible).toContain("Last read Nov 3, 14:05 UTC.");
		expect(visible).not.toContain("None held.");
		expect(visible).not.toContain("OpenAI");
	});

	it("says none are held at zero", () => {
		const visible = text(
			render({
				...held,
				availableCount: 0,
				applicableCount: 0,
				soonestExpiresAt: null,
				appliesNow: false,
			}),
		);
		expect(visible).toContain("Banked resets: 0");
		expect(visible).toContain("None held.");
		expect(visible).not.toContain("OpenAI");
	});

	it("says nothing about applicability when OpenAI's flag disagrees with a zero or unknown count", () => {
		for (const availableCount of [0, null]) {
			const visible = text(
				render({ ...held, availableCount, appliesNow: true }),
			);
			expect(visible).not.toMatch(APPLICABILITY);
		}
	});

	it("says a custom-endpoint account is not tracked instead of showing 0", () => {
		const visible = text(
			render({
				...held,
				tracked: false,
				availableCount: null,
				applicableCount: null,
				soonestExpiresAt: null,
				appliesNow: false,
			}),
		);
		expect(visible).toContain("Banked resets: not tracked");
		expect(visible).toContain(
			"Custom endpoint accounts do not report banked resets.",
		);
		expect(visible).not.toMatch(/\b0\b/);
	});

	it("says the count has not been read yet, even when stale", () => {
		const visible = text(
			render({
				...held,
				availableCount: null,
				applicableCount: null,
				soonestExpiresAt: null,
				appliesNow: false,
				stale: true,
				observedAt: null,
			}),
		);
		expect(visible).toContain("Banked resets: not read yet");
		expect(visible).toContain("Waiting for the first usage check.");
		expect(visible).not.toMatch(/last known/i);
		expect(visible).not.toMatch(/\b0\b/);
	});

	it("says when resets do not expire", () => {
		expect(
			text(render({ ...held, soonestExpiresAt: null, doesNotExpire: true })),
		).toContain("Does not expire");
		expect(inline(render({ ...held, doesNotExpire: true }))).toContain(
			"Soonest expires Nov 30, 2026 UTC (in 27d 5h); at least one does not expire",
		);
		expect(text(render({ ...held, soonestExpiresAt: null }))).toContain(
			"Expiry not reported",
		);
	});

	it("leaves the redeem how-to to the summary card", () => {
		const visible = text(render(held));
		expect(visible).not.toContain("/usage");
		expect(visible).not.toContain("Redeem reset");
	});
});

describe("BankedResetsStatus Use reset button (R8)", () => {
	function withButton(resets: BankedResets): string {
		return renderToStaticMarkup(
			<BankedResetsStatus
				resets={resets}
				accountName="codex-pro-1"
				now={NOW}
				onUseReset={() => {}}
			/>,
		);
	}

	/** The Use reset button's markup, or null when it is not rendered. */
	function button(html: string): string | null {
		const match = html.match(/<button\b[^>]*>Use reset<\/button>/);
		return match ? match[0] : null;
	}

	/** The disabled attribute, not the disabled: style variants in its class. */
	const DISABLED = /\sdisabled=""/;

	it("is not rendered unless the card asks for it", () => {
		expect(button(render(held))).toBeNull();
	});

	it("is enabled on any fresh held count, whatever OpenAI's applicable count says (#772)", () => {
		for (const [applicableCount, appliesNow] of [
			[2, true],
			[0, false],
			[null, false],
		] as const) {
			const html = withButton({ ...held, applicableCount, appliesNow });
			const tag = button(html);
			expect(tag).not.toBeNull();
			expect(tag).not.toMatch(DISABLED);
			// Described by the detail line, which says it is optional and final.
			const describedBy = tag?.match(/aria-describedby="([^"]+)"/)?.[1];
			expect(describedBy).toBeDefined();
			expect(html).toContain(`<p id="${describedBy}"`);
			expect(text(html)).toContain(HELD_DETAIL);
			expect(text(html)).not.toMatch(BANNED);
			expect(text(html)).not.toMatch(APPLICABILITY);
		}
	});

	it("is disabled on a stale count and says a fresh count is needed", () => {
		for (const appliesNow of [true, false]) {
			const html = withButton({ ...held, appliesNow, stale: true });
			expect(button(html)).toMatch(DISABLED);
			expect(text(html)).toContain(
				"Last read Nov 3, 14:05 UTC. The router has not been able to refresh it. Use reset needs a fresh count.",
			);
		}
	});

	it("is not rendered when no reset is held, the count is unknown, or the account is not tracked", () => {
		for (const resets of [
			{ ...held, availableCount: 0, applicableCount: 0 },
			{ ...held, availableCount: null, applicableCount: null },
			{ ...held, tracked: false },
		]) {
			const html = withButton(resets);
			expect(button(html)).toBeNull();
			expect(text(html)).not.toContain("fresh count");
		}
	});
});
