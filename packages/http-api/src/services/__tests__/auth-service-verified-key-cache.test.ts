import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { type ApiKey, NodeCryptoUtils } from "@better-ccflare/types/api-key";
import { AuthService } from "../auth-service";

/**
 * Every dashboard poll and proxied request presents the same API key, and
 * each verification is a scrypt run (~20 ms CPU and a 16 MiB work buffer).
 * The service remembers keys it has already verified, but must still apply
 * revocation, deletion, rotation and role changes on the very next request.
 */
describe("verified API key cache", () => {
	const spies: Array<{ mockRestore(): void }> = [];
	afterEach(() => {
		for (const spy of spies.splice(0)) spy.mockRestore();
	});

	async function makeKey(id: string, role: ApiKey["role"] = "admin") {
		const crypto = new NodeCryptoUtils();
		const raw = await crypto.generateApiKey();
		const record: ApiKey = {
			id,
			name: id,
			hashedKey: await crypto.hashApiKey(raw),
			prefixLast8: raw.slice(-8),
			createdAt: 0,
			lastUsed: null,
			usageCount: 0,
			isActive: true,
			role,
		};
		return { raw, record };
	}

	function serviceOver(active: () => ApiKey[]) {
		return new AuthService({
			countActiveApiKeys: async () => active().length,
			getActiveApiKeys: async () => active(),
			updateApiKeyUsage: async () => {},
		} as never);
	}

	function countVerifies() {
		const spy = spyOn(NodeCryptoUtils.prototype, "verifyApiKey");
		spies.push(spy);
		return spy;
	}

	test("a key verified once is not re-hashed on later requests", async () => {
		const { raw, record } = await makeKey("key-1");
		const auth = serviceOver(() => [record]);
		const verifies = countVerifies();

		for (let i = 0; i < 5; i++) {
			const result = await auth.validateApiKey(raw);
			expect(result.isAuthenticated).toBe(true);
			expect(result.apiKeyId).toBe("key-1");
		}
		expect(verifies).toHaveBeenCalledTimes(1);
	});

	test("disabling or deleting a cached key rejects it on the next request", async () => {
		const { raw, record } = await makeKey("key-1");
		// A second key keeps authentication enabled once key-1 is gone.
		const other = await makeKey("key-2");
		let active = [record, other.record];
		const auth = serviceOver(() => active);

		expect((await auth.validateApiKey(raw)).isAuthenticated).toBe(true);
		active = [other.record];
		const result = await auth.validateApiKey(raw);
		expect(result.isAuthenticated).toBe(false);
	});

	test("a key whose stored hash changed is verified again, not trusted from cache", async () => {
		const first = await makeKey("key-1");
		const rotated = await makeKey("key-1");
		let active = [first.record];
		const auth = serviceOver(() => active);
		const verifies = countVerifies();

		expect((await auth.validateApiKey(first.raw)).isAuthenticated).toBe(true);
		// Same id, new secret: the old raw key must no longer authenticate.
		active = [{ ...rotated.record, prefixLast8: first.record.prefixLast8 }];
		expect((await auth.validateApiKey(first.raw)).isAuthenticated).toBe(false);
		expect(verifies).toHaveBeenCalledTimes(2);
	});

	test("a role change on a cached key applies immediately", async () => {
		const { raw, record } = await makeKey("key-1", "admin");
		let active = [record];
		const auth = serviceOver(() => active);

		expect((await auth.validateApiKey(raw)).role).toBe("admin");
		active = [{ ...record, role: "api-only" }];
		expect((await auth.validateApiKey(raw)).role).toBe("api-only");
	});

	test("an invalid key is verified every time and never cached", async () => {
		const { record } = await makeKey("key-1");
		const auth = serviceOver(() => [record]);
		const verifies = countVerifies();
		// Matches the stored last-8 so the cheap prefilter does not skip scrypt.
		const forged = `btr-${"x".repeat(24)}${record.prefixLast8}`;

		for (let i = 0; i < 3; i++) {
			expect((await auth.validateApiKey(forged)).isAuthenticated).toBe(false);
		}
		expect(verifies).toHaveBeenCalledTimes(3);
	});

	test("the cache stays bounded however many keys verify", async () => {
		const keys = await Promise.all(
			Array.from({ length: 70 }, (_, i) => makeKey(`key-${i}`)),
		);
		const records = keys.map((k) => k.record);
		const auth = serviceOver(() => records);
		for (const { raw } of keys) {
			expect((await auth.validateApiKey(raw)).isAuthenticated).toBe(true);
		}
		const size = (auth as unknown as { verifiedKeys: Map<string, unknown> })
			.verifiedKeys.size;
		expect(size).toBeLessThanOrEqual(64);
		expect(size).toBeGreaterThan(0);
	});
});
