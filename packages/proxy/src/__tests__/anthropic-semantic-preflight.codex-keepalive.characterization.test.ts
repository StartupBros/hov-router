import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import {
	AnthropicPreCommitStallError,
	AnthropicPreCommitTransientError,
	gateAnthropicSsePreCommit,
	isProtocolIdleExemptProvider,
	isTranslatedSseProvider,
} from "../anthropic-semantic-preflight";

// CHARACTERIZATION test: pins what the pre-commit gate does when an upstream
// sends message_start and then only 25 s ping frames. Codex heartbeats refresh
// protocol idle while translated-stream pings do not (#639); CONCEPTS.md
// "Synthesized keepalive" records why that layering is kept. Time is faked
// with bun's jest.useFakeTimers (Date.now and setTimeout), advanced 1 s at a
// time.

const encoder = new TextEncoder();
const messageStart =
	'event: message_start\ndata: {"type":"message_start","message":{"content":[]},"usage":{"output_tokens":1}}\n\n';
const ping = 'event: ping\ndata: {"type":"ping"}\n\n';
// Shape written by the codex provider for upstream_stream_timeout
// (packages/providers/src/providers/codex/provider.ts:5469-5490, via
// closeOpenBlockAndWriteError -> writeSSE("error", { type, error:{type:"api_error",message} })).
const codexUpstreamStreamTimeoutError =
	'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Codex upstream timed out while waiting for response data."}}\n\n';

const PING_EVERY_MS = 25_000;
const SEMANTIC_TIMEOUT_MS = 120_000; // code default
const HORIZON_MS = 200_000;
// Production overrides the idle clock in
// /etc/systemd/system/ccflare-stack.service.d/60-precommit-timeout.conf, and a
// Claude Code request carries a request-wide 14-minute commitment boundary
// (CLAUDE_CODE_PRECOMMIT_RESCUE_COMMITMENT_DEADLINE_MS).
const PROD_SEMANTIC_TIMEOUT_MS = 420_000;
const PROD_COMMITMENT_MS = 14 * 60 * 1000;
const PROD_HORIZON_MS = 900_000;

interface GateTiming {
	semanticTimeoutMs: number;
	commitmentMs?: number;
}

type Outcome =
	| { kind: "pending" }
	| { kind: "committed" }
	| { kind: "rejected"; error: unknown };

interface Run {
	outcome: () => Outcome;
	/** Fake ms elapsed since start when the gate settled, or null. */
	settledAtMs: () => number | null;
	/** Advance fake time up to totalMs, enqueueing a ping every 25 s. */
	advanceTo: (totalMs: number, pingsUntilMs: number) => Promise<void>;
	enqueue: (text: string) => void;
}

async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

function startRun(
	provider: string,
	timing: GateTiming = { semanticTimeoutMs: SEMANTIC_TIMEOUT_MS },
): Run {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	const enqueue = (text: string) => controller.enqueue(encoder.encode(text));
	enqueue(messageStart);

	const t0 = Date.now();
	let outcome: Outcome = { kind: "pending" };
	let settledAt: number | null = null;
	let elapsed = 0;

	// Options exactly as proxy-operations.ts:7812-7820 derives them from the
	// provider name (no hasIrreversibleCodexWebSocketWrite here: HTTP/SSE path).
	gateAnthropicSsePreCommit(stream, {
		semanticTimeoutMs: timing.semanticTimeoutMs,
		...(timing.commitmentMs === undefined
			? {}
			: { commitmentDeadlineAt: t0 + timing.commitmentMs }),
		disableProtocolIdleTimeout: isProtocolIdleExemptProvider(provider),
		keepaliveIsProtocolActivity: !isTranslatedSseProvider(provider),
	}).then(
		() => {
			outcome = { kind: "committed" };
			settledAt = Date.now() - t0;
		},
		(error: unknown) => {
			outcome = { kind: "rejected", error };
			settledAt = Date.now() - t0;
		},
	);

	return {
		outcome: () => outcome,
		settledAtMs: () => settledAt,
		enqueue,
		async advanceTo(totalMs, pingsUntilMs) {
			await flush();
			while (elapsed < totalMs && outcome.kind === "pending") {
				elapsed += 1000;
				if (elapsed <= pingsUntilMs && elapsed % PING_EVERY_MS === 0) {
					enqueue(ping);
				}
				jest.advanceTimersByTime(1000);
				await flush();
			}
		},
	};
}

