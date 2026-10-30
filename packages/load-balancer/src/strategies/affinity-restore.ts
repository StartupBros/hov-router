import { Logger } from "@better-ccflare/logger";
import type {
	AffinityRestoreHealth,
	AffinityRestoreSession,
	LoadBalancingStrategy,
	RoutingAffinityLaneRecord,
} from "@better-ccflare/types";
import { parseRoutingAffinityLaneSummary } from "@better-ccflare/types/request";

export const AFFINITY_RESTORE_BUDGET_MS = 3000;
export const AFFINITY_RESTORE_ROW_CAP = 20_000;

type ParsedLane = NonNullable<
	ReturnType<typeof parseRoutingAffinityLaneSummary>
>;

function outranks(candidate: ParsedLane, current: ParsedLane): boolean {
	const processOrder =
		(candidate.processStartedAt ?? -1) - (current.processStartedAt ?? -1);
	if (processOrder !== 0) return processOrder > 0;
	const observationOrder =
		candidate.record.observedAt - current.record.observedAt;
	if (observationOrder !== 0) return observationOrder > 0;
	return (
		(candidate.record.owner?.assignedAt ?? -1) >
		(current.record.owner?.assignedAt ?? -1)
	);
}

/** Best-effort startup restore. Neither a stalled reader nor a partial parse installs pins. */
export async function restoreAffinityPins(options: {
	strategy: LoadBalancingStrategy;
	reader: {
		listAffinityLaneSummariesSince(
			sinceMs: number,
			limit: number,
		): Promise<{ summaries: string[]; capReached: boolean }>;
	};
	now?: () => number;
	budgetMs?: number;
	rowCap?: number;
	chunkSize?: number;
}): Promise<AffinityRestoreHealth | null> {
	let session: AffinityRestoreSession | null;
	try {
		session = options.strategy.beginAffinityRestore?.() ?? null;
	} catch {
		return null;
	}
	if (!session) return null;
	const restoreSession = session;
	const now = options.now ?? Date.now;
	const budgetMs = options.budgetMs ?? AFFINITY_RESTORE_BUDGET_MS;
	const rowCap = options.rowCap ?? AFFINITY_RESTORE_ROW_CAP;
	const chunkSize = Math.max(1, options.chunkSize ?? 256);
	const log = new Logger("AffinityRestore");

	return new Promise((resolve) => {
		let finished = false;
		let recordsRead = 0;
		let startedAt = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (
			state: "restored" | "abandoned",
			abandonReason: AffinityRestoreHealth["abandonReason"],
			pinsRestored = 0,
		) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			let durationMs = 0;
			try {
				durationMs = Math.max(0, now() - startedAt);
			} catch {
				/* A broken clock cannot leave routing gated. */
			}
			const health = {
				state,
				recordsRead,
				pinsRestored,
				durationMs,
				abandonReason,
			};
			try {
				restoreSession.finish(health);
				if (state === "abandoned")
					log.warn("Affinity restore abandoned", health);
				else log.info("Affinity restore completed", health);
			} catch {
				// Strategy/telemetry observers must not reject the startup task.
			}
			resolve(health);
		};
		const expired = () => {
			if (finished) return true;
			if (now() - startedAt < budgetMs) return false;
			finish("abandoned", "budget");
			return true;
		};
		const run = async () => {
			try {
				startedAt = now();
				// The timer also settles the returned promise while the read is hung.
				timer = setTimeout(() => finish("abandoned", "budget"), budgetMs);
				const { summaries, capReached } =
					await options.reader.listAffinityLaneSummariesSince(
						now() - restoreSession.ttlMs,
						rowCap,
					);
				if (finished) return;
				recordsRead = summaries.length;
				if (expired()) return;
				if (capReached) {
					finish("abandoned", "row_cap");
					return;
				}
				const staged = new Map<string, ParsedLane>();
				for (let offset = 0; offset < summaries.length; offset += chunkSize) {
					if (expired()) return;
					for (const summary of summaries.slice(offset, offset + chunkSize)) {
						const parsed = parseRoutingAffinityLaneSummary(summary);
						if (!parsed) continue;
						const current = staged.get(parsed.record.digest);
						if (!current || outranks(parsed, current))
							staged.set(parsed.record.digest, parsed);
					}
					if (offset + chunkSize < summaries.length)
						await new Promise<void>((resume) => setTimeout(resume, 0));
				}
				if (expired()) return;
				const winners: RoutingAffinityLaneRecord[] = [];
				// Rank tombstones too: never resurrect an older owner behind a winning deletion.
				for (const { record } of staged.values())
					if (record.owner) winners.push(record);
				if (expired()) return;
				const pinsRestored = restoreSession.install(winners);
				finish("restored", null, pinsRestored);
			} catch {
				finish("abandoned", "read_failed");
			}
		};
		void run();
	});
}
