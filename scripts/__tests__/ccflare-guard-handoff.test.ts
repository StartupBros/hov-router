import { afterEach, expect, test } from "bun:test";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createInterface } from "node:readline";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createGuard,
	isDrainAdmissibleRead,
	matchesPinnedSourceId,
} from "../ccflare-guard.mjs";
import { resolveNodeExecutable } from "./node-runtime";

const sourceSha = "0123456789abcdef0123456789abcdef01234567";
test.each([
	[sourceSha, sourceSha, true],
	[sourceSha.slice(0, 7), sourceSha, true],
	[sourceSha.slice(0, 8), sourceSha, true],
	[sourceSha.slice(0, 12), sourceSha, true],
	[sourceSha.slice(0, 39), sourceSha, true],
	["11234567", sourceSha, false],
	[`${sourceSha.slice(0, 39)}8`, sourceSha, false],
	[sourceSha.slice(0, 6), sourceSha, false],
	[`${sourceSha}0`, sourceSha, false],
	["0123456G", sourceSha, false],
	["0123456789ABCDEF", sourceSha, false],
	["01234567\n", sourceSha, false],
	["", sourceSha, false],
	[null, sourceSha, false],
	[1234567, sourceSha, false],
	["fixture", "fixture-sha", false],
	["fixture-sha", "fixture-sha", true],
	[sourceSha.slice(0, 7), sourceSha.slice(0, 8), false],
	[sourceSha.slice(0, 8), sourceSha.toUpperCase(), false],
])("replacement health source %j against %j matches=%j", (reported, pinned, expected) => {
	expect(matchesPinnedSourceId(reported, pinned)).toBe(expected);
});

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const tick = () => Bun.sleep(10);
async function until(check: () => boolean) {
	for (let n = 0; n < 200; n++) {
		if (check()) return;
		await tick();
	}
	throw new Error("fixture condition timed out");
}
const secret = Buffer.alloc(32, 1).toString("base64url");
const identity = { pid: process.pid, startTime: "1", sha256: "a".repeat(64) };
async function fixture(options: Record<string, unknown> = {}) {
	let hold: http.ServerResponse | undefined;
	const calls: string[] = [];
	const signatures: string[] = [];
	const upstream = http.createServer((req, res) => {
		calls.push(req.url!);
		signatures.push(
			String(req.headers["x-better-ccflare-guard-request-id"] || ""),
		);
		if (req.url?.includes("hold")) {
			hold = res;
			res.writeHead(200);
			res.write("first");
			return;
		}
		res.end("done");
	});
	await new Promise<void>((resolve) =>
		upstream.listen(0, "127.0.0.1", resolve),
	);
	cleanups.push(
		() =>
			new Promise<void>((resolve) => {
				upstream.closeAllConnections();
				upstream.close(() => resolve());
			}),
	);
	const port = (upstream.address() as net.AddressInfo).port;
	const guard = createGuard({
		listenPort: 0,
		upstreamBase: `http://127.0.0.1:${port}`,
		maxActive: 2,
		maxQueue: 2,
		totalDeadlineMs: 700,
		retryAttemptHeadroomMs: 1,
		maxRecoverySleepMs: 20,
		shutdownGraceMs: 150,
		guardCorrelationSecret: secret,
		lifecycleEnabled: true,
		verifyReplacement: async () => identity,
		logger: () => {},
		...options,
	});
	const addr = await guard.listen();
	cleanups.push(() => guard.shutdown("fixture"));
	return {
		guard,
		base: `http://127.0.0.1:${addr.port}`,
		calls,
		signatures,
		release: () => hold!.end("last"),
		chunk: () => hold!.write("tick"),
	};
}

