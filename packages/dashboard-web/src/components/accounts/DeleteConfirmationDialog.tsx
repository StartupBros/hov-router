import { AlertCircle } from "lucide-react";
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

interface DeleteConfirmationDialogProps {
	accountName: string;
	confirmInput: string;
	onConfirmInputChange: (value: string) => void;
	onConfirm: () => void;
	onCancel: () => void;
}

export function DeleteConfirmationDialog({
	accountName,
	confirmInput,
	onConfirmInputChange,
	onConfirm,
	onCancel,
}: DeleteConfirmationDialogProps) {
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onCancel();
			}}
		>
			<DialogContent
				role="alertdialog"
				className="max-w-md"
				// A stray click outside must not dismiss a typed-name confirmation.
				onInteractOutside={(event) => event.preventDefault()}
			>
				<DialogHeader>
					<DialogTitle>Confirm Account Removal</DialogTitle>
					<DialogDescription>This action cannot be undone.</DialogDescription>
				</DialogHeader>
				<div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
					<div className="flex items-center gap-2 text-destructive">
						<AlertCircle className="h-5 w-5" aria-hidden="true" />
						<p className="font-medium">Warning</p>
					</div>
					<p className="text-sm mt-2">
						You are about to permanently remove the account '{accountName}'.
						This will delete all associated data and cannot be recovered.
					</p>
				</div>
				<div className="space-y-2">
					<Label htmlFor="confirm-input">
						Type <span className="font-mono font-semibold">{accountName}</span>{" "}
						to confirm:
					</Label>
					<Input
						id="confirm-input"
						value={confirmInput}
						onChange={(e) => onConfirmInputChange(e.target.value)}
						placeholder="Enter account name"
						autoComplete="off"
					/>
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={onCancel}>
						Cancel
					</Button>
					<Button
						variant="destructive"
						onClick={onConfirm}
						disabled={confirmInput !== accountName}
					>
						Delete Account
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
