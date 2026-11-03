import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type CodexResetConsumeResult,
	classifyCodexResetConsume,
	consumeCodexResetCredit,
	fetchCodexResetCredits,
} from "./reset-credits";

function base64url(input: string): string {
	return Buffer.from(input, "utf8")
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

const TOKEN = `${base64url('{"alg":"none"}')}.${base64url(
	JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: "acct-fake-1" },
	}),
)}.sig`;

const PRIMARY_URL =
	"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

const captureList = {
	credits: [
		{
			id: "credit-a",
			reset_type: "codex_rate_limit",
			status: "available",
			granted_at: "2026-10-31T20:04:05.410479Z",
			expires_at: "2026-11-30T20:04:05.410479Z",
			title: "Reset",
			description: "Reset your Codex limits",
		},
		{
			id: "credit-b",
			reset_type: "codex_rate_limit",
			status: "available",
			granted_at: "2026-10-24T08:00:00.000001Z",
			expires_at: "2026-11-23T08:00:00.000001Z",
			title: "Reset",
			description: null,
		},
	],
	available_count: 2,
	total_earned_count: 9,
};

function jsonFetch(body: unknown, status = 200): typeof fetch {
	return (async () =>
		Response.json(body, { status })) as unknown as typeof fetch;
}

describe("fetchCodexResetCredits", () => {
	let originalFetch: typeof fetch;
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("parses a capture-shaped list with microsecond timestamps", async () => {
		const result = await fetchCodexResetCredits(TOKEN, {
			fetchImpl: jsonFetch(captureList),
		});
		expect(result).toEqual({
			ok: true,
			availableCount: 2,
			chatgptAccountId: "acct-fake-1",
			credits: [
				{
					id: "credit-a",
					resetType: "codex_rate_limit",
					status: "available",
					grantedAt: Date.UTC(2026, 9, 31, 20, 4, 5, 410),
					expiresAt: Date.UTC(2026, 10, 30, 20, 4, 5, 410),
					title: "Reset",
					description: "Reset your Codex limits",
				},
				{
					id: "credit-b",
					resetType: "codex_rate_limit",
					status: "available",
					grantedAt: Date.UTC(2026, 9, 24, 8, 0, 0, 0),
					expiresAt: Date.UTC(2026, 10, 23, 8, 0, 0, 0),
					title: "Reset",
					description: null,
				},
			],
		});
	});

	it("parses a null expires_at as null", async () => {
		const result = await fetchCodexResetCredits(TOKEN, {
			fetchImpl: jsonFetch({
				credits: [{ ...captureList.credits[0], expires_at: null }],
				available_count: 1,
			}),
		});
		expect(result.ok && result.credits[0]?.expiresAt).toBeNull();
	});

	it("keeps an unrecognized status as its raw string", async () => {
		const result = await fetchCodexResetCredits(TOKEN, {
			fetchImpl: jsonFetch({
				credits: [{ ...captureList.credits[0], status: "frozen" }],
			}),
		});
		expect(result.ok && result.credits[0]?.status).toBe("frozen");
		expect(result.ok && result.availableCount).toBeNull();
	});

	it("skips an entry without a string id and rejects a non-array credits", async () => {
		const skipped = await fetchCodexResetCredits(TOKEN, {
			fetchImpl: jsonFetch({
				credits: [{ ...captureList.credits[0], id: 7 }, captureList.credits[1]],
			}),
		});
		expect(skipped.ok && skipped.credits.map((c) => c.id)).toEqual([
			"credit-b",
		]);
		const bad = await fetchCodexResetCredits(TOKEN, {
			fetchImpl: jsonFetch({ credits: "nope" }),
		});
		expect(bad).toEqual({ ok: false, reason: "invalid_body", status: null });
	});

	it("returns an http failure without the response body", async () => {
		const result = await fetchCodexResetCredits(TOKEN, {
			fetchImpl: jsonFetch({ detail: "DISTINCT-SECRET-BODY-TEXT" }, 500),
		});
		expect(result).toEqual({ ok: false, reason: "http", status: 500 });
		expect(JSON.stringify(result)).not.toContain("DISTINCT-SECRET-BODY-TEXT");
	});

	it("times out when the request never resolves", async () => {
		const never = ((_url: unknown, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError")),
				);
			})) as unknown as typeof fetch;
		const result = await fetchCodexResetCredits(TOKEN, {
			fetchImpl: never,
			timeoutMs: 20,
		});
		expect(result).toEqual({ ok: false, reason: "timeout", status: null });
	});

	it("sends the shared headers to the primary URL and never the luna header", async () => {
		let url = "";
		let headers: Headers = new Headers();
		await fetchCodexResetCredits(TOKEN, {
			fetchImpl: (async (input: unknown, init?: RequestInit) => {
				url = String(input);
				headers = new Headers(init?.headers);
				return Response.json(captureList);
			}) as unknown as typeof fetch,
		});
		expect(url).toBe(PRIMARY_URL);
		expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		expect(headers.get("chatgpt-account-id")).toBe("acct-fake-1");
		expect(headers.get("x-account-id")).toBe("acct-fake-1");
		expect(headers.get("user-agent")).toMatch(/^codex-cli\//);
		expect(headers.has("x-openai-codex-luna-reserve")).toBe(false);
	});
});

