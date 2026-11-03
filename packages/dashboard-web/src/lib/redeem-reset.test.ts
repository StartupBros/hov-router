import { describe, expect, it } from "bun:test";
import type { RedeemResetResponse } from "@better-ccflare/types";
import {
	mintRedeemRequestId,
	parseRedeemResetAnswer,
	type RedeemResetTransport,
	sendRedeemReset,
} from "./redeem-reset";

// The server's check (packages/http-api/src/handlers/redeem-reset.ts), minus
// the case flag: the dashboard mints lower case, as the server stores it.
const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ID = "3f2b8c1e-7a4d-4b9e-9c21-5d6e7f8a9b0c";
const OPEN_ID = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";

const RESPONSE: RedeemResetResponse = {
	requestId: ID,
	accountId: "acc-1",
	state: "done",
	outcome: "reset",
	windowsReset: 2,
	spend: "spent",
	availableBefore: 2,
	availableAfter: 1,
	requestedAt: 1_793_660_000_000,
	completedAt: 1_793_660_001_200,
};

describe("mintRedeemRequestId", () => {
	it("mints distinct lower-case UUID v4 ids the server accepts", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 200; i++) {
			const id = mintRedeemRequestId();
			expect(id).toMatch(UUID_V4);
			ids.add(id);
		}
		expect(ids.size).toBe(200);
	});

	it("sets the version and variant bits whatever the random bytes are", () => {
		// The bytes come from getRandomValues, which plain-http pages have;
		// crypto.randomUUID exists only in secure contexts.
		expect(mintRedeemRequestId((bytes) => bytes.fill(0xff))).toBe(
			"ffffffff-ffff-4fff-bfff-ffffffffffff",
		);
		expect(mintRedeemRequestId((bytes) => bytes.fill(0))).toBe(
			"00000000-0000-4000-8000-000000000000",
		);
	});
});

describe("parseRedeemResetAnswer", () => {
	it("reads a 200 body as the stored result", () => {
		expect(parseRedeemResetAnswer(200, RESPONSE)).toEqual({
			kind: "result",
			response: RESPONSE,
		});
		const open = {
			...RESPONSE,
			state: "unknown",
			outcome: "unclear",
			windowsReset: null,
			spend: null,
			availableAfter: null,
			completedAt: null,
		};
		expect(parseRedeemResetAnswer(200, open)).toEqual({
			kind: "result",
			response: open as RedeemResetResponse,
		});
	});

	it("treats an unreadable 200 body as no answer, so a retry is offered", () => {
		for (const body of [
			null,
			"ok",
			{ ...RESPONSE, state: "finished" },
			{ ...RESPONSE, outcome: "maybe" },
			{ ...RESPONSE, spend: "some" },
			{ ...RESPONSE, requestId: 7 },
			{ ...RESPONSE, availableBefore: "2" },
		]) {
			expect(parseRedeemResetAnswer(200, body)).toEqual({ kind: "no_answer" });
		}
	});

	it("reads an error body's reason, message and the ids it names", () => {
		expect(
			parseRedeemResetAnswer(409, {
				error: "Another request is open.",
				reason: "open_request",
				openRequestId: OPEN_ID,
			}),
		).toEqual({
			kind: "error",
			status: 409,
			reason: "open_request",
			message: "Another request is open.",
			openRequestId: OPEN_ID,
		});
		expect(
			parseRedeemResetAnswer(503, {
				error: "Nothing was sent to OpenAI. Try again.",
				reason: "not_sent",
				requestId: ID,
			}),
		).toEqual({
			kind: "error",
			status: 503,
			reason: "not_sent",
			message: "Nothing was sent to OpenAI. Try again.",
			openRequestId: null,
		});
	});

	it("keeps the status when the body is missing or names an unknown reason", () => {
		expect(parseRedeemResetAnswer(500, null)).toEqual({
			kind: "error",
			status: 500,
			reason: null,
			message: null,
			openRequestId: null,
		});
		expect(
			parseRedeemResetAnswer(409, { error: "x", reason: "new_reason" }),
		).toEqual({
			kind: "error",
			status: 409,
			reason: null,
			message: "x",
			openRequestId: null,
		});
	});
});

