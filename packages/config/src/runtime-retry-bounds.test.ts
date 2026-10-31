import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@better-ccflare/logger";
import { Config } from "./index";
import { resetRuntimeWarningsForTest } from "./runtime-validation";

const ENV_KEYS = [
	"RETRY_ATTEMPTS",
	"RETRY_DELAY_MS",
	"RETRY_BACKOFF",
	"SESSION_DURATION_MS",
] as const;

describe("getRuntime() retry bounds and env resolution", () => {
	const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
	let dir: string;
	let configPath: string;

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		dir = mkdtempSync(join(tmpdir(), "better-ccflare-runtime-bounds-"));
		configPath = join(dir, "config.json");
		resetRuntimeWarningsForTest();
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		rmSync(dir, { recursive: true, force: true });
	});

	function configWith(fileContents: Record<string, unknown>): Config {
		writeFileSync(configPath, JSON.stringify(fileContents));
		return new Config(configPath);
	}

	it("keeps the production defaults untouched", () => {
		const runtime = configWith({
			retry_attempts: 3,
			retry_delay_ms: 1000,
			retry_backoff: 2,
			session_duration_ms: 18_000_000,
		}).getRuntime();
		expect(runtime.retry).toEqual({ attempts: 3, delayMs: 1000, backoff: 2 });
		expect(runtime.sessionDurationMs).toBe(18_000_000);
	});

	it("honours RETRY_ATTEMPTS when the file has no key, without rewriting the file", () => {
		const original = JSON.stringify({});
		writeFileSync(configPath, original);
		process.env.RETRY_ATTEMPTS = "7";
		const config = new Config(configPath);
		expect(config.getRuntime().retry.attempts).toBe(7);
		expect(readFileSync(configPath, "utf8")).toBe(original);
	});

	it("clamps attempts to 0..10 and floors fractions", () => {
		expect(configWith({ retry_attempts: 99 }).getRuntime().retry.attempts).toBe(
			10,
		);
		expect(configWith({ retry_attempts: -1 }).getRuntime().retry.attempts).toBe(
			0,
		);
		expect(
			configWith({ retry_attempts: 1.6 }).getRuntime().retry.attempts,
		).toBe(1);
	});

	it("clamps delay to 0..30000 and backoff to 1..5", () => {
		const retry = configWith({
			retry_delay_ms: 99_999,
			retry_backoff: 0.5,
		}).getRuntime().retry;
		expect(retry.delayMs).toBe(30_000);
		expect(retry.backoff).toBe(1);
		expect(configWith({ retry_backoff: 9 }).getRuntime().retry.backoff).toBe(5);
	});

	it("falls back to the default for a non-numeric env value", () => {
		process.env.RETRY_ATTEMPTS = "abc";
		expect(configWith({}).getRuntime().retry.attempts).toBe(3);
	});

	it("warns once per distinct misconfiguration", () => {
		const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
		try {
			const config = configWith({ retry_attempts: 99 });
			config.getRuntime();
			config.getRuntime();
			config.getRuntime();
			const attemptWarnings = warn.mock.calls.filter((call) =>
				String(call[0]).includes("retry_attempts"),
			);
			expect(attemptWarnings.length).toBe(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("keeps a configured session_duration_ms of 0 at 0", () => {
		expect(
			configWith({ session_duration_ms: 0 }).getRuntime().sessionDurationMs,
		).toBe(0);
	});

	it("keeps SESSION_DURATION_MS=0 at 0", () => {
		process.env.SESSION_DURATION_MS = "0";
		expect(configWith({}).getRuntime().sessionDurationMs).toBe(0);
	});

	it("falls back to the default session duration for a non-numeric SESSION_DURATION_MS", () => {
		// parseInt("abc") is NaN; in SessionStrategy `elapsed >= NaN` is always
		// false, so a NaN duration would silently stop sessions from expiring.
		process.env.SESSION_DURATION_MS = "abc";
		expect(configWith({}).getRuntime().sessionDurationMs).toBe(18_000_000);
	});

	it("falls back to the default session duration for a negative value from either source", () => {
		process.env.SESSION_DURATION_MS = "-5";
		expect(configWith({}).getRuntime().sessionDurationMs).toBe(18_000_000);
		delete process.env.SESSION_DURATION_MS;
		expect(
			configWith({ session_duration_ms: -1 }).getRuntime().sessionDurationMs,
		).toBe(18_000_000);
	});

	it("warns once about an invalid session duration", () => {
		const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
		try {
			process.env.SESSION_DURATION_MS = "abc";
			const config = configWith({});
			config.getRuntime();
			config.getRuntime();
			const sessionWarnings = warn.mock.calls.filter((call) =>
				String(call[0]).includes("session_duration_ms"),
			);
			expect(sessionWarnings.length).toBe(1);
		} finally {
			warn.mockRestore();
		}
	});
});
