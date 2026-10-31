import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@better-ccflare/config";
import { buildServerRuntimeConfig } from "./runtime-config";

describe("buildServerRuntimeConfig", () => {
	let dir: string;
	let configPath: string;
	let savedAttempts: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "better-ccflare-server-runtime-"));
		configPath = join(dir, "config.json");
		savedAttempts = process.env.RETRY_ATTEMPTS;
		delete process.env.RETRY_ATTEMPTS;
	});

	afterEach(() => {
		if (savedAttempts === undefined) delete process.env.RETRY_ATTEMPTS;
		else process.env.RETRY_ATTEMPTS = savedAttempts;
		rmSync(dir, { recursive: true, force: true });
	});

	it("honours RETRY_ATTEMPTS and does not write defaults into the config file", () => {
		const original = JSON.stringify({});
		writeFileSync(configPath, original);
		process.env.RETRY_ATTEMPTS = "7";
		const config = new Config(configPath);

		const runtime = buildServerRuntimeConfig(config, 8081);

		expect(runtime.retry.attempts).toBe(7);
		expect(runtime.port).toBe(8081);
		expect(readFileSync(configPath, "utf8")).toBe(original);
	});

	it("keeps a configured session_duration_ms of 0 at 0", () => {
		writeFileSync(configPath, JSON.stringify({ session_duration_ms: 0 }));
		const runtime = buildServerRuntimeConfig(new Config(configPath), 8080);
		expect(runtime.sessionDurationMs).toBe(0);
	});

	it("matches the production defaults when the file holds them", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				retry_attempts: 3,
				retry_delay_ms: 1000,
				retry_backoff: 2,
				session_duration_ms: 18_000_000,
			}),
		);
		const runtime = buildServerRuntimeConfig(new Config(configPath), 8080);
		expect(runtime.retry).toEqual({ attempts: 3, delayMs: 1000, backoff: 2 });
		expect(runtime.sessionDurationMs).toBe(18_000_000);
	});

	it("server.ts no longer builds retry or session settings with config.get", () => {
		const source = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
		expect(source).not.toContain('config.get("retry_attempts"');
		expect(source).not.toContain('config.get("retry_delay_ms"');
		expect(source).not.toContain('config.get("retry_backoff"');
		expect(source).not.toContain('config.get("session_duration_ms"');
	});
});
