import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Config } from "@better-ccflare/config";
import { DatabaseOperations } from "@better-ccflare/database";
import type {
	AccountResponse,
	BankedResetsSummary,
} from "@better-ccflare/types";
import { APIRouter } from "../../router";
import type { APIContext } from "../../types";
import { createAccountsListHandler } from "../accounts";
import { createBankedResetsSummaryHandler } from "../banked-resets";

const CONFIG = {
	getUsageThrottlingFiveHourEnabled: () => true,
	getUsageThrottlingWeeklyEnabled: () => true,
} as unknown as Config;
const HOUR = 3_600_000;
const NOV_30 = Date.UTC(2026, 10, 30);
const DEC_05 = Date.UTC(2026, 11, 5);
const SHARED_HASH = "hash-of-shared-chatgpt-account";
const OTHER_HASH = "hash-of-other-chatgpt-account";

let dbOps: DatabaseOperations;

async function insertAccount(
	id: string,
	provider: string,
	customEndpoint: string | null = null,
) {
	await dbOps.getAdapter().run(
		`INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			`name-${id}`,
			provider,
			"refresh",
			"access",
			Date.now() + HOUR,
			Date.now(),
			customEndpoint,
		],
	);
}

/** Stores what the observer would after a successful poll and list read. */
async function observe(
	accountId: string,
	opts: {
		available: number;
		applicable: number;
		expiries: (number | null)[];
		hash?: string | null;
		observedAt?: number;
	},
) {
	const repo = dbOps.getCodexResetCreditsRepository();
	const at = opts.observedAt ?? Date.now();
	await repo.recordCounts(accountId, {
		availableCount: opts.available,
		applicableCount: opts.applicable,
		countsPresent: true,
		observedAt: at,
	});
	await repo.recordListSuccess(accountId, {
		at,
		listedAvailableCount: opts.available,
		listedApplicableCount: opts.applicable,
		chatgptAccountHash: opts.hash ?? null,
		baselineAt: at,
	});
	let n = 0;
	for (const expiresAt of opts.expiries) {
		n += 1;
		await repo.insertCreditIfAbsent({
			accountId,
			creditId: `${accountId}-credit-${n}`,
			resetType: "codex_rate_limits",
			status: "available",
			grantedAt: at - 2 * 24 * HOUR,
			expiresAt,
			title: null,
			description: null,
			firstSeenAt: at,
			lastSeenAt: at,
			isBaseline: true,
			waveId: "codex:2026-10-31T12:00Z",
			vanishedAt: null,
			vanishReason: null,
		});
	}
}

async function listAccounts(): Promise<{
	rows: Map<string, AccountResponse>;
	text: string;
}> {
	const response = await createAccountsListHandler(dbOps, CONFIG)();
	const text = await response.text();
	const parsed = JSON.parse(text) as AccountResponse[];
	return { rows: new Map(parsed.map((row) => [row.id, row])), text };
}

async function summary(): Promise<{
	body: BankedResetsSummary;
	text: string;
}> {
	const response = await createBankedResetsSummaryHandler(dbOps)();
	const text = await response.text();
	return { body: JSON.parse(text) as BankedResetsSummary, text };
}

beforeEach(() => {
	dbOps = new DatabaseOperations(":memory:", { walMode: false });
});

afterEach(async () => {
	await dbOps.close();
});

describe("bankedResets on the accounts list", () => {
	it("shows an account whose resets apply now with its soonest expiry", async () => {
		await insertAccount("ae1", "codex");
		await observe("ae1", {
			available: 2,
			applicable: 2,
			expiries: [DEC_05, NOV_30],
		});

		const { rows } = await listAccounts();

		expect(rows.get("ae1")?.bankedResets).toMatchObject({
			tracked: true,
			availableCount: 2,
			applicableCount: 2,
			soonestExpiresAt: NOV_30,
			doesNotExpire: false,
			appliesNow: true,
			stale: false,
		});
	});

	it("shows held resets that do not apply now", async () => {
		await insertAccount("ae2", "codex");
		await observe("ae2", {
			available: 2,
			applicable: 0,
			expiries: [NOV_30, DEC_05],
		});

		const { rows } = await listAccounts();

		expect(rows.get("ae2")?.bankedResets).toMatchObject({
			availableCount: 2,
			applicableCount: 0,
			appliesNow: false,
			stale: false,
		});
	});

	it("keeps the last values and flags them stale after 12 hours of failed reads", async () => {
		await insertAccount("ae3", "codex");
		await observe("ae3", {
			available: 2,
			applicable: 2,
			expiries: [NOV_30, DEC_05],
		});
		await dbOps
			.getCodexResetCreditsRepository()
			.recordListFailure("ae3", Date.now() - 13 * HOUR);

		const { rows } = await listAccounts();

		expect(rows.get("ae3")?.bankedResets).toMatchObject({
			tracked: true,
			availableCount: 2,
			applicableCount: 2,
			soonestExpiresAt: NOV_30,
			stale: true,
		});
	});

	it("says a reset with no expiry does not expire", async () => {
		await insertAccount("forever", "codex");
		await observe("forever", { available: 1, applicable: 0, expiries: [null] });

		const { rows } = await listAccounts();

		expect(rows.get("forever")?.bankedResets).toMatchObject({
			availableCount: 1,
			soonestExpiresAt: null,
			doesNotExpire: true,
		});
	});

	it("gives other providers no field and a custom-endpoint Codex account tracked false", async () => {
		await insertAccount("anthropic", "anthropic");
		await insertAccount("custom", "codex", "https://codex.example.test/v1");

		const { rows } = await listAccounts();

		expect("bankedResets" in (rows.get("anthropic") ?? {})).toBe(false);
		expect(rows.get("custom")?.bankedResets).toEqual({
			tracked: false,
			availableCount: null,
			applicableCount: null,
			soonestExpiresAt: null,
			doesNotExpire: false,
			appliesNow: false,
			stale: false,
			observedAt: null,
		});
	});

	it("shows a Codex account never observed as stale with no values", async () => {
		await insertAccount("fresh", "codex");

		const { rows } = await listAccounts();

		expect(rows.get("fresh")?.bankedResets).toEqual({
			tracked: true,
			availableCount: null,
			applicableCount: null,
			soonestExpiresAt: null,
			doesNotExpire: false,
			appliesNow: false,
			stale: true,
			observedAt: null,
		});
	});

	it("still lists accounts, without the field, when the reset tables cannot be read", async () => {
		await insertAccount("ae1", "codex");
		await observe("ae1", { available: 2, applicable: 2, expiries: [NOV_30] });
		const failing = spyOn(
			dbOps.getCodexResetCreditsRepository(),
			"listAllStates",
		).mockRejectedValue(new Error("database is locked"));

		try {
			const response = await createAccountsListHandler(dbOps, CONFIG)();
			expect(response.status).toBe(200);
			const rows = JSON.parse(await response.text()) as AccountResponse[];
			const row = rows.find((candidate) => candidate.id === "ae1");
			expect(row).toBeDefined();
			expect("bankedResets" in (row ?? {})).toBe(false);
		} finally {
			failing.mockRestore();
		}
	});
});

describe("GET /api/banked-resets fleet summary", () => {
	it("counts one ChatGPT account once however many router accounts share it", async () => {
		await insertAccount("shared-a", "codex");
		await insertAccount("shared-b", "codex");
		await insertAccount("other", "codex");
		await insertAccount("custom", "codex", "https://codex.example.test/v1");
		await observe("shared-a", {
			available: 2,
			applicable: 2,
			expiries: [DEC_05, DEC_05],
			hash: SHARED_HASH,
		});
		await observe("shared-b", {
			available: 2,
			applicable: 2,
			expiries: [DEC_05, DEC_05],
			hash: SHARED_HASH,
		});
		await observe("other", {
			available: 1,
			applicable: 0,
			expiries: [NOV_30],
			hash: OTHER_HASH,
		});

		const { body } = await summary();

		expect(body.totalAvailable).toBe(3);
		expect(body.soonestExpiresAt).toBe(NOV_30);
		expect(body.trackedAccounts).toBe(3);
		expect(body.anyStale).toBe(false);
		expect(body.appliesNow.map((entry) => entry.accountId).sort()).toEqual([
			"shared-a",
			"shared-b",
		]);
		expect(body.appliesNow[0]).toMatchObject({
			applicableCount: 2,
			stale: false,
		});
	});

	it("takes the freshest observation of a shared ChatGPT account", async () => {
		await insertAccount("older", "codex");
		await insertAccount("newer", "codex");
		await observe("older", {
			available: 3,
			applicable: 0,
			expiries: [DEC_05, DEC_05, DEC_05],
			hash: SHARED_HASH,
			observedAt: Date.now() - 2 * 60_000,
		});
		await observe("newer", {
			available: 1,
			applicable: 0,
			expiries: [DEC_05],
			hash: SHARED_HASH,
		});

		const { body } = await summary();

		expect(body.totalAvailable).toBe(1);
	});

	it("marks the summary stale when any tracked account is stale", async () => {
		await insertAccount("ok", "codex");
		await insertAccount("never", "codex");
		await observe("ok", { available: 1, applicable: 1, expiries: [NOV_30] });

		const { body } = await summary();

		expect(body.totalAvailable).toBe(1);
		expect(body.anyStale).toBe(true);
		expect(body.trackedAccounts).toBe(2);
	});

	it("never exposes the ChatGPT account hash", async () => {
		await insertAccount("shared-a", "codex");
		await observe("shared-a", {
			available: 1,
			applicable: 1,
			expiries: [NOV_30],
			hash: SHARED_HASH,
		});

		const list = await listAccounts();
		const fleet = await summary();

		expect(list.text).not.toContain(SHARED_HASH);
		expect(fleet.text).not.toContain(SHARED_HASH);
		expect(list.text).not.toContain("chatgptAccountHash");
		expect(fleet.text).not.toContain("chatgptAccountHash");
	});
});

describe("banked reset route authorization", () => {
	for (const path of ["/api/accounts", "/api/banked-resets"]) {
		it(`answers 401 to GET ${path} without a key while an API key is active`, async () => {
			const router = new APIRouter({
				dbOps: {
					getAdapter: () => ({}),
					countActiveApiKeys: async () => 1,
					getActiveApiKeys: async () => [],
				},
				config: {},
			} as unknown as APIContext);
			const url = new URL(`http://localhost${path}`);
			const response = await router.handleRequest(
				url,
				new Request(url, { method: "GET" }),
			);
			expect(response?.status).toBe(401);
		});
	}

	it("routes an authorized GET /api/banked-resets to the summary", async () => {
		await insertAccount("ae1", "codex");
		await observe("ae1", { available: 2, applicable: 2, expiries: [NOV_30] });
		const router = new APIRouter({
			dbOps,
			config: CONFIG,
		} as unknown as APIContext);
		const url = new URL("http://localhost/api/banked-resets");
		const response = await router.handleRequest(
			url,
			new Request(url, { method: "GET" }),
		);
		expect(response?.status).toBe(200);
		const body = (await response?.json()) as BankedResetsSummary;
		expect(body.totalAvailable).toBe(2);
	});
});
