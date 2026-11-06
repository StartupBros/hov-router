import { describe, expect, it } from "bun:test";
import {
	attributionSourceLabel,
	describeRequestAgent,
	groupAgentFilterOptions,
	shortSessionId,
} from "../attribution";

const SESSION_A = "0f3c9a1e-7b2d-4c55-9e10-3a1b2c3d4e5f";
const SESSION_B = "9a8b7c6d-1111-4222-8333-444455556666";

describe("attributionSourceLabel", () => {
	it("maps header_project to 'header'", () => {
		expect(attributionSourceLabel("header_project")).toBe("header");
	});

	it("maps header_agent to 'header'", () => {
		expect(attributionSourceLabel("header_agent")).toBe("header");
	});

	it("maps path_project to 'path'", () => {
		expect(attributionSourceLabel("path_project")).toBe("path");
	});

	it("maps heading_project to 'heading'", () => {
		expect(attributionSourceLabel("heading_project")).toBe("heading");
	});

	it("maps prompt_agent to 'prompt'", () => {
		expect(attributionSourceLabel("prompt_agent")).toBe("prompt");
	});

	it("maps 'none' to null", () => {
		expect(attributionSourceLabel("none")).toBeNull();
	});

	it("maps undefined to null", () => {
		expect(attributionSourceLabel(undefined)).toBeNull();
	});
});

describe("shortSessionId", () => {
	it("shortens a UUID to its first 8 characters", () => {
		expect(shortSessionId(SESSION_A)).toBe("0f3c9a1e…");
	});

	it("keeps an already short id whole", () => {
		expect(shortSessionId("sess-42")).toBe("sess-42");
	});
});

describe("describeRequestAgent", () => {
	for (const empty of [undefined, null, ""]) {
		it(`returns null when no agent value is recorded (${JSON.stringify(empty)})`, () => {
			expect(describeRequestAgent(empty, "prompt_agent")).toBeNull();
		});
	}

	it("reports a session-id fallback as a session, not an agent", () => {
		expect(describeRequestAgent(SESSION_A, "session_header")).toEqual({
			kind: "session",
			sessionId: SESSION_A,
			shortId: "0f3c9a1e…",
		});
	});

	it("reports a prompt-matched agent with its source", () => {
		expect(describeRequestAgent("lean-reader", "prompt_agent")).toEqual({
			kind: "agent",
			name: "lean-reader",
			sourceLabel: "prompt",
		});
	});

	it("reports a header-declared agent with its source", () => {
		expect(describeRequestAgent("planner", "header_agent")).toEqual({
			kind: "agent",
			name: "planner",
			sourceLabel: "header",
		});
	});

	it("keeps a value with no recorded source as an agent without a source label", () => {
		expect(describeRequestAgent("legacy-agent", undefined)).toEqual({
			kind: "agent",
			name: "legacy-agent",
			sourceLabel: null,
		});
	});
});

describe("groupAgentFilterOptions", () => {
	it("separates agents from session ids, deduplicated", () => {
		const options = groupAgentFilterOptions([
			{ agentUsed: SESSION_A, source: "session_header" },
			{ agentUsed: "lean-reader", source: "prompt_agent" },
			{ agentUsed: SESSION_B, source: "session_header" },
			{ agentUsed: "lean-collector", source: "prompt_agent" },
			{ agentUsed: SESSION_A, source: "session_header" },
			{ agentUsed: "lean-reader", source: "prompt_agent" },
			{ agentUsed: undefined, source: "none" },
			{ agentUsed: "", source: "none" },
		]);
		expect(options.agents).toEqual(["lean-collector", "lean-reader"]);
		expect(options.sessions).toEqual([
			{ value: SESSION_A, label: "Session 0f3c9a1e…" },
			{ value: SESSION_B, label: "Session 9a8b7c6d…" },
		]);
	});

	it("lists a value under agents when any request attributed it to an agent", () => {
		const options = groupAgentFilterOptions([
			{ agentUsed: "shared-name", source: "session_header" },
			{ agentUsed: "shared-name", source: "header_agent" },
		]);
		expect(options.agents).toEqual(["shared-name"]);
		expect(options.sessions).toEqual([]);
	});

	it("returns empty groups for no requests", () => {
		expect(groupAgentFilterOptions([])).toEqual({ agents: [], sessions: [] });
	});
});