// Two Bun.serve backends sharing one port, like a quiesced backend and its
// replacement: stop(false) releases the listener while in-flight responses
// keep streaming from the old server.
async function overlapFixture(options: Record<string, unknown> = {}) {
	const encoder = new TextEncoder();
	const oldCalls: string[] = [];
	const newCalls: string[] = [];
	let hold: ReadableStreamDefaultController<Uint8Array> | undefined;
	const old = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			oldCalls.push(url.pathname + url.search);
			if (url.pathname === "/hold")
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							hold = controller;
							controller.enqueue(encoder.encode("first"));
						},
					}),
				);
			if (url.search === "?retry")
				return new Response("{}", {
					status: 503,
					headers: {
						"x-better-ccflare-pool-status": "exhausted",
						"x-better-ccflare-recovery-scope": "pool",
						"retry-after": "0.3",
					},
				});
			return new Response("old");
		},
	});
	const port = old.port;
	let replacement: ReturnType<typeof Bun.serve> | undefined;
	cleanups.push(() => {
		old.stop(true);
		replacement?.stop(true);
	});
	const guard = createGuard({
		listenPort: 0,
		upstreamBase: `http://127.0.0.1:${port}`,
		maxActive: 4,
		maxQueue: 4,
		totalDeadlineMs: 2000,
		retryAttemptHeadroomMs: 1,
		maxRecoverySleepMs: 400,
		shutdownGraceMs: 2000,
		guardCorrelationSecret: secret,
		lifecycleEnabled: true,
		verifyReplacement: async () => identity,
		logger: () => {},
		...options,
	});
	const addr = await guard.listen();
	cleanups.push(() => guard.shutdown("fixture"));
	return {
		guard,
		base: `http://127.0.0.1:${addr.port}`,
		oldCalls,
		newCalls,
		quiesceOld: () => {
			void old.stop(false);
		},
		// The legacy path reaps the old process, closing every connection.
		reapOld: async () => {
			await old.stop(true);
			await Bun.sleep(100);
		},
		async startNew() {
			for (let n = 0; n < 200 && !replacement; n++) {
				try {
					replacement = Bun.serve({
						hostname: "127.0.0.1",
						port,
						fetch(req) {
							const url = new URL(req.url);
							newCalls.push(url.pathname + url.search);
							return new Response("new");
						},
					});
				} catch {
					await tick();
				}
			}
			if (!replacement) throw new Error("replacement could not bind");
		},
		releaseOld() {
			hold!.enqueue(encoder.encode("last"));
			hold!.close();
		},
	};
}
async function firstChunk(response: Response) {
	const reader = response.body!.getReader();
	const { value } = await reader.read();
	const rest = (async () => {
		let text = "";
		while (true) {
			const next = await reader.read();
			if (next.done) return text;
			text += new TextDecoder().decode(next.value);
		}
	})().catch(() => "aborted");
	return { first: new TextDecoder().decode(value), rest };
}
const attachNext = (guard: any, generation = 2) =>
	guard.recycle.attach({ generation, ...identity, correlationSecret: secret });

test("overlap handoff answers new work from the replacement while the fenced generation's stream keeps running", async () => {
	const f = await overlapFixture();
	// A finished request leaves a pooled keep-alive socket to the old backend.
	expect(await (await fetch(`${f.base}/warm`)).text()).toBe("old");
	const old = await firstChunk(await fetch(`${f.base}/hold`));
	expect(old.first).toBe("first");
	expect(f.guard.recycle.fence(1)).toEqual({ ok: true, generation: 1 });
	expect(
		(await (await fetch(`${f.base}/_guard/health`)).json()).lifecycle.state,
	).toBe("fenced");
	const fresh = fetch(`${f.base}/v1/messages`, {
		method: "POST",
		body: "fixture",
	});
	await until(() => f.guard.state.lifecycle.waiting === 1);
	f.quiesceOld();
	await f.startNew();
	expect((await attachNext(f.guard)).ok).toBe(true);
	const answered = await fresh;
	expect(answered.status).toBe(200);
	expect(await answered.text()).toBe("new");
	// The new request was answered while the old stream is still open.
	expect(f.guard.state.lifecycle.retiring).toEqual({
		generation: 1,
		dispatched: 1,
	});
	f.releaseOld();
	expect(await old.rest).toBe("last");
	expect(await f.guard.recycle.retire(1)).toEqual({
		ok: true,
		generation: 1,
		outcome: "natural",
	});
	expect(f.guard.state.lifecycle.retiring).toBeNull();
	expect(f.oldCalls).toEqual(["/warm", "/hold"]);
	expect(f.newCalls).toEqual(["/v1/messages"]);
});

test("legacy drain holds the same new request until the old stream ends", async () => {
	// The ordering the overlap handoff removes: with begin/drain, a replacement
	// may already be listening but cannot attach while an old stream is open.
	const f = await overlapFixture();
	const old = await firstChunk(await fetch(`${f.base}/hold`));
	const drain = f.guard.recycle.begin(1);
	const fresh = fetch(`${f.base}/v1/messages`, {
		method: "POST",
		body: "fixture",
	});
	await until(() => f.guard.state.lifecycle.waiting === 1);
	expect((await attachNext(f.guard)).ok).toBe(false);
	expect(
		await Promise.race([
			fresh.then(() => "answered"),
			Bun.sleep(150).then(() => "waiting"),
		]),
	).toBe("waiting");
	f.releaseOld();
	expect(await old.rest).toBe("last");
	expect((await drain).outcome).toBe("natural");
	await f.reapOld();
	await f.startNew();
	expect((await attachNext(f.guard)).ok).toBe(true);
	expect(await (await fresh).text()).toBe("new");
});

