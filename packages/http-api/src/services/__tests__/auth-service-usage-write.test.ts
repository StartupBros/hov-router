import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NodeCryptoUtils } from "@better-ccflare/types/api-key";
import { AuthService } from "../auth-service";

/**
 * Recording an API key's last use is best-effort. On 2026-10-25 production
 * exited with status 1 when that write hit SQLITE_FULL: the promise was never
 * awaited or caught, so the rejection was unhandled and Bun terminated the
 * whole router mid-stream for every client.
 */
describe("API key usage write", () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason);
	};

	beforeEach(() => {
		unhandled.length = 0;
		process.on("unhandledRejection", onUnhandled);
	});

	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
	});

	test("a failed usage write neither rejects authentication nor escapes unhandled", async () => {
		const crypto = new NodeCryptoUtils();
		const rawKey = await crypto.generateApiKey();
		const hashedKey = await crypto.hashApiKey(rawKey);
		const auth = new AuthService({
			countActiveApiKeys: async () => 1,
			getActiveApiKeys: async () => [
				{
					id: "key-1",
					name: "primary",
					hashedKey,
					prefixLast8: rawKey.slice(-8),
					createdAt: 0,
					lastUsed: null,
					usageCount: 0,
					isActive: true,
					role: "admin",
				},
			],
			updateApiKeyUsage: async () => {
				throw Object.assign(new Error("database or disk is full"), {
					code: "SQLITE_FULL",
				});
			},
		} as never);

		const result = await auth.validateApiKey(rawKey);
		// Let the rejected write settle and any unhandled-rejection event fire.
		await Bun.sleep(10);

		expect(result.isAuthenticated).toBe(true);
		expect(result.apiKeyId).toBe("key-1");
		expect(unhandled).toEqual([]);
	});
});
