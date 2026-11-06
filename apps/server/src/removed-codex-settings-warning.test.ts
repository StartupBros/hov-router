/**
 * Removed Codex features leave their environment variables behind in existing
 * installs. At startup the router names every removed variable that is still
 * set, one warning line per removed feature, says it is ignored, and never
 * prints a value.
 */
import { describe, expect, it } from "bun:test";
import { PRODUCT_NAME } from "@better-ccflare/core/product-identity";
import {
	buildRemovedSettingsWarning,
	logRemovedCodexSettingsWarnings,
	REMOVED_CODEX_CACHE_EXPERIMENT_ENV_NAMES,
	REMOVED_CODEX_CONTINUITY_CANARY_ENV_NAMES,
	REMOVED_CODEX_SETTING_GROUPS,
	REMOVED_CODEX_WEBSOCKET_ENV_NAMES,
	readSetEnvNames,
} from "./removed-codex-settings-warning";

function recordingLog() {
	const warnings: string[] = [];
	return {
		warnings,
		log: {
			warn: (message: string) => {
				warnings.push(message);
			},
		},
	};
}

function groupFor(names: readonly string[]) {
	const group = REMOVED_CODEX_SETTING_GROUPS.find(
		(candidate) => candidate.names === names,
	);
	if (!group) throw new Error("expected a registered group");
	return group;
}

describe("readSetEnvNames", () => {
	it("returns the removed variables set to a non-empty value, in declared order", () => {
		expect(
			readSetEnvNames(REMOVED_CODEX_WEBSOCKET_ENV_NAMES, {
				CCFLARE_CODEX_WS_PERCENT: "0",
				CCFLARE_CODEX_WS_ACCOUNT_IDS: "acct-a,acct-b",
				CCFLARE_CODEX_WS_OBSERVE_ONLY: "1",
				CCFLARE_CODEX_WS_MODELS: "",
				CCFLARE_CODEX_WS_MAX_GLOBAL: "   ",
				CCFLARE_CODEX_TURN_STATE_PERCENT: "100",
				PATH: "/usr/bin",
			}),
		).toEqual([
			"CCFLARE_CODEX_WS_ACCOUNT_IDS",
			"CCFLARE_CODEX_WS_OBSERVE_ONLY",
			"CCFLARE_CODEX_WS_PERCENT",
		]);
	});

	it("covers all twelve removed WebSocket variables", () => {
		const env = Object.fromEntries(
			REMOVED_CODEX_WEBSOCKET_ENV_NAMES.map((name) => [name, "1"]),
		);

		expect(
			readSetEnvNames(REMOVED_CODEX_WEBSOCKET_ENV_NAMES, env),
		).toHaveLength(12);
	});

	it("covers the continuity canary and the five retired cache experiments", () => {
		expect(REMOVED_CODEX_CONTINUITY_CANARY_ENV_NAMES).toEqual([
			"CCFLARE_CODEX_CACHE_KEY_CONTINUITY_PERCENT",
		]);
		expect([...REMOVED_CODEX_CACHE_EXPERIMENT_ENV_NAMES].sort()).toEqual([
			"CCFLARE_CODEX_CACHE_KEY_PREFIX_SHARD_PERCENT",
			"CCFLARE_CODEX_CACHE_KEY_SESSION_PERCENT",
			"CCFLARE_CODEX_CACHE_PACING_SETTLE_MS",
			"CCFLARE_CODEX_GPT56_EXPLICIT_CACHE_BREAKPOINT_PERCENT",
			"CCFLARE_CODEX_PACING_BYPASS_PERCENT",
		]);
	});

	it("never lists a setting that still works", () => {
		const all = REMOVED_CODEX_SETTING_GROUPS.flatMap((group) => group.names);
		for (const live of [
			"CCFLARE_CODEX_CACHE_KEY_MODE",
			"CCFLARE_CODEX_PROMPT_CACHE_KEY",
			"CCFLARE_CODEX_EFFECTIVE_CONTEXT",
			"CCFLARE_CODEX_TRACE_DIR",
		]) {
			expect(all).not.toContain(live);
		}
		expect(new Set(all).size).toBe(all.length);
	});
});

