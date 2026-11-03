import type { HealthResponse, PoolStatus } from "@better-ccflare/types";

export type HealthVerdictStatus = "ok" | "degraded" | "unhealthy";

/** The parts of a /health body the overview's status banner reads. */
export interface HealthVerdict {
	status: HealthVerdictStatus;
	pool: PoolStatus;
	runtime?: HealthResponse["runtime"];
}

const STATUSES: ReadonlySet<string> = new Set<HealthVerdictStatus>([
	"ok",
	"degraded",
	"unhealthy",
]);

/**
 * Accept a /health body only when it carries the server's verdict
 * (computeHealthStatus in http-api). During a drain or binary swap the guard
 * answers /health itself with a 503 error body that has neither `status` nor
 * `pool`; that, and anything else unexpected, is null rather than a guess.
 */
export function parseHealthVerdict(body: unknown): HealthVerdict | null {
	if (!body || typeof body !== "object") return null;
	const { status, pool, runtime } = body as Record<string, unknown>;
	if (typeof status !== "string" || !STATUSES.has(status)) return null;
	if (!pool || typeof pool !== "object") return null;
	const { configured, routable } = pool as Record<string, unknown>;
	if (typeof configured !== "number" || typeof routable !== "number") {
		return null;
	}
	return {
		status: status as HealthVerdictStatus,
		pool: pool as PoolStatus,
		...(runtime && typeof runtime === "object"
			? { runtime: runtime as HealthVerdict["runtime"] }
			: {}),
	};
}
