/**
 * The stored request payload must not carry the credential headers an
 * upstream sends back (Set-Cookie, WWW-Authenticate and the like). The request
 * side has been sanitized before persistence all along; this pins the
 * response side at the one place the collector writes it, so every producer
 * of StartMessage.responseHeaders is covered.
 *
 * The client still receives every header: only the persisted copy is
 * stripped.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";

import {
	AsyncDbWriter,
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import { UsageCollector } from "../usage-collector";
import type { EndMessage, StartMessage } from "../worker-messages";

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-usage-collector-response-header-strip.db`;

describe("UsageCollector - persisted response headers drop credentials", () => {
	let dbOps: DatabaseOperations;
	let asyncWriter: AsyncDbWriter;
	let collector: UsageCollector;

	beforeAll(() => {
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch (error) {
			console.warn("Failed to clean up existing test database:", error);
		}
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		asyncWriter = new AsyncDbWriter();
		collector = new UsageCollector(
			dbOps,
			asyncWriter,
			() => true, // store payloads, so the response headers are persisted
			() => {},
		);
	});

	afterAll(async () => {
		collector.dispose();
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch (error) {
			console.warn("Failed to clean up test database:", error);
		}
	});

	test("strips set-cookie and the auth challenge headers, keeps the rest", async () => {
		const requestId = "response-header-strip-1";
		const start: StartMessage = {
			type: "start",
			messageId: `msg-${requestId}`,
			requestId,
			accountId: null,
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			requestHeaders: {},
			requestBody: null,
			project: null,
			responseStatus: 200,
			responseHeaders: {
				"set-cookie": "session=upstream-secret; HttpOnly",
				"www-authenticate": 'Bearer realm="api"',
				"proxy-authenticate": "Basic realm=proxy",
				authorization: "Bearer upstream-token",
				"content-type": "application/json",
				"request-id": "req_upstream",
				"anthropic-ratelimit-unified-overage-status": "allowed",
			},
			isStream: false,
			providerName: "anthropic",
			accountBillingType: null,
			accountAutoPauseOnOverageEnabled: null,
			accountName: null,
			agentUsed: null,
			comboName: null,
			comboModelOverrideFrom: null,
			comboModelOverrideTo: null,
			apiKeyId: null,
			apiKeyName: null,
			retryAttempt: 0,
			failoverAttempts: 0,
		};

		collector.handleStart(start);
		const endMsg: EndMessage = { type: "end", requestId, success: true };
		await collector.handleEnd(endMsg);
		await collector.drain();

		const payload = (await dbOps.getRequestPayload(requestId)) as {
			response?: { headers?: Record<string, string> };
		} | null;
		expect(payload).not.toBeNull();
		expect(payload?.response?.headers).toEqual({
			"content-type": "application/json",
			"request-id": "req_upstream",
			"anthropic-ratelimit-unified-overage-status": "allowed",
		});
	});
});
