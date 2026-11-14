import { expect, test } from "bun:test";
import { createDialogSubmission } from "./useDialogSubmission";

test("guards duplicates synchronously, exposes rejection, and permits retry", async () => {
	const flow = createDialogSubmission();
	let release!: () => void;
	let calls = 0;
	const errors: string[] = [];
	const work = () => {
		calls++;
		return new Promise<void>((resolve) => {
			release = resolve;
		});
	};
	const first = flow.run(
		work,
		() => {},
		(error) => errors.push(error),
	);
	await flow.run(
		work,
		() => {},
		(error) => errors.push(error),
	);
	expect(calls).toBe(1);
	expect(flow.pending).toBe(true);
	release();
	await first;
	expect(flow.pending).toBe(false);
	await flow.run(
		async () => {
			throw new Error("Save failed");
		},
		() => {},
		(error) => errors.push(error),
	);
	expect(errors).toEqual(["Save failed"]);
	expect(flow.pending).toBe(false);
	let saved = false;
	await flow.run(
		async () => {},
		() => {
			saved = true;
		},
		() => {},
	);
	expect(saved).toBe(true);
});

test("old completion cannot close or report errors to a new target", async () => {
	const flow = createDialogSubmission();
	let reject!: (error: Error) => void;
	let completed = false;
	const old = flow.run(
		() =>
			new Promise<void>((_, fail) => {
				reject = fail;
			}),
		() => {
			completed = true;
		},
		() => {
			completed = true;
		},
	);
	flow.reset();
	reject(new Error("old failure"));
	await old;
	expect(completed).toBe(false);
	expect(flow.pending).toBe(false);
});

test("a replaced target ignores an old successful completion", async () => {
	const flow = createDialogSubmission();
	let resolve!: () => void;
	let closed = false;
	const old = flow.run(
		() =>
			new Promise<void>((done) => {
				resolve = done;
			}),
		() => {
			closed = true;
		},
		() => {},
	);
	flow.reset();
	resolve();
	await old;
	expect(closed).toBe(false);
});
