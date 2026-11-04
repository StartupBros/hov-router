import { PRODUCT_NAME } from "@better-ccflare/core/product-identity";
import type { BunSqlAdapter } from "@better-ccflare/database";

type AccountNamesDb = Pick<BunSqlAdapter, "query">;

interface WarningLog {
	warn(message: string): void;
	error(message: string, ...args: unknown[]): void;
}

/**
 * Names of accounts whose stored auto-refresh setting is still on. The column
 * is kept (no migration) but nothing reads it for routing any more.
 */
export async function readAutoRefreshOptedInAccountNames(
	db: AccountNamesDb,
): Promise<string[]> {
	const rows = await db.query<{ name: string }>(
		"SELECT name FROM accounts WHERE COALESCE(auto_refresh_enabled, 0) = 1 ORDER BY name",
	);
	return rows.map((row) => row.name);
}

/**
 * The startup warning for accounts that still have auto-refresh on, or null
 * when there are none. Every account is named so the operator can clear each
 * one.
 */
export function buildAutoRefreshRemovedWarning(names: string[]): string | null {
	if (names.length === 0) return null;
	const noun = names.length === 1 ? "account still has" : "accounts still have";
	return (
		`Auto-refresh was removed from ${PRODUCT_NAME}. ${names.length} ${noun} it turned on: ${names.join(", ")}. ` +
		"They no longer get their usage windows opened ahead of use or their pauses lifted after a probe; " +
		"tokens are still refreshed when a request needs one. " +
		'To clear the stored setting and silence this warning, send POST /api/accounts/<id>/auto-refresh with {"enabled": false} for each account.'
	);
}

/**
 * Log the warning once at startup. A failed query is logged and never thrown,
 * so it cannot block the server from starting.
 */
export async function logAutoRefreshRemovedWarning(
	db: AccountNamesDb,
	log: WarningLog,
): Promise<void> {
	try {
		const warning = buildAutoRefreshRemovedWarning(
			await readAutoRefreshOptedInAccountNames(db),
		);
		if (warning) log.warn(warning);
	} catch (error) {
		log.error("Could not check for accounts with auto-refresh still on", error);
	}
}
