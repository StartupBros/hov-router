import type {
	AgentAttributionSource,
	ProjectAttributionSource,
} from "@better-ccflare/types";

/**
 * Maps a raw attribution source enum value to a short human label.
 * Returns null for "none"/undefined so callers can render nothing when
 * there's no meaningful provenance to show.
 */
export function attributionSourceLabel(
	source?: ProjectAttributionSource | AgentAttributionSource | null,
): string | null {
	switch (source) {
		case "header_project":
		case "header_agent":
			return "header";
		case "path_project":
			return "path";
		case "heading_project":
			return "heading";
		case "prompt_agent":
			return "prompt";
		default:
			return null; // "none" / undefined -> no badge
	}
}

/**
 * What a request's `agentUsed` value actually names. When no agent is
 * declared or matched, the proxy falls back to the Claude Code session id
 * (source `session_header`), so that value is a session, not an agent.
 */
export type RequestAgentView =
	| { kind: "agent"; name: string; sourceLabel: string | null }
	| { kind: "session"; sessionId: string; shortId: string };

export function shortSessionId(sessionId: string): string {
	return sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId;
}

export function describeRequestAgent(
	agentUsed?: string | null,
	source?: AgentAttributionSource | null,
): RequestAgentView | null {
	if (!agentUsed) return null;
	if (source === "session_header") {
		return {
			kind: "session",
			sessionId: agentUsed,
			shortId: shortSessionId(agentUsed),
		};
	}
	return {
		kind: "agent",
		name: agentUsed,
		sourceLabel: attributionSourceLabel(source),
	};
}

export interface AgentFilterOptions {
	agents: string[];
	sessions: Array<{ value: string; label: string }>;
}

/**
 * Splits the distinct `agentUsed` values of a request list into real agents
 * and session-id fallbacks, each sorted. A value any request attributed to an
 * agent is listed as an agent.
 */
export function groupAgentFilterOptions(
	entries: Iterable<{
		agentUsed?: string | null;
		source?: AgentAttributionSource | null;
	}>,
): AgentFilterOptions {
	const agents = new Set<string>();
	const sessions = new Set<string>();
	for (const { agentUsed, source } of entries) {
		if (!agentUsed) continue;
		if (source === "session_header") sessions.add(agentUsed);
		else agents.add(agentUsed);
	}
	return {
		agents: [...agents].sort(),
		sessions: [...sessions]
			.filter((id) => !agents.has(id))
			.sort()
			.map((id) => ({ value: id, label: `Session ${shortSessionId(id)}` })),
	};
}
