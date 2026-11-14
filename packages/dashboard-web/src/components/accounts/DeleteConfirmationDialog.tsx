import { AlertCircle } from "lucide-react";
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

interface DeleteConfirmationDialogProps {
	accountName: string;
	confirmInput: string;
	onConfirmInputChange: (value: string) => void;
	onConfirm: () => void | Promise<void>;
	onCancel: () => void;
}

export function DeleteConfirmationDialog({
	accountName,
	confirmInput,
	onConfirmInputChange,
	onConfirm,
	onCancel,
}: DeleteConfirmationDialogProps) {
	const submission = useDialogSubmission(accountName, true);
	const busy = submission.pending;
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) submission.close(onCancel);
			}}
		>
			<DialogContent
				role="alertdialog"
				closeDisabled={busy}
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
						You are about to remove the account '{accountName}' from this
						router. Historical request records are retained.
					</p>
				</div>
				<div className="space-y-2">
					<Label htmlFor="confirm-input">
						Type <span className="font-mono font-semibold">{accountName}</span>{" "}
						to confirm:
					</Label>
					<Input
						id="confirm-input"
						disabled={busy}
						value={confirmInput}
						onChange={(e) => onConfirmInputChange(e.target.value)}
						placeholder="Enter account name"
						autoComplete="off"
					/>
				</div>
				{submission.error && (
					<p role="alert" className="text-sm text-destructive">
						{submission.error}
					</p>
				)}
				<DialogFooter className="[&>button]:min-h-11">
					<Button
						variant="outline"
						disabled={busy}
						onClick={() => submission.close(onCancel)}
					>
						Cancel
					</Button>
					<Button
						variant="destructive"
						onClick={() => {
							if (confirmInput === accountName)
								void submission.submit(onConfirm, () => {});
						}}
						disabled={busy || confirmInput !== accountName}
					>
						{busy ? "Removing..." : "Remove account"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
