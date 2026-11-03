import { describe, expect, it } from "bun:test";
import type { BankedResets, RedeemResetResponse } from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
import type { RedeemResetAnswer } from "../../lib/redeem-reset";
import { Dialog } from "../ui/dialog";
import type { ResetFlowState } from "./reset-redemption-flow";
import { UseResetPanel } from "./UseResetDialog";

const ID = "3f2b8c1e-7a4d-4b9e-9c21-5d6e7f8a9b0c";
const NOW = Date.UTC(2026, 10, 3, 12, 0);
const NOV_30 = Date.UTC(2026, 10, 30);
const WEEK_RESET = Date.UTC(2026, 10, 9, 14, 0);
const BANNED =
	/applies now|bonus|free|claim|(?<!al)ready|recommended|today|you can/i;

const resets: BankedResets = {
	tracked: true,
	availableCount: 2,
	applicableCount: 2,
	soonestExpiresAt: NOV_30,
	doesNotExpire: false,
	appliesNow: true,
	stale: false,
	observedAt: NOW,
};

function flow(
	phase: ResetFlowState["phase"],
	answer: RedeemResetAnswer | null = null,
): ResetFlowState {
	return { requestId: ID, phase, answer };
}

function response(
	overrides: Partial<RedeemResetResponse> = {},
): RedeemResetAnswer {
	return {
		kind: "result",
		response: {
			requestId: ID,
			accountId: "acc-1",
			state: "done",
			outcome: "reset",
			windowsReset: 2,
			spend: "spent",
			availableBefore: 2,
			availableAfter: 1,
			requestedAt: NOW,
			completedAt: NOW + 1_000,
			...overrides,
		},
	};
}

function render(
	state: ResetFlowState,
	props: Partial<Parameters<typeof UseResetPanel>[0]> = {},
): string {
	return renderToStaticMarkup(
		<Dialog open>
			<UseResetPanel
				accountName="codex-pro-1"
				resets={resets}
				windows={[{ label: "Weekly", resetsAt: WEEK_RESET }]}
				flow={state}
				now={NOW}
				onConfirm={() => {}}
				onClose={() => {}}
				{...props}
			/>
		</Dialog>,
	);
}

/** Visible text, with React's entity escapes decoded. */
function text(html: string): string {
	return html
		.replace(/<[^>]+>/g, " ")
		.replace(/&#x27;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}

/** Each button's opening tag and label, in document order. */
function buttons(html: string): Array<{ tag: string; label: string }> {
	return [...html.matchAll(/(<button\b[^>]*>)([\s\S]*?)<\/button>/g)].map(
		(match) => ({ tag: match[1], label: text(match[2]) }),
	);
}

describe("UseResetPanel confirmation (R9, KTD12)", () => {
	it("states each effect and the cost before anything is sent", () => {
		const visible = text(render(flow("confirm")));
		expect(visible).toContain("Use one banked reset on codex-pro-1?");
		expect(visible).toContain("OpenAI says a reset");
		expect(visible).toContain("resets the 5-hour window");
		expect(visible).toContain("resets the weekly window on Pro plans");
		expect(visible).toContain(
			"moves the weekly reset date to about 7 days after you use it (about Nov 10, 2026 UTC)",
		);
		expect(visible).toContain(
			"It spends the reset that expires soonest, on Nov 30, 2026 UTC.",
		);
		expect(visible).toContain("This cannot be undone.");
	});

	it("lists this account's windows with the times they would reset anyway", () => {
		const visible = text(render(flow("confirm")));
		expect(visible).toContain("Without a reset, this account's windows reset:");
		expect(visible).toContain("Weekly: Nov 9, 14:00 UTC (in 6d 2h)");
		expect(text(render(flow("confirm"), { windows: [] }))).toContain(
			"The router has no reset times for this account yet.",
		);
	});

	it("names a reset that does not expire when no expiry is reported", () => {
		const visible = text(
			render(flow("confirm"), {
				resets: { ...resets, soonestExpiresAt: null, doesNotExpire: true },
			}),
		);
		expect(visible).toContain(
			"It spends one reset. These resets do not expire.",
		);
	});

	it("gives 'No, go back' the initial focus and puts it first", () => {
		const [goBack, confirm] = buttons(render(flow("confirm"))).filter(
			(button) => button.label !== "Close",
		);
		expect(goBack.label).toBe("No, go back");
		expect(goBack.tag).toContain("autofocus");
		expect(confirm.label).toBe("Use 1 reset");
		expect(confirm.tag).not.toContain("autofocus");
	});
});

describe("UseResetPanel while sending", () => {
	it("says it is sending and disables both buttons", () => {
		const html = render(flow("sending"));
		expect(text(html)).toContain("Sending the request to OpenAI");
		const footer = buttons(html).filter((button) => button.label !== "Close");
		expect(footer.map((button) => button.label)).toEqual([
			"No, go back",
			"Sending...",
		]);
		for (const button of footer) expect(button.tag).toContain("disabled");
	});
});

describe("UseResetPanel results (R12, KTD11)", () => {
	it("shows the outcome, the spend from the count, and a Close button only", () => {
		const html = render(flow("answered", response()));
		const visible = text(html);
		expect(visible).toContain("OpenAI reset this account's usage windows.");
		expect(visible).toContain("A credit was spent.");
		expect(visible).toContain("Banked resets: 2 before, 1 after.");
		expect(buttons(html).map((button) => button.label)).not.toContain(
			"Try again",
		);
		expect(html).toContain('role="status"');
	});

	it("offers a retry that reuses the request when the outcome is unclear", () => {
		const html = render(
			flow(
				"answered",
				response({ state: "unknown", outcome: "unclear", spend: null }),
			),
		);
		expect(text(html)).toContain("Trying again is safe");
		expect(buttons(html).map((button) => button.label)).toContain("Try again");
	});

	it("points a refusal to /usage and Redeem reset in the Codex CLI", () => {
		const html = render(
			flow(
				"answered",
				response({ state: "refused", outcome: "refused", spend: null }),
			),
		);
		expect(text(html)).toContain("OpenAI refused the router's request.");
		expect(html).toContain("<code>/usage</code>");
		expect(html).toContain("<code>Redeem reset</code>");
		expect(buttons(html).map((button) => button.label)).not.toContain(
			"Try again",
		);
	});

	it("renders a 409 naming an open request with a retry", () => {
		const html = render(
			flow("answered", {
				kind: "error",
				status: 409,
				reason: "open_request",
				message: null,
				openRequestId: ID,
			}),
		);
		expect(text(html)).toContain(
			"An earlier request on this account has not finished.",
		);
		expect(buttons(html).map((button) => button.label)).toContain("Try again");
	});

	it("renders 'nothing was sent' with a retry", () => {
		const html = render(
			flow("answered", {
				kind: "error",
				status: 503,
				reason: "not_sent",
				message: null,
				openRequestId: null,
			}),
		);
		expect(text(html)).toContain("Nothing was sent to OpenAI.");
		expect(buttons(html).map((button) => button.label)).toContain("Try again");
	});
});

describe("UseResetPanel copy", () => {
	it("never reads as a prompt to spend, in any phase", () => {
		for (const html of [
			render(flow("confirm")),
			render(flow("sending")),
			render(flow("answered", response())),
			render(
				flow(
					"answered",
					response({ state: "refused", outcome: "refused", spend: null }),
				),
			),
		]) {
			expect(text(html)).not.toMatch(BANNED);
		}
	});
});
