import type { SqlWindowSummary } from "@better-ccflare/database";

/**
 * Event-loop stall attribution for the post-start freeze in #606.
 *
 * A 1 s interval measures how late each tick fires. A late tick means the
 * main thread was held for that long. Every tick also drains the main-thread
 * SQL timing window, so a report can say how much of the held time was SQL
 * and which statements. It reports either:
 * - a stall: the tick fired at least `stallThresholdMs` late; or
 * - SQL saturation: on-time ticks whose window still spent
 *   `sqlSaturationMs` in SQL. Short tasks that yield let timers fire on
 *   time while queued requests wait behind them.
 */

export const EVENT_LOOP_TICK_MS = 1000;
export const EVENT_LOOP_STALL_WARN_MS = 250;
export const MAIN_THREAD_SQL_SATURATION_MS = 500;

export interface EventLoopStallReport {
	lagMs: number;
	tickMs: number;
	/** Process uptime when the late tick's interval began. */
	uptimeAtStartSec: number;
	stalled: boolean;
	/** Main-thread SQL in that tick; null when not measured. */
	sql: SqlWindowSummary | null;
}

export interface EventLoopStallMonitorOptions {
	intervalMs?: number;
	stallThresholdMs?: number;
	sqlSaturationMs?: number;
	now?: () => number;
	uptimeMs?: () => number;
	drainSql: () => SqlWindowSummary | null;
	report: (report: EventLoopStallReport) => void;
}

export class EventLoopStallMonitor {
	private readonly intervalMs: number;
	private readonly stallThresholdMs: number;
	private readonly sqlSaturationMs: number;
	private readonly now: () => number;
	private readonly uptimeMs: () => number;
	private readonly drainSql: () => SqlWindowSummary | null;
	private readonly report: (report: EventLoopStallReport) => void;
	private timer: ReturnType<typeof setInterval> | null = null;
	private lastTick = 0;

	constructor(options: EventLoopStallMonitorOptions) {
		this.intervalMs = options.intervalMs ?? EVENT_LOOP_TICK_MS;
		this.stallThresholdMs =
			options.stallThresholdMs ?? EVENT_LOOP_STALL_WARN_MS;
		this.sqlSaturationMs =
			options.sqlSaturationMs ?? MAIN_THREAD_SQL_SATURATION_MS;
		this.now = options.now ?? (() => performance.now());
		this.uptimeMs = options.uptimeMs ?? (() => process.uptime() * 1000);
		this.drainSql = options.drainSql;
		this.report = options.report;
	}

	start(): void {
		this.stop();
		// Statements from before the first tick (schema setup, migrations) have
		// their own slow-statement lines; don't fold them into the first window.
		this.safeDrainSql();
		this.lastTick = this.now();
		this.timer = setInterval(() => this.tick(), this.intervalMs);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	tick(): void {
		const now = this.now();
		const tickMs = now - this.lastTick;
		this.lastTick = now;
		const lagMs = Math.max(0, tickMs - this.intervalMs);
		const sql = this.safeDrainSql();
		const stalled = lagMs >= this.stallThresholdMs;
		if (!stalled && (sql?.totalMs ?? 0) < this.sqlSaturationMs) return;
		this.report({
			lagMs,
			tickMs,
			uptimeAtStartSec: (this.uptimeMs() - tickMs) / 1000,
			stalled,
			sql,
		});
	}

	private safeDrainSql(): SqlWindowSummary | null {
		try {
			return this.drainSql();
		} catch {
			return null;
		}
	}
}

export function formatEventLoopStallReport(
	report: EventLoopStallReport,
): string {
	const label = report.stalled
		? "Event loop stall"
		: "Main-thread SQL saturation";
	const head =
		`${label}: ${Math.round(report.lagMs)}ms late ` +
		`(tick took ${Math.round(report.tickMs)}ms, ` +
		`began ${report.uptimeAtStartSec.toFixed(1)}s after process start)`;
	if (!report.sql) return `${head}; main-thread SQL not measured`;
	const sql =
		`main-thread SQL in that tick: ${report.sql.count} statements, ` +
		`${Math.round(report.sql.totalMs)}ms`;
	if (report.sql.top.length === 0) return `${head}; ${sql}`;
	const top = report.sql.top
		.map(
			(entry) =>
				`${Math.round(entry.totalMs)}ms ×${entry.count} ` +
				`(max ${Math.round(entry.maxMs)}ms) ${entry.fingerprint}`,
		)
		.join(" | ");
	return `${head}; ${sql}; top: ${top}`;
}
