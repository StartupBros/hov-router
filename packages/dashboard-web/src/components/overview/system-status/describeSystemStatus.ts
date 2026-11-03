import type { PoolStatus } from "@better-ccflare/types";
import type { HealthVerdict } from "../../../lib/health-verdict";

export type SystemStatusTone = "ok" | "warning" | "down" | "neutral";

export interface SystemStatusView {
	tone: SystemStatusTone;
	title: string;
	detail: string;
}

/**
 * Word the server's /health verdict for the overview banner. The server
 * decides health (computeHealthStatus in http-api); this function only
 * describes it. `undefined` means the first check has not answered yet and
 * `null` means it answered without a verdict. Neither is ever shown as fine.
 */
export function describeSystemStatus(
	health: HealthVerdict | null | undefined,
): SystemStatusView {
	if (health === undefined) {
		return {
			tone: "neutral",
			title: "Checking status",
			detail: "Waiting for the router's health check.",
		};
	}
	if (health === null) {
		return {
			tone: "neutral",
			title: "Status unknown",
			detail: "The health check gave no answer. Retrying every 30 seconds.",
		};
	}

	const { pool } = health;
	switch (health.status) {
		case "ok":
			return (
				describeUnreachableUpstream(health) ?? {
					tone: "ok",
					title: "Routing normally",
					detail: availabilityLine(pool),
				}
			);
		case "degraded":
			return {
				tone: "warning",
				title: "No account can route right now",
				detail: recoveryLine(pool.next_available_at),
			};
		case "unhealthy":
			return describeUnhealthy(health);
		default: {
			const unreachable: never = health.status;
			return unreachable;
		}
	}
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
	anthropic: "Anthropic",
	codex: "Codex",
	"openai-compatible": "OpenAI-compatible endpoints",
	other: "other providers",
};

/**
 * /health stays `ok` when the host cannot reach an upstream, because the
 * deploy and readiness probes need its 200 (2026-11-02: every Anthropic
 * request failed for 45 minutes while this banner said "Routing normally").
 * runtime.upstreamTransport carries the signal instead.
 */
function describeUnreachableUpstream(
	health: HealthVerdict,
): SystemStatusView | null {
	const transport = health.runtime?.upstreamTransport;
	// parseHealthVerdict passes runtime through unvalidated.
	if (
		!transport ||
		!Array.isArray(transport.unreachable) ||
		transport.unreachable.length === 0
	) {
		return null;
	}
	const names = transport.unreachable.map(
		(label) => PROVIDER_NAMES[label] ?? label,
	);
	const tail = `That points at the network connection, not the accounts. ${availabilityLine(health.pool)}`;
	if (names.length === 1) {
		const name = names[0] as string;
		const provider = transport.providers[transport.unreachable[0] as string];
		const code = provider?.lastFailureCode
			? ` (${provider.lastFailureCode})`
			: "";
		const attempts =
			provider?.consecutiveFailures ?? transport.unreachableAfter;
		return {
			tone: "warning",
			title: `Can't reach ${name} from this machine`,
			detail: `The last ${attempts} attempts to reach ${name} got no answer${code}. ${tail}`,
		};
	}
	return {
		tone: "warning",
		title: `Can't reach ${joinOr(names)} from this machine`,
		detail: `Recent attempts to reach each got no answer. ${tail}`,
	};
}

function joinOr(items: string[]): string {
	if (items.length <= 2) return items.join(" or ");
	return `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

function describeUnhealthy(health: HealthVerdict): SystemStatusView {
	const { pool, runtime } = health;
	const failing: Array<{ part: string; effect: string }> = [];
	if (runtime?.asyncWriter && !runtime.asyncWriter.healthy) {
		failing.push({
			part: "request writer",
			effect: "request history may not be saved",
		});
	}
	if (runtime?.usageWorker?.state === "error") {
		failing.push({
			part: "usage worker",
			effect: "account usage may be out of date",
		});
	}
	if (failing.length > 0) {
		const parts = failing.map((f) => f.part).join(" and ");
		const effects = failing.map((f) => f.effect).join(", and ");
		return {
			tone: "down",
			title: `The ${parts} ${failing.length > 1 ? "are" : "is"} failing`,
			detail: `${capitalize(effects)}.`,
		};
	}
	if (pool.configured === 0) {
		return {
			tone: "warning",
			title: "No accounts configured",
			detail: "Add an account to start routing requests.",
		};
	}
	if (pool.routable === 0) {
		const reasons = unavailableReasons(pool);
		return {
			tone: "down",
			title: "No account can route requests",
			detail: `${reasons ? `${capitalize(reasons)}. ` : ""}No recovery time is known.`,
		};
	}
	return {
		tone: "down",
		title: "The router reports a problem",
		detail: availabilityLine(pool),
	};
}

/** "3 of 4 accounts available (1 paused)", plus any at their usage limit. */
function availabilityLine(pool: PoolStatus): string {
	const noun = pool.configured === 1 ? "account" : "accounts";
	const reasons = unavailableReasons(pool);
	let line = `${pool.routable} of ${pool.configured} ${noun} available`;
	if (reasons) line += ` (${reasons})`;
	// Exhausted accounts still count as routable, but upstream rejects them.
	if (pool.usage_exhausted > 0) {
		line += `; ${pool.usage_exhausted} at ${pool.usage_exhausted === 1 ? "its" : "their"} usage limit`;
	}
	return `${line}.`;
}

function unavailableReasons(pool: PoolStatus): string {
	const reasons: string[] = [];
	if (pool.paused > 0) reasons.push(`${pool.paused} paused`);
	if (pool.rate_limited > 0) reasons.push(`${pool.rate_limited} rate-limited`);
	return reasons.join(", ");
}

function recoveryLine(nextAvailableAt: string | null): string {
	const at = nextAvailableAt ? new Date(nextAvailableAt) : null;
	if (!at || Number.isNaN(at.getTime())) return "No recovery time is known.";
	const time = new Intl.DateTimeFormat(undefined, {
		hour: "numeric",
		minute: "2-digit",
	}).format(at);
	return `The next account frees up at ${time}.`;
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}
