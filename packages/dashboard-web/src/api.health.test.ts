import { afterEach, describe, expect, test } from "bun:test";
import { api } from "./api";

const realFetch = globalThis.fetch;

const POOL = {
	configured: 2,
	routable: 0,
	paused: 0,
	rate_limited: 2,
	usage_exhausted: 0,
	next_available_at: "2026-11-02T15:45:00.000Z",
};

const calls: string[] = [];

function stubFetch(respond: () => Promise<Response>) {
	globalThis.fetch = ((input: RequestInfo | URL) => {
		calls.push(String(input));
		return respond();
	}) as typeof fetch;
}

function json(body: unknown, status: number): Promise<Response> {
	return Promise.resolve(
		new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		}),
	);
}

afterEach(() => {
	globalThis.fetch = realFetch;
	calls.length = 0;
});

describe("api.getHealth", () => {
	test("returns the verdict carried by a 503", async () => {
		stubFetch(() => json({ status: "degraded", pool: POOL }, 503));
		expect(await api.getHealth()).toEqual({ status: "degraded", pool: POOL });
		expect(calls).toEqual(["/health"]);
	});

	test("returns an ok verdict from a 200", async () => {
		const pool = { ...POOL, routable: 2, rate_limited: 0 };
		stubFetch(() => json({ status: "ok", pool }, 200));
		expect(await api.getHealth()).toEqual({ status: "ok", pool });
	});

	test("returns null for the guard's drain body, without retrying", async () => {
		stubFetch(() =>
			json(
				{ error: "service_unavailable", message: "HoV Router is restarting" },
				503,
			),
		);
		expect(await api.getHealth()).toBeNull();
		expect(calls).toHaveLength(1);
	});

	test("returns null when the request fails", async () => {
		stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
		expect(await api.getHealth()).toBeNull();
	});

	test("returns null for a body that is not JSON", async () => {
		stubFetch(() =>
			Promise.resolve(
				new Response("<html>Bad Gateway</html>", { status: 502 }),
			),
		);
		expect(await api.getHealth()).toBeNull();
	});
});
