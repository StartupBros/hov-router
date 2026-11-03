import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Config } from "@better-ccflare/config";
import { DatabaseOperations } from "@better-ccflare/database";
import { consumeCodexResetCredit, usageCache } from "@better-ccflare/providers";
import {
	registerCodexResetRedeemer,
	registerCodexUsageRefresher,
	unregisterCodexResetRedeemer,
	unregisterCodexUsageRefresher,
} from "@better-ccflare/proxy";
import type {
	RedeemResetErrorBody,
	RedeemResetResponse,
} from "@better-ccflare/types";
import { APIRouter } from "../../router";
import type { APIContext } from "../../types";

const SERVER = "redeem-reset-test-server";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const CONFIG = {
	getUsageThrottlingFiveHourEnabled: () => true,
	getUsageThrottlingWeeklyEnabled: () => true,
} as unknown as Config;

type UsageData = Parameters<typeof usageCache.set>[1];

interface ConsumeCall {
	url: string;
	body: Record<string, unknown>;
}

let dbOps: DatabaseOperations;
let accountId: string;
let seq = 0;
let calls: ConsumeCall[];
let replies: Array<() => Promise<Response>>;
/** What the next polled usage read reports; null means the read fails. */
let nextUsage: { available: number; applicable: number } | null;
let refreshOptions: unknown[];

const fakeOpenAi = (async (input: RequestInfo | URL, init?: RequestInit) => {
	calls.push({
		url: String(input),
		body: JSON.parse(String(init?.body)) as Record<string, unknown>,
	});
	const next = replies.shift();
	if (!next) throw new Error("the test scripted no reply for this call");
	return next();
}) as typeof fetch;

function reply(status: number, body?: unknown): () => Promise<Response> {
	return async () =>
		new Response(body === undefined ? "" : JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
}

/** The answer is lost on the wire; the message carries a secret. */
function lostAnswer(): () => Promise<Response> {
	return async () => {
		throw new Error("socket hang up, token=sk-secret-token-value");
	};
}

function gatedReply(status: number, body: unknown) {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		reply: async () => {
			await gate;
			return reply(status, body)();
		},
		release: () => release(),
	};
}

function usageWith(counts: {
	available: number;
	applicable: number;
}): UsageData {
	return {
		reset_credits_present: true,
		reset_credits_available_count: counts.available,
		reset_credits_applicable_count: counts.applicable,
	} as unknown as UsageData;
}

