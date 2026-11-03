/** Tone of a status pill on the accounts page. Each tone has a dark-mode variant. */
export type StatusTone = "ok" | "warning" | "bad" | "muted";

export const STATUS_PILL_CLASS =
	"inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium";

export const STATUS_TONE_CLASS: Record<StatusTone, string> = {
	ok: "bg-green-500/10 text-green-800 dark:text-green-400",
	warning: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
	bad: "bg-destructive/10 text-red-700 dark:text-red-400",
	muted: "bg-muted text-foreground",
};
