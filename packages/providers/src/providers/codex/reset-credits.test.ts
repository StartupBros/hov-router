import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { fetchCodexResetCredits } from "./reset-credits";

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
