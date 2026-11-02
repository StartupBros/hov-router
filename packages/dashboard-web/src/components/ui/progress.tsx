import * as ProgressPrimitive from "@radix-ui/react-progress";
import * as React from "react";
import { cn } from "../../lib/utils";

const Progress = React.forwardRef<
	React.ElementRef<typeof ProgressPrimitive.Root>,
	React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & {
		indicatorClassName?: string;
	}
>(({ className, indicatorClassName, value, max, ...props }, ref) => {
	const limit = max ?? 100;
	const clamped = value == null ? value : Math.min(limit, Math.max(0, value));
	return (
		<ProgressPrimitive.Root
			ref={ref}
			value={clamped}
			max={max}
			className={cn(
				"relative h-2 w-full overflow-hidden rounded-full bg-secondary",
				className,
			)}
			{...props}
		>
			<ProgressPrimitive.Indicator
				className={cn(
					"h-full w-full flex-1 bg-primary transition-all duration-700 ease-out",
					indicatorClassName,
				)}
				style={{
					transform: `translateX(-${100 - ((clamped || 0) / limit) * 100}%)`,
				}}
			/>
		</ProgressPrimitive.Root>
	);
});
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
