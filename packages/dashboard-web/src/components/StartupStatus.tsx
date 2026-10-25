import { PRODUCT_NAME } from "@better-ccflare/core/product-identity";
import { Button } from "./ui/button";

export function StartupCheckingView({ slow }: { slow: boolean }) {
	return (
		<div className="min-h-screen bg-background flex items-center justify-center">
			<div className="text-center max-w-md px-4">
				<div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4" />
				{slow ? (
					<>
						<p className="text-muted-foreground">
							Waiting for {PRODUCT_NAME}...
						</p>
						<p className="text-muted-foreground text-sm mt-2">
							It may be restarting after an update. This page loads as soon as
							it answers.
						</p>
					</>
				) : (
					<p className="text-muted-foreground">Checking authentication...</p>
				)}
			</div>
		</div>
	);
}

export function RouterUnreachableView({
	message,
	retrying,
	onRetry,
}: {
	message: string;
	retrying: boolean;
	onRetry: () => void;
}) {
	return (
		<div className="min-h-screen bg-background flex items-center justify-center">
			<div className="text-center max-w-md px-4 space-y-3">
				<h1 className="text-xl font-semibold">Can't reach {PRODUCT_NAME}</h1>
				<p className="text-muted-foreground">
					It may be restarting after an update. This page keeps retrying and
					loads as soon as the router answers.
				</p>
				<p className="text-muted-foreground text-sm">Last error: {message}</p>
				<Button onClick={onRetry} disabled={retrying}>
					{retrying ? "Retrying..." : "Retry now"}
				</Button>
			</div>
		</div>
	);
}
