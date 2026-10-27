import { describe, expect, it } from "bun:test";
import {
	DEFAULT_KEEPALIVE_INTERVAL_MS,
	DEFAULT_KEEPALIVE_MAX_UPSTREAM_SILENCE_MS,
	type KeepaliveScheduler,
	transformStreamingResponse,
} from "../stream";

// A long tool call is buffered until [DONE], so nothing reaches the client
// while the model writes it. These tests pin the keepalive ping that bridges
// that silence (#633).

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PING_FRAME = 'event: ping\ndata: {"type":"ping"}\n\n';

interface ManualScheduler extends KeepaliveScheduler {
	advance(ms: number): void;
	activeTimers(): number;
}

/** Deterministic clock: timers fire only when the test advances time. */
function manualScheduler(): ManualScheduler {
	let clock = 0;
	let nextId = 1;
	const timers = new Map<
		number,
		{ callback: () => void; intervalMs: number; dueAt: number }
	>();
	return {
		now: () => clock,
		setInterval(callback, intervalMs) {
			const id = nextId++;
			timers.set(id, { callback, intervalMs, dueAt: clock + intervalMs });
			return id;
		},
		clearInterval(handle) {
			timers.delete(handle as number);
		},
		advance(ms) {
			const target = clock + ms;
			while (true) {
				let due:
					| { callback: () => void; intervalMs: number; dueAt: number }
					| undefined;
				for (const timer of timers.values()) {
					if (timer.dueAt <= target && (!due || timer.dueAt < due.dueAt)) {
						due = timer;
					}
				}
				if (!due) break;
				clock = due.dueAt;
				due.dueAt += due.intervalMs;
				due.callback();
			}
			clock = target;
		},
		activeTimers: () => timers.size,
	};
}

/** An upstream SSE body the test feeds one chunk at a time. */
function controllableUpstream() {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	return {
		response: new Response(body, {
			headers: { "content-type": "text/event-stream" },
		}),
		send(payload: unknown) {
			const data =
				typeof payload === "string" ? payload : JSON.stringify(payload);
			controller.enqueue(encoder.encode(`data: ${data}\n\n`));
		},
		close() {
			controller.close();
		},
	};
}

function collect(body: ReadableStream<Uint8Array> | null) {
	if (!body) throw new Error("expected response body, got null");
	const reader = body.getReader();
	let text = "";
	const finished = (async () => {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			text += decoder.decode(value, { stream: true });
		}
	})();
	return { text: () => text, finished, reader };
}

/** Let the pipe move queued chunks through the transform and the reader. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function countPings(text: string): number {
	return text.split(PING_FRAME).length - 1;
}

function textChunk(content: string) {
	return {
		id: "c1",
		model: "deepseek-v4.1-flash",
		choices: [{ index: 0, delta: { content }, finish_reason: null }],
	};
}

function toolCallStartChunk() {
	return {
		id: "c1",
		model: "deepseek-v4.1-flash",
		choices: [
			{
				index: 0,
				delta: {
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							type: "function",
							function: { name: "Write", arguments: "" },
						},
					],
				},
				finish_reason: null,
			},
		],
	};
}

function toolArgsChunk(args: string) {
	return {
		id: "c1",
		model: "deepseek-v4.1-flash",
		choices: [
			{
				index: 0,
				delta: { tool_calls: [{ index: 0, function: { arguments: args } }] },
				finish_reason: null,
			},
		],
	};
}

/** Text, then a tool call whose arguments the translator holds until [DONE]. */
async function startToolCallStream(scheduler: ManualScheduler) {
	const upstream = controllableUpstream();
	const transformed = transformStreamingResponse(upstream.response, {
		keepaliveScheduler: scheduler,
	});
	const downstream = collect(transformed.body);
	upstream.send(textChunk("I'll write the file now."));
	upstream.send(toolCallStartChunk());
	await settle();
	return { upstream, downstream };
}

