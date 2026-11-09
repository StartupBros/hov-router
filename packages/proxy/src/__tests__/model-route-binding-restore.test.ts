import { describe, expect, it } from "bun:test";
import { restoreModelRouteBindings } from "../model-route-binding-restore";
import {
	apiKeyRouteCallerIdentity,
	ModelRouteSessionRegistry,
	parseModelRouteProfiles,
} from "../model-route-profiles";

function profile() {
	const [configured] = parseModelRouteProfiles(
		JSON.stringify([
			{
				id: "codex-pool-astra",
				displayName: "Codex pool",
				accountId: "codex-account",
				logicalModel: "claude-opus-5",
			},
		]),
	);
	if (!configured) throw new Error("Expected the route profile to parse");
	return configured;
}

function childResolution(registry: ModelRouteSessionRegistry, model: string) {
	return registry.resolve(
		{
			callerIdentity: apiKeyRouteCallerIdentity("key-1"),
			requestModel: model,
			sessionId: "session",
			isSubagent: true,
		},
		null,
		{ touchInheritedBinding: false },
	);
}

const NOW = 50_000_000;

function bound(sessionId = "session", lastStartedAt = NOW - 60_000) {
	return {
		apiKeyId: "key-1",
		sessionId,
		routeProfileId: "codex-pool-astra",
		lastStartedAt,
	};
}

describe("restoreModelRouteBindings", () => {
	it("derives caller identity exactly as the proxy keys live API-key requests", () => {
		expect(apiKeyRouteCallerIdentity(" key-1 ")).toBe("api-key-id:key-1");
		expect(apiKeyRouteCallerIdentity("  ")).toBeNull();
		expect(apiKeyRouteCallerIdentity(null)).toBeNull();
	});

	it("restores bindings read from history and opens the gate", async () => {
		const configured = profile();
		const registry = new ModelRouteSessionRegistry([configured], {
			now: () => NOW,
		});
		const reads: Array<[number, number]> = [];
		const outcome = await restoreModelRouteBindings({
			registry,
			reader: {
				listRouteBindingSessionsSince: async (sinceMs, limit) => {
					reads.push([sinceMs, limit]);
					return { sessions: [bound()], capReached: false };
				},
			},
			now: () => NOW,
		});

		expect(reads).toEqual([[NOW - 5 * 60 * 60 * 1000, 10_000]]);
		expect(outcome).toMatchObject({
			state: "restored",
			sessionsRead: 1,
			bindingsRestored: 1,
			capReached: false,
			abandonReason: null,
		});
		expect(registry.bindingRestoreGate()).toBeNull();
		expect(childResolution(registry, configured.publicModelId)).toMatchObject({
			kind: "route",
			source: "inherited",
			profile: configured,
		});
	});

	it("installs the newest sessions it read when the cap is reached", async () => {
		const configured = profile();
		const registry = new ModelRouteSessionRegistry([configured], {
			now: () => NOW,
		});
		const outcome = await restoreModelRouteBindings({
			registry,
			reader: {
				listRouteBindingSessionsSince: async () => ({
					sessions: [bound()],
					capReached: true,
				}),
			},
			now: () => NOW,
		});
		expect(outcome).toMatchObject({
			state: "restored",
			bindingsRestored: 1,
			capReached: true,
		});
	});

	it("abandons on a failed read, installs nothing, and opens the gate", async () => {
		const configured = profile();
		const registry = new ModelRouteSessionRegistry([configured], {
			now: () => NOW,
		});
		const outcome = await restoreModelRouteBindings({
			registry,
			reader: {
				listRouteBindingSessionsSince: async () => {
					throw new Error("reader unavailable");
				},
			},
			now: () => NOW,
		});
		expect(outcome).toMatchObject({
			state: "abandoned",
			bindingsRestored: 0,
			abandonReason: "read_failed",
		});
		expect(registry.bindingRestoreGate()).toBeNull();
		expect(childResolution(registry, configured.publicModelId)).toEqual({
			kind: "unavailable",
			reason: "unbound_child_profile",
		});
	});

	it("opens the gate at the budget and ignores a read that lands later", async () => {
		const configured = profile();
		const registry = new ModelRouteSessionRegistry([configured], {
			now: () => NOW,
		});
		let deliver: (value: {
			sessions: ReturnType<typeof bound>[];
			capReached: boolean;
		}) => void = () => {};
		const outcome = await restoreModelRouteBindings({
			registry,
			reader: {
				listRouteBindingSessionsSince: () =>
					new Promise((resolve) => {
						deliver = resolve;
					}),
			},
			now: () => NOW,
			budgetMs: 5,
		});
		expect(outcome).toMatchObject({
			state: "abandoned",
			abandonReason: "budget",
			bindingsRestored: 0,
		});
		expect(registry.bindingRestoreGate()).toBeNull();

		deliver({ sessions: [bound()], capReached: false });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(registry.size).toBe(0);
	});

	it("does not read history when no route profiles are configured", async () => {
		let read = false;
		const outcome = await restoreModelRouteBindings({
			registry: new ModelRouteSessionRegistry([]),
			reader: {
				listRouteBindingSessionsSince: async () => {
					read = true;
					return { sessions: [], capReached: false };
				},
			},
		});
		expect(outcome).toBeNull();
		expect(read).toBe(false);
	});
});
