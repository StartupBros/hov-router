import { Bot } from "lucide-react";
import type { RequestAgentView } from "../lib/attribution";
import { Badge } from "./ui/badge";

interface RequestAgentBadgeProps {
	view: RequestAgentView | null;
	className?: string;
}

/**
 * Shows which agent a request came from, or, when the proxy only had the
 * Claude Code session id to go on, which session.
 */
export function RequestAgentBadge({ view, className }: RequestAgentBadgeProps) {
	if (!view) return null;

	if (view.kind === "session") {
		return (
			<Badge
				variant="secondary"
				className={className}
				title={`Claude Code session ${view.sessionId}`}
			>
				Session {view.shortId}
			</Badge>
		);
	}

	return (
		<Badge variant="secondary" className={className}>
			<Bot className="h-3 w-3 mr-1" />
			{view.name}
			{view.sourceLabel && (
				<span className="text-muted-foreground/70 ml-1">
					· {view.sourceLabel}
				</span>
			)}
		</Badge>
	);
}
