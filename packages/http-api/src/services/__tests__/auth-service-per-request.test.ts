import { describe, expect, test } from "bun:test";
import { type ApiKey, NodeCryptoUtils } from "@better-ccflare/types/api-key";
import { AuthService } from "../auth-service";

/**
 * A proxied request is authenticated twice on the same Request object: once
 * by ApiRouter.handleRequest (which finds no /api route and returns null) and
 * again by server.ts before it proxies. Each authentication incremented the
 * key's usage_count, so proxy traffic was counted double.
 */
describe("authentication is computed once per request", () => {
	async function setup(lookupDelayMs = 0) {
		const crypto = new NodeCryptoUtils();
		const raw = await crypto.generateApiKey();
		const record: ApiKey = {
			id: "key-1",
			name: "primary",
			hashedKey: await crypto.hashApiKey(raw),
			prefixLast8: raw.slice(-8),
			createdAt: 0,
			lastUsed: null,
			usageCount: 0,
			isActive: true,
			role: "api-only",
		};
		const calls = { usage: 0, activeKeys: 0 };
		const auth = new AuthService({
			countActiveApiKeys: async () => 1,
			getActiveApiKeys: async () => {
				calls.activeKeys++;
				if (lookupDelayMs) await Bun.sleep(lookupDelayMs);
				return [record];
			},
			updateApiKeyUsage: async () => {
				calls.usage++;
			},
		} as never);
		const proxied = () =>
			new Request("http://localhost/v1/messages", {
				method: "POST",
				headers: { "x-api-key": raw },
			});
		return { auth, calls, proxied };
	}

	test("the router and the proxy path share one result for the same Request", async () => {
		const { auth, calls, proxied } = await setup();
		const req = proxied();

		const first = await auth.authenticateRequest(req, "/v1/messages", "POST");
		const second = await auth.authenticateRequest(req, "/v1/messages", "POST");
		await Bun.sleep(5);

		expect(first.isAuthenticated).toBe(true);
		expect(second).toEqual(first);
		expect(calls.usage).toBe(1);
		expect(calls.activeKeys).toBe(1);
	});

	test("overlapping authentications of one Request share the in-flight result", async () => {
		const { auth, calls, proxied } = await setup(20);
		const req = proxied();

		const [first, second] = await Promise.all([
			auth.authenticateRequest(req, "/v1/messages", "POST"),
			auth.authenticateRequest(req, "/v1/messages", "POST"),
		]);
		await Bun.sleep(5);

		expect(first.isAuthenticated).toBe(true);
		expect(second).toEqual(first);
		expect(calls.activeKeys).toBe(1);
		expect(calls.usage).toBe(1);
	});

	test("a failed authentication is not remembered for the next call", async () => {
		let fail = true;
		const auth = new AuthService({
			countActiveApiKeys: async () => {
				if (fail) throw new Error("database is locked");
				return 0;
			},
			getActiveApiKeys: async () => [],
			updateApiKeyUsage: async () => {},
		} as never);
		const req = new Request("http://localhost/v1/messages", { method: "POST" });

		await expect(
			auth.authenticateRequest(req, "/v1/messages", "POST"),
		).rejects.toThrow("database is locked");
		fail = false;
		// No keys configured once the database answers: authentication is off.
		expect(
			(await auth.authenticateRequest(req, "/v1/messages", "POST"))
				.isAuthenticated,
		).toBe(true);
	});

	test("separate requests are each authenticated and counted", async () => {
		const { auth, calls, proxied } = await setup();

		await auth.authenticateRequest(proxied(), "/v1/messages", "POST");
		await auth.authenticateRequest(proxied(), "/v1/messages", "POST");
		await Bun.sleep(5);

		expect(calls.usage).toBe(2);
		expect(calls.activeKeys).toBe(2);
	});

	test("a different path or method on the same Request is authenticated afresh", async () => {
		const { auth, calls, proxied } = await setup();
		const req = proxied();

		await auth.authenticateRequest(req, "/v1/messages", "POST");
		await auth.authenticateRequest(req, "/v1/messages/count_tokens", "POST");
		await auth.authenticateRequest(req, "/v1/messages", "GET");

		expect(calls.activeKeys).toBe(3);
	});
});
