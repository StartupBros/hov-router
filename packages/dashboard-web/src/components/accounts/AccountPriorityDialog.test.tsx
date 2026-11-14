import { expect, test } from "bun:test";
import { parseAccountPriority } from "./AccountPriorityDialog";

test("priority accepts only nonblank whole numbers in the inclusive range", () => {
	for (const input of ["", " ", "1.2", "-1", "101", "1abc", "Infinity"])
		expect(parseAccountPriority(input)).toBeNull();
	expect(parseAccountPriority("0")).toBe(0);
	expect(parseAccountPriority("100")).toBe(100);
	expect(parseAccountPriority(" 42 ")).toBe(42);
});