test("a retiring stream past the grace budget is aborted while the replacement keeps serving", async () => {
	const events: string[] = [];
	const f = await overlapFixture({
		shutdownGraceMs: 150,
		logger: (line: string) => events.push(JSON.parse(line).event),
	});
	const old = await firstChunk(await fetch(`${f.base}/hold`));
	expect(f.guard.recycle.fence(1).ok).toBe(true);
	f.quiesceOld();
	await f.startNew();
	expect((await attachNext(f.guard)).ok).toBe(true);
	expect((await f.guard.recycle.retire(1)).outcome).toBe("forced");
	expect(await old.rest).toBe("aborted");
	expect(f.guard.state.lifecycle.state).toBe("serving");
	expect(f.guard.state.counters.retireForcedRequests).toBe(1);
	// The guard ended it as maintenance, not via a torn-down socket.
	expect(events).toContain("guard_recycle_request_terminated");
	const after = await fetch(`${f.base}/v1/messages`, {
		method: "POST",
		body: "fixture",
	});
	expect(await after.text()).toBe("new");
	expect(f.oldCalls).toEqual(["/hold"]);
	expect(f.newCalls).toEqual(["/v1/messages"]);
});

test("a retiring request whose recovery retry comes due after attach is refused, never replayed on the replacement", async () => {
	const f = await overlapFixture({ maxAttempts: 3 });
	const retried = fetch(`${f.base}/v1/messages?retry`, {
		method: "POST",
		body: "fixture",
	});
	await until(() => f.oldCalls.includes("/v1/messages?retry"));
	expect(f.guard.recycle.fence(1).ok).toBe(true);
	f.quiesceOld();
	await f.startNew();
	expect((await attachNext(f.guard)).ok).toBe(true);
	expect((await retried).status).toBe(503);
	expect(f.newCalls).toEqual([]);
	expect((await f.guard.recycle.retire(1)).outcome).toBe("natural");
});

test("a retry that comes due after shutdown of a fenced generation is refused", async () => {
	const f = await overlapFixture({ maxAttempts: 3 });
	const retried = fetch(`${f.base}/v1/messages?retry`, {
		method: "POST",
		body: "fixture",
	});
	await until(() => f.oldCalls.includes("/v1/messages?retry"));
	expect(f.guard.recycle.fence(1).ok).toBe(true);
	f.quiesceOld();
	await f.startNew();
	const stopped = f.guard.shutdown("SIGTERM");
	expect((await retried).status).toBe(503);
	await stopped;
	expect(f.newCalls).toEqual([]);
});

test("a legacy drain of the replacement generation neither waits on nor aborts the retiring generation", async () => {
	const f = await overlapFixture();
	const old = await firstChunk(await fetch(`${f.base}/hold`));
	expect(f.guard.recycle.fence(1).ok).toBe(true);
	f.quiesceOld();
	await f.startNew();
	expect((await attachNext(f.guard)).ok).toBe(true);
	expect((await f.guard.recycle.begin(2)).outcome).toBe("natural");
	expect(f.guard.state.lifecycle.state).toBe("absent");
	f.releaseOld();
	expect(await old.rest).toBe("last");
	expect((await f.guard.recycle.retire(1)).outcome).toBe("natural");
});

test("fence admits only the serving generation and one retiring generation at a time", async () => {
	const f = await overlapFixture();
	expect(f.guard.recycle.fence(0).ok).toBe(false);
	const old = await firstChunk(await fetch(`${f.base}/hold`));
	expect(f.guard.recycle.fence(1).ok).toBe(true);
	expect(f.guard.recycle.fence(1).ok).toBe(false);
	expect((await f.guard.recycle.begin(1)).ok).toBe(false);
	expect((await attachNext(f.guard, 3)).ok).toBe(false);
	f.quiesceOld();
	await f.startNew();
	expect((await attachNext(f.guard)).ok).toBe(true);
	expect(f.guard.recycle.fence(2)).toEqual({
		ok: false,
		reason: "retire_in_progress",
	});
	f.releaseOld();
	await old.rest;
	expect((await f.guard.recycle.retire(1)).outcome).toBe("natural");
	expect((await f.guard.recycle.retire(5)).ok).toBe(false);
	expect(f.guard.recycle.fence(2).ok).toBe(true);
	expect((await f.guard.recycle.retire(2)).outcome).toBe("natural");
	expect(await f.guard.recycle.retire(1)).toEqual({
		ok: false,
		reason: "invalid_generation_or_state",
	});
});