const CONSUME_URL =
	"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const REQUEST_ID = "6f1c1c2e-1d4b-4f5e-9a51-1f0e2a3b4c5d";

type CapturedRequest = {
	url: string;
	method: string | undefined;
	headers: Headers;
	body: unknown;
};

function capturingFetch(
	response: () => Response,
	captured: CapturedRequest[],
): typeof fetch {
	return (async (input: unknown, init?: RequestInit) => {
		captured.push({
			url: String(input),
			method: init?.method,
			headers: new Headers(init?.headers),
			body: init?.body == null ? undefined : JSON.parse(String(init.body)),
		});
		return response();
	}) as unknown as typeof fetch;
}

describe("consumeCodexResetCredit", () => {
	it("posts the request id and credit id with the shared headers and no luna header", async () => {
		const captured: CapturedRequest[] = [];
		const result = await consumeCodexResetCredit(
			TOKEN,
			{ redeemRequestId: REQUEST_ID, creditId: "credit-a" },
			{
				fetchImpl: capturingFetch(
					() => Response.json({ code: "reset", windows_reset: 2 }),
					captured,
				),
			},
		);
		expect(result).toEqual({
			kind: "answered",
			status: 200,
			code: "reset",
			windowsReset: 2,
		});
		expect(captured).toHaveLength(1);
		const [request] = captured;
		expect(request.url).toBe(CONSUME_URL);
		expect(request.method).toBe("POST");
		expect(request.body).toEqual({
			redeem_request_id: REQUEST_ID,
			credit_id: "credit-a",
		});
		expect(request.headers.get("content-type")).toBe("application/json");
		expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		expect(request.headers.get("chatgpt-account-id")).toBe("acct-fake-1");
		expect(request.headers.get("user-agent")).toMatch(/^codex-cli\//);
		expect(request.headers.has("x-openai-codex-luna-reserve")).toBe(false);
		expect(request.headers.has("idempotency-key")).toBe(false);
	});

	it("omits the credit id key when there is no credit to name", async () => {
		const captured: CapturedRequest[] = [];
		await consumeCodexResetCredit(
			TOKEN,
			{ redeemRequestId: REQUEST_ID, creditId: null },
			{
				fetchImpl: capturingFetch(
					() => Response.json({ code: "no_credit" }),
					captured,
				),
			},
		);
		expect(captured[0].body).toEqual({ redeem_request_id: REQUEST_ID });
		expect(Object.hasOwn(captured[0].body as object, "credit_id")).toBe(false);
	});

	it("defaults windows_reset to 0 like the Codex client", async () => {
		const result = await consumeCodexResetCredit(
			TOKEN,
			{ redeemRequestId: REQUEST_ID, creditId: null },
			{ fetchImpl: jsonFetch({ code: "nothing_to_reset" }) },
		);
		expect(result).toEqual({
			kind: "answered",
			status: 200,
			code: "nothing_to_reset",
			windowsReset: 0,
		});
	});

	it("keeps only a safe code shape and never echoes other answer fields", async () => {
		const result = await consumeCodexResetCredit(
			TOKEN,
			{ redeemRequestId: REQUEST_ID, creditId: null },
			{
				fetchImpl: jsonFetch({
					code: "Reset <script>DISTINCT-SECRET-BODY-TEXT</script>",
					detail: "DISTINCT-SECRET-BODY-TEXT",
				}),
			},
		);
		expect(result).toEqual({
			kind: "answered",
			status: 200,
			code: null,
			windowsReset: 0,
		});
		expect(JSON.stringify(result)).not.toContain("DISTINCT-SECRET-BODY-TEXT");
	});

	it("reports a 2xx body that is not JSON as an answer without a code", async () => {
		const result = await consumeCodexResetCredit(
			TOKEN,
			{ redeemRequestId: REQUEST_ID, creditId: null },
			{
				fetchImpl: (async () =>
					new Response("not json", { status: 200 })) as unknown as typeof fetch,
			},
		);
		expect(result).toEqual({
			kind: "answered",
			status: 200,
			code: null,
			windowsReset: null,
		});
	});

	it("reports a non-2xx answer by status only, never its body", async () => {
		const result = await consumeCodexResetCredit(
			TOKEN,
			{ redeemRequestId: REQUEST_ID, creditId: "credit-a" },
			{
				fetchImpl: jsonFetch({ detail: "DISTINCT-SECRET-BODY-TEXT" }, 403),
			},
		);
		expect(result).toEqual({ kind: "http", status: 403 });
		expect(JSON.stringify(result)).not.toContain("DISTINCT-SECRET-BODY-TEXT");
	});

	it("keeps a rejected fetch's message, token and account id out of the result and the logs", async () => {
		const logged: string[] = [];
		const methods = ["log", "info", "warn", "error", "debug"] as const;
		const originals = methods.map((m) => console[m]);
		for (const m of methods) {
			console[m] = (...args: unknown[]) => {
				logged.push(args.map(String).join(" "));
			};
		}
		let result: CodexResetConsumeResult;
		try {
			result = await consumeCodexResetCredit(
				TOKEN,
				{ redeemRequestId: REQUEST_ID, creditId: "credit-a" },
				{
					fetchImpl: (async () => {
						throw new Error(
							`connect failed for Bearer ${TOKEN} account acct-fake-1`,
						);
					}) as unknown as typeof fetch,
				},
			);
		} finally {
			methods.forEach((m, i) => {
				console[m] = originals[i];
			});
		}
		expect(result).toEqual({ kind: "network" });
		const everything = `${JSON.stringify(result)}\n${logged.join("\n")}`;
		expect(everything).not.toContain(TOKEN);
		expect(everything).not.toContain("acct-fake-1");
	});

	it("times out after the deadline", async () => {
		const never = ((_url: unknown, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError")),
				);
			})) as unknown as typeof fetch;
		const result = await consumeCodexResetCredit(
			TOKEN,
			{ redeemRequestId: REQUEST_ID, creditId: null },
			{ fetchImpl: never, timeoutMs: 20 },
		);
		expect(result).toEqual({ kind: "timeout" });
	});
});

