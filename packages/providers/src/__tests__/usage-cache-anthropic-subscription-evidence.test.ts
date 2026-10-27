import { afterEach, describe, expect, it } from "bun:test";
import { usageCache } from "../usage-fetcher";

const originalFetch = globalThis.fetch;
const id = "anthropic-subscription-evidence-test";
const token = "fake-oauth-token";
const payload = () => ({
	five_hour: {
		utilization: 10,
		resets_at: new Date(Date.now() + 3_600_000).toISOString(),
	},
	spend: { enabled: false },
});
async function poll(endpoint?: string) {
	globalThis.fetch = (async () => Response.json(payload())) as typeof fetch;
	usageCache.startPolling(id, token, "anthropic", 60_000, endpoint);
	expect(await usageCache.refreshNow(id)).toBe(true);
}
function evidence(accessToken = token, endpoint?: string, now = Date.now()) {
	return usageCache.getAnthropicSubscriptionEvidence(
		id,
		accessToken,
		endpoint,
		now,
	);
}
afterEach(() => {
	usageCache.stopPolling(id);
	usageCache.delete(id);
	globalThis.fetch = originalFetch;
});
describe("poll-owned Anthropic subscription evidence", () => {
	it("binds a real poll to credential, endpoint, cache identity and observation time", async () => {
		await poll();
		const snapshot = evidence();
		if (!snapshot) throw new Error("missing poll evidence");
		expect(snapshot?.data.spend).toEqual({ enabled: false });
		expect(evidence("replacement-token")).toBeNull();
		expect(evidence(token, "https://other.example")).toBeNull();
		expect(
			evidence(token, undefined, snapshot.observedAt + 179_999),
		).not.toBeNull();
		expect(
			evidence(token, undefined, snapshot.observedAt + 180_000),
		).toBeNull();
		expect(evidence(token, undefined, snapshot.observedAt - 1)).toBeNull();
	});
	it("passive writes cannot mint or restore permission", async () => {
		usageCache.set(id, payload());
		expect(evidence()).toBeNull();
		await poll();
		const owned = usageCache.getSnapshot(id);
		if (!owned) throw new Error("missing poll snapshot");
		usageCache.set(id, owned.data);
		expect(evidence()).toBeNull();
		expect(usageCache.getSnapshot(id)).not.toBeNull();
	});
	it("replacement registration and late results cannot restore old permission", async () => {
		await poll();
		let release!: (response: Response) => void;
		globalThis.fetch = (() =>
			new Promise<Response>((resolve) => {
				release = resolve;
			})) as typeof fetch;
		const late = usageCache.refreshNow(id);
		await Promise.resolve();
		usageCache.startPolling(id, "new-token", "anthropic", 60_000);
		expect(evidence()).toBeNull();
		release(Response.json(payload()));
		expect(await late).toBe(false);
		expect(evidence()).toBeNull();
	});
	it("a passive mutation during a poll cannot grant permission from the late result", async () => {
		await poll();
		let release!: (response: Response) => void;
		globalThis.fetch = (() =>
			new Promise<Response>((resolve) => {
				release = resolve;
			})) as typeof fetch;
		const late = usageCache.refreshNow(id);
		await Promise.resolve();
		usageCache.set(id, payload());
		release(Response.json(payload()));
		await late;
		expect(evidence()).toBeNull();
	});
	it("custom endpoint polls never establish first-party permission", async () => {
		await poll("https://other.example");
		expect(evidence(token, "https://other.example")).toBeNull();
	});
});
