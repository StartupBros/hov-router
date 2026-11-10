/**
 * First-sight catalogue refresh (#774): a lookup for a first-party model the
 * loaded catalogue lacks starts one background models.dev fetch, so a model
 * the catalogue lists before the next scheduled refresh is priced without
 * waiting up to a day. The fetch is stubbed; time is pinned with
 * setSystemTime.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	estimateCostUSD,
	isModelPriced,
	onPricingCatalogLoaded,
	resetNanoGPTPricingCacheForTest,
	warmPricingCatalog,
} from "./pricing";

const DISK_CACHE_PATH = join(tmpdir(), "better-ccflare", "models.dev.json");
const MODELS_DEV_URL = "https://models.dev/api.json";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.parse("2026-11-10T00:00:00Z");
const NEW_MODEL = "claude-opus-6";
const LISTED_ONLY = "gpt-6-nova";

function catalogueWith(...ids: string[]) {
	return {
		anthropic: {
			models: Object.fromEntries(
				ids
					.filter((id) => id.startsWith("claude-"))
					.map((id) => [id, { id, name: id, cost: { input: 5, output: 25 } }]),
			),
		},
		openai: {
			models: Object.fromEntries(
				ids
					.filter((id) => id.startsWith("gpt-"))
					.map((id) => [id, { id, name: id, cost: { input: 2, output: 8 } }]),
			),
		},
	};
}

describe("first-sight catalogue refresh", () => {
	let originalFetch: typeof fetch;
	let previousOffline: string | undefined;
	let catalogue: unknown;
	let modelsDevFetches: number;
	let failNext: boolean;
	let gate: Promise<void> | null;

	/** Resolves on the next load that came from models.dev. */
	const nextRemoteLoad = () =>
		new Promise<void>((resolve) => {
			const off = onPricingCatalogLoaded((_data, source) => {
				if (source !== "remote") return;
				off();
				resolve();
			});
		});

	const flush = async () => {
		await Bun.sleep(0);
		await Bun.sleep(0);
	};

	beforeEach(async () => {
		originalFetch = globalThis.fetch;
		previousOffline = process.env.CF_PRICING_OFFLINE;
		delete process.env.CF_PRICING_OFFLINE;
		resetNanoGPTPricingCacheForTest();
		await rm(DISK_CACHE_PATH, { force: true });
		modelsDevFetches = 0;
		failNext = false;
		gate = null;
		catalogue = catalogueWith("claude-opus-5-5", LISTED_ONLY);
		globalThis.fetch = (async (input: string | URL | Request) => {
			if (String(input) !== MODELS_DEV_URL) {
				return { ok: true, json: async () => ({ object: "list", data: [] }) };
			}
			modelsDevFetches += 1;
			const served = catalogue;
			const fail = failNext;
			failNext = false;
			if (gate) await gate;
			return fail
				? { ok: false, status: 503, statusText: "Service Unavailable" }
				: { ok: true, json: async () => served };
		}) as unknown as typeof fetch;
		setSystemTime(T0);
		await warmPricingCatalog();
		expect(modelsDevFetches).toBe(1);
	});

	afterEach(async () => {
		setSystemTime();
		globalThis.fetch = originalFetch;
		if (previousOffline === undefined) delete process.env.CF_PRICING_OFFLINE;
		else process.env.CF_PRICING_OFFLINE = previousOffline;
		resetNanoGPTPricingCacheForTest();
		await rm(DISK_CACHE_PATH, { force: true });
	});

	it("refetches the catalogue when a lookup names a first-party model it lacks", async () => {
		setSystemTime(T0 + 6 * MINUTE);
		catalogue = catalogueWith("claude-opus-5-5", NEW_MODEL);
		const loaded = nextRemoteLoad();

		// The lookup that missed answers from the catalogue it had.
		expect(await isModelPriced(NEW_MODEL)).toBe(false);
		await loaded;

		expect(modelsDevFetches).toBe(2);
		expect(await isModelPriced(NEW_MODEL)).toBe(true);
	});

	it("tries each missing id once per refresh cycle, outside a 5-minute floor", async () => {
		setSystemTime(T0 + MINUTE);
		await isModelPriced(NEW_MODEL);
		expect(modelsDevFetches).toBe(1);

		setSystemTime(T0 + 6 * MINUTE);
		const first = nextRemoteLoad();
		await isModelPriced(NEW_MODEL);
		await first;
		expect(modelsDevFetches).toBe(2);

		setSystemTime(T0 + 20 * MINUTE);
		await isModelPriced(NEW_MODEL);
		expect(modelsDevFetches).toBe(2);

		const other = nextRemoteLoad();
		await isModelPriced("gpt-7-nova");
		await other;
		expect(modelsDevFetches).toBe(3);

		// The next scheduled refresh starts a new cycle for the id.
		setSystemTime(T0 + 25 * HOUR);
		await isModelPriced(NEW_MODEL);
		expect(modelsDevFetches).toBe(4);

		setSystemTime(T0 + 25 * HOUR + 6 * MINUTE);
		const again = nextRemoteLoad();
		await isModelPriced(NEW_MODEL);
		await again;
		expect(modelsDevFetches).toBe(5);
	});

	it("leaves the scheduled refresh where it was when the refetch still lacks the model", async () => {
		setSystemTime(T0 + 6 * MINUTE);
		const first = nextRemoteLoad();
		await isModelPriced(NEW_MODEL);
		await first;
		expect(modelsDevFetches).toBe(2);

		// Due 24 hours after the scheduled load at T0, not after the refetch.
		catalogue = catalogueWith("claude-opus-5-5", NEW_MODEL);
		setSystemTime(T0 + 24 * HOUR + MINUTE);
		expect(await isModelPriced(NEW_MODEL)).toBe(true);
		expect(modelsDevFetches).toBe(3);
	});

	it("ignores ids outside the first-party catalogue shapes and offline mode", async () => {
		setSystemTime(T0 + 6 * MINUTE);
		for (const id of [
			"claude-bccf-route-codex-pool-astra",
			"claude-bccf-quality-auto",
			"gpt-reserve",
			"chat",
			"glm-5.3",
		]) {
			await isModelPriced(id);
		}
		expect(modelsDevFetches).toBe(1);

		process.env.CF_PRICING_OFFLINE = "1";
		await isModelPriced(NEW_MODEL);
		expect(modelsDevFetches).toBe(1);
	});

	it("never holds up the cost estimate that saw the miss", async () => {
		setSystemTime(T0 + 6 * MINUTE);
		catalogue = catalogueWith("claude-opus-5-5", NEW_MODEL);
		let release = () => {};
		gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tokens = { inputTokens: 1_000 };

		expect(await estimateCostUSD(NEW_MODEL, tokens)).toBe(0);
		expect(modelsDevFetches).toBe(2);

		const loaded = nextRemoteLoad();
		release();
		await loaded;
		expect(await estimateCostUSD(NEW_MODEL, tokens)).toBeCloseTo(0.005, 10);
	});

	it("keeps the loaded catalogue when the refetch fails", async () => {
		setSystemTime(T0 + 6 * MINUTE);
		failNext = true;
		await isModelPriced(NEW_MODEL);
		await flush();
		expect(modelsDevFetches).toBe(2);
		expect(await isModelPriced(LISTED_ONLY)).toBe(true);

		// The failed attempt still counts toward the floor.
		setSystemTime(T0 + 7 * MINUTE);
		await isModelPriced("claude-sonnet-6");
		expect(modelsDevFetches).toBe(2);
	});
});