async function insertAccount(
	id: string,
	opts: {
		provider?: string;
		customEndpoint?: string | null;
		paused?: boolean;
	} = {},
) {
	await dbOps.getAdapter().run(
		`INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at, custom_endpoint, paused)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			`name-${id}`,
			opts.provider ?? "codex",
			"refresh",
			"access",
			Date.now() + HOUR,
			Date.now(),
			opts.customEndpoint ?? null,
			opts.paused ? 1 : 0,
		],
	);
}

/** Stores what the observer would after a successful poll and list read. */
async function observe(
	id: string,
	opts: {
		available: number;
		applicable: number;
		credits?: number;
		observedAt?: number;
	},
) {
	const repo = dbOps.getCodexResetCreditsRepository();
	const at = opts.observedAt ?? Date.now();
	await repo.recordCounts(id, {
		availableCount: opts.available,
		applicableCount: opts.applicable,
		countsPresent: true,
		observedAt: at,
	});
	await repo.recordListSuccess(id, {
		at,
		listedAvailableCount: opts.available,
		listedApplicableCount: opts.applicable,
		chatgptAccountHash: null,
		baselineAt: at,
	});
	const credits = opts.credits ?? opts.available;
	for (let n = 1; n <= credits; n++) {
		await repo.insertCreditIfAbsent({
			accountId: id,
			creditId: `${id}-credit-${n}`,
			resetType: "codex_rate_limits",
			status: "available",
			grantedAt: at - 2 * DAY,
			// The last credit expires first, so the choice is not list order.
			expiresAt: Date.now() + (10 - n) * DAY,
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

async function post(
	id: string,
	body: unknown,
	contentType = "application/json",
): Promise<{
	status: number;
	text: string;
	body: RedeemResetResponse & RedeemResetErrorBody;
}> {
	const router = new APIRouter({ dbOps, config: CONFIG } as APIContext);
	const url = new URL(`http://localhost/api/accounts/${id}/redeem-reset`);
	const response = await router.handleRequest(
		url,
		new Request(url, {
			method: "POST",
			headers: { "Content-Type": contentType },
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	);
	if (!response) throw new Error("POST redeem-reset is not routed");
	const text = await response.text();
	return {
		status: response.status,
		text,
		body: JSON.parse(text) as RedeemResetResponse & RedeemResetErrorBody,
	};
}

function stored(requestId: string) {
	return dbOps.getCodexResetRedemptionsRepository().findByRequestId(requestId);
}

async function waitFor(condition: () => boolean) {
	for (let i = 0; i < 200 && !condition(); i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	if (!condition()) throw new Error("condition never held");
}

beforeEach(() => {
	dbOps = new DatabaseOperations(":memory:", { walMode: false });
	accountId = `redeem-acct-${++seq}`;
	calls = [];
	replies = [];
	nextUsage = null;
	refreshOptions = [];
	registerCodexResetRedeemer(SERVER, async (_accountId, request) => ({
		sent: true,
		result: await consumeCodexResetCredit("test-token", request, {
			fetchImpl: fakeOpenAi,
		}),
	}));
	spyOn(usageCache, "refreshNow").mockImplementation(
		async (id: string, options?: unknown) => {
			refreshOptions.push(options);
			if (!nextUsage) return false;
			usageCache.set(id, usageWith(nextUsage));
			return true;
		},
	);
});

afterEach(async () => {
	unregisterCodexResetRedeemer(SERVER);
	unregisterCodexUsageRefresher(SERVER);
	(usageCache.refreshNow as unknown as { mockRestore(): void }).mockRestore();
	await dbOps.close();
});

describe("POST /api/accounts/:id/redeem-reset", () => {
	it("redeems one credit, reports the reset and judges the spend from the count", async () => {
		await insertAccount(accountId);
		await observe(accountId, { available: 2, applicable: 2 });
		replies.push(reply(200, { code: "reset", windows_reset: 2 }));
		nextUsage = { available: 1, applicable: 1 };
		const requestId = crypto.randomUUID();

		const res = await post(accountId, { requestId });

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			requestId,
			accountId,
			state: "done",
			outcome: "reset",
			windowsReset: 2,
			spend: "spent",
			availableBefore: 2,
			availableAfter: 1,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url.endsWith("/consume")).toBe(true);
		// The soonest-expiring credit, not the first one listed.
		expect(calls[0]?.body).toEqual({
			redeem_request_id: requestId,
			credit_id: `${accountId}-credit-2`,
		});
		expect(refreshOptions).toEqual([{ awaitInFlight: true }]);
	});

	it("sends one consume call for two requests with one id while the first is in flight (AE5)", async () => {
		await insertAccount(accountId);
		await observe(accountId, { available: 2, applicable: 2 });
		const gated = gatedReply(200, { code: "reset", windows_reset: 1 });
		replies.push(gated.reply);
		nextUsage = { available: 1, applicable: 1 };
		const requestId = crypto.randomUUID();

		const first = post(accountId, { requestId });
		await waitFor(() => calls.length === 1);
		const second = await post(accountId, { requestId });
		gated.release();
		const firstRes = await first;

		expect(second.status).toBe(409);
		expect(second.body).toMatchObject({ reason: "in_progress", requestId });
		expect(firstRes.status).toBe(200);
		expect(firstRes.body.outcome).toBe("reset");
		expect(calls).toHaveLength(1);
	});

	it("answers a different id while another is in flight with 409 naming the open id", async () => {
		await insertAccount(accountId);
		await observe(accountId, { available: 2, applicable: 2 });
		const gated = gatedReply(200, { code: "reset", windows_reset: 1 });
		replies.push(gated.reply);
		const openId = crypto.randomUUID();

		const first = post(accountId, { requestId: openId });
		await waitFor(() => calls.length === 1);
		const other = await post(accountId, { requestId: crypto.randomUUID() });
		gated.release();
		await first;

		expect(other.status).toBe(409);
		expect(other.body).toMatchObject({
			reason: "open_request",
			openRequestId: openId,
		});
		expect(calls).toHaveLength(1);
	});

	it("resends the same id and credit after a lost answer and spends at most one credit (AE5)", async () => {
		await insertAccount(accountId);
		await observe(accountId, { available: 2, applicable: 2 });
		replies.push(lostAnswer());
		const requestId = crypto.randomUUID();

		const lost = await post(accountId, { requestId });
		expect(lost.status).toBe(200);
		expect(lost.body).toMatchObject({
			state: "unknown",
			outcome: "unclear",
			spend: null,
		});
		expect(lost.text).not.toContain("sk-secret-token-value");

		const otherId = await post(accountId, { requestId: crypto.randomUUID() });
		expect(otherId.status).toBe(409);
		expect(otherId.body).toMatchObject({
			reason: "open_request",
			openRequestId: requestId,
		});

		replies.push(reply(200, { code: "already_redeemed", windows_reset: 0 }));
		nextUsage = { available: 1, applicable: 1 };
		const retry = await post(accountId, { requestId });

		expect(retry.status).toBe(200);
		expect(retry.body).toMatchObject({
			state: "done",
			outcome: "already_redeemed",
			spend: "spent",
			availableBefore: 2,
			availableAfter: 1,
		});
		expect(calls).toHaveLength(2);
		expect(calls[1]?.body).toEqual(calls[0]?.body);
		expect(calls[0]?.body).toEqual({
			redeem_request_id: requestId,
			credit_id: `${accountId}-credit-2`,
		});
	});

	it("retries a pending row left by a crash with its own id and credit", async () => {
		await insertAccount(accountId);
		await observe(accountId, { available: 2, applicable: 2 });
		const requestId = crypto.randomUUID();
		await dbOps.getCodexResetRedemptionsRepository().insertPending({
			requestId,
			accountId,
			creditId: `${accountId}-credit-1`,
			availableBefore: 2,
			at: Date.now() - 2 * MINUTE,
		});
		replies.push(reply(200, { code: "reset", windows_reset: 1 }));
		nextUsage = { available: 1, applicable: 1 };

		const res = await post(accountId, { requestId });

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			state: "done",
			outcome: "reset",
			spend: "spent",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.body).toEqual({
			redeem_request_id: requestId,
			credit_id: `${accountId}-credit-1`,
		});
		expect((await stored(requestId))?.attempts).toBe(2);
	});

	it("answers 409 in progress for a pending row younger than 60 seconds", async () => {
		await insertAccount(accountId);
		await observe(accountId, { available: 2, applicable: 2 });
		const requestId = crypto.randomUUID();
		await dbOps.getCodexResetRedemptionsRepository().insertPending({
			requestId,
			accountId,
			creditId: null,
			availableBefore: 2,
			at: Date.now() - 10_000,
		});

		const res = await post(accountId, { requestId });

		expect(res.status).toBe(409);
		expect(res.body.reason).toBe("in_progress");
		expect(calls).toHaveLength(0);
	});

	it("resends on a single-credit account whose refreshed applicable count reached 0", async () => {
		await insertAccount(accountId);
		await observe(accountId, { available: 1, applicable: 1 });
		replies.push(lostAnswer());
		const requestId = crypto.randomUUID();
		await post(accountId, { requestId });
		// The lost call did spend it; the next poll shows none left.
		await dbOps.getCodexResetCreditsRepository().recordCounts(accountId, {
			availableCount: 0,
			applicableCount: 0,
			countsPresent: true,
			observedAt: Date.now(),
		});
		replies.push(reply(200, { code: "already_redeemed", windows_reset: 0 }));
		nextUsage = { available: 0, applicable: 0 };

		const retry = await post(accountId, { requestId });

		expect(retry.status).toBe(200);
		expect(retry.body).toMatchObject({
			state: "done",
			outcome: "already_redeemed",
			spend: "spent",
			availableBefore: 1,
			availableAfter: 0,
		});
		expect(calls).toHaveLength(2);
	});

	it("resends a retry with the same id while the counts are stale", async () => {
		await insertAccount(accountId);
		await observe(accountId, { available: 2, applicable: 2 });
		replies.push(lostAnswer());
		const requestId = crypto.randomUUID();
		await post(accountId, { requestId });
		await dbOps.getCodexResetCreditsRepository().recordCounts(accountId, {
			availableCount: 2,
			applicableCount: 2,
			countsPresent: true,
			observedAt: Date.now() - 11 * MINUTE,
		});
		replies.push(reply(200, { code: "reset", windows_reset: 1 }));

		const retry = await post(accountId, { requestId });

		expect(retry.status).toBe(200);
		expect(retry.body).toMatchObject({ state: "done", outcome: "reset" });
		expect(calls).toHaveLength(2);
	});

	it("refuses a new id after a done redemption once the applicable count reads 0", async () => {
		await insertAccount(accountId);
		await observe(accountId, { available: 1, applicable: 1 });
		replies.push(reply(200, { code: "reset", windows_reset: 1 }));
		nextUsage = { available: 0, applicable: 0 };
		const firstId = crypto.randomUUID();
		expect((await post(accountId, { requestId: firstId })).status).toBe(200);
		await dbOps.getCodexResetCreditsRepository().recordCounts(accountId, {
			availableCount: 0,
			applicableCount: 0,
			countsPresent: true,
			observedAt: Date.now(),
		});

		const res = await post(accountId, { requestId: crypto.randomUUID() });

		expect(res.status).toBe(409);
		expect(res.body.reason).toBe("not_applicable");
		expect(calls).toHaveLength(1);
	});

	it("replays a stored outcome for the same id without calling OpenAI", async () => {
		await insertAccount(accountId);
		await observe(accountId, { available: 2, applicable: 2 });
		replies.push(reply(200, { code: "reset", windows_reset: 1 }));
		nextUsage = { available: 1, applicable: 1 };
		const requestId = crypto.randomUUID();
		const first = await post(accountId, { requestId });

		const again = await post(accountId, { requestId });

		expect(again.status).toBe(200);
		expect(again.body).toEqual(first.body);
		expect(calls).toHaveLength(1);
	});

	it("answers 415 to a text/plain request and sends nothing", async () => {
		await insertAccount(accountId);
		await observe(accountId, { available: 2, applicable: 2 });
		const requestId = crypto.randomUUID();

		const res = await post(
			accountId,
			JSON.stringify({ requestId }),
			"text/plain",
		);

		expect(res.status).toBe(415);
		expect(res.body.reason).toBe("unsupported_media_type");
		expect(calls).toHaveLength(0);
		expect(await stored(requestId)).toBeNull();
	});

	it("accepts application/json with a charset parameter", async () => {
		await insertAccount(accountId);
		await observe(accountId, { available: 2, applicable: 2 });
		replies.push(reply(200, { code: "reset", windows_reset: 1 }));

		const res = await post(
			accountId,
			{ requestId: crypto.randomUUID() },
			"application/json; charset=utf-8",
		);

		expect(res.status).toBe(200);
		expect(calls).toHaveLength(1);
	});

	it("answers 409 with the R8 reason when no reset applies now (AE2)", async () => {
		await insertAccount(accountId);
		await observe(accountId, { available: 2, applicable: 0 });

		const res = await post(accountId, { requestId: crypto.randomUUID() });

		expect(res.status).toBe(409);
		expect(res.body.reason).toBe("not_applicable");
		expect(calls).toHaveLength(0);
	});

	it("answers 409 when the counts are stale", async () => {
		await insertAccount(accountId);
		await observe(accountId, {
			available: 2,
			applicable: 2,
			observedAt: Date.now() - 11 * MINUTE,
		});

		const res = await post(accountId, { requestId: crypto.randomUUID() });

		expect(res.status).toBe(409);
		expect(res.body.reason).toBe("counts_stale");
		expect(calls).toHaveLength(0);
	});

	it("reports no credit spent for nothing_to_reset with an unchanged count (AE6)", async () => {
		await insertAccount(accountId);
		await observe(accountId, { available: 2, applicable: 2 });
		replies.push(reply(200, { code: "nothing_to_reset", windows_reset: 0 }));
		nextUsage = { available: 2, applicable: 2 };

		const res = await post(accountId, { requestId: crypto.randomUUID() });

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			state: "done",
			outcome: "nothing_to_reset",
			spend: "not_spent",
			availableBefore: 2,
			availableAfter: 2,
		});
	});

	it("reports a 403 as refused without passing OpenAI's body through (AE6)", async () => {
		await insertAccount(accountId);
		await observe(accountId, { available: 2, applicable: 2 });
		replies.push(reply(403, { error: { message: "do-not-show-this-body" } }));

		const res = await post(accountId, { requestId: crypto.randomUUID() });

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			state: "refused",
			outcome: "refused",
			spend: null,
		});
		expect(res.text).not.toContain("do-not-show-this-body");
	});

	it("reads the count after through the manual refresh when the polled read fails", async () => {
		await insertAccount(accountId);
		await observe(accountId, { available: 2, applicable: 2 });
		replies.push(reply(200, { code: "reset", windows_reset: 1 }));
		registerCodexUsageRefresher(SERVER, async (id) => {
			usageCache.set(id, usageWith({ available: 1, applicable: 1 }));
			return { success: true, message: "ok" };
		});

		const res = await post(accountId, { requestId: crypto.randomUUID() });

		expect(res.body).toMatchObject({ spend: "spent", availableAfter: 1 });
		expect(refreshOptions).toEqual([{ awaitInFlight: true }]);
	});

	it("says the spend is not confirmed when no fresh count arrives", async () => {
		await insertAccount(accountId);
		await observe(accountId, { available: 2, applicable: 2 });
		replies.push(reply(200, { code: "reset", windows_reset: 1 }));

		const res = await post(accountId, { requestId: crypto.randomUUID() });

		expect(res.body).toMatchObject({
			outcome: "reset",
			spend: "not_confirmed",
			availableAfter: null,
		});
	});

	it("answers 503 and stores nothing when no redeemer is registered", async () => {
		await insertAccount(accountId);
		await observe(accountId, { available: 2, applicable: 2 });
		unregisterCodexResetRedeemer(SERVER);
		const requestId = crypto.randomUUID();

		const res = await post(accountId, { requestId });

		expect(res.status).toBe(503);
		expect(res.body).toMatchObject({ reason: "not_sent", requestId });
		expect(calls).toHaveLength(0);
		expect(await stored(requestId)).toBeNull();
	});

	it("lets a paused account redeem", async () => {
		await insertAccount(accountId, { paused: true });
		await observe(accountId, { available: 2, applicable: 2 });
		replies.push(reply(200, { code: "reset", windows_reset: 1 }));

		const res = await post(accountId, { requestId: crypto.randomUUID() });

		expect(res.status).toBe(200);
		expect(res.body.outcome).toBe("reset");
	});

	it("stores an upper-case request id in lower case", async () => {
		await insertAccount(accountId);
		await observe(accountId, { available: 2, applicable: 2 });
		replies.push(reply(200, { code: "reset", windows_reset: 1 }));
		const requestId = crypto.randomUUID();

		const res = await post(accountId, { requestId: requestId.toUpperCase() });

		expect(res.body.requestId).toBe(requestId);
		expect(calls[0]?.body.redeem_request_id).toBe(requestId);
	});

	it("answers 409 when the id was already used for another account", async () => {
		const otherAccount = `${accountId}-other`;
		await insertAccount(accountId);
		await insertAccount(otherAccount);
		await observe(accountId, { available: 2, applicable: 2 });
		await observe(otherAccount, { available: 2, applicable: 2 });
		replies.push(reply(200, { code: "reset", windows_reset: 1 }));
		const requestId = crypto.randomUUID();
		await post(accountId, { requestId });

		const res = await post(otherAccount, { requestId });

		expect(res.status).toBe(409);
		expect(res.body.reason).toBe("request_conflict");
		expect(calls).toHaveLength(1);
	});

	for (const [label, body] of [
		["no request id", {}],
		["a request id that is not a UUID", { requestId: "not-a-uuid" }],
		["a version 1 UUID", { requestId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" }],
		["a body that is not JSON", "{not json"],
	] as const) {
		it(`answers 400 to ${label}`, async () => {
			await insertAccount(accountId);
			await observe(accountId, { available: 2, applicable: 2 });

			const res = await post(accountId, body);

			expect(res.status).toBe(400);
			expect(res.body.reason).toBe("invalid_request");
			expect(calls).toHaveLength(0);
		});
	}

	it("answers 404 for an unknown account", async () => {
		const res = await post("no-such-account", {
			requestId: crypto.randomUUID(),
		});

		expect(res.status).toBe(404);
		expect(res.body.reason).toBe("account_not_found");
	});

	it("answers 400 for a non-Codex account", async () => {
		await insertAccount(accountId, { provider: "anthropic" });

		const res = await post(accountId, { requestId: crypto.randomUUID() });

		expect(res.status).toBe(400);
		expect(res.body.reason).toBe("not_codex");
		expect(calls).toHaveLength(0);
	});

	it("answers 400 for a Codex account on a custom endpoint", async () => {
		await insertAccount(accountId, {
			customEndpoint: "https://codex.example.test/v1",
		});

		const res = await post(accountId, { requestId: crypto.randomUUID() });

		expect(res.status).toBe(400);
		expect(res.body.reason).toBe("not_codex");
	});

	it("rejects a request without a key while an API key is active", async () => {
		const router = new APIRouter({
			dbOps: {
				getAdapter: () => ({}),
				countActiveApiKeys: async () => 1,
				getActiveApiKeys: async () => [],
			},
			config: {},
		} as unknown as APIContext);
		const url = new URL(
			`http://localhost/api/accounts/${accountId}/redeem-reset`,
		);

		const response = await router.handleRequest(
			url,
			new Request(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ requestId: crypto.randomUUID() }),
			}),
		);

		expect(response?.status).toBe(401);
		expect(calls).toHaveLength(0);
	});
});
