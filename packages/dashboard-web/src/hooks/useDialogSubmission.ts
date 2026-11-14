import { useEffect, useRef, useState } from "react";

export function createDialogSubmission() {
	let generation = 0;
	let pending = false;
	return {
		get pending() {
			return pending;
		},
		reset() {
			generation++;
			pending = false;
		},
		async run(
			work: () => void | Promise<void>,
			success: () => void,
			failure: (message: string) => void,
		) {
			if (pending) return;
			pending = true;
			const started = generation;
			try {
				await work();
				if (started === generation) success();
			} catch (error) {
				if (started === generation)
					failure(
						error instanceof Error
							? error.message
							: "Unable to save account changes",
					);
			} finally {
				if (started === generation) pending = false;
			}
		},
	};
}

export function useDialogSubmission(
	target: string | undefined,
	open: boolean,
	externalPending = false,
) {
	const flow = useRef(createDialogSubmission());
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (!open || target === undefined) {
			flow.current.reset();
			setPending(false);
			setError(null);
			return;
		}
		flow.current.reset();
		setPending(false);
		setError(null);
		return () => flow.current.reset();
	}, [target, open]);
	const blocked = () => externalPending || flow.current.pending;
	return {
		pending: pending || externalPending,
		error,
		clearError: () => setError(null),
		canSubmit: () => !blocked(),
		close: (callback: () => void) => {
			if (!blocked()) callback();
		},
		async submit(work: () => void | Promise<void>, success: () => void) {
			if (blocked()) return;
			setError(null);
			setPending(true);
			const current = flow.current;
			await current.run(work, success, setError);
			if (!current.pending) setPending(false);
		},
	};
}
