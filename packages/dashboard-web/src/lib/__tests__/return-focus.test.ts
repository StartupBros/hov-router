/**
 * This package has no DOM test environment (see LiveCountdown.test.tsx), so
 * these tests drive resolveReturnFocus with minimal element stand-ins that
 * implement only what it reads. The real focus behaviour is checked in a
 * browser keyboard walk; these pin the decision logic.
 */
import { describe, expect, it } from "bun:test";
import { resolveReturnFocus } from "../return-focus";

type Stub = {
	id?: string;
	role?: string;
	labelledBy?: string;
	parent?: Stub;
	ownerDocument: FakeDocument;
};

class FakeDocument {
	body: Stub;
	private byId = new Map<string, Stub>();
	constructor() {
		this.body = { ownerDocument: this };
	}
	add(stub: Omit<Stub, "ownerDocument">): Stub {
		const el: Stub = { ...stub, ownerDocument: this };
		if (el.id) this.byId.set(el.id, el);
		return el;
	}
	getElementById(id: string) {
		return this.byId.get(id) ?? null;
	}
}

function asElement(stub: Stub): Element {
	return {
		ownerDocument: stub.ownerDocument,
		closest(selector: string) {
			expect(selector).toBe('[role="menu"]');
			for (let node: Stub | undefined = stub; node; node = node.parent) {
				if (node.role === "menu") {
					return {
						getAttribute: (name: string) =>
							name === "aria-labelledby" ? (node.labelledBy ?? null) : null,
					};
				}
			}
			return null;
		},
	} as unknown as Element;
}

describe("resolveReturnFocus", () => {
	it("returns null when nothing was focused", () => {
		expect(resolveReturnFocus(null)).toBeNull();
	});

	it("returns null for <body>, keeping the Radix default", () => {
		const doc = new FakeDocument();
		const body = doc.body as unknown as Element;
		expect(resolveReturnFocus(body)).toBeNull();
	});

	it("returns a plain opener itself", () => {
		const doc = new FakeDocument();
		const button = doc.add({ id: "open-settings" });
		const el = asElement(button);
		expect(resolveReturnFocus(el)).toBe(el as HTMLElement);
	});

	it("returns the menu trigger when a menu item opened the dialog", () => {
		const doc = new FakeDocument();
		const trigger = doc.add({ id: "radix-trigger-1" });
		const menu = doc.add({ role: "menu", labelledBy: "radix-trigger-1" });
		const item = doc.add({ role: "menuitem", parent: menu });
		expect(resolveReturnFocus(asElement(item))).toBe(
			trigger as unknown as HTMLElement,
		);
	});

	it("returns null for a menu with no labelling trigger", () => {
		const doc = new FakeDocument();
		const menu = doc.add({ role: "menu" });
		const item = doc.add({ role: "menuitem", parent: menu });
		expect(resolveReturnFocus(asElement(item))).toBeNull();
	});

	it("returns null when the menu's trigger is no longer in the document", () => {
		const doc = new FakeDocument();
		const menu = doc.add({ role: "menu", labelledBy: "gone" });
		const item = doc.add({ role: "menuitem", parent: menu });
		expect(resolveReturnFocus(asElement(item))).toBeNull();
	});
});
