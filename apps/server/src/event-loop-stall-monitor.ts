import type { SqlWindowSummary } from "@better-ccflare/database";
import { diffHostCounters, type HostCounters } from "./host-counters";

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
 *
 * With a host sampler, a report also says whether the main thread spent the
 * tick on a CPU or blocked, how many pages it faulted back in, and how long
 * the host was stalled on disk, memory and CPU.
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
	/** Growth of the host counters over that tick; null when not measured. */
	host: HostCounters | null;
}

export interface EventLoopStallMonitorOptions {
	intervalMs?: number;
	stallThresholdMs?: number;
	sqlSaturationMs?: number;
	now?: () => number;
	uptimeMs?: () => number;
	drainSql: () => SqlWindowSummary | null;
	sampleHost?: () => HostCounters | null;
	report: (report: EventLoopStallReport) => void;
}

export class EventLoopStallMonitor {
	private readonly intervalMs: number;
	private readonly stallThresholdMs: number;
	private readonly sqlSaturationMs: number;
	private readonly now: () => number;
	private readonly uptimeMs: () => number;
	private readonly drainSql: () => SqlWindowSummary | null;
	private readonly sampleHost: () => HostCounters | null;
	private readonly report: (report: EventLoopStallReport) => void;
	private timer: ReturnType<typeof setInterval> | null = null;
	private lastTick = 0;
	private lastHost: HostCounters | null = null;

	constructor(options: EventLoopStallMonitorOptions) {
		this.intervalMs = options.intervalMs ?? EVENT_LOOP_TICK_MS;
		this.stallThresholdMs =
			options.stallThresholdMs ?? EVENT_LOOP_STALL_WARN_MS;
		this.sqlSaturationMs =
			options.sqlSaturationMs ?? MAIN_THREAD_SQL_SATURATION_MS;
		this.now = options.now ?? (() => performance.now());
		this.uptimeMs = options.uptimeMs ?? (() => process.uptime() * 1000);
		this.drainSql = options.drainSql;
		this.sampleHost = options.sampleHost ?? (() => null);
		this.report = options.report;
	}

	start(): void {
		this.stop();
		// Statements from before the first tick (schema setup, migrations) have
		// their own slow-statement lines; don't fold them into the first window.
		this.safeDrainSql();
		this.lastHost = this.safeSampleHost();
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
		const hostBefore = this.lastHost;
		const hostNow = this.safeSampleHost();
		this.lastHost = hostNow;
		const stalled = lagMs >= this.stallThresholdMs;
		if (!stalled && (sql?.totalMs ?? 0) < this.sqlSaturationMs) return;
		this.report({
			lagMs,
			tickMs,
			uptimeAtStartSec: (this.uptimeMs() - tickMs) / 1000,
			stalled,
			sql,
			host:
				hostBefore && hostNow ? diffHostCounters(hostBefore, hostNow) : null,
		});
	}

	private safeDrainSql(): SqlWindowSummary | null {
		try {
			return this.drainSql();
		} catch {
			return null;
		}
	}

	private safeSampleHost(): HostCounters | null {
		try {
			return this.sampleHost();
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
	const parts = [head, ...formatSql(report.sql)];
	if (report.host) parts.push(...formatHost(report.host, report.tickMs));
	return parts.join("; ");
}

function formatSql(sql: SqlWindowSummary | null): string[] {
	if (!sql) return ["main-thread SQL not measured"];
	const summary =
		`main-thread SQL in that tick: ${sql.count} statements, ` +
		`${Math.round(sql.totalMs)}ms`;
	if (sql.top.length === 0) return [summary];
	const top = sql.top
		.map(
			(entry) =>
				`${Math.round(entry.totalMs)}ms ×${entry.count} ` +
				`(max ${Math.round(entry.maxMs)}ms) ${entry.fingerprint}`,
		)
		.join(" | ");
	return [summary, `top: ${top}`];
}

const ms = (value: number) => `${Math.round(value)}ms`;

function formatHost(host: HostCounters, tickMs: number): string[] {
	const parts: string[] = [];
	const thread: string[] = [];
	if (host.threadCpuMs !== undefined)
		thread.push(`${ms(host.threadCpuMs)} on CPU`);
	if (host.threadWaitMs !== undefined)
		thread.push(`${ms(host.threadWaitMs)} waiting for a CPU`);
	if (host.threadCpuMs !== undefined && host.threadWaitMs !== undefined)
		thread.push(
			`${ms(Math.max(0, tickMs - host.threadCpuMs - host.threadWaitMs))} off CPU`,
		);
	if (host.threadMajorFaults !== undefined)
		thread.push(`${host.threadMajorFaults} major faults`);
	if (thread.length > 0) parts.push(`main thread: ${thread.join(", ")}`);

	const stalled: string[] = [];
	const resource = (name: string, some?: number, full?: number) => {
		if (some === undefined) return;
		stalled.push(
			full === undefined
				? `${name} ${ms(some)}`
				: `${name} ${ms(some)} (all tasks ${ms(full)})`,
		);
	};
	resource("io", host.ioSomeMs, host.ioFullMs);
	resource("memory", host.memorySomeMs, host.memoryFullMs);
	resource("cpu", host.cpuSomeMs);
	if (stalled.length > 0) parts.push(`host stalled on ${stalled.join(", ")}`);
	return parts;
}
