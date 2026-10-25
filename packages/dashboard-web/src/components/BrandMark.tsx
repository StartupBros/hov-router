import { cn } from "../lib/utils";

interface BrandMarkProps {
	className?: string;
}

/**
 * Placeholder HoV Router mark: an "H" whose crossbar is a route with a hub node.
 * Mirrors favicon.svg but uses currentColor so it follows the theme. Decorative:
 * it always sits next to the product name, so it is hidden from assistive tech.
 */
export function BrandMark({ className }: BrandMarkProps) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			aria-hidden="true"
			focusable="false"
			className={cn("h-6 w-6", className)}
			data-testid="brand-mark"
		>
			<g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
				<path d="M7 5.5v13M17 5.5v13M7 12h10" />
			</g>
			<circle cx="12" cy="12" r="2.2" fill="currentColor" />
		</svg>
	);
}
