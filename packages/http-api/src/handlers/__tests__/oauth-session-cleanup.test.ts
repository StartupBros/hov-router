import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Deleting the one-shot OAuth session happens after the account was already
// created or re-authenticated. A failed delete must not turn that completed
// flow into an error: the client would retry a code that was already spent.
// The session row expires on its own (getOAuthSession filters expires_at and
// cleanupExpiredOAuthSessions removes it).

const complete = mock(async () => ({
	id: "cleanup-created-id",
	name: "cleanup-anthropic",
	provider: "anthropic" as const,
	authType: "oauth" as const,
}));
const completeReauth = mock(async () => {});

mock.module("@better-ccflare/oauth-flow", () => ({
	createOAuthFlow: async () => ({ complete, completeReauth }),
}));
mock.module("@better-ccflare/providers", () => ({
	getOAuthProvider: () => ({ getOAuthConfig: () => ({ clientId: "test" }) }),
}));
mock.module("@better-ccflare/proxy", () => ({
	clearAccountRefreshCache: () => {},
}));

const SESSION_ID = "00000000-0000-0000-0000-0000000000c1";
let configDir: string;
const originalConfigPath = process.env.BETTER_CCFLARE_CONFIG_PATH;

beforeAll(() => {
	configDir = mkdtempSync(join(tmpdir(), "oauth-session-cleanup-"));
	process.env.BETTER_CCFLARE_CONFIG_PATH = join(configDir, "config.json");
});

afterAll(() => {
	if (originalConfigPath === undefined) {
		delete process.env.BETTER_CCFLARE_CONFIG_PATH;
	} else {
		process.env.BETTER_CCFLARE_CONFIG_PATH = originalConfigPath;
	}
	rmSync(configDir, { recursive: true, force: true });
});

function failingCleanupDb() {
	const deleted: string[] = [];
	const dbOps = {
		getAdapter: () => ({
			get: async () => ({ id: "cleanup-account-id" }),
			run: async () => {},
		}),
		getOAuthSession: async () => ({
			accountName: "cleanup-anthropic",
			verifier: "verifier",
			mode: "claude-oauth",
			customEndpoint: undefined,
			priority: 0,
		}),
		deleteOAuthSession: async (sessionId: string) => {
			deleted.push(sessionId);
			throw new Error("database is locked");
		},
	};
	return { dbOps, deleted };
}

function callbackRequest(path: string): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sessionId: SESSION_ID, code: "authorization-code" }),
	});
}

describe("OAuth session cleanup after a completed flow", () => {
	it("reports a created account as success when deleting its session fails", async () => {
		const { createOAuthCallbackHandler } = await import("../oauth");
		const { dbOps, deleted } = failingCleanupDb();

		const response = await createOAuthCallbackHandler(dbOps as never)(
			callbackRequest("/api/oauth/callback"),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			success: true,
			accountId: "cleanup-created-id",
		});
		expect(complete).toHaveBeenCalledTimes(1);
		expect(deleted).toEqual([SESSION_ID]);
	});

	it("reports a re-authentication as success when deleting its session fails", async () => {
		const { createAnthropicReauthCallbackHandler } = await import("../oauth");
		const { dbOps, deleted } = failingCleanupDb();
		const config = { getRuntime: () => ({ clientId: "test-client-id" }) };

		const response = await createAnthropicReauthCallbackHandler(
			dbOps as never,
			config as never,
		)(callbackRequest("/api/oauth/reauth/anthropic/callback"));

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ success: true });
		expect(completeReauth).toHaveBeenCalledTimes(1);
		expect(deleted).toEqual([SESSION_ID]);
	});
});
