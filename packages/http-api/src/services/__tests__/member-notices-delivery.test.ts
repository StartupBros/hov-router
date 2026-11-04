import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@better-ccflare/config";
import { DatabaseOperations } from "@better-ccflare/database";
import {
	type MemberNoticeFetch,
	runMemberNoticePass,
	signMemberNoticeRequest,
	startMemberNoticeScheduler,
} from "../member-notices";

const MINUTE = 60_000;
const NOW = Date.parse("2026-11-03T10:00:00.000Z");
const INTAKE_PATH = "/api/internal/ai-alerts/router-events";
const MEMBER_URL = `https://brobot.example.com${INTAKE_PATH}`;
const SECRET = "router-signing-secret-7f3a";
const KEY = "early:codex:after:none";
const ENV_KEYS = [
	"MEMBER_NOTICE_WEBHOOK_URL",
	"MEMBER_NOTICE_SIGNING_SECRET",
	"ALERT_WEBHOOK_URL",
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function eventBody(noticeKey: string, provider: "codex" | "claude"): string {
	return JSON.stringify({
		version: 1,
		noticeKey,
		kind: "early_reset",
		provider,
		detectedAt: new Date(NOW).toISOString(),
		waveExpiresAt: null,
		lead: null,
	});
}
const BODY = eventBody(KEY, "codex");

let dbOps: DatabaseOperations;
let directory: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
	saved = {};
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	directory = mkdtempSync(join(tmpdir(), "member-notice-delivery-"));
	dbOps = new DatabaseOperations(":memory:", { walMode: false });
});

