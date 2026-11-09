import { Logger } from "@better-ccflare/logger";
import {
	apiKeyRouteCallerIdentity,
	type ModelRouteBindingRecord,
	type ModelRouteSessionRegistry,
} from "./model-route-profiles";

export const ROUTE_BINDING_RESTORE_BUDGET_MS = 3000;

export interface RouteBindingHistoryReader {
	listRouteBindingSessionsSince(
		sinceMs: number,
		limit: number,
	): Promise<{
		sessions: ReadonlyArray<{
			apiKeyId: string;
			sessionId: string;
			routeProfileId: string;
			lastStartedAt: number;
		}>;
		capReached: boolean;
	}>;
}

export interface RouteBindingRestoreOutcome {
	state: "restored" | "abandoned";
	sessionsRead: number;
	bindingsRestored: number;
	capReached: boolean;
	durationMs: number;
	abandonReason: "read_failed" | "budget" | null;
}

/**
 * Best-effort startup restore of route-profile session bindings, so a picker
 * session's subagents keep routing after the process is replaced. Requests
 * wait on the registry's gate until this settles; a failed or slow read
 * installs nothing and leaves the registry as empty as it was at boot.
 */
export async function restoreModelRouteBindings(options: {
	registry: ModelRouteSessionRegistry | undefined;
	reader: RouteBindingHistoryReader;
	now?: () => number;
	budgetMs?: number;
}): Promise<RouteBindingRestoreOutcome | null> {
	let session: ReturnType<ModelRouteSessionRegistry["beginBindingRestore"]>;
	try {
		session = options.registry?.beginBindingRestore() ?? null;
	} catch {
		return null;
	}
	if (!session) return null;
	const restoreSession = session;
	const now = options.now ?? Date.now;
	const budgetMs = options.budgetMs ?? ROUTE_BINDING_RESTORE_BUDGET_MS;
	const log = new Logger("RouteBindingRestore");

	return new Promise((resolve) => {
		let finished = false;
		let sessionsRead = 0;
		let capReached = false;
		let startedAt = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (
			state: RouteBindingRestoreOutcome["state"],
			abandonReason: RouteBindingRestoreOutcome["abandonReason"],
			bindingsRestored = 0,
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
			const outcome: RouteBindingRestoreOutcome = {
				state,
				sessionsRead,
				bindingsRestored,
				capReached,
				durationMs,
				abandonReason,
			};
			try {
				restoreSession.finish();
				if (state === "abandoned")
					log.warn("Route binding restore abandoned", outcome);
				else log.info("Route binding restore completed", outcome);
			} catch {
				// Logging must not reject the startup task.
			}
			resolve(outcome);
		};
		const run = async () => {
			try {
				startedAt = now();
				// The timer also settles the returned promise while the read is hung.
				timer = setTimeout(() => finish("abandoned", "budget"), budgetMs);
				const history = await options.reader.listRouteBindingSessionsSince(
					now() - restoreSession.ttlMs,
					restoreSession.maxEntries,
				);
				if (finished) return;
				sessionsRead = history.sessions.length;
				capReached = history.capReached;
				if (now() - startedAt >= budgetMs) {
					finish("abandoned", "budget");
					return;
				}
				const records: ModelRouteBindingRecord[] = [];
				for (const row of history.sessions) {
					const callerIdentity = apiKeyRouteCallerIdentity(row.apiKeyId);
					if (!callerIdentity) continue;
					records.push({
						callerIdentity,
						sessionId: row.sessionId,
						routeProfileId: row.routeProfileId,
						lastStartedAt: row.lastStartedAt,
					});
				}
				finish("restored", null, restoreSession.install(records));
			} catch {
				finish("abandoned", "read_failed");
			}
		};
		void run();
	});
}
