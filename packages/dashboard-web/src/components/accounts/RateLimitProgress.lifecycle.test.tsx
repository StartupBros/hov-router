import { expect, it, mock, spyOn } from "bun:test";
import { intervalManager } from "@better-ccflare/core";
import * as React from "react";
import { RateLimitProgress } from "./RateLimitProgress";

// Execute the component's hooks and effects against the real registration manager.
// This deliberately makes no claim about DOM mounting or browser behavior.
it("keeps refresh registrations independent across instance cleanup and effect restart", async () => {
	const internals = (
		React as unknown as {
			__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
				H: unknown;
			};
		}
	).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
	const previous = internals.H;
	const register = spyOn(intervalManager, "register");
	const instances = ["row", "details", "credits"].map((id) => {
		const update = mock(() => {});
		let effect: (() => () => void) | undefined;
		internals.H = {
			useId: () => id,
			useState: () => [Date.now(), update],
			useEffect: (callback: () => () => void) => {
				effect = callback;
			},
		};
		RateLimitProgress({ resetIso: null, provider: "anthropic" });
		if (!effect) throw new Error("Refresh effect missing");
		return { update, effect, cleanup: () => {} };
	});
	internals.H = previous;
	try {
		for (const instance of instances) instance.cleanup = instance.effect();
		const configs = register.mock.calls.map(([config]) => config);
		expect(new Set(configs.map((config) => config.id)).size).toBe(3);
		for (const config of configs) {
			expect(config.intervalMs).toBe(30000);
			expect(config.immediate).toBe(true);
		}
		for (const instance of instances)
			expect(instance.update).toHaveBeenCalledTimes(1);
		const details = instances[1];
		const detailsConfig = configs[1];
		if (!details || !detailsConfig)
			throw new Error("Details registration missing");
		details.cleanup();
		expect(intervalManager.has(detailsConfig.id)).toBe(false);
		for (const index of [0, 2]) {
			const instance = instances[index];
			const config = configs[index];
			if (!instance || !config)
				throw new Error("Surviving registration missing");
			expect(await intervalManager.runNow(config.id)).toBe(true);
			expect(instance.update).toHaveBeenCalledTimes(2);
		}
		details.cleanup = details.effect();
		expect(register.mock.calls.at(-1)?.[0].id).toBe(detailsConfig.id);
	} finally {
		for (const instance of instances) instance.cleanup();
		register.mockRestore();
		internals.H = previous;
	}
});
