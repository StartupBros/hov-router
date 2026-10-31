import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@better-ccflare/config";
import { TIME_CONSTANTS } from "@better-ccflare/core";
import { createConfigHandlers } from "../config";

describe("GET /api/config session duration", () => {
	const originalEnv = process.env.SESSION_DURATION_MS;
	const tmpDirs: string[] = [];

	function configWith(contents: Record<string, unknown>): Config {
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-config-session-"));
		tmpDirs.push(dir);
		const path = join(dir, "config.json");
		writeFileSync(path, JSON.stringify(contents));
		return new Config(path);
	}

	async function reported(config: Config): Promise<number> {
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});
		const body = (await handlers.getConfig().json()) as {
			sessionDurationMs: number;
		};
		return body.sessionDurationMs;
	}

	afterEach(() => {
		if (originalEnv === undefined) delete process.env.SESSION_DURATION_MS;
		else process.env.SESSION_DURATION_MS = originalEnv;
		while (tmpDirs.length > 0) {
			rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
		}
	});

	it("reports a configured session_duration_ms", async () => {
		delete process.env.SESSION_DURATION_MS;
		expect(await reported(configWith({ session_duration_ms: 18_000_000 }))).toBe(
			18_000_000,
		);
	});

	it("reports a configured zero as zero", async () => {
		delete process.env.SESSION_DURATION_MS;
		expect(await reported(configWith({ session_duration_ms: 0 }))).toBe(0);
	});

	it("reports the 5-hour default when nothing is configured", async () => {
		delete process.env.SESSION_DURATION_MS;
		expect(await reported(configWith({}))).toBe(
			TIME_CONSTANTS.SESSION_DURATION_DEFAULT,
		);
	});

	it("reports the value the server runs with when only the environment sets it", async () => {
		process.env.SESSION_DURATION_MS = "7200000";
		expect(await reported(configWith({}))).toBe(7_200_000);
	});
});