test("terminal shutdown while fenced never releases waiters onto the unverified listener", async () => {
	const f = await overlapFixture();
	const old = await firstChunk(await fetch(`${f.base}/hold`));
	expect(f.guard.recycle.fence(1).ok).toBe(true);
	const pending = fetch(`${f.base}/v1/messages`, {
		method: "POST",
		body: "fixture",
	});
	await until(() => f.guard.state.lifecycle.waiting === 1);
	f.quiesceOld();
	await f.startNew();
	const stopped = f.guard.shutdown("SIGTERM");
	expect((await pending).status).toBe(503);
	expect((await attachNext(f.guard)).ok).toBe(false);
	f.releaseOld();
	expect(await old.rest).toBe("last");
	await stopped;
	expect(f.newCalls).toEqual([]);
});

test("fence retires the Node connection pool so a quiesced backend's keep-alive sockets never carry replacement traffic", async () => {
	// Worst case: the old backend keeps idle and in-flight keep-alive
	// connections open after closing its listener, and answers "old" on them.
	const source = new URL("../ccflare-guard.mjs", import.meta.url).href;
	const script = `
import http from 'node:http';
import net from 'node:net';
const { createGuard } = await import(${JSON.stringify(source)});
const oldSockets = new Set();
let holdSocket;
const old = net.createServer((socket) => {
	oldSockets.add(socket);
	let buffer = Buffer.alloc(0);
	socket.on('data', (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (true) {
			const end = buffer.indexOf('\\r\\n\\r\\n');
			if (end < 0) return;
			const head = buffer.subarray(0, end).toString();
			const length = Number(/content-length: *(\\d+)/i.exec(head)?.[1] ?? 0);
			if (buffer.length < end + 4 + length) return;
			buffer = buffer.subarray(end + 4 + length);
			if (head.startsWith('GET /hold ')) {
				holdSocket = socket;
				socket.write('HTTP/1.1 200 OK\\r\\nTransfer-Encoding: chunked\\r\\nConnection: keep-alive\\r\\n\\r\\n5\\r\\nfirst\\r\\n');
			} else {
				socket.write('HTTP/1.1 200 OK\\r\\nContent-Length: 3\\r\\nConnection: keep-alive\\r\\n\\r\\nold');
			}
		}
	});
	socket.on('error', () => {});
});
await new Promise((resolve) => old.listen(0, '127.0.0.1', resolve));
const port = old.address().port;
const identity = { pid: process.pid, startTime: '1', sha256: 'a'.repeat(64) };
const secret = Buffer.alloc(32, 1).toString('base64url');
const guard = createGuard({ listenPort: 0, upstreamBase: 'http://127.0.0.1:' + port, lifecycleEnabled: true, guardCorrelationSecret: secret, verifyReplacement: async () => identity, logger: () => {}, totalDeadlineMs: 5000, retryAttemptHeadroomMs: 1, maxRecoverySleepMs: 20, shutdownGraceMs: 3000 });
const base = 'http://127.0.0.1:' + (await guard.listen()).port;
const warm = await (await fetch(base + '/warm')).text();
const hold = (await fetch(base + '/hold')).body.getReader();
const first = new TextDecoder().decode((await hold.read()).value);
guard.recycle.fence(1);
old.close();
const newCalls = [];
const replacement = http.createServer((req, res) => { newCalls.push(req.url); req.resume(); req.on('end', () => res.end('new')); });
await new Promise((resolve) => replacement.listen(port, '127.0.0.1', resolve));
const attached = (await guard.recycle.attach({ generation: 2, ...identity, correlationSecret: secret })).ok;
const fresh = await (await fetch(base + '/v1/messages', { method: 'POST', body: 'x' })).text();
holdSocket.write('4\\r\\nlast\\r\\n0\\r\\n\\r\\n');
let rest = '';
for (let next = await hold.read(); !next.done; next = await hold.read()) rest += new TextDecoder().decode(next.value);
const retire = (await guard.recycle.retire(1)).outcome;
const after = await (await fetch(base + '/after')).text();
console.log(JSON.stringify({ warm, first, attached, fresh, rest, retire, after, newCalls }));
for (const socket of oldSockets) socket.destroy();
replacement.closeAllConnections();
replacement.close();
await guard.shutdown('fixture');
process.exit(0);
`;
	const child = spawn(
		resolveNodeExecutable(),
		["--input-type=module", "--eval", script],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	let stderr = "";
	child.stderr.on("data", (d) => (stderr += d));
	const ended = new Promise<number | null>((resolve) =>
		child.once("exit", (code) => resolve(code)),
	);
	cleanups.push(async () => {
		child.kill("SIGKILL");
		await ended;
	});
	const line = await new Promise<string>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) =>
			reject(new Error(`node fixture exited ${code}: ${stderr}`)),
		);
		createInterface({ input: child.stdout }).once("line", resolve);
	});
	expect(JSON.parse(line)).toEqual({
		warm: "old",
		first: "first",
		attached: true,
		fresh: "new",
		rest: "last",
		retire: "natural",
		after: "new",
		newCalls: ["/v1/messages", "/after"],
	});
}, 10000);