afterEach(async () => {
	await dbOps.dispose();
	rmSync(directory, { recursive: true, force: true });
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

function configFor(memberUrl: string, secret = SECRET): Config {
	const config = new Config(join(directory, "config.json"));
	config.set("member_notice_webhook_url", memberUrl);
	config.set("member_notice_signing_secret", secret);
	return config;
}

async function claimNotice(expiresAt = NOW + 10 * 24 * 60 * MINUTE) {
	await dbOps.getMemberNoticesRepository().claim({
		noticeKey: KEY,
		kind: "early_reset",
		provider: "codex",
		content: BODY,
		claimedAt: NOW,
		expiresAt,
	});
}

type Reply = Response | Error;

function recorder(replies: Reply[] = []) {
	const calls: { url: string; init: RequestInit }[] = [];
	const fetch: MemberNoticeFetch = async (url, init) => {
		calls.push({ url, init });
		const reply = replies.shift() ?? new Response(null, { status: 204 });
		if (reply instanceof Error) throw reply;
		return reply;
	};
	return { calls, fetch };
}

const headersOf = (init: RequestInit | undefined) =>
	(init?.headers ?? {}) as Record<string, string>;

/**
 * A real fetch to a local plain-HTTP server, while the configured address
 * stays https as the destination gate requires. Only the origin changes, so
 * the path the router signs is the path the server receives.
 */
function viaLocalServer(port: number): MemberNoticeFetch {
	return (url, init) => {
		const target = new URL(url);
		return globalThis.fetch(
			`http://127.0.0.1:${port}${target.pathname}${target.search}`,
			init,
		);
	};
}

function pass(
	config: Config,
	at: number,
	fetch: MemberNoticeFetch,
	failures: string[] = [],
	owner?: string,
) {
	return runMemberNoticePass({
		dbOps,
		config,
		now: () => at,
		fetch,
		owner,
		onDeliveryFailed: async (status) => {
			failures.push(status);
		},
	});
}

const row = () => dbOps.getMemberNoticesRepository().findByKey(KEY);

describe("member notice request signature", () => {
	it("reproduces BroBot's golden v1 vector byte for byte", () => {
		// Copied from StartupBros-com/pushbot at c8bbfb59,
		// packages/shared/src/__fixtures__/request-signature-v1.json. BroBot's
		// intake recomputes this signature with generateRequestSignature, so a
		// router signer that drifts from it is refused with 401.
		expect(
			signMemberNoticeRequest("secret", {
				method: "POST",
				pathname: "/api/webhooks/discord-brobot",
				timestamp: 1788400000000,
				requestId: "golden-req-0001",
				body: '{"ok":true,"n":1}',
			}),
		).toBe(
			"v1=f7a5ff9ad239542531621bd0b6032081ab46a0b46c932cc189e41f27a390b274",
		);
	});
});

describe("member notice delivery", () => {
	it("posts the stored event body, signed for the intake path when it is sent", async () => {
		await claimNotice();
		const config = configFor(MEMBER_URL);
		const { calls, fetch } = recorder();

		const result = await pass(config, NOW, fetch);

		expect(result).toMatchObject({ state: "on", delivered: 1, retried: 0 });
		expect(calls).toHaveLength(1);
		const { url, init } = calls[0] ?? { url: "", init: {} };
		expect(url).toBe(MEMBER_URL);
		expect(init.method).toBe("POST");
		expect(init.redirect).toBe("manual");
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(init.body).toBe(BODY);
		const headers = headersOf(init);
		const requestId = headers["X-Request-Id"] ?? "";
		expect(requestId).toMatch(UUID);
		expect(headers).toEqual({
			"Content-Type": "application/json",
			"User-Agent": "better-ccflare-alerts/1.0",
			"X-Request-Signature": signMemberNoticeRequest(SECRET, {
				method: "POST",
				pathname: INTAKE_PATH,
				timestamp: NOW,
				requestId,
				body: BODY,
			}),
			"X-Request-Timestamp": String(NOW),
			"X-Request-Id": requestId,
			"X-Key-Version": "1",
		});
		expect(JSON.stringify(headers)).not.toContain(SECRET);
		expect(await row()).toMatchObject({
			deliveredAt: NOW,
			lastStatus: "204",
			attempts: 1,
			leaseOwner: null,
		});

		expect((await pass(config, NOW + MINUTE, fetch)).delivered).toBe(0);
		expect(calls).toHaveLength(1);
	});

	it("sends the same bytes on a retry, with a fresh timestamp, request id and signature", async () => {
		await claimNotice();
		const config = configFor(MEMBER_URL);
		const { calls, fetch } = recorder([new Response(null, { status: 503 })]);

		await pass(config, NOW, fetch);
		await pass(config, NOW + MINUTE, fetch);

		expect(calls).toHaveLength(2);
		const [first, second] = [calls[0]?.init, calls[1]?.init];
		expect(first?.body).toBe(BODY);
		expect(second?.body).toBe(BODY);
		expect(headersOf(first)["X-Request-Timestamp"]).toBe(String(NOW));
		expect(headersOf(second)["X-Request-Timestamp"]).toBe(String(NOW + MINUTE));
		expect(headersOf(second)["X-Request-Id"]).not.toBe(
			headersOf(first)["X-Request-Id"],
		);
		expect(headersOf(second)["X-Request-Signature"]).not.toBe(
			headersOf(first)["X-Request-Signature"],
		);
		expect(await row()).toMatchObject({
			deliveredAt: NOW + MINUTE,
			attempts: 2,
		});
	});

	it("puts a request on the wire that verifies the way BroBot's intake checks it", async () => {
		await claimNotice();
		const received: {
			pathname: string;
			body: string;
			verified: boolean;
			headers: string;
		}[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				// The same reads as authenticateBrobotInternalRequest: the raw
				// body, the request's own pathname and the three headers.
				const body = await request.text();
				const pathname = new URL(request.url).pathname;
				const expected = signMemberNoticeRequest(SECRET, {
					method: request.method,
					pathname,
					timestamp: Number.parseInt(
						request.headers.get("X-Request-Timestamp") ?? "",
						10,
					),
					requestId: request.headers.get("X-Request-Id") ?? "",
					body,
				});
				received.push({
					pathname,
					body,
					verified: request.headers.get("X-Request-Signature") === expected,
					headers: JSON.stringify([...request.headers]),
				});
				return Response.json({ ok: true });
			},
		});
		try {
			const result = await pass(
				configFor(MEMBER_URL),
				NOW,
				viaLocalServer(server.port),
			);

			expect(result).toMatchObject({ delivered: 1, gaveUp: 0 });
			expect(received).toHaveLength(1);
			expect(received[0]).toMatchObject({
				pathname: INTAKE_PATH,
				body: BODY,
				verified: true,
			});
			expect(received[0]?.headers).not.toContain(SECRET);
		} finally {
			server.stop(true);
		}
	});

	it("retries a 429 after its Retry-After, in seconds or as a date", async () => {
		await claimNotice();
		const config = configFor(MEMBER_URL);
		const later = NOW + 2 * MINUTE;
		const { calls, fetch } = recorder([
			new Response(null, { status: 429, headers: { "Retry-After": "120" } }),
			new Response(null, {
				status: 429,
				headers: { "Retry-After": new Date(later + 5 * MINUTE).toUTCString() },
			}),
			new Response(null, { status: 429 }),
		]);

		expect((await pass(config, NOW, fetch)).retried).toBe(1);
		expect(await row()).toMatchObject({
			nextAttemptAt: later,
			lastStatus: "429",
		});
		await pass(config, NOW + MINUTE, fetch);
		expect(calls).toHaveLength(1);

		await pass(config, later, fetch);
		expect((await row())?.nextAttemptAt).toBe(later + 5 * MINUTE);

		// Without a usable header, the third attempt backs off 4 minutes.
		await pass(config, later + 5 * MINUTE, fetch);
		expect((await row())?.nextAttemptAt).toBe(later + 9 * MINUTE);
	});

	it("backs off 5xx and network errors from 1 minute, doubling to a 30-minute cap", async () => {
		await claimNotice();
		const config = configFor(MEMBER_URL);
		const { fetch } = recorder([
			new Response(null, { status: 503 }),
			new Error(`connect ECONNREFUSED ${MEMBER_URL}`),
			new Response(null, { status: 502 }),
			new Response(null, { status: 503 }),
			new Response(null, { status: 500 }),
			new Response(null, { status: 503 }),
			new Response(null, { status: 503 }),
		]);
		const delays: number[] = [];
		const statuses: (string | null)[] = [];
		let at = NOW;
		for (let attempt = 0; attempt < 7; attempt++) {
			await pass(config, at, fetch);
			const current = await row();
			delays.push(((current?.nextAttemptAt ?? 0) - at) / MINUTE);
			statuses.push(current?.lastStatus ?? null);
			at = current?.nextAttemptAt ?? at;
		}
		expect(delays).toEqual([1, 2, 4, 8, 16, 30, 30]);
		expect(statuses).toEqual([
			"503",
			"network_error",
			"502",
			"503",
			"500",
			"503",
			"503",
		]);
		expect((await row())?.attempts).toBe(7);
	});

	it("gives up on a refused signature or any other status and raises one delivery-failed alert", async () => {
		await claimNotice();
		const config = configFor(MEMBER_URL);
		const failures: string[] = [];
		const { calls, fetch } = recorder([new Response(null, { status: 401 })]);

		const result = await pass(config, NOW, fetch, failures);

		expect(result.gaveUp).toBe(1);
		expect(failures).toEqual(["401"]);
		expect(await row()).toMatchObject({ gaveUpAt: NOW, lastStatus: "401" });
		await pass(config, NOW + 60 * MINUTE, fetch, failures);
		expect(calls).toHaveLength(1);
		expect(failures).toEqual(["401"]);
	});

	it("lets a notice that is still failing expire when it stops mattering, without an alert", async () => {
		await claimNotice(NOW + 3 * MINUTE);
		const config = configFor(MEMBER_URL);
		const failures: string[] = [];
		const { calls, fetch } = recorder([
			new Response(null, { status: 503 }),
			new Response(null, { status: 503 }),
		]);
		await pass(config, NOW, fetch, failures);
		await pass(config, NOW + MINUTE, fetch, failures);

		const result = await pass(config, NOW + 3 * MINUTE, fetch, failures);

		expect(result).toMatchObject({ expired: 1, delivered: 0, gaveUp: 0 });
		expect(calls).toHaveLength(2);
		expect(failures).toEqual([]);
		expect(await row()).toMatchObject({
			gaveUpAt: NOW + 3 * MINUTE,
			lastStatus: "expired",
		});
	});

	it("sends a notice once when two passes run at the same time", async () => {
		await claimNotice();
		const config = configFor(MEMBER_URL);
		let release: (response: Response) => void = () => {};
		let entered: () => void = () => {};
		const sending = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const first = pass(config, NOW, () => {
			entered();
			return new Promise<Response>((resolve) => {
				release = resolve;
			});
		});
		await sending;

		const second = recorder();
		const secondResult = await pass(config, NOW, second.fetch, [], "second");
		release(new Response(null, { status: 204 }));
		const firstResult = await first;

		expect(second.calls).toEqual([]);
		expect(secondResult.delivered).toBe(0);
		expect(firstResult.delivered).toBe(1);
		expect((await row())?.attempts).toBe(1);
	});

	it("ignores a late result once another pass has taken over the lease", async () => {
		await claimNotice();
		const config = configFor(MEMBER_URL);
		let clock = NOW;
		let takeover: Awaited<ReturnType<typeof runMemberNoticePass>> | undefined;
		const late = await runMemberNoticePass({
			dbOps,
			config,
			now: () => clock,
			owner: "slow",
			onDeliveryFailed: async () => {},
			fetch: async () => {
				clock += 61_000;
				takeover = await pass(config, clock, recorder().fetch, [], "fast");
				return new Response(null, { status: 503 });
			},
		});

		expect(takeover?.delivered).toBe(1);
		expect(late).toMatchObject({ delivered: 0, retried: 0 });
		expect(await row()).toMatchObject({
			deliveredAt: NOW + 61_000,
			lastStatus: "204",
			attempts: 2,
			leaseOwner: null,
		});
	});

	it("gives up on a redirect instead of following it, so a login page cannot count as delivered", async () => {
		await claimNotice();
		const hits: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const { pathname } = new URL(request.url);
				hits.push(`${request.method} ${pathname}`);
				if (pathname === "/hook") {
					return new Response(null, {
						status: 302,
						headers: { location: "/login" },
					});
				}
				return new Response("login page", { status: 200 });
			},
		});
		try {
			const failures: string[] = [];
			const result = await pass(
				configFor("https://member.test/hook"),
				NOW,
				viaLocalServer(server.port),
				failures,
			);

			expect(result).toMatchObject({ delivered: 0, gaveUp: 1 });
			expect(hits).toEqual(["POST /hook"]);
			expect(failures).toEqual(["302"]);
			expect(await row()).toMatchObject({
				deliveredAt: null,
				gaveUpAt: NOW,
				lastStatus: "302",
			});
		} finally {
			server.stop(true);
		}
	});
});

