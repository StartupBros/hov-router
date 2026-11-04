import { PRODUCT_NAME } from "@better-ccflare/core/product-identity";

/** The docs section the refusal points to; its heading must stay in sync. */
export const POSTGRES_REMOVED_GUIDE =
	'"PostgreSQL support removed" in docs/hov-router-migration.md';

/** The last published release that can still run on PostgreSQL. */
export const LAST_POSTGRES_RELEASE = "v3.7.1";

/**
 * Thrown before any database file is opened when DATABASE_URL still selects
 * PostgreSQL. The message never includes the URL, which can carry a password.
 */
export class PostgresUrlRefusedError extends Error {
	constructor() {
		super(
			[
				`PostgreSQL support was removed from ${PRODUCT_NAME}, and DATABASE_URL selects a PostgreSQL database.`,
				`${PRODUCT_NAME} stopped instead of starting on a different, empty SQLite database.`,
				`To keep using PostgreSQL, stay on ${LAST_POSTGRES_RELEASE}, the last release that supports it.`,
				"To switch to SQLite, unset DATABASE_URL; the router then starts on a new, empty SQLite database (no migration tool exists).",
				`See ${POSTGRES_REMOVED_GUIDE}.`,
			].join(" "),
		);
		this.name = "PostgresUrlRefusedError";
	}
}

/** The exact test that selected the PostgreSQL backend before it was removed. */
export function isPostgresDatabaseUrl(value: string | undefined): boolean {
	return (
		value !== undefined &&
		(value.startsWith("postgres://") || value.startsWith("postgresql://"))
	);
}

/** Refuse to open any database while DATABASE_URL selects PostgreSQL. */
export function assertNotPostgresUrl(
	env: Record<string, string | undefined> = process.env,
): void {
	if (isPostgresDatabaseUrl(env.DATABASE_URL)) {
		throw new PostgresUrlRefusedError();
	}
}
