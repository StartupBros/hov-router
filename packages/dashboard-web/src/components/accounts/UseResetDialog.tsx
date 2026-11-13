import type { AnthropicUsageData, BankedResets } from "@better-ccflare/types";
import { useRef, useState } from "react";
import type { Account } from "../../api";
import type { RedeemResetAnswer } from "../../lib/redeem-reset";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { formatBankedResetExpiry } from "./BankedResetsSummary";
import {
	accountResetWindows,
	describeRedeemAnswer,
	formatWindowReset,
	openResetFlow,
	type ResetFlowState,
	type ResetWindow,
	receiveAnswer,
	startSending,
} from "./reset-redemption-flow";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function spendSentence(resets: BankedResets): string {
	if (resets.soonestExpiresAt !== null) {
		return `It spends the reset that expires soonest, on ${formatBankedResetExpiry(resets.soonestExpiresAt)} UTC.`;
	}
	return resets.doesNotExpire
		? "It spends one reset. These resets do not expire."
		: "It spends one reset. OpenAI did not report when these expire.";
}

/** What using a reset does, before anything is sent (R9, KTD12). */
function ConfirmBody({
	resets,
	windows,
	now,
}: {
	resets: BankedResets;
	windows: ResetWindow[];
	now: number;
}) {
	const weekFromNow = `${formatBankedResetExpiry(now + SEVEN_DAYS_MS)} UTC`;
	return (
		<div className="space-y-3 text-sm">
			<div>
				<p>OpenAI says a reset:</p>
				<ul className="list-disc space-y-0.5 pl-5">
					<li>resets the 5-hour window;</li>
					<li>resets the weekly window on Pro plans;</li>
					<li>
						{`moves the weekly reset date to about 7 days after you use it (about ${weekFromNow}).`}
					</li>
				</ul>
			</div>
			<p>{spendSentence(resets)}</p>
			{windows.length > 0 ? (
				<div>
					<p>Without a reset, this account's windows reset:</p>
					<ul className="list-disc space-y-0.5 pl-5 tabular-nums">
						{windows.map((window) => (
							<li key={window.label}>
								{`${window.label}: ${formatWindowReset(window.resetsAt, now)}`}
							</li>
						))}
					</ul>
				</div>
			) : (
				<p>The router has no reset times for this account yet.</p>
			)}
		</div>
	);
}

export interface UseResetPanelProps {
	accountName: string;
	resets: BankedResets;
	windows: ResetWindow[];
	flow: ResetFlowState;
	now: number;
	onConfirm: () => void;
	onClose: () => void;
}

/**
 * The confirmation's header, body and footer, without the portal, so it can
 * be rendered on its own. Only "Use 1 reset" and "Try again" send anything,
 * and "No, go back" holds the initial focus.
 */
export function UseResetPanel({
	accountName,
	resets,
	windows,
	flow,
	now,
	onConfirm,
	onClose,
}: UseResetPanelProps) {
	const sending = flow.phase === "sending";
	const view =
		flow.phase === "answered" && flow.answer
			? describeRedeemAnswer(flow.answer)
			: null;

	return (
		<>
			<DialogHeader>
				<DialogTitle>
					{view
						? `Banked reset on ${accountName}`
						: `Use one banked reset on ${accountName}?`}
				</DialogTitle>
				<DialogDescription>
					{view ? "What happened to this request." : "This cannot be undone."}
				</DialogDescription>
			</DialogHeader>

			{!view && <ConfirmBody resets={resets} windows={windows} now={now} />}

			{/* One live region for both phases, so the result is announced. */}
			<div role="status" className="space-y-2 text-sm">
				{sending && <p>Sending the request to OpenAI...</p>}
				{view?.lines.map((line) => (
					<p key={line}>{line}</p>
				))}
				{view?.counts && <p className="tabular-nums">{view.counts}</p>}
				{view?.showsCliPointer && (
					<p>
						The Codex CLI signed in to this account can still redeem it: run{" "}
						<code>/usage</code> and choose <code>Redeem reset</code>.
					</p>
				)}
			</div>

			<DialogFooter>
				{view ? (
					<>
						{view.canRetry && (
							<Button variant="outline" onClick={onConfirm}>
								Try again
							</Button>
						)}
						<Button autoFocus onClick={onClose}>
							Close
						</Button>
					</>
				) : (
					<>
						<Button
							variant="outline"
							autoFocus
							disabled={sending}
							onClick={onClose}
						>
							No, go back
						</Button>
						<Button disabled={sending} onClick={onConfirm}>
							{sending ? "Sending..." : "Use 1 reset"}
						</Button>
					</>
				)}
			</DialogFooter>
		</>
	);
}

/**
 * The Use reset confirmation for one account. Mount it once per opening
 * (keyed by account id): the request id is minted on mount and reused by
 * every send from this opening.
 */
export function UseResetDialog({
	account,
	redeem,
	onClose,
}: {
	account: Account;
	redeem: (accountId: string, requestId: string) => Promise<RedeemResetAnswer>;
	onClose: () => void;
}) {
	const [flow, setFlow] = useState<ResetFlowState>(() => openResetFlow());
	// Controller-mounted dialogs have no Radix trigger to restore focus to.
	const [returnFocusTo] = useState(() =>
		typeof document !== "undefined" &&
		document.activeElement instanceof HTMLElement
			? document.activeElement
			: null,
	);
	// State updates land after the next render; the ref stops a fast second
	// click from sending before the buttons disable.
	const sendingRef = useRef(false);
	const resets = account.bankedResets;
	if (!resets) return null;

	const send = async () => {
		if (sendingRef.current) return;
		sendingRef.current = true;
		const { requestId } = flow;
		setFlow(startSending);
		let answer: RedeemResetAnswer;
		try {
			answer = await redeem(account.id, requestId);
		} catch {
			answer = { kind: "no_answer" };
		}
		sendingRef.current = false;
		setFlow((current) => receiveAnswer(current, answer));
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				// A request in flight cannot be called back, so the dialog stays
				// open until its answer arrives.
				if (!open && !sendingRef.current) onClose();
			}}
		>
			<DialogContent
				className="max-w-md"
				onCloseAutoFocus={(event) => {
					if (!returnFocusTo?.isConnected) return;
					event.preventDefault();
					returnFocusTo.focus();
				}}
			>
				<UseResetPanel
					accountName={account.name}
					resets={resets}
					// Codex usage arrives in the Anthropic window shape (RateLimitProgress).
					windows={accountResetWindows(
						account.usageData as AnthropicUsageData | null | undefined,
					)}
					flow={flow}
					now={Date.now()}
					onConfirm={send}
					onClose={onClose}
				/>
			</DialogContent>
		</Dialog>
	);
}
