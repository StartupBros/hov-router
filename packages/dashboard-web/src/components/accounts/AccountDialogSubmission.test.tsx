import { expect, mock, test } from "bun:test";
import * as React from "react";
import type { Account } from "../../api";

const states: unknown[] = [];
const refs: { current: unknown }[] = [];
const effects: unknown[][] = [];
let si = 0,
	ri = 0,
	ei = 0;
mock.module("react", () => ({
	...React,
	useState: (initial: unknown) => {
		const index = si++;
		if (!(index in states)) states[index] = initial;
		return [
			states[index],
			(value: unknown) => {
				states[index] =
					typeof value === "function" ? value(states[index]) : value;
			},
		];
	},
	useRef: (initial: unknown) => {
		const index = ri++;
		refs[index] ??= { current: initial };
		return refs[index];
	},
	useEffect: (effect: () => void, deps: unknown[]) => {
		const index = ei++;
		if (!effects[index] || deps.some((dep, i) => dep !== effects[index][i])) {
			effects[index] = deps;
			effect();
		}
	},
	useId: () => "error",
}));
const { RenameAccountDialog } = await import("./RenameAccountDialog");
const { AccountPriorityDialog } = await import("./AccountPriorityDialog");
const { AccountCustomEndpointDialog } = await import(
	"./AccountCustomEndpointDialog"
);
const { AccountModelMappingsDialog } = await import(
	"./AccountModelMappingsDialog"
);
const { DeleteConfirmationDialog } = await import("./DeleteConfirmationDialog");

interface TestProps {
	children?: React.ReactNode;
	id?: string;
	role?: string;
	value?: string;
	closeDisabled?: boolean;
	onChange?: (event: { target: { value: string } }) => void;
	onSubmit?: (event: { preventDefault(): void }) => unknown;
	onClick?: () => unknown;
}
function nodes(tree: React.ReactNode): React.ReactElement<TestProps>[] {
	if (!React.isValidElement<TestProps>(tree)) return [];
	return [tree, ...React.Children.toArray(tree.props.children).flatMap(nodes)];
}
const account = {
	id: "stable-id",
	name: "Account",
	priority: 0,
	provider: "ollama",
	customEndpoint: null,
};
for (const kind of ["rename", "priority", "endpoint", "mappings", "delete"]) {
	test(
		kind +
			" guards duplicate saves, shows failure, preserves draft, and restores dismissal",
		async () => {
			states.length = refs.length = effects.length = 0;
			let fail!: (error: Error) => void;
			let succeed!: () => void;
			let calls = 0,
				closes = 0;
			const save = () => {
				calls++;
				return new Promise<void>((resolve, reject) => {
					succeed = resolve;
					fail = reject;
				});
			};
			const close = () => {
				closes++;
			};
			const renderDialog = () => {
				si = ri = ei = 0;
				if (kind === "rename")
					return RenameAccountDialog({
						isOpen: true,
						currentName: "Account",
						onClose: close,
						onRename: save,
					});
				if (kind === "priority")
					return AccountPriorityDialog({
						account: account as Account,
						isOpen: true,
						onOpenChange: close,
						onUpdatePriority: save,
					});
				if (kind === "endpoint")
					return AccountCustomEndpointDialog({
						account,
						isOpen: true,
						onOpenChange: close,
						onUpdateEndpoint: save,
					});
				if (kind === "mappings")
					return AccountModelMappingsDialog({
						account: account as Account,
						isOpen: true,
						onOpenChange: close,
						onUpdateModelMappings: save,
					});
				return DeleteConfirmationDialog({
					accountName: "Account",
					confirmInput: "Account",
					onConfirmInputChange: () => {},
					onConfirm: save,
					onCancel: close,
				});
			};
			const render = () => {
				const node = renderDialog();
				if (!node) throw new Error("Expected open dialog");
				return node;
			};
			let tree = render();
			tree = render();
			if (kind === "delete")
				expect(
					nodes(tree).some((node) => node.props.children === "Remove account"),
				).toBe(true);
			if (kind === "rename") {
				const field = nodes(tree).find((node) => node.props.id === "new-name");
				if (!field?.props.onChange) throw new Error("Rename input missing");
				field.props.onChange({ target: { value: "Draft" } });
				tree = render();
			}
			const submit = () => {
				const form = nodes(tree).find((node) => node.type === "form");
				if (form?.props.onSubmit)
					return form.props.onSubmit({ preventDefault() {} });
				const action = nodes(tree)
					.filter((node) => node.props.onClick)
					.at(-1);
				if (!action?.props.onClick) throw new Error("Submit button missing");
				return action.props.onClick();
			};
			const first = submit();
			submit();
			expect(calls).toBe(1);
			tree = render();
			expect(
				nodes(tree).some((node) => node.props.closeDisabled === true),
			).toBe(true);
			tree.props.onOpenChange(false);
			expect(closes).toBe(0);
			fail(new Error("Synthetic save rejection"));
			await first;
			await Promise.resolve();
			await Promise.resolve();
			tree = render();
			expect(
				nodes(tree).some(
					(node) =>
						node.props.role === "alert" &&
						node.props.children === "Synthetic save rejection",
				),
			).toBe(true);
			if (kind === "rename")
				expect(
					nodes(tree).find((node) => node.props.id === "new-name")?.props.value,
				).toBe("Draft");
			tree.props.onOpenChange(false);
			expect(closes).toBe(1);
			const retry = submit();
			expect(calls).toBe(2);
			tree = render();
			expect(nodes(tree).some((node) => node.props.role === "alert")).toBe(
				false,
			);
			succeed();
			await retry;
			await Promise.resolve();
			await Promise.resolve();
			tree = render();
			expect(
				nodes(tree).some((node) => node.props.closeDisabled === true),
			).toBe(false);
			expect(closes).toBe(kind === "delete" ? 1 : 2);
		},
	);
}