test("handoff preserves listener and old stream, queues new work before body reads, then rotates identity", async () => {
	const f = await fixture();
	const old = await fetch(`${f.base}/hold`);
	const oldBody = old.text().catch(() => "aborted");
	const drain = f.guard.recycle.begin(1);
	expect(
		(await (await fetch(`${f.base}/_guard/health`)).json()).lifecycle.state,
	).toBe("draining");
	const queued = fetch(`${f.base}/v1/messages`, {
		method: "POST",
		body: "fixture",
	});
	await until(() => f.guard.state.lifecycle.waiting === 1);
	expect(f.guard.state.bodyReaders.active).toBe(1);
	expect(f.calls).toEqual(["/hold"]);
	f.release();
	expect(await oldBody).toBe("firstlast");
	expect((await drain).outcome).toBe("natural");
	expect(f.guard.state.lifecycle.state).toBe("absent");
	expect(
		(
			await f.guard.recycle.attach({
				generation: 2,
				...identity,
				correlationSecret: secret,
			})
		).ok,
	).toBe(true);
	expect(await (await queued).text()).toBe("done");
	expect(f.guard.state.lifecycle.generation).toBe(2);
	expect(
		(await (await fetch(`${f.base}/_guard/health`)).json()).runtime.process
			.upstreamPid,
	).toBe(process.pid);
});

test.each([
	["GET", "/", true],
	["GET", "/accounts", true],
	["GET", "/assets/index-abc123.js", true],
	["GET", "/api/accounts?include=routing", true],
	["HEAD", "/api/config/strategy", true],
	["GET", "/v1beta/models", true],
	["GET", "/v1", false],
	["GET", "/v1/models", false],
	["GET", "/api/logs/stream", false],
	["GET", "/api/insights/alerts/stream?token=t", false],
	["POST", "/api/accounts/a/pause", false],
	["DELETE", "/api/accounts/a", false],
	["POST", "/v1/messages", false],
])("%s %s is a drain-admissible dashboard read: %j", (method, url, expected) => {
	expect(isDrainAdmissibleRead({ method, url })).toBe(expected);
});

test("dashboard reads mid-drain reach the draining backend; inference, writes and streams wait", async () => {
	const f = await fixture({ maxQueue: 8 });
	const old = await fetch(`${f.base}/hold`);
	const oldBody = old.text().catch(() => "aborted");
	const drain = f.guard.recycle.begin(1);
	expect(f.guard.state.lifecycle.state).toBe("draining");

	const read = await fetch(`${f.base}/api/accounts`);
	expect(read.status).toBe(200);
	expect(await read.text()).toBe("done");
	expect((await fetch(`${f.base}/api/config/strategy`, { method: "HEAD" })).status).toBe(200);

	const inference = fetch(`${f.base}/v1/messages`, {
		method: "POST",
		body: "fixture",
	});
	const write = fetch(`${f.base}/api/accounts/a/pause`, {
		method: "POST",
		body: "{}",
	});
	const stream = fetch(`${f.base}/api/logs/stream`);
	await until(() => f.guard.state.lifecycle.waiting === 3);
	expect(f.calls).toEqual(["/hold", "/api/accounts", "/api/config/strategy"]);

	f.release();
	expect(await oldBody).toBe("firstlast");
	expect((await drain).outcome).toBe("natural");

	// Between the drain and the replacement there is no backend to answer.
	const afterDrain = fetch(`${f.base}/api/accounts`);
	await until(() => f.guard.state.lifecycle.waiting === 4);
	expect(f.calls).toHaveLength(3);

	await f.guard.recycle.attach({
		generation: 2,
		...identity,
		correlationSecret: secret,
	});
	for (const pending of [inference, write, stream, afterDrain]) {
		expect((await pending).status).toBe(200);
	}
	expect(f.calls.slice(3).sort()).toEqual(
		["/api/accounts", "/api/accounts/a/pause", "/api/logs/stream", "/v1/messages"].sort(),
	);
});

