import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RequestAgentBadge } from "./RequestAgentBadge";

const SESSION_ID = "0f3c9a1e-7b2d-4c55-9e10-3a1b2c3d4e5f";

describe("RequestAgentBadge", () => {
	it("renders nothing when the request has no agent or session", () => {
		expect(renderToStaticMarkup(<RequestAgentBadge view={null} />)).toBe("");
	});

	it("labels a session-id fallback as a session, with the full id on hover", () => {
		const html = renderToStaticMarkup(
			<RequestAgentBadge
				view={{ kind: "session", sessionId: SESSION_ID, shortId: "0f3c9a1e…" }}
			/>,
		);
		expect(html).toContain("Session 0f3c9a1e…");
		expect(html).toContain(`title="Claude Code session ${SESSION_ID}"`);
		expect(html).not.toContain("lucide-bot");
		expect(html).not.toContain("Agent");
	});

	it("shows an attributed agent with the agent icon and its source", () => {
		const html = renderToStaticMarkup(
			<RequestAgentBadge
				view={{ kind: "agent", name: "lean-reader", sourceLabel: "prompt" }}
			/>,
		);
		expect(html).toContain("lean-reader");
		expect(html).toContain("· prompt");
		expect(html).toContain("lucide-bot");
		expect(html).not.toContain("Session");
	});

	it("omits the source suffix when the source is unknown", () => {
		const html = renderToStaticMarkup(
			<RequestAgentBadge
				view={{ kind: "agent", name: "legacy-agent", sourceLabel: null }}
			/>,
		);
		expect(html).toContain("legacy-agent");
		expect(html).not.toContain("·");
	});
});
