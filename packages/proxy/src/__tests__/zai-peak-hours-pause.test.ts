/**
 * The zai peak-hours pause: an opted-in zai account is paused inside the zai
 * peak window and resumed outside it, and only a pause this job set is lifted.
 *
 * The cycle runs its real SQL against an in-memory SQLite database built from
 * the real migrations, seeded with one account per scenario.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { intervalManager } from "@better-ccflare/core";
import { BunSqlAdapter } from "../../../database/src/adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../../database/src/migrations";
import {
	isZaiPeakHour,
	runZaiPeakHoursPauseOnce,
	startZaiPeakHoursPause,
} from "../zai-peak-hours-pause";

// Friday 2026-10-30 15:00 SGT = 07:00 UTC: inside the zai peak window.
const PEAK = Date.parse("2026-10-30T07:00:00Z");
// Friday 2026-10-30 19:00 SGT = 11:00 UTC: outside it.
const OFF_PEAK = Date.parse("2026-10-30T11:00:00Z");
// Saturday 2026-10-31 15:00 SGT = 07:00 UTC: inside the hours, but a weekend.
const WEEKEND_PEAK_HOURS = Date.parse("2026-10-31T07:00:00Z");

interface AccountSeed {
	id: string;
	provider: string;
	peakHoursPauseEnabled: number;
	paused: number;
	pauseReason: string | null;
}

interface AccountState {
	paused: number;
	pause_reason: string | null;
}

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

function seed(db: Database, account: AccountSeed): void {
	db.prepare(
		`INSERT INTO accounts (id, name, provider, created_at, paused, pause_reason, peak_hours_pause_enabled)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(
		account.id,
		account.id,
		account.provider,
		Date.now(),
		account.paused,
		account.pauseReason,
		account.peakHoursPauseEnabled,
	);
}

function stateOf(db: Database, id: string): AccountState {
	const row = db
		.prepare(
			"SELECT COALESCE(paused, 0) AS paused, pause_reason FROM accounts WHERE id = ?",
		)
		.get(id) as AccountState | null;
	if (!row) throw new Error(`account ${id} not seeded`);
	return row;
}

describe("runZaiPeakHoursPauseOnce", () => {
	it("pauses an opted-in zai account at peak and resumes it off peak, leaving a manual pause alone", async () => {
		const db = makeDb();
		seed(db, {
			id: "zai-opted-in",
			provider: "zai",
			peakHoursPauseEnabled: 1,
			paused: 0,
			pauseReason: null,
		});
		seed(db, {
			id: "zai-manual",
			provider: "zai",
			peakHoursPauseEnabled: 1,
			paused: 1,
			pauseReason: "manual",
		});
		const adapter = new BunSqlAdapter(db);

		await runZaiPeakHoursPauseOnce(adapter, PEAK);
		expect(stateOf(db, "zai-opted-in")).toEqual({
			paused: 1,
			pause_reason: "peak_hours",
		});
		expect(stateOf(db, "zai-manual")).toEqual({
			paused: 1,
			pause_reason: "manual",
		});

		await runZaiPeakHoursPauseOnce(adapter, OFF_PEAK);
		expect(stateOf(db, "zai-opted-in")).toEqual({
			paused: 0,
			pause_reason: null,
		});
		expect(stateOf(db, "zai-manual")).toEqual({
			paused: 1,
			pause_reason: "manual",
		});
	});

	it("leaves a zai account without the opt-in and a non-zai account with it untouched", async () => {
		const db = makeDb();
		seed(db, {
			id: "zai-not-opted-in",
			provider: "zai",
			peakHoursPauseEnabled: 0,
			paused: 0,
			pauseReason: null,
		});
		seed(db, {
			id: "anthropic-opted-in",
			provider: "anthropic",
			peakHoursPauseEnabled: 1,
			paused: 0,
			pauseReason: null,
		});
		seed(db, {
			id: "anthropic-peak-paused",
			provider: "anthropic",
			peakHoursPauseEnabled: 1,
			paused: 1,
			pauseReason: "peak_hours",
		});
		const adapter = new BunSqlAdapter(db);

		await runZaiPeakHoursPauseOnce(adapter, PEAK);
		await runZaiPeakHoursPauseOnce(adapter, OFF_PEAK);

		expect(stateOf(db, "zai-not-opted-in")).toEqual({
			paused: 0,
			pause_reason: null,
		});
		expect(stateOf(db, "anthropic-opted-in")).toEqual({
			paused: 0,
			pause_reason: null,
		});
		expect(stateOf(db, "anthropic-peak-paused")).toEqual({
			paused: 1,
			pause_reason: "peak_hours",
		});
	});

	it("never pauses on a weekend inside the peak hours", async () => {
		const db = makeDb();
		seed(db, {
			id: "zai-opted-in",
			provider: "zai",
			peakHoursPauseEnabled: 1,
			paused: 0,
			pauseReason: null,
		});

		await runZaiPeakHoursPauseOnce(new BunSqlAdapter(db), WEEKEND_PEAK_HOURS);

		expect(stateOf(db, "zai-opted-in")).toEqual({
			paused: 0,
			pause_reason: null,
		});
	});
});

describe("startZaiPeakHoursPause", () => {
	const spies: Array<{ mockRestore(): void }> = [];
	afterEach(() => {
		intervalManager.unregister("zai-peak-hours-pause");
		for (const spy of spies.splice(0)) spy.mockRestore();
	});

	it("registers a one-minute job that runs at once and stops on request", async () => {
		const register = spyOn(intervalManager, "register");
		spies.push(register);
		const queries: string[] = [];
		const db = {
			query: async (sql: string) => {
				queries.push(sql);
				return [];
			},
			run: async () => {},
		};

		const stop = startZaiPeakHoursPause(db as never);

		expect(register).toHaveBeenCalledTimes(1);
		const config = register.mock.calls[0]?.[0];
		expect(config).toMatchObject({
			id: "zai-peak-hours-pause",
			intervalMs: 60_000,
			immediate: true,
			maxConcurrent: 1,
		});
		await Promise.resolve();
		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain("provider = 'zai'");
		expect(intervalManager.has("zai-peak-hours-pause")).toBe(true);

		stop();
		expect(intervalManager.has("zai-peak-hours-pause")).toBe(false);
	});
});

// Z.ai peak is Monday to Friday 14:00-18:00 Singapore time (UTC+8). The
// weekday is the Singapore weekday, so it is taken after the +8h shift.
describe("isZaiPeakHour", () => {
	it("is true on a weekday inside 14:00-18:00 SGT", () => {
		// Friday 2026-10-30 15:00 SGT = 07:00 UTC
		expect(isZaiPeakHour(Date.parse("2026-10-30T07:00:00Z"))).toBe(true);
	});

	it("is false on a Saturday inside 14:00-18:00 SGT", () => {
		// Saturday 2026-10-31 15:00 SGT = 07:00 UTC
		expect(isZaiPeakHour(Date.parse("2026-10-31T07:00:00Z"))).toBe(false);
	});

	it("is false on a Sunday inside 14:00-18:00 SGT", () => {
		// Sunday 2026-11-01 15:00 SGT = 07:00 UTC
		expect(isZaiPeakHour(Date.parse("2026-11-01T07:00:00Z"))).toBe(false);
	});

	it("is false outside the hour window on a weekday", () => {
		// Friday 13:59 SGT and 18:00 SGT
		expect(isZaiPeakHour(Date.parse("2026-10-30T05:59:00Z"))).toBe(false);
		expect(isZaiPeakHour(Date.parse("2026-10-30T10:00:00Z"))).toBe(false);
	});

	it("takes the weekday after the +8h shift, not the UTC weekday", () => {
		// Sunday 17:00 UTC is Monday 01:00 SGT: weekday, but outside the hours.
		expect(isZaiPeakHour(Date.parse("2026-11-01T17:00:00Z"))).toBe(false);
		// Friday 16:00 UTC is Saturday 00:00 SGT: weekend.
		expect(isZaiPeakHour(Date.parse("2026-10-30T16:00:00Z"))).toBe(false);
		// Monday 2026-11-02 14:00 SGT = Monday 06:00 UTC, in peak.
		expect(isZaiPeakHour(Date.parse("2026-11-02T06:00:00Z"))).toBe(true);
	});
});
