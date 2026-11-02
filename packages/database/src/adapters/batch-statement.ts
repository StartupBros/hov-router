// Dependency-free so the writer worker bundle can share the batch contract
// with the adapter: callers branch on `instanceof BatchExpectedChangesError`.

export interface BatchStatement {
	sql: string;
	params?: unknown[];
	expectedChanges?: number;
}

export class BatchExpectedChangesError extends Error {
	constructor(
		readonly statementIndex: number,
		readonly expectedChanges: number,
		readonly actualChanges: number,
	) {
		super(
			`Batch statement ${statementIndex + 1} expected ${expectedChanges} change(s), got ${actualChanges}`,
		);
		this.name = "BatchExpectedChangesError";
	}
}

export function assertExpectedChanges(
	statement: BatchStatement,
	actualChanges: number,
	index: number,
): void {
	if (
		statement.expectedChanges !== undefined &&
		actualChanges !== statement.expectedChanges
	) {
		throw new BatchExpectedChangesError(
			index,
			statement.expectedChanges,
			actualChanges,
		);
	}
}