describe("buildRemovedSettingsWarning", () => {
	it("returns null when none of the group's variables is set", () => {
		expect(
			buildRemovedSettingsWarning(
				groupFor(REMOVED_CODEX_WEBSOCKET_ENV_NAMES),
				[],
			),
		).toBeNull();
	});

	it("keeps the WebSocket warning text unchanged", () => {
		expect(
			buildRemovedSettingsWarning(groupFor(REMOVED_CODEX_WEBSOCKET_ENV_NAMES), [
				"CCFLARE_CODEX_WS_ACCOUNT_IDS",
				"CCFLARE_CODEX_WS_PERCENT",
			]),
		).toBe(
			`The Codex WebSocket transport was removed from ${PRODUCT_NAME}. 2 settings are still set and ignored: CCFLARE_CODEX_WS_ACCOUNT_IDS, CCFLARE_CODEX_WS_PERCENT. ` +
				"Codex requests always go over HTTP. Remove these variables from the environment to silence this warning.",
		);
	});

	it("says continuity is always on for the retired continuity canary", () => {
		const text = buildRemovedSettingsWarning(
			groupFor(REMOVED_CODEX_CONTINUITY_CANARY_ENV_NAMES),
			["CCFLARE_CODEX_CACHE_KEY_CONTINUITY_PERCENT"],
		);

		if (text === null) throw new Error("expected a warning");
		expect(text).toContain("1 setting is still set and ignored");
		expect(text).toContain("CCFLARE_CODEX_CACHE_KEY_CONTINUITY_PERCENT");
		expect(text).toContain("always on");
		expect(text).toContain("CCFLARE_CODEX_CACHE_KEY_MODE=session");
		expect(text).toContain("CCFLARE_CODEX_SINGLE_ORCHESTRATION_ROOT=0");
	});

	it("says the retired cache experiments behave as they did at 0", () => {
		const text = buildRemovedSettingsWarning(
			groupFor(REMOVED_CODEX_CACHE_EXPERIMENT_ENV_NAMES),
			[
				"CCFLARE_CODEX_CACHE_KEY_SESSION_PERCENT",
				"CCFLARE_CODEX_PACING_BYPASS_PERCENT",
			],
		);

		if (text === null) throw new Error("expected a warning");
		expect(text).toContain("CCFLARE_CODEX_CACHE_KEY_SESSION_PERCENT");
		expect(text).toContain("CCFLARE_CODEX_PACING_BYPASS_PERCENT");
		expect(text).toContain("ignored");
		expect(text).toContain("at 0");
	});
});

describe("logRemovedCodexSettingsWarnings", () => {
	it("logs one warning per removed feature that carries names but not values", () => {
		const { log, warnings } = recordingLog();

		logRemovedCodexSettingsWarnings(
			{
				CCFLARE_CODEX_WS_ACCOUNT_IDS: "secret-looking-account-id",
				CCFLARE_CODEX_WS_PERCENT: "37",
				CCFLARE_CODEX_CACHE_KEY_CONTINUITY_PERCENT: "100",
				CCFLARE_CODEX_CACHE_KEY_SESSION_PERCENT: "0",
				CCFLARE_CODEX_CACHE_PACING_SETTLE_MS: "250",
			},
			log,
		);

		expect(warnings).toHaveLength(3);
		expect(warnings[0]).toContain("WebSocket");
		expect(warnings[0]).toContain("CCFLARE_CODEX_WS_ACCOUNT_IDS");
		expect(warnings[1]).toContain("CCFLARE_CODEX_CACHE_KEY_CONTINUITY_PERCENT");
		expect(warnings[2]).toContain("CCFLARE_CODEX_CACHE_KEY_SESSION_PERCENT");
		expect(warnings[2]).toContain("CCFLARE_CODEX_CACHE_PACING_SETTLE_MS");
		for (const warning of warnings) {
			expect(warning).not.toContain("secret-looking-account-id");
			expect(warning).not.toContain("37");
			expect(warning).not.toContain("250");
		}
	});

	it("logs only the features whose variables are set", () => {
		const { log, warnings } = recordingLog();

		logRemovedCodexSettingsWarnings(
			{ CCFLARE_CODEX_GPT56_EXPLICIT_CACHE_BREAKPOINT_PERCENT: "0" },
			log,
		);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(
			"CCFLARE_CODEX_GPT56_EXPLICIT_CACHE_BREAKPOINT_PERCENT",
		);
	});

	it("logs nothing when none of the removed variables is set", () => {
		const { log, warnings } = recordingLog();

		logRemovedCodexSettingsWarnings({ PATH: "/usr/bin" }, log);

		expect(warnings).toHaveLength(0);
	});
});