test("handoff waiters are bounded, cancel without dispatch and retain the original deadline", async () => {
	const f = await fixture({ maxQueue: 1, totalDeadlineMs: 120 });
	await f.guard.recycle.begin(1);
	const abort = new AbortController();
	const waiting = fetch(`${f.base}/v1/messages`, {
		method: "POST",
		body: "fixture",
		signal: abort.signal,
	}).catch(() => null);
	await until(() => f.guard.state.lifecycle.waiting === 1);
	expect(
		(await fetch(`${f.base}/v1/messages`, { method: "POST", body: "fixture" }))
			.status,
	).toBe(503);
	abort.abort();
	await waiting;
	await until(() => f.guard.state.lifecycle.waiting === 0);
	const expired = await fetch(`${f.base}/v1/messages`, {
		method: "POST",
		body: "fixture",
	});
	expect(expired.status).toBe(504);
	expect((await expired.json()).error.type).toBe("guard_deadline_exceeded");
	expect(f.calls).toHaveLength(0);
	expect(f.guard.state.lifecycle.waiting).toBe(0);
});

test("forced drain aborts only dispatched streams and never replays them", async () => {
	const f = await fixture({ shutdownGraceMs: 40 });
	const stream = await fetch(`${f.base}/hold`);
	const body = stream.text().catch(() => "aborted");
	const drain = await f.guard.recycle.begin(1);
	expect(drain.outcome).toBe("forced");
	expect(await body).toBe("aborted");
	expect(
		(
			await f.guard.recycle.attach({
				generation: 2,
				...identity,
				correlationSecret: secret,
			})
		).ok,
	).toBe(true);
	expect(f.calls).toEqual(["/hold"]);
});

test("stale generation and failed verification cannot resume admission", async () => {
	const f = await fixture({
		verifyReplacement: async () => {
			throw new Error("mismatch");
		},
	});
	expect((await f.guard.recycle.begin(0)).ok).toBe(false);
	await f.guard.recycle.begin(1);
	expect(
		(
			await f.guard.recycle.attach({
				generation: 1,
				...identity,
				correlationSecret: secret,
			})
		).ok,
	).toBe(false);
	expect(
		(
			await f.guard.recycle.attach({
				generation: 2,
				...identity,
				correlationSecret: secret,
			})
		).ok,
	).toBe(false);
	expect(f.guard.state.lifecycle.state).toBe("absent");
	expect(f.calls).toHaveLength(0);
});

test("terminal shutdown fences an in-flight replacement verification", async () => {
	let verified: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		verified = resolve;
	});
	const f = await fixture({
		verifyReplacement: async () => {
			await gate;
			return identity;
		},
	});
	await f.guard.recycle.begin(1);
	const attach = f.guard.recycle.attach({
		generation: 2,
		...identity,
		correlationSecret: secret,
	});
	await f.guard.shutdown("SIGTERM");
	verified!();
	expect((await attach).ok).toBe(false);
	expect(f.guard.state.lifecycle.state).toBe("shutdown");
});

test("private control authenticates commands and generation without exposing credentials", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-control-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "control.sock");
	const f = await fixture({ controlSocketPath: path, controlSecret: secret });
	async function control(value: unknown) {
		return new Promise<any>((resolve, reject) => {
			const s = net.createConnection(path);
			let out = "";
			s.on("error", reject);
			s.on("connect", () => s.write(JSON.stringify(value) + "\n"));
			s.on("data", (c) => (out += c));
			s.on("end", () => resolve(JSON.parse(out)));
		});
	}
	expect((await control(null)).ok).toBe(false);
	expect((await control([])).ok).toBe(false);
	expect(
		(await control({ command: "begin", generation: 1, secret: "bad" })).ok,
	).toBe(false);
	expect(f.guard.state.lifecycle.state).toBe("serving");
	expect((await control({ command: "begin", generation: 0, secret })).ok).toBe(
		false,
	);
	expect((await control({ command: "begin", generation: 1, secret })).ok).toBe(
		true,
	);
	expect(
		JSON.stringify(await (await fetch(`${f.base}/_guard/health`)).json()),
	).not.toContain(secret);
});

