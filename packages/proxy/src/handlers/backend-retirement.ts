/** Process-local ownership of outbound OAuth refresh during deploy overlap. */
let retiring = false;
export function markBackendRetiring(): void {
	retiring = true;
}
export function isBackendRetiring(): boolean {
	return retiring;
}
export function resetBackendRetirementForTests(): void {
	retiring = false;
}
