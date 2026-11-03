/**
 * Where focus should go when a dialog closes.
 *
 * Radix Dialog sends focus back to its `DialogTrigger`. Most dashboard dialogs
 * have none: they are controlled, and the account dialogs open from a row menu
 * item that has unmounted by the time the dialog closes, so focus fell to
 * `<body>` and keyboard users lost their place (#695).
 *
 * Call this with the element focused when the dialog opened. A menu item
 * resolves to the button that opens its menu (Radix labels the menu with that
 * trigger's id); any other element resolves to itself. `<body>` and `null`
 * resolve to `null`, which leaves the Radix default in place.
 */
export function resolveReturnFocus(opener: Element | null): HTMLElement | null {
	if (!opener || opener === opener.ownerDocument.body) return null;
	const menu = opener.closest('[role="menu"]');
	if (!menu) return opener as HTMLElement;
	const triggerId = menu.getAttribute("aria-labelledby");
	if (!triggerId) return null;
	return opener.ownerDocument.getElementById(triggerId);
}