test("private control fences and retires a generation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-control-fence-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "control.sock");
	const f = await fixture({ controlSocketPath: path, controlSecret: secret });
	async function control(value: unknown) {
		return new Promise<any>((resolve, reject) => {
			const s = net.createConnection(path);
			let out = "";
			s.on("error", reject);
			s.on("connect", () => s.write(JSON.stringify(value) + "\n"));
			s.on("data", (c) => (out += c));
			s.on("end", () => resolve(JSON.parse(out)));
		});
	}
	expect(
		(await control({ command: "fence", generation: 1, secret: "bad" })).ok,
	).toBe(false);
	expect(await control({ command: "fence", generation: 1, secret })).toEqual({
		ok: true,
		generation: 1,
	});
	expect(await control({ command: "retire", generation: 1, secret })).toEqual({
		ok: true,
		generation: 1,
		outcome: "natural",
	});
	const health = await (await fetch(`${f.base}/_guard/health`)).json();
	expect(health.lifecycle.state).toBe("fenced");
	expect(health.lifecycle.lastRetireOutcome).toEqual({
		generation: 1,
		outcome: "natural",
	});
});

test("preexisting concurrency queue stays fenced until replacement without reading its body", async () => {
	const f = await fixture({ maxActive: 1 });
	const old = await fetch(`${f.base}/v1/messages?hold`, {
		method: "POST",
		body: "old",
	});
	const oldBody = old.text();
	const queued = fetch(`${f.base}/v1/messages`, {
		method: "POST",
		body: "next",
	});
	await until(() => f.guard.state.queued === 1);
	const drain = f.guard.recycle.begin(1);
	expect((await fetch(`${f.base}/health`)).status).toBe(503);
	f.release();
	await oldBody;
	await drain;
	expect(f.calls).toHaveLength(1);
	expect(f.guard.state.bodyReaders.active).toBe(0);
	await f.guard.recycle.attach({
		generation: 2,
		...identity,
		correlationSecret: secret,
	});
	expect((await queued).status).toBe(200);
	expect(f.calls).toHaveLength(2);
});