describe("transformStreamingResponse — keepalive ping", () => {
	it("defaults to a 25 s interval and a 15 min upstream-silence bound", () => {
		expect(DEFAULT_KEEPALIVE_INTERVAL_MS).toBe(25_000);
		expect(DEFAULT_KEEPALIVE_MAX_UPSTREAM_SILENCE_MS).toBe(15 * 60_000);
	});

	it("pings each interval while a buffered tool call keeps the client silent", async () => {
		const scheduler = manualScheduler();
		const { upstream, downstream } = await startToolCallStream(scheduler);
		// The message_start ping is the only one so far.
		expect(countPings(downstream.text())).toBe(1);

		scheduler.advance(DEFAULT_KEEPALIVE_INTERVAL_MS);
		await settle();
		expect(countPings(downstream.text())).toBe(2);

		// Argument chunks reach the translator but are buffered, so the client
		// still hears nothing and the pings continue.
		upstream.send(toolArgsChunk('{"file_path":"/tmp/a.ts",'));
		await settle();
		scheduler.advance(DEFAULT_KEEPALIVE_INTERVAL_MS);
		await settle();
		upstream.send(toolArgsChunk('"content":"x"}'));
		await settle();
		scheduler.advance(DEFAULT_KEEPALIVE_INTERVAL_MS);
		await settle();
		expect(countPings(downstream.text())).toBe(4);

		// [DONE] ends the timer even if the upstream holds the connection open.
		upstream.send("[DONE]");
		await settle();
		expect(scheduler.activeTimers()).toBe(0);
		upstream.close();
		await downstream.finished;
		const text = downstream.text();
		expect(text).toContain("event: message_stop");
		expect(text).toContain(
			'"partial_json":"{\\"file_path\\":\\"/tmp/a.ts\\",\\"content\\":\\"x\\"}"',
		);
		// No ping trails the terminal event.
		expect(text.endsWith(PING_FRAME)).toBe(false);
		expect(scheduler.activeTimers()).toBe(0);
	});

	it("sends no ping while the client is still receiving output", async () => {
		const scheduler = manualScheduler();
		const upstream = controllableUpstream();
		const transformed = transformStreamingResponse(upstream.response, {
			keepaliveScheduler: scheduler,
		});
		const downstream = collect(transformed.body);
		upstream.send(textChunk("one"));
		await settle();
		for (let i = 0; i < 6; i++) {
			scheduler.advance(DEFAULT_KEEPALIVE_INTERVAL_MS - 5_000);
			upstream.send(textChunk(` ${i}`));
			await settle();
		}
		expect(countPings(downstream.text())).toBe(1);
		upstream.send("[DONE]");
		upstream.close();
		await downstream.finished;
	});

	it("sends nothing before message_start", async () => {
		const scheduler = manualScheduler();
		const upstream = controllableUpstream();
		const transformed = transformStreamingResponse(upstream.response, {
			keepaliveScheduler: scheduler,
		});
		const downstream = collect(transformed.body);
		scheduler.advance(DEFAULT_KEEPALIVE_INTERVAL_MS * 4);
		await settle();
		expect(downstream.text()).toBe("");

		upstream.send(textChunk("hello"));
		await settle();
		expect(downstream.text().startsWith("event: message_start\n")).toBe(true);
		upstream.send("[DONE]");
		upstream.close();
		await downstream.finished;
	});

	it("stops pinging once the upstream has been silent past the bound", async () => {
		const scheduler = manualScheduler();
		const { upstream, downstream } = await startToolCallStream(scheduler);

		scheduler.advance(DEFAULT_KEEPALIVE_MAX_UPSTREAM_SILENCE_MS);
		await settle();
		const pingsWithinBound = countPings(downstream.text());
		expect(pingsWithinBound).toBe(
			1 +
				DEFAULT_KEEPALIVE_MAX_UPSTREAM_SILENCE_MS /
					DEFAULT_KEEPALIVE_INTERVAL_MS,
		);

		// A hung upstream must still trip the guard's idle watchdog.
		scheduler.advance(DEFAULT_KEEPALIVE_INTERVAL_MS * 20);
		await settle();
		expect(countPings(downstream.text())).toBe(pingsWithinBound);

		upstream.close();
		await downstream.finished;
		expect(scheduler.activeTimers()).toBe(0);
	});

	it("measures the bound from the last upstream chunk, not from the stream start", async () => {
		const scheduler = manualScheduler();
		const { upstream, downstream } = await startToolCallStream(scheduler);

		scheduler.advance(DEFAULT_KEEPALIVE_MAX_UPSTREAM_SILENCE_MS - 60_000);
		upstream.send(toolArgsChunk('{"a":'));
		await settle();
		const before = countPings(downstream.text());

		scheduler.advance(DEFAULT_KEEPALIVE_MAX_UPSTREAM_SILENCE_MS - 60_000);
		await settle();
		expect(countPings(downstream.text())).toBeGreaterThan(before + 30);

		upstream.send(toolArgsChunk("1}"));
		upstream.send("[DONE]");
		upstream.close();
		await downstream.finished;
		expect(downstream.text()).toContain("event: message_stop");
	});

	it("clears the timer when the client cancels the stream", async () => {
		const scheduler = manualScheduler();
		const { downstream } = await startToolCallStream(scheduler);
		expect(scheduler.activeTimers()).toBe(1);

		await downstream.reader.cancel("client disconnected");
		await settle();
		expect(scheduler.activeTimers()).toBe(0);
		expect(() =>
			scheduler.advance(DEFAULT_KEEPALIVE_INTERVAL_MS * 4),
		).not.toThrow();
	});

	it("clears the timer when the upstream closes without [DONE]", async () => {
		const scheduler = manualScheduler();
		const { upstream, downstream } = await startToolCallStream(scheduler);

		upstream.close();
		await downstream.finished;
		expect(downstream.text()).toContain("event: message_stop");
		expect(scheduler.activeTimers()).toBe(0);
	});

	it("sends no ping after a provider error frame", async () => {
		const scheduler = manualScheduler();
		const { upstream, downstream } = await startToolCallStream(scheduler);

		upstream.send({ error: { type: "api_error", message: "model crashed" } });
		await settle();
		expect(downstream.text()).toContain("event: error");
		expect(scheduler.activeTimers()).toBe(0);
		const afterError = downstream.text();

		scheduler.advance(DEFAULT_KEEPALIVE_INTERVAL_MS * 4);
		await settle();
		expect(downstream.text()).toBe(afterError);

		upstream.close();
		await downstream.finished;
	});

	it("pings on the real clock when no scheduler is injected", async () => {
		const upstream = controllableUpstream();
		const transformed = transformStreamingResponse(upstream.response, {
			keepaliveIntervalMs: 20,
		});
		const downstream = collect(transformed.body);
		upstream.send(toolCallStartChunk());
		await Bun.sleep(90);
		expect(countPings(downstream.text())).toBeGreaterThanOrEqual(2);

		upstream.send("[DONE]");
		upstream.close();
		await downstream.finished;
		const afterDone = downstream.text();
		await Bun.sleep(60);
		expect(downstream.text()).toBe(afterDone);
		expect(afterDone).toContain("event: message_stop");
	});

	it("does not arm a timer when the interval is not positive", async () => {
		const scheduler = manualScheduler();
		const upstream = controllableUpstream();
		const transformed = transformStreamingResponse(upstream.response, {
			keepaliveScheduler: scheduler,
			keepaliveIntervalMs: 0,
		});
		const downstream = collect(transformed.body);
		upstream.send(toolCallStartChunk());
		await settle();
		expect(scheduler.activeTimers()).toBe(0);
		upstream.send("[DONE]");
		upstream.close();
		await downstream.finished;
	});
});
