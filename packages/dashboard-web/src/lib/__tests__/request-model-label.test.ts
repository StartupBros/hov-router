import { describe, expect, it } from "bun:test";
import type { RouteProvenance } from "@better-ccflare/types";
import { requestModelLabel } from "../request-model-label";

function route(overrides: Partial<RouteProvenance>): RouteProvenance {
	return {
		profileId: "ai-gateway-chat",
		requestedModel: null,
		routedProvider: null,
		routedModel: null,
		fallbackRung: null,
		homeAction: "none",
		repinReason: null,
		candidateId: null,
		...overrides,
	};
}

describe("requestModelLabel", () => {
	it("names the response model when the row has one", () => {
		expect(
			requestModelLabel({
				model: "claude-sonnet-5-5",
				routeProvenance: route({ requestedModel: "claude-opus-5-5" }),
			}),
		).toEqual({ kind: "response", model: "claude-sonnet-5-5", routedTo: null });
	});

	it("falls back to the requested model and the model it was routed to (#756)", () => {
		expect(
			requestModelLabel({
				routeProvenance: route({
					requestedModel: "claude-sonnet-5-5",
					routedModel: "chat",
				}),
			}),
		).toEqual({
			kind: "requested",
			model: "claude-sonnet-5-5",
			routedTo: "chat",
		});
	});

	it("omits the routed model when it matches the requested one", () => {
		expect(
			requestModelLabel({
				model: "",
				routeProvenance: route({
					requestedModel: "chat",
					routedModel: "chat",
				}),
			}),
		).toEqual({ kind: "requested", model: "chat", routedTo: null });
	});

	it("uses the routed model when nothing was requested by name", () => {
		expect(
			requestModelLabel({ routeProvenance: route({ routedModel: "chat" }) }),
		).toEqual({ kind: "routed", model: "chat", routedTo: null });
	});

	it("returns null when the row names no model at all", () => {
		expect(requestModelLabel(undefined)).toBeNull();
		expect(requestModelLabel({})).toBeNull();
		expect(requestModelLabel({ routeProvenance: route({}) })).toBeNull();
	});
});