test("native Node body receipt timeout cannot preempt the finite paused-upload deadline", async () => {
	const source = new URL("../ccflare-guard.mjs", import.meta.url).href;
	const script = `
 import http from 'node:http';
 const original = http.createServer;
 http.createServer = (options, handler) => typeof options === 'function'
  ? original({requestTimeout:80,headersTimeout:80,connectionsCheckingInterval:5},options)
  : original({requestTimeout:80,headersTimeout:80,connectionsCheckingInterval:5,...options},handler);
 const {createGuard}=await import(${JSON.stringify(source)});
 const guard=createGuard({listenPort:0,lifecycleEnabled:true,totalDeadlineMs:350,retryAttemptHeadroomMs:1,maxRecoverySleepMs:20,requestDrainTimeoutMs:1000,shutdownGraceMs:30,logger:()=>{}});
 const address=await guard.listen(); await guard.recycle.begin(1);
 console.log(JSON.stringify({port:address.port,headerTimeout:guard.server.headersTimeout}));
 process.on('SIGTERM',()=>guard.shutdown('SIGTERM',{exitProcess:true}));
 `;
	const child = spawn(
		resolveNodeExecutable(),
		["--input-type=module", "--eval", script],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	const ended = new Promise<void>((resolve) =>
		child.once("exit", () => resolve()),
	);
	cleanups.push(async () => {
		child.kill("SIGTERM");
		await ended;
	});
	const ready = await new Promise<{ port: number; headerTimeout: number }>(
		(resolve, reject) => {
			child.once("error", reject);
			child.stderr.on("data", (d) => reject(new Error(String(d))));
			createInterface({ input: child.stdout }).once("line", (line) =>
				resolve(JSON.parse(line)),
			);
		},
	);
	expect(ready.headerTimeout).toBeGreaterThan(0);
	const started = Date.now();
	const response = await new Promise<string>((resolve, reject) => {
		const socket = net.createConnection({
			host: "127.0.0.1",
			port: ready.port,
		});
		let output = "";
		socket.on("error", reject);
		socket.on("data", (chunk) => (output += chunk));
		socket.on("end", () => resolve(output));
		socket.on("connect", () =>
			socket.write(
				"POST /v1/messages HTTP/1.1\r\nHost: localhost\r\nContent-Length: 32768\r\nConnection: close\r\n\r\nx",
			),
		);
	});
	expect(response).toContain("HTTP/1.1 504");
	expect(response).toContain("guard_deadline_exceeded");
	expect(Date.now() - started).toBeGreaterThanOrEqual(300);
	expect(Date.now() - started).toBeLessThan(1000);
	const healthStarted = Date.now();
	const health = await new Promise<string>((resolve, reject) => {
		const socket = net.createConnection({
			host: "127.0.0.1",
			port: ready.port,
		});
		let output = "";
		socket.on("error", reject);
		socket.on("data", (chunk) => (output += chunk));
		socket.on("close", () => resolve(output));
		socket.on("connect", () =>
			socket.write(
				"POST /_guard/health HTTP/1.1\r\nHost: localhost\r\nContent-Length: 32768\r\nConnection: keep-alive\r\n\r\nx",
			),
		);
	});
	expect(health).toContain("HTTP/1.1 200");
	expect(Date.now() - healthStarted).toBeGreaterThanOrEqual(900);
	expect(Date.now() - healthStarted).toBeLessThan(1800);
}, 5000);

test("terminal shutdown never releases a preexisting queue onto an unverified replacement", async () => {
	const f = await fixture({ maxActive: 1 });
	const old = await fetch(`${f.base}/v1/messages?hold`, {
		method: "POST",
		body: "old",
	});
	const oldBody = old.text();
	const pending = fetch(`${f.base}/v1/messages`, {
		method: "POST",
		body: "pending",
	});
	await until(() => f.guard.state.queued === 1);
	const drain = f.guard.recycle.begin(1);
	f.release();
	await oldBody;
	await drain;
	// The mock remains reachable on the same port, just like a candidate which
	// has started listening but has not passed attach identity verification.
	await f.guard.shutdown("SIGTERM");
	expect((await pending).status).toBe(503);
	expect(f.calls).toHaveLength(1);
	expect(f.guard.state.lifecycle.generation).toBe(1);
});

test("replacement signer uses the new backend credential before releasing waiters", async () => {
	const f = await fixture();
	await f.guard.recycle.begin(1);
	const pending = fetch(`${f.base}/v1/messages`, {
		method: "POST",
		body: "fixture",
	});
	await until(() => f.guard.state.lifecycle.waiting === 1);
	const nextSecret = Buffer.alloc(32, 2).toString("base64url");
	await f.guard.recycle.attach({
		generation: 2,
		...identity,
		correlationSecret: nextSecret,
	});
	expect((await pending).status).toBe(200);
	const [version, id, ordinal, signature] = f.signatures[0].split(".");
	expect(version).toBe("v1");
	const expected = createHmac("sha256", Buffer.from(nextSecret, "base64url"))
		.update(`better-ccflare/guard-correlation/v1\n${id}\n${ordinal}`)
		.digest("base64url");
	expect(signature).toBe(expected);
});

test("trickled unauthenticated control input cannot pin all command slots", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-control-deadline-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "control.sock");
	const f = await fixture({ controlSocketPath: path, controlSecret: secret });
	const sockets = Array.from({ length: 4 }, () => net.createConnection(path));
	let closed = 0;
	for (const socket of sockets) {
		socket.on("error", () => {});
		socket.on("close", () => closed++);
	}
	const trickle = setInterval(() => {
		for (const socket of sockets) if (!socket.destroyed) socket.write(" ");
	}, 100);
	try {
		await Bun.sleep(2250);
		expect(closed).toBe(4);
		const result = await new Promise<{ ok: boolean }>((resolve, reject) => {
			const socket = net.createConnection(path);
			let out = "";
			socket.on("error", reject);
			socket.on("data", (c) => (out += c));
			socket.on("end", () => resolve(JSON.parse(out)));
			socket.on("connect", () =>
				socket.write(
					JSON.stringify({ command: "begin", generation: 1, secret }) + "\n",
				),
			);
		});
		expect(result.ok).toBe(true);
		expect(f.guard.state.lifecycle.state).toBe("absent");
	} finally {
		clearInterval(trickle);
		for (const socket of sockets) socket.destroy();
	}
}, 5000);

test("native fixture runtime resolution rejects Bun instead of silently weakening coverage", () => {
	expect(() =>
		resolveNodeExecutable({ ...process.env, GUARD_NODE_BIN: process.execPath }),
	).toThrow("require Node");
});

test("productive response chunks cannot renew the new accepted-work ceiling", async () => {
	const f = await fixture({
		acceptedCapMs: 120,
		responseIdleTimeoutMs: 1000,
		totalDeadlineMs: 700,
	});
	const response = await fetch(`${f.base}/hold`, {
		headers: {
			"x-better-ccflare-managed-timing": "forged",
			"x-better-ccflare-timeout-ms": "1800000",
		},
	});
	const outcome = response.text().catch(() => "accepted-cutoff");
	const timer = setInterval(() => f.chunk(), 10);
	try {
		expect(await outcome).toBe("accepted-cutoff");
		expect(f.guard.state.counters.acceptedDeadlineExceeded).toBe(1);
		expect(f.calls).toEqual(["/hold"]);
	} finally {
		clearInterval(timer);
	}
});