async function waitFor(condition: () => boolean, timeoutMs = 1_000) {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition not reached");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("member notice scheduler", () => {
	it("runs one pass at a time and stops cleanly", async () => {
		let started = 0;
		let release: () => void = () => {};
		const stop = startMemberNoticeScheduler(
			() => {
				started++;
				return new Promise<void>((resolve) => {
					release = resolve;
				});
			},
			{ initialDelayMs: 1, intervalMs: 5 },
		);
		try {
			await waitFor(() => started === 1);
			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(started).toBe(1);
			release();
			await waitFor(() => started >= 2);
		} finally {
			const stopping = stop();
			release();
			await stopping;
		}
		const stoppedAt = started;
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(started).toBe(stoppedAt);
	});

	it("on stop, sends nothing more and waits until the send in flight is recorded", async () => {
		const SECOND = "early:claude:after:none";
		await claimNotice();
		await dbOps.getMemberNoticesRepository().claim({
			noticeKey: SECOND,
			kind: "early_reset",
			provider: "claude",
			content: eventBody(SECOND, "claude"),
			claimedAt: NOW,
			expiresAt: NOW + 60 * MINUTE,
		});
		const config = configFor(MEMBER_URL);
		const sends: string[] = [];
		let finishSend: () => void = () => {};
		const stop = startMemberNoticeScheduler(
			(signal) =>
				runMemberNoticePass({
					dbOps,
					config,
					now: () => NOW,
					signal,
					fetch: async (_url, init) => {
						sends.push(JSON.parse(String(init.body)).noticeKey);
						await new Promise<void>((resolve) => {
							finishSend = resolve;
						});
						return new Response(null, { status: 204 });
					},
					onDeliveryFailed: async () => {},
				}),
			{ initialDelayMs: 1, intervalMs: 60_000 },
		);
		await waitFor(() => sends.length === 1);

		let stopped = false;
		const stopping = stop().then(() => {
			stopped = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(stopped).toBe(false);
		finishSend();
		await stopping;

		// The first due notice (by key) was sent and recorded; the second was
		// never leased, so it is still waiting for the next process.
		expect(sends).toEqual([SECOND]);
		expect(
			await dbOps.getMemberNoticesRepository().findByKey(SECOND),
		).toMatchObject({ deliveredAt: NOW, lastStatus: "204", leaseOwner: null });
		expect(await row()).toMatchObject({
			deliveredAt: null,
			attempts: 0,
			leaseOwner: null,
		});
	});

	it("logs a failed pass by its error name only", async () => {
		const messages: string[] = [];
		const stop = startMemberNoticeScheduler(
			async () => {
				throw new TypeError(`fetch failed for ${MEMBER_URL} with ${SECRET}`);
			},
			{
				initialDelayMs: 1,
				intervalMs: 1_000,
				log: { error: (message: string) => messages.push(message) },
			},
		);
		try {
			await waitFor(() => messages.length === 1);
		} finally {
			await stop();
		}
		expect(messages[0]).toContain("TypeError");
		expect(messages[0]).not.toContain("brobot.example.com");
		expect(messages[0]).not.toContain(SECRET);
	});
});
