import { reauthInstruction } from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	checkAllAccountsHealth,
	formatTokenHealthReport,
	getAccountsNeedingReauth,
} from "@better-ccflare/proxy";

/**
 * Check token health for all accounts
 */
export async function checkTokenHealth(
	dbOps: DatabaseOperations,
): Promise<void> {
	const accounts = await dbOps.getAllAccounts();
	const healthReport = checkAllAccountsHealth(accounts);

	console.log(formatTokenHealthReport(healthReport));
}

/**
 * Check accounts that need re-authentication
 */
export async function checkReauthNeeded(
	dbOps: DatabaseOperations,
): Promise<void> {
	const accounts = await dbOps.getAllAccounts();
	const needsReauth = getAccountsNeedingReauth(accounts);

	if (needsReauth.length === 0) {
		console.log(
			"✅ All accounts have valid tokens. No re-authentication needed.",
		);
		return;
	}

	console.log(
		`🔄 Found ${needsReauth.length} account(s) that need re-authentication:\n`,
	);

	needsReauth.forEach((account) => {
		const instruction = reauthInstruction(account.provider, account.name, {
			hasRefreshToken: !!account.refresh_token,
		});
		console.log(`  - ${account.name} (${account.provider}): ${instruction}`);
	});

	console.log("\n💡 Or run the health check for detailed information:");
	console.log("  bun run cli --token-health");
}
