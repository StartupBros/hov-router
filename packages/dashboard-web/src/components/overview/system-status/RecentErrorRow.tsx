import type { RecentErrorGroup } from "@better-ccflare/types";
import { formatTimestamp } from "@better-ccflare/ui-common";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, X, XCircle } from "lucide-react";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { getErrorMeta } from "./errorCodeMeta";

interface RecentErrorRowProps {
	error: RecentErrorGroup;
	otherAccountsAvailable: boolean;
	onClick: () => void;
	onDismiss: () => void;
}

function accountLabel(error: RecentErrorGroup): string {
	if (error.accountName) return error.accountName;
	if (error.accountId === null) return "Unauthenticated";
	return "Deleted account";
}

export function RecentErrorRow({
	error,
	otherAccountsAvailable,
	onClick,
	onDismiss,
}: RecentErrorRowProps) {
	const meta = getErrorMeta(error.errorCode, {
		provider: error.provider,
		otherAccountsAvailable,
	});
	const isWarning = meta.severity === "warning";
	const Icon = isWarning ? AlertTriangle : XCircle;
	const bgClass = isWarning ? "bg-warning/10" : "bg-destructive/10";
	const iconColor = isWarning ? "text-warning" : "text-destructive";

	const relativeTime = formatDistanceToNow(new Date(error.latestTimestamp), {
		addSuffix: true,
	});
	const absoluteTime = formatTimestamp(error.latestTimestamp);

	return (
		<div
			className={`relative w-full text-left p-3 rounded-lg flex items-start gap-2 transition-colors ${bgClass}`}
		>
			<button
				type="button"
				onClick={onClick}
				aria-label={`View details: ${meta.title}`}
				title={absoluteTime}
				className="absolute inset-0 rounded-lg cursor-pointer hover:bg-foreground/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			/>
			<Icon
				className={`pointer-events-none h-4 w-4 mt-0.5 shrink-0 ${iconColor}`}
			/>
			<div className="pointer-events-none relative flex-1 min-w-0">
				<p className="text-sm font-medium truncate">{meta.title}</p>
				<p className="text-xs text-foreground/70 truncate">
					{accountLabel(error)}
					{error.model ? ` · ${error.model}` : ""}
					{error.statusCode != null ? ` · ${error.statusCode}` : ""}
				</p>
			</div>
			<div className="pointer-events-none relative flex items-center gap-2 shrink-0">
				{error.occurrenceCount > 1 && (
					<Badge
						variant="secondary"
						aria-label={`${error.occurrenceCount} occurrences`}
					>
						×{error.occurrenceCount}
					</Badge>
				)}
				<span className="text-xs text-foreground/70 whitespace-nowrap">
					{relativeTime}
				</span>
				<Button
					variant="ghost"
					size="sm"
					className="pointer-events-auto relative z-10 h-7 w-7 p-0"
					aria-label="Dismiss error"
					onClick={(e) => {
						e.stopPropagation();
						onDismiss();
					}}
				>
					<X className="h-3.5 w-3.5" />
				</Button>
			</div>
		</div>
	);
}