describe("sendRedeemReset", () => {
	type Call = { input: string; init: RequestInit };

	function transport(
		reply: (call: Call) => Promise<Response>,
		apiKey: string | null = "dash-key",
	) {
		const calls: Call[] = [];
		let unauthorized = 0;
		const t: RedeemResetTransport = {
			fetch: (input, init) => {
				const call = { input, init };
				calls.push(call);
				return reply(call);
			},
			apiKey,
			onUnauthorized: () => {
				unauthorized++;
			},
		};
		return { t, calls, unauthorized: () => unauthorized };
	}

	const json = (status: number, body: unknown) =>
		Promise.resolve(
			new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
		);

	it("posts the request id as JSON with the dashboard key, once", async () => {
		const { t, calls } = transport(() => json(200, RESPONSE));
		const answer = await sendRedeemReset("acc/1", ID, t);

		expect(answer).toEqual({ kind: "result", response: RESPONSE });
		expect(calls).toHaveLength(1);
		const [{ input, init }] = calls;
		expect(input).toBe("/api/accounts/acc%2F1/redeem-reset");
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({
			"Content-Type": "application/json",
			Accept: "application/json",
			"x-api-key": "dash-key",
		});
		expect(JSON.parse(init.body as string)).toEqual({ requestId: ID });
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("sends no key header when the dashboard has none", async () => {
		const { t, calls } = transport(() => json(200, RESPONSE), null);
		await sendRedeemReset("acc-1", ID, t);
		expect(calls[0].init.headers).not.toHaveProperty("x-api-key");
	});

	it("reads a failed fetch or a timeout as no answer, without asking for the key", async () => {
		for (const failure of [
			new TypeError("Failed to fetch"),
			new DOMException("The operation timed out.", "TimeoutError"),
		]) {
			const { t, unauthorized } = transport(() => Promise.reject(failure));
			expect(await sendRedeemReset("acc-1", ID, t)).toEqual({
				kind: "no_answer",
			});
			expect(unauthorized()).toBe(0);
		}
	});

	it("asks for the dashboard key again on a 401 and keeps the answer", async () => {
		const { t, unauthorized } = transport(() =>
			json(401, { error: "Unauthorized" }),
		);
		expect(await sendRedeemReset("acc-1", ID, t)).toEqual({
			kind: "error",
			status: 401,
			reason: null,
			message: "Unauthorized",
			openRequestId: null,
		});
		expect(unauthorized()).toBe(1);
	});

	it("keeps the status of a reply whose body is not JSON", async () => {
		const html = () =>
			Promise.resolve(
				new Response("<html>Bad gateway</html>", { status: 502 }),
			);
		expect(await sendRedeemReset("acc-1", ID, transport(html).t)).toEqual({
			kind: "error",
			status: 502,
			reason: null,
			message: null,
			openRequestId: null,
		});
		const ok = () =>
			Promise.resolve(new Response("<html>ok</html>", { status: 200 }));
		expect(await sendRedeemReset("acc-1", ID, transport(ok).t)).toEqual({
			kind: "no_answer",
		});
	});

	it("passes a 409's open request id through, and drops one that is not a UUID", async () => {
		const open = await sendRedeemReset(
			"acc-1",
			ID,
			transport(() =>
				json(409, {
					error: "Another request is open.",
					reason: "open_request",
					openRequestId: OPEN_ID,
				}),
			).t,
		);
		expect(open).toMatchObject({
			reason: "open_request",
			openRequestId: OPEN_ID,
		});
		const garbled = await sendRedeemReset(
			"acc-1",
			ID,
			transport(() =>
				json(409, {
					error: "x",
					reason: "open_request",
					openRequestId: "../x",
				}),
			).t,
		);
		expect(garbled).toMatchObject({
			reason: "open_request",
			openRequestId: null,
		});
	});
});
