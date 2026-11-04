import { intervalManager } from "@better-ccflare/core";
import type { BunSqlAdapter } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("ZaiPeakHoursPause");

const ZAI_PEAK_HOURS_PAUSE_INTERVAL_MS = 60_000;

type PeakHoursPauseDb = Pick<BunSqlAdapter, "query" | "run">;

/**
 * Z.ai peak is Monday to Friday 14:00-18:00 Singapore time (UTC+8); weekends
 * are off-peak. The weekday is read from the Singapore-shifted date, so a UTC
 * evening that is already the next day in Singapore counts as that next day.
 */
export function isZaiPeakHour(ts = Date.now()): boolean {
	const sgt = new Date(ts + 8 * 60 * 60 * 1000);
	const day = sgt.getUTCDay();
	if (day === 0 || day === 6) return false;
	const sgtHour = sgt.getUTCHours() + sgt.getUTCMinutes() / 60;
	return sgtHour >= 14 && sgtHour < 18;
}

/**
 * Pause or resume zai accounts based on the per-account
 * peak_hours_pause_enabled flag. Only touches accounts that opted in, and only
 * lifts a pause this job set.
 */
export async function runZaiPeakHoursPauseOnce(
	db: PeakHoursPauseDb,
	now = Date.now(),
): Promise<void> {
	const inPeak = isZaiPeakHour(now);

	const zaiAccounts = await db.query<{
		id: string;
		name: string;
		paused: number;
		pause_reason: string | null;
		peak_hours_pause_enabled: number;
	}>(
		`SELECT id, name, COALESCE(paused, 0) as paused, pause_reason, COALESCE(peak_hours_pause_enabled, 0) as peak_hours_pause_enabled
		 FROM accounts WHERE provider = 'zai' AND peak_hours_pause_enabled = 1`,
	);

	for (const account of zaiAccounts) {
		if (inPeak && !account.paused) {
			// SQL-level guard prevents race: if another actor paused the account
			// with a different reason between SELECT and UPDATE, skip it
			await db.run(
				"UPDATE accounts SET paused = 1, pause_reason = 'peak_hours' WHERE id = ? AND COALESCE(paused, 0) = 0",
				[account.id],
			);
			log.info(`Peak hours pause: paused zai account '${account.name}'`);
		} else if (
			!inPeak &&
			account.paused &&
			account.pause_reason === "peak_hours"
		) {
			// SQL-level guard prevents race condition: if manual-pause API changed pause_reason
			// between SELECT and UPDATE, this UPDATE will not affect that account
			await db.run(
				"UPDATE accounts SET paused = 0, pause_reason = NULL WHERE id = ? AND pause_reason = 'peak_hours'",
				[account.id],
			);
			log.info(`Peak hours resume: resumed zai account '${account.name}'`);
		}
	}
}

/**
 * Run the zai peak-hours pause at once and then every minute. Returns the
 * function that stops it.
 */
export function startZaiPeakHoursPause(db: PeakHoursPauseDb): () => void {
	return intervalManager.register({
		id: "zai-peak-hours-pause",
		callback: () => runZaiPeakHoursPauseOnce(db),
		intervalMs: ZAI_PEAK_HOURS_PAUSE_INTERVAL_MS,
		maxConcurrent: 1,
		immediate: true,
		description: "Pause and resume opted-in zai accounts around zai peak hours",
	});
}
