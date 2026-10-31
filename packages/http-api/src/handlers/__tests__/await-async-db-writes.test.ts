/**
 * dbOps writes that return promises must be awaited by the handler. Without
 * the await a rejected write either returned `success: true` or surfaced as an
 * unhandled rejection. Each test makes the write reject and expects a non-200.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { Config } from "@better-ccflare/config";
import { DatabaseOperations } from "@better-ccflare/database";
import type { APIContext } from "@better-ccflare/types";
import {
	createAccountPriorityUpdateHandler,
	createAccountAutoFallbackHandler,
	createAccountAutoPauseOnOverageHandler,
} from "../accounts";
import { createAgentPreferenceUpdateHandler } from "../agents";
import { createAnthropicReauthInitHandler } from "../oauth";

const DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-await-async-db-writes.db`;

function cleanup() {
	for (const suffix of ["", "-wal", "-shm"]) {
		try {
			if (existsSync(DB_PATH + suffix)) unlinkSync(DB_PATH + suffix);
		} catch {
			// ignore
		}
	}
}

const boom = async () => {
	throw new Error("simulated database write failure");
};

describe("handlers await async database writes", () => {
	let dbOps: DatabaseOperations;
	const accountId = "await-writes-anthropic";

	beforeAll(async () => {
		cleanup();
		dbOps = new DatabaseOperations(DB_PATH);
		const now = Date.now();
		await dbOps.getAdapter().run(
			`INSERT INTO accounts (id, name, provider, api_key, refresh_token, access_token,
				expires_at, created_at, request_count, total_requests, priority,
				custom_endpoint, model_mappings, model_fallbacks)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, NULL, NULL)`,
			[
				accountId,
				"await-writes-account",
				"anthropic",
				null,
				"rt",
				"at",
				now + 3600000,
				now,
			],
		);
	});

	afterAll(async () => {
		await dbOps.close();
		cleanup();
	});

	function json(body: unknown): Request {
		return new Request("http://localhost/api/test", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("account priority update returns non-200 when updateAccountPriority rejects", async () => {
		const original = dbOps.updateAccountPriority;
		dbOps.updateAccountPriority = boom as typeof original;
		try {
			const res = await createAccountPriorityUpdateHandler(dbOps)(
				json({ priority: 5 }),
				accountId,
			);
			expect(res.status).not.toBe(200);
		} finally {
			dbOps.updateAccountPriority = original;
		}
	});

	it("auto-fallback toggle returns non-200 when setAutoFallbackEnabled rejects", async () => {
		const original = dbOps.setAutoFallbackEnabled;
		dbOps.setAutoFallbackEnabled = boom as typeof original;
		try {
			const res = await createAccountAutoFallbackHandler(dbOps)(
				json({ enabled: 1 }),
				accountId,
			);
			expect(res.status).not.toBe(200);
		} finally {
			dbOps.setAutoFallbackEnabled = original;
		}
	});

	it("auto-pause-on-overage toggle returns non-200 when setAutoPauseOnOverageEnabled rejects", async () => {
		const original = dbOps.setAutoPauseOnOverageEnabled;
		dbOps.setAutoPauseOnOverageEnabled = boom as typeof original;
		try {
			const res = await createAccountAutoPauseOnOverageHandler(dbOps)(
				json({ enabled: 1 }),
				accountId,
			);
			expect(res.status).not.toBe(200);
		} finally {
			dbOps.setAutoPauseOnOverageEnabled = original;
		}
	});

	it("agent preference update returns non-200 when setAgentPreference rejects", async () => {
		const original = dbOps.setAgentPreference;
		dbOps.setAgentPreference = boom as typeof original;
		const catalog: APIContext["modelCatalog"] = {
			get: async () => ({
				models: [
					{
						id: "claude-3-5-sonnet-20241022",
						displayName: "claude-3-5-sonnet-20241022",
						createdAt: null,
					},
				],
				fetchedAt: Date.now(),
				source: "live",
			}),
			refresh: async () => ({ success: true }),
		};
		try {
			const res = await createAgentPreferenceUpdateHandler(dbOps, catalog)(
				json({ model: "claude-3-5-sonnet-20241022" }),
				"agent-1",
			);
			expect(res.status).not.toBe(200);
		} finally {
			dbOps.setAgentPreference = original;
		}
	});

	it("Anthropic reauth init returns non-200 when createOAuthSession rejects", async () => {
		const original = dbOps.createOAuthSession;
		dbOps.createOAuthSession = boom as typeof original;
		const stubConfig = {
			getRuntime: () => ({ clientId: "test-client-id" }),
		} as unknown as Config;
		try {
			const res = await createAnthropicReauthInitHandler(dbOps, stubConfig)(
				json({ accountId }),
			);
			expect(res.status).not.toBe(200);
		} finally {
			dbOps.createOAuthSession = original;
		}
	});
});
