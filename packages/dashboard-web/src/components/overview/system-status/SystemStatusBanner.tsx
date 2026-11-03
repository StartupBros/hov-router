import {
	AlertTriangle,
	CheckCircle,
	HelpCircle,
	type LucideIcon,
	XCircle,
} from "lucide-react";
import { cn } from "../../../lib/utils";
import type {
	SystemStatusTone,
	SystemStatusView,
} from "./describeSystemStatus";

const TONE_STYLE: Record<
	SystemStatusTone,
	{ container: string; icon: LucideIcon; iconClass: string }
> = {
	ok: { container: "bg-success", icon: CheckCircle, iconClass: "text-success" },
	warning: {
		container: "bg-warning",
		icon: AlertTriangle,
		iconClass: "text-warning",
	},
	down: {
		container: "bg-destructive/10",
		icon: XCircle,
		iconClass: "text-destructive",
	},
	neutral: {
		container: "bg-muted",
		icon: HelpCircle,
		iconClass: "text-muted-foreground",
	},
};

/** The overview's status line. Tone sets the icon and tint; the title says it. */
export function SystemStatusBanner({ view }: { view: SystemStatusView }) {
	const { container, icon: Icon, iconClass } = TONE_STYLE[view.tone];
	return (
		<div
			role="status"
			className={cn("flex items-center gap-3 rounded-lg p-4", container)}
		>
			<Icon className={cn("h-5 w-5 shrink-0", iconClass)} aria-hidden="true" />
			<div>
				<p className="font-medium">{view.title}</p>
				<p className="text-sm text-muted-foreground">{view.detail}</p>
			</div>
		</div>
	);
}
