import { stdPromptAdapter } from "./std-adapter";

// Re-export adapter types
export type { PromptAdapter } from "./adapter";
export { stdPromptAdapter } from "./std-adapter";

/**
 * Prompt user to confirm account removal
 */
export async function promptAccountRemovalConfirmation(
	accountName: string,
): Promise<boolean> {
	console.info(
		`\n⚠️  WARNING: You are about to remove the account '${accountName}'`,
	);
	console.info("This action cannot be undone.");
	console.info("\nTo confirm, please type the account name exactly:");

	const confirmation = await stdPromptAdapter.input(
		`Type '${accountName}' to confirm deletion: `,
	);

	if (!confirmation) {
		return false;
	}

	return confirmation === accountName;
}
