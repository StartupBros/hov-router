import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "../database-operations";

type AccountsRepo = { incrementUsage: (id: string, ms: number) => unknown };

describe("updateAccountUsage session duration", () => {
	let dir: string;
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ccflare-session-duration-"));
		dbOps = new DatabaseOperations(join(dir, "test.db"));
	});

	afterEach(async () => {
		await dbOps.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function runtime(sessionDurationMs: number) {
		return {
			clientId: "test",
			retry: { attempts: 3, delayMs: 1000, backoff: 2 },
			sessionDurationMs,
			port: 8080,
		};
	}

	async function durationPassed(
		sessionDurationMs: number | undefined,
	): Promise<number> {
		if (sessionDurationMs !== undefined) {
			dbOps.setRuntimeConfig(runtime(sessionDurationMs));
		}
		const repo = (dbOps as unknown as { accounts: AccountsRepo }).accounts;
		const spy = spyOn(repo, "incrementUsage").mockResolvedValue(undefined);
		try {
			await dbOps.updateAccountUsage("acct");
			return spy.mock.calls[0][1] as number;
		} finally {
			spy.mockRestore();
		}
	}

	it("keeps a configured session duration of 0", async () => {
		expect(await durationPassed(0)).toBe(0);
	});

	it("passes a configured duration through", async () => {
		expect(await durationPassed(1_800_000)).toBe(1_800_000);
	});

	it("falls back to 5 hours when no runtime config is set", async () => {
		expect(await durationPassed(undefined)).toBe(5 * 60 * 60 * 1000);
	});
});
