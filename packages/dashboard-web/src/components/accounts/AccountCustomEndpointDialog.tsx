import { useEffect, useId, useRef, useState } from "react";
import { useDialogSubmission } from "../../hooks/useDialogSubmission";
import { getDefaultEndpointForProvider } from "../../utils/provider-utils";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

interface AccountCustomEndpointDialogProps {
	isOpen: boolean;
	account: {
		id: string;
		name: string;
		provider: string;
		customEndpoint: string | null;
	} | null;
	onOpenChange: (open: boolean) => void;
	onUpdateEndpoint: (
		accountId: string,
		customEndpoint: string | null,
	) => Promise<void>;
	isLoading?: boolean;
}

export function AccountCustomEndpointDialog({
	isOpen,
	account,
	onOpenChange,
	onUpdateEndpoint,
	isLoading = false,
}: AccountCustomEndpointDialogProps) {
	const [customEndpoint, setCustomEndpoint] = useState("");
	const [error, setError] = useState<string | null>(null);
	const errorId = useId();
	const submission = useDialogSubmission(account?.id, isOpen, isLoading);
	const busy = submission.pending;

	const initialAccount = useRef(account);
	initialAccount.current = account;
	const accountId = account?.id;
	// Initialize custom endpoint when dialog opens or account changes
	useEffect(() => {
		if (!isOpen || !accountId) return;
		const account = initialAccount.current;
		setCustomEndpoint(account?.customEndpoint || "");
		setError(null);
	}, [isOpen, accountId]);

	const validateEndpoint = (endpoint: string): boolean => {
		if (!endpoint) return true; // Empty is fine (use default)
		try {
			new URL(endpoint);
			return true;
		} catch {
			return false;
		}
	};

	const handleSave = async () => {
		if (!account || !submission.canSubmit()) return;
		submission.clearError();

		if (customEndpoint && !validateEndpoint(customEndpoint)) {
			setError(
				"Custom endpoint must be a valid URL (e.g., https://api.anthropic.com)",
			);
			return;
		}

		setError(null);
		await submission.submit(
			() => onUpdateEndpoint(account.id, customEndpoint.trim() || null),
			() => onOpenChange(false),
		);
	};

	const defaultPlaceholder = account?.provider
		? getDefaultEndpointForProvider(account.provider)
		: "https://api.anthropic.com";

	return (
		<Dialog
			open={isOpen}
			onOpenChange={(open) => submission.close(() => onOpenChange(open))}
		>
			<DialogContent closeDisabled={busy} className="sm:max-w-[425px]">
				<DialogHeader>
					<DialogTitle>Custom Endpoint</DialogTitle>
					<DialogDescription>
						Configure a custom API endpoint for{" "}
						<span className="font-medium">{account?.name}</span>
						{account?.provider && (
							<span className="text-muted-foreground">
								{" "}
								(Provider: {account.provider})
							</span>
						)}
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-4 py-4">
					<div className="grid gap-2">
						<Label htmlFor="customEndpoint">Custom Endpoint</Label>
						<Input
							id="customEndpoint"
							disabled={busy}
							value={customEndpoint}
							onChange={(e) => {
								setCustomEndpoint(e.target.value);
								setError(null);
							}}
							placeholder={defaultPlaceholder}
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? errorId : undefined}
							className={error ? "border-destructive" : ""}
						/>
						<p className="text-xs text-muted-foreground">
							Leave empty to use default endpoint ({defaultPlaceholder})
						</p>
						{error && (
							<p id={errorId} role="alert" className="text-xs text-destructive">
								{error}
							</p>
						)}
					</div>
				</div>
				{submission.error && (
					<p role="alert" className="text-sm text-destructive">
						{submission.error}
					</p>
				)}
				<DialogFooter className="[&>button]:min-h-11">
					<Button
						type="button"
						variant="outline"
						onClick={() => submission.close(() => onOpenChange(false))}
						disabled={busy}
					>
						Cancel
					</Button>
					<Button type="button" onClick={handleSave} disabled={busy}>
						{busy ? "Saving..." : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
