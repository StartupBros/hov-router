import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "@better-ccflare/config";
import { DatabaseFactory } from "../factory";

// The server's runtime config only takes effect if it reaches the factory
// before the first getInstance(). The CLI's --serve path once opened the
// database unconfigured first, so production ran synchronous=FULL with mmap
// off and paid a WAL fsync on the event loop for every commit (#606).
const runtime: RuntimeConfig = {
	clientId: "test",
	retry: { attempts: 3, delayMs: 1000, backoff: 2 },
	sessionDurationMs: 5 * 60 * 60 * 1000,
	port: 8080,
	database: {
		walMode: true,
		busyTimeoutMs: 5000,
		synchronous: "NORMAL",
		mmapSize: 268435456,
	},
};

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ccflare-factory-runtime-"));
});
afterEach(async () => {
	await DatabaseFactory.closeAll();
	rmSync(dir, { recursive: true, force: true });
});

function pragma(name: string): unknown {
	const row = DatabaseFactory.getInstance()
		.getDatabase()
		.query(`PRAGMA ${name}`)
		.get() as Record<string, unknown>;
	return Object.values(row)[0];
}

describe("database factory runtime config", () => {
	it("opens the database with the runtime config's pragmas", () => {
		DatabaseFactory.initialize(join(dir, "test.db"), runtime);
		expect(pragma("synchronous")).toBe(1); // NORMAL
		expect(pragma("mmap_size")).toBe(268435456);
		expect(pragma("busy_timeout")).toBe(5000);
	});

	it("refuses a runtime config once the database is already open", () => {
		const path = join(dir, "test.db");
		DatabaseFactory.initialize(path);
		DatabaseFactory.getInstance();
		expect(() => DatabaseFactory.initialize(path, runtime)).toThrow(
			/already open/,
		);
		expect(pragma("synchronous")).toBe(2); // the open connection is unchanged
	});

	it("refuses a different path once the database is already open", () => {
		DatabaseFactory.initialize(join(dir, "test.db"));
		DatabaseFactory.getInstance();
		expect(() => DatabaseFactory.initialize(join(dir, "other.db"))).toThrow(
			/already open/,
		);
	});

	it("accepts a repeat of the settings the open database already uses", () => {
		const path = join(dir, "test.db");
		DatabaseFactory.initialize(path, runtime);
		const db = DatabaseFactory.getInstance();
		DatabaseFactory.initialize(path, runtime);
		expect(DatabaseFactory.getInstance()).toBe(db);
	});
});