describe("classifyCodexResetConsume", () => {
	const answered = (code: string | null, windowsReset: number | null = 1) =>
		({
			kind: "answered",
			status: 200,
			code,
			windowsReset,
		}) as const;

	it.each([
		"reset",
		"already_redeemed",
		"nothing_to_reset",
		"no_credit",
	])("records 200 %s as done", (code) => {
		expect(classifyCodexResetConsume(answered(code))).toEqual({
			state: "done",
			code,
			windowsReset: 1,
			httpStatus: 200,
		});
	});

	it("records 200 with any other code, or none, as unknown", () => {
		expect(classifyCodexResetConsume(answered("queued"))).toEqual({
			state: "unknown",
			code: "queued",
			windowsReset: null,
			httpStatus: 200,
		});
		expect(classifyCodexResetConsume(answered(null, null)).state).toBe(
			"unknown",
		);
	});

	it.each([
		[401, "retryable"],
		[429, "retryable"],
		[403, "refused"],
		[400, "refused"],
		[404, "refused"],
		[409, "refused"],
		[500, "unknown"],
		[502, "unknown"],
		[503, "unknown"],
	] as const)("records HTTP %i as %s", (status, state) => {
		expect(classifyCodexResetConsume({ kind: "http", status })).toEqual({
			state,
			code: null,
			windowsReset: null,
			httpStatus: status,
		});
	});

	it("records a timeout or a network error as unknown", () => {
		for (const result of [{ kind: "timeout" }, { kind: "network" }] as const) {
			expect(classifyCodexResetConsume(result)).toEqual({
				state: "unknown",
				code: null,
				windowsReset: null,
				httpStatus: null,
			});
		}
	});
});
