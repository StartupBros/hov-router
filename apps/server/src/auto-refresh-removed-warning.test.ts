/**
 * Auto-refresh was removed. At startup the router names every account whose
 * stored setting is still on, says what those accounts lost, and how to clear
 * the setting. The queries run against a real in-memory database.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseOperations } from "@better-ccflare/database";
import { createAccountAutoRefreshHandler } from "../../../packages/http-api/src/handlers/accounts";
import {
	buildAutoRefreshRemovedWarning,
	logAutoRefreshRemovedWarning,
	readAutoRefreshOptedInAccountNames,
} from "./auto-refresh-removed-warning";

let dbOps: DatabaseOperations;

beforeEach(() => {
	dbOps = new DatabaseOperations(":memory:", { walMode: false });
});

afterEach(async () => {
	await dbOps.close();
});

async function insertAccount(
	id: string,
	autoRefreshEnabled: 0 | 1 | null,
): Promise<void> {
	await dbOps.getAdapter().run(
		`INSERT INTO accounts
			(id, name, provider, refresh_token, access_token, expires_at, created_at, auto_refresh_enabled)
		 VALUES (?, ?, 'anthropic', 'rt-fixture', 'at-fixture', ?, ?, ?)`,
		[id, id, Date.now() + 60 * 60 * 1000, Date.now(), autoRefreshEnabled],
	);
}

function recordingLog() {
	const warnings: string[] = [];
	const errors: unknown[][] = [];
	return {
		warnings,
		errors,
		log: {
			warn: (message: string) => {
				warnings.push(message);
			},
			error: (...args: unknown[]) => {
				errors.push(args);
			},
		},
	};
}

describe("buildAutoRefreshRemovedWarning", () => {
	it("returns null when no account has the setting on", () => {
		expect(buildAutoRefreshRemovedWarning([])).toBeNull();
	});

	it("names every opted-in account, what they lost, and how to turn it off", () => {
		const names = Array.from(
			{ length: 12 },
			(_, index) => `acct-${String(index).padStart(2, "0")}`,
		);

		const text = buildAutoRefreshRemovedWarning(names);

		if (text === null) throw new Error("expected a warning");
		for (const name of names) expect(text).toContain(name);
		expect(text).toContain("usage windows opened ahead of use");
		expect(text).toContain("pauses lifted after a probe");
		expect(text).toContain("POST /api/accounts/<id>/auto-refresh");
		expect(text).toContain('{"enabled": false}');
	});
});

describe("readAutoRefreshOptedInAccountNames", () => {
	it("returns the sorted names of accounts whose stored value is on", async () => {
		await insertAccount("bravo", 1);
		await insertAccount("alpha", 1);
		await insertAccount("charlie", 0);
		await insertAccount("delta", null);

		expect(
			await readAutoRefreshOptedInAccountNames(dbOps.getAdapter()),
		).toEqual(["alpha", "bravo"]);
	});

	it("stops naming an account once its setting is turned off through the endpoint", async () => {
		await insertAccount("alpha", 1);
		await insertAccount("bravo", 1);

		const response = await createAccountAutoRefreshHandler(dbOps)(
			new Request("http://localhost/api/accounts/alpha/auto-refresh", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: false }),
			}),
			"alpha",
		);

		expect(response.status).toBe(200);
		expect(
			await readAutoRefreshOptedInAccountNames(dbOps.getAdapter()),
		).toEqual(["bravo"]);
	});
});

describe("logAutoRefreshRemovedWarning", () => {
	it("logs one warning naming the opted-in accounts", async () => {
		await insertAccount("alpha", 1);
		await insertAccount("bravo", 0);
		const { log, warnings, errors } = recordingLog();

		await logAutoRefreshRemovedWarning(dbOps.getAdapter(), log);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("alpha");
		expect(warnings[0]).not.toContain("bravo");
		expect(errors).toHaveLength(0);
	});

	it("logs nothing when no account has the setting on", async () => {
		await insertAccount("alpha", 0);
		const { log, warnings, errors } = recordingLog();

		await logAutoRefreshRemovedWarning(dbOps.getAdapter(), log);

		expect(warnings).toHaveLength(0);
		expect(errors).toHaveLength(0);
	});

	it("logs a failed query instead of throwing, so startup continues", async () => {
		const { log, warnings, errors } = recordingLog();
		const failingDb = {
			query: async () => {
				throw new Error("no such table: accounts");
			},
		};

		await logAutoRefreshRemovedWarning(failingDb, log);

		expect(warnings).toHaveLength(0);
		expect(errors).toHaveLength(1);
	});
});
