/**
 * The Codex WebSocket transport was removed. At startup the router names every
 * removed CCFLARE_CODEX_WS_* variable that is still set, says it is ignored,
 * and never prints a value.
 */
import { describe, expect, it } from "bun:test";
import {
	buildCodexWebSocketRemovedWarning,
	logCodexWebSocketRemovedWarning,
	REMOVED_CODEX_WEBSOCKET_ENV_NAMES,
	readSetCodexWebSocketEnvNames,
} from "./codex-websocket-removed-warning";

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

describe("readSetCodexWebSocketEnvNames", () => {
	it("returns the removed variables set to a non-empty value, in declared order", () => {
		expect(
			readSetCodexWebSocketEnvNames({
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

	it("covers all twelve removed variables", () => {
		const env = Object.fromEntries(
			REMOVED_CODEX_WEBSOCKET_ENV_NAMES.map((name) => [name, "1"]),
		);

		expect(readSetCodexWebSocketEnvNames(env)).toHaveLength(12);
	});
});

describe("buildCodexWebSocketRemovedWarning", () => {
	it("returns null when none of the removed variables is set", () => {
		expect(buildCodexWebSocketRemovedWarning([])).toBeNull();
	});

	it("names every set variable and says it is ignored", () => {
		const text = buildCodexWebSocketRemovedWarning([
			"CCFLARE_CODEX_WS_ACCOUNT_IDS",
			"CCFLARE_CODEX_WS_PERCENT",
		]);

		if (text === null) throw new Error("expected a warning");
		expect(text).toContain("CCFLARE_CODEX_WS_ACCOUNT_IDS");
		expect(text).toContain("CCFLARE_CODEX_WS_PERCENT");
		expect(text).toContain("ignored");
		expect(text).toContain("HTTP");
	});
});

describe("logCodexWebSocketRemovedWarning", () => {
	it("logs one warning that carries names but not values", () => {
		const { log, warnings } = recordingLog();

		logCodexWebSocketRemovedWarning(
			{
				CCFLARE_CODEX_WS_ACCOUNT_IDS: "secret-looking-account-id",
				CCFLARE_CODEX_WS_PERCENT: "37",
			},
			log,
		);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("CCFLARE_CODEX_WS_ACCOUNT_IDS");
		expect(warnings[0]).not.toContain("secret-looking-account-id");
		expect(warnings[0]).not.toContain("37");
	});

	it("logs nothing when none of the removed variables is set", () => {
		const { log, warnings } = recordingLog();

		logCodexWebSocketRemovedWarning({ PATH: "/usr/bin" }, log);

		expect(warnings).toHaveLength(0);
	});
});