describe("anthropic pre-commit gate: codex keepalive characterization", () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});
	afterEach(() => {
		jest.useRealTimers();
	});

	it("provider flags as proxy-operations computes them", () => {
		expect(isTranslatedSseProvider("codex")).toBe(false); // keepalive counts
		expect(isTranslatedSseProvider("xai")).toBe(true); // keepalive ignored
		expect(isProtocolIdleExemptProvider("codex")).toBe(false);
		expect(isProtocolIdleExemptProvider("xai")).toBe(false);
	});

	it("case 1: codex, message_start then pings every 25 s: protocol-idle (semantic_timeout) never fires; only the 150 s commitment deadline ends it", async () => {
		const run = startRun("codex");
		await run.advanceTo(119_000, HORIZON_MS);
		expect(run.outcome().kind).toBe("pending");
		await run.advanceTo(121_000, HORIZON_MS);
		// Not failed at 120 s: each ping pushed the idle deadline out.
		expect(run.outcome().kind).toBe("pending");
		await run.advanceTo(HORIZON_MS, HORIZON_MS);

		const outcome = run.outcome();
		expect(outcome.kind).toBe("rejected");
		const error = (outcome as { error: unknown }).error;
		expect(error).toBeInstanceOf(AnthropicPreCommitStallError);
		const stall = error as AnthropicPreCommitStallError;
		// The standalone default commitment cap is 180 s - 30 s = 150 s. Routed
		// requests pass a request-wide commitmentDeadlineAt instead.
		expect(stall.reason).toBe("meaningful_progress_timeout");
		expect(run.settledAtMs()).toBe(150_000);
		// message_start + pings at 25..125 s counted as protocol activity. The
		// ping enqueued at exactly 150 s loses the race to the deadline timer.
		expect(stall.validProtocolFramesSeen).toBe(1 + 5);
		expect(stall.frameKindCounts.meaningful).toBe(0);
	});

	it("case 1b: codex, pings stop after 25 s: semantic_timeout fires 120 s after the last ping (145 s), i.e. the idle clock is refreshed by pings", async () => {
		const run = startRun("codex");
		await run.advanceTo(HORIZON_MS, 25_000);
		const outcome = run.outcome();
		expect(outcome.kind).toBe("rejected");
		const stall = (outcome as { error: AnthropicPreCommitStallError }).error;
		expect(stall.reason).toBe("semantic_timeout");
		expect(run.settledAtMs()).toBe(145_000);
	});

	it("case 2: xai (translated), message_start then pings every 25 s: pings are ignored, semantic_timeout fires at 120 s", async () => {
		const run = startRun("xai");
		await run.advanceTo(119_000, HORIZON_MS);
		expect(run.outcome().kind).toBe("pending");
		await run.advanceTo(HORIZON_MS, HORIZON_MS);

		const outcome = run.outcome();
		expect(outcome.kind).toBe("rejected");
		const stall = (outcome as { error: AnthropicPreCommitStallError }).error;
		expect(stall).toBeInstanceOf(AnthropicPreCommitStallError);
		expect(stall.reason).toBe("semantic_timeout");
		expect(run.settledAtMs()).toBe(120_000);
		// Only message_start counted as protocol activity; pings were seen but not credited.
		expect(stall.validProtocolFramesSeen).toBe(1);
		expect(stall.frameKindCounts.keepalive).toBe(4);
	});

	it("case 3: codex, after pings, an api_error SSE event (upstream_stream_timeout shape) is a retryable pre-commit failure, not committed", async () => {
		const run = startRun("codex");
		await run.advanceTo(50_000, HORIZON_MS); // pings at 25 s and 50 s
		expect(run.outcome().kind).toBe("pending");

		run.enqueue(codexUpstreamStreamTimeoutError);
		await flush();

		const outcome = run.outcome();
		expect(outcome.kind).toBe("rejected");
		const error = (outcome as { error: unknown }).error;
		expect(error).toBeInstanceOf(AnthropicPreCommitTransientError);
		const transient = error as AnthropicPreCommitTransientError;
		expect(transient.reason).toBe("transient_sse_error");
		expect(transient.errorType).toBe("api_error");
		expect(transient.frameKindCounts.error).toBe(1);
		expect(transient.frameKindCounts.meaningful).toBe(0);
	});
});

describe("anthropic pre-commit gate: codex keepalive at production timing (idle 420 s, commitment 840 s)", () => {
	const prod: GateTiming = {
		semanticTimeoutMs: PROD_SEMANTIC_TIMEOUT_MS,
		commitmentMs: PROD_COMMITMENT_MS,
	};

	beforeEach(() => {
		jest.useFakeTimers();
	});
	afterEach(() => {
		jest.useRealTimers();
	});

	it("codex with pings every 25 s is held to the 840 s commitment boundary", async () => {
		const run = startRun("codex", prod);
		await run.advanceTo(PROD_HORIZON_MS, PROD_HORIZON_MS);
		const stall = (run.outcome() as { error: AnthropicPreCommitStallError })
			.error;
		expect(stall).toBeInstanceOf(AnthropicPreCommitStallError);
		expect(stall.reason).toBe("meaningful_progress_timeout");
		expect(run.settledAtMs()).toBe(PROD_COMMITMENT_MS);
	});

	it("codex whose pings stop after 25 s fails protocol-idle at 445 s", async () => {
		const run = startRun("codex", prod);
		await run.advanceTo(PROD_HORIZON_MS, 25_000);
		const stall = (run.outcome() as { error: AnthropicPreCommitStallError })
			.error;
		expect(stall.reason).toBe("semantic_timeout");
		expect(run.settledAtMs()).toBe(25_000 + PROD_SEMANTIC_TIMEOUT_MS);
	});

	it("xai with pings every 25 s fails protocol-idle at 420 s", async () => {
		const run = startRun("xai", prod);
		await run.advanceTo(PROD_HORIZON_MS, PROD_HORIZON_MS);
		const stall = (run.outcome() as { error: AnthropicPreCommitStallError })
			.error;
		expect(stall.reason).toBe("semantic_timeout");
		expect(run.settledAtMs()).toBe(PROD_SEMANTIC_TIMEOUT_MS);
	});
});
