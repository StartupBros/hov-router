/**
 * Endpoints removed in 5.0.0 must answer 410 from the API router itself.
 *
 * An unmatched /api/* path makes APIRouter.handleRequest return null, and
 * server.ts then hands the request to the inference proxy, whose Anthropic
 * provider accepts every path. Without a local answer, a stale script calling
 * a removed endpoint would be forwarded upstream on a real account.
 *
 * Authentication is disabled here (no API keys) so each request reaches route
 * dispatch, the same as a local install that never created a key.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { APIContext } from "../types";

const scratch = mkdtempSync(join(tmpdir(), "ccflare-removed-endpoints-"));
process.env.BETTER_CCFLARE_DB_PATH = join(scratch, "test.db");
process.env.BETTER_CCFLARE_CONFIG_PATH = join(scratch, "config.json");
process.env.DATABASE_URL = "";
process.env.BETTER_CCFLARE_PUBLIC_SUBSCRIPTIONS = "";

const { APIRouter } = await import("../router");

function context(): APIContext {
	return {
		dbOps: {
			getAdapter: () => ({}),
			countActiveApiKeys: async () => 0,
			getActiveApiKeys: async () => [],
		},
		config: {},
	} as unknown as APIContext;
}

async function send(
	method: string,
	path: string,
	body?: unknown,
): Promise<Response | null> {
	const router = new APIRouter(context());
	const url = new URL(`http://localhost${path}`);
	return router.handleRequest(
		url,
		new Request(url, {
			method,
			...(body === undefined
				? {}
				: {
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
					}),
		}),
	);
}

const REMOVED: Array<{
	method: string;
	path: string;
	body?: unknown;
	endpoint: string;
	replacement: string | null;
}> = [
	{
		method: "GET",
		path: "/api/config/model",
		endpoint: "/api/config/model",
		replacement: null,
	},
	{
		method: "POST",
		path: "/api/config/model",
		body: { model: "claude-sonnet-5-5" },
		endpoint: "/api/config/model",
		replacement: null,
	},
	{
		method: "POST",
		path: "/api/accounts/acct-1/auto-refresh",
		body: { enabled: false },
		endpoint: "/api/accounts/:id/auto-refresh",
		replacement: null,
	},
	{
		method: "POST",
		path: "/api/accounts/acct-1/model-fallbacks",
		body: { modelFallbacks: { sonnet: ["model-b"] } },
		endpoint: "/api/accounts/:id/model-fallbacks",
		replacement: "POST /api/accounts/:id/model-mappings",
	},
	{
		method: "GET",
		path: "/api/system/info",
		endpoint: "/api/system/info",
		replacement: null,
	},
	{
		method: "GET",
		path: "/api/workspaces",
		endpoint: "/api/workspaces",
		replacement: "GET /api/agents",
	},
	{
		method: "POST",
		path: "/api/debug/cache-diagnosis",
		body: {},
		endpoint: "/api/debug/cache-diagnosis",
		replacement: null,
	},
];

describe("endpoints removed in 5.0.0", () => {
	for (const removed of REMOVED) {
		it(`${removed.method} ${removed.path} answers 410 locally`, async () => {
			const response = await send(removed.method, removed.path, removed.body);

			expect(response).not.toBeNull();
			expect(response?.status).toBe(410);
			const body = (await response?.json()) as {
				error: string;
				endpoint: string;
				removedIn: string;
				replacement: string | null;
				message: string;
			};
			expect(body.error).toBe("Gone");
			expect(body.endpoint).toBe(removed.endpoint);
			expect(body.removedIn).toBe("5.0.0");
			expect(body.replacement).toBe(removed.replacement);
			expect(body.message).toContain("removed in");
			expect(body.message).toContain("5.0.0");
			if (removed.replacement) {
				expect(body.message).toContain(removed.replacement);
			}
		});
	}

	it("answers 410 for any method on a removed path, so none reaches the proxy", async () => {
		for (const method of ["HEAD", "PUT", "PATCH", "DELETE"]) {
			for (const path of [
				"/api/config/model",
				"/api/accounts/acct-1/auto-refresh",
				"/api/accounts/acct-1/model-fallbacks",
				// The removed handlers matched by path suffix at any depth.
				"/api/accounts/acct-1/x/model-fallbacks",
				"/api/system/info",
				"/api/workspaces",
				"/api/debug/cache-diagnosis",
			]) {
				expect((await send(method, path))?.status).toBe(410);
			}
		}
		expect((await send("GET", "/api/debug/cache-diagnosis"))?.status).toBe(410);
	});

	it("leaves the routes next to them alone", async () => {
		for (const [method, path] of [
			["GET", "/api/config/model-capacity-routing"],
			["POST", "/api/accounts/acct-1/model-mappings"],
			["GET", "/api/agents"],
			["GET", "/api/debug/cache-pacing"],
		] as const) {
			const response = await send(
				method,
				path,
				method === "POST" ? {} : undefined,
			);
			expect(response).not.toBeNull();
			expect(response?.status).not.toBe(410);
		}
		for (const path of [
			"/api/config/models",
			"/api/accounts/acct-1/auto-refresh/extra",
			"/api/accounts/acct-1/model-fallbacks-x",
			"/api/system/info/extra",
			"/api/workspaces/extra",
			"/api/debug/cache-diagnosis/extra",
		]) {
			expect((await send("GET", path))?.status).not.toBe(410);
		}
	});
});
