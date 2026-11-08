import type { RouteProvenance } from "@better-ccflare/types";

/**
 * What a request row's model badge names.
 *
 * `model` comes from the response's usage, so a failed request has none. The
 * row still records the route it asked for, so the badge falls back to that
 * (#756): the requested model, plus the model the route sent it to when that
 * differs. `kind` says which source the name came from so the badge can label
 * it.
 */
export interface RequestModelLabel {
	kind: "response" | "requested" | "routed";
	model: string;
	/** The routed model, only when it differs from a requested `model`. */
	routedTo: string | null;
}

export function requestModelLabel(
	summary:
		| { model?: string | null; routeProvenance?: RouteProvenance | null }
		| null
		| undefined,
): RequestModelLabel | null {
	if (!summary) return null;
	if (summary.model) {
		return { kind: "response", model: summary.model, routedTo: null };
	}
	const requested = summary.routeProvenance?.requestedModel || null;
	const routed = summary.routeProvenance?.routedModel || null;
	if (requested) {
		return {
			kind: "requested",
			model: requested,
			routedTo: routed && routed !== requested ? routed : null,
		};
	}
	if (routed) return { kind: "routed", model: routed, routedTo: null };
	return null;
}
