import { useEffect, useRef, useState } from "react";
import type { Account } from "../../api";
import { useDialogSubmission } from "../../hooks/useDialogSubmission";
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

interface AccountPriorityDialogProps {
	account: Account | null;
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	onUpdatePriority: (accountId: string, priority: number) => Promise<void>;
}

export function parseAccountPriority(value: string): number | null {
	const number = Number(value);
	return value.trim() &&
		Number.isInteger(number) &&
		number >= 0 &&
		number <= 100
		? number
		: null;
}

export function AccountPriorityDialog({
	account,
	isOpen,
	onOpenChange,
	onUpdatePriority,
}: AccountPriorityDialogProps) {
	const [priority, setPriority] = useState(
		account?.priority?.toString() || "0",
	);
	const submission = useDialogSubmission(account?.id, isOpen);
	const isUpdating = submission.pending;
	const [validationError, setValidationError] = useState("");

	const initialAccount = useRef(account);
	initialAccount.current = account;
	const accountId = account?.id;
	// Reset priority when account changes or dialog opens
	useEffect(() => {
		if (!isOpen || !accountId) return;
		const account = initialAccount.current;
		if (account) {
			setPriority(account.priority?.toString() || "0");
		}
		setValidationError("");
	}, [accountId, isOpen]);

	const handleUpdate = async () => {
		if (!account) return;

		if (!submission.canSubmit()) return;
		submission.clearError();
		const priorityValue = parseAccountPriority(priority);
		if (priorityValue === null) {
			setValidationError("Enter a whole number from 0 to 100.");
			return;
		}
		setValidationError("");
		await submission.submit(
			() => onUpdatePriority(account.id, priorityValue),
			() => onOpenChange(false),
		);
	};

	return (
		<Dialog
			open={isOpen}
			onOpenChange={(open) => submission.close(() => onOpenChange(open))}
		>
			<DialogContent closeDisabled={isUpdating} className="sm:max-w-[425px]">
				<DialogHeader>
					<DialogTitle>Change Account Priority</DialogTitle>
					<DialogDescription>
						Set the priority for {account?.name}. Lower priority values (0-100)
						will make this account more likely to be selected for requests.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-4 py-4">
					<div className="grid grid-cols-4 items-center gap-4">
						<Label htmlFor="priority" className="text-right">
							Priority
						</Label>
						<Input
							id="priority"
							disabled={isUpdating}
							type="number"
							min="0"
							max="100"
							value={priority}
							onChange={(e) => setPriority(e.target.value)}
							className="col-span-3"
						/>
					</div>
					<div className="text-sm text-muted-foreground">
						Current priority: {account?.priority || 0}. Enter a whole number
						from 0 to 100.
					</div>
				</div>
				{(validationError || submission.error) && (
					<p role="alert" className="text-sm text-destructive">
						{validationError || submission.error}
					</p>
				)}
				<DialogFooter className="[&>button]:min-h-11">
					<Button
						type="button"
						variant="outline"
						disabled={isUpdating}
						onClick={() => submission.close(() => onOpenChange(false))}
					>
						Cancel
					</Button>
					<Button type="button" onClick={handleUpdate} disabled={isUpdating}>
						{isUpdating ? "Updating..." : "Update Priority"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
