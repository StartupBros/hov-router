import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import type { IntegrityStatus } from "@better-ccflare/types";

/**
 * The last integrity-check results, kept in a small JSON file beside the
 * SQLite database so they survive a backend restart (#606).
 *
 * Without it, every backend started "unchecked" and re-read the whole database
 * twice (`quick_check` at +30 s, `integrity_check` at +30 min). With several
 * deploys a day the 6 h / 24 h cadence never applied, and each rescan of a
 * multi-GB file evicted the hot pages the request writes need.
 *
 * Only completed outcomes are stored; the in-flight `running` state and the
 * collapsed `status` are recomputed on load. Losing the file (or a write) is
 * harmless: the next start just runs the checks on the startup delays again.
 */
export type PersistedIntegrityStatus = Pick<
	IntegrityStatus,
	| "lastQuickCheckAt"
	| "lastQuickResult"
	| "lastQuickError"
	| "lastFullCheckAt"
	| "lastFullResult"
	| "lastFullError"
	| "lastQuickSkipReason"
	| "lastFullSkipReason"
>;

const TIME_FIELDS = ["lastQuickCheckAt", "lastFullCheckAt"] as const;
const RESULT_FIELDS = ["lastQuickResult", "lastFullResult"] as const;
const TEXT_FIELDS = [
	"lastQuickError",
	"lastFullError",
	"lastQuickSkipReason",
	"lastFullSkipReason",
] as const;

export function integrityStatusPath(dbPath: string): string {
	return `${dbPath}.integrity.json`;
}

/**
 * Read the saved results, or `null` when the file is missing or does not hold
 * exactly the expected field types (a partial restore could pair one probe's
 * time with another's verdict).
 */
export function readIntegrityStatusFile(
	path: string,
): PersistedIntegrityStatus | null {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const record = raw as Record<string, unknown>;
	const field = (key: string): unknown => record[key] ?? null;

	for (const key of TIME_FIELDS) {
		const value = field(key);
		if (value !== null && !Number.isFinite(value)) return null;
	}
	for (const key of RESULT_FIELDS) {
		const value = field(key);
		if (value !== null && value !== "ok" && value !== "corrupt") return null;
	}
	for (const key of TEXT_FIELDS) {
		const value = field(key);
		if (value !== null && typeof value !== "string") return null;
	}

	return {
		lastQuickCheckAt: field("lastQuickCheckAt") as number | null,
		lastQuickResult: field("lastQuickResult") as "ok" | "corrupt" | null,
		lastQuickError: field("lastQuickError") as string | null,
		lastFullCheckAt: field("lastFullCheckAt") as number | null,
		lastFullResult: field("lastFullResult") as "ok" | "corrupt" | null,
		lastFullError: field("lastFullError") as string | null,
		lastQuickSkipReason: field("lastQuickSkipReason") as string | null,
		lastFullSkipReason: field("lastFullSkipReason") as string | null,
	};
}

/**
 * Replace the file atomically (temp file + rename), so a reader — this
 * process after a restart, or the other backend during a handoff — sees the
 * old or the new results, never half of one.
 */
export async function writeIntegrityStatusFile(
	path: string,
	status: PersistedIntegrityStatus,
): Promise<void> {
	const tempPath = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(tempPath, JSON.stringify(status));
		await rename(tempPath, path);
	} finally {
		await rm(tempPath, { force: true });
	}
}
