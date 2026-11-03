import { describe, expect, test } from "bun:test";
import {
	UPSTREAM_UNREACHABLE_AFTER,
	UpstreamTransportTracker,
} from "../upstream-transport-health";

const WINDOW_MS = 5 * 60_000;

function trackerAt(start = 1_800_000_000_000) {
	let now = start;
	const tracker = new UpstreamTransportTracker({ now: () => now });
	return {
		tracker,
		advance(ms: number) {
			now += ms;
		},
	};
}

function connectionRefused(): Error {
	return Object.assign(
		new TypeError("Unable to connect. Is the computer able to access the url?"),
		{ code: "ConnectionRefused" },
	);
}

describe("UpstreamTransportTracker", () => {
	test("a fresh tracker reports no providers and nothing unreachable", () => {
		const { tracker } = trackerAt();
		expect(tracker.snapshot()).toEqual({
			windowMs: WINDOW_MS,
			unreachableAfter: UPSTREAM_UNREACHABLE_AFTER,
			unreachable: [],
			providers: {},
		});
	});

	test("any upstream answer marks the provider reachable", () => {
		const { tracker } = trackerAt();
		tracker.recordResponse("anthropic");
		tracker.recordResponse("anthropic");
		const provider = tracker.snapshot().providers.anthropic;
		expect(provider?.state).toBe("reachable");
		expect(provider?.responses).toBe(2);
		expect(provider?.failures).toBe(0);
		expect(provider?.consecutiveFailures).toBe(0);
		expect(provider?.lastResponseAt).toBe(
			new Date(1_800_000_000_000).toISOString(),
		);
		expect(provider?.lastFailureAt).toBeNull();
	});

	test("enough failures in a row with no answer marks the provider unreachable", () => {
		const { tracker, advance } = trackerAt();
		tracker.recordResponse("anthropic");
		advance(1_000);
		for (let i = 0; i < UPSTREAM_UNREACHABLE_AFTER; i++) {
			tracker.recordFailure("anthropic", connectionRefused());
		}
		const snapshot = tracker.snapshot();
		expect(snapshot.unreachable).toEqual(["anthropic"]);
		expect(snapshot.providers.anthropic).toMatchObject({
			state: "unreachable",
			responses: 1,
			failures: UPSTREAM_UNREACHABLE_AFTER,
			consecutiveFailures: UPSTREAM_UNREACHABLE_AFTER,
			lastFailureCode: "ConnectionRefused",
		});
	});

	test("one failure short of the threshold is not unreachable", () => {
		const { tracker } = trackerAt();
		for (let i = 0; i < UPSTREAM_UNREACHABLE_AFTER - 1; i++) {
			tracker.recordFailure("anthropic", connectionRefused());
		}
		const snapshot = tracker.snapshot();
		expect(snapshot.unreachable).toEqual([]);
		// Failures but no answer in the window: not proof either way.
		expect(snapshot.providers.anthropic?.state).toBe("unknown");
	});

	test("a single answer resets the failure streak", () => {
		const { tracker } = trackerAt();
		for (let i = 0; i < UPSTREAM_UNREACHABLE_AFTER + 3; i++) {
			tracker.recordFailure("anthropic", connectionRefused());
		}
		tracker.recordResponse("anthropic");
		const provider = tracker.snapshot().providers.anthropic;
		expect(provider?.state).toBe("reachable");
		expect(provider?.consecutiveFailures).toBe(0);
		expect(provider?.failures).toBe(UPSTREAM_UNREACHABLE_AFTER + 3);
	});

	test("providers are tracked independently (the 2026-11-02 shape)", () => {
		const { tracker } = trackerAt();
		for (let i = 0; i < 20; i++) {
			tracker.recordFailure("anthropic", connectionRefused());
			tracker.recordResponse("openai-compatible");
		}
		const snapshot = tracker.snapshot();
		expect(snapshot.unreachable).toEqual(["anthropic"]);
		expect(snapshot.providers["openai-compatible"]?.state).toBe("reachable");
		expect(snapshot.providers.anthropic?.consecutiveFailures).toBe(20);
	});

	test("old failures age out once traffic stops", () => {
		const { tracker, advance } = trackerAt();
		for (let i = 0; i < UPSTREAM_UNREACHABLE_AFTER; i++) {
			tracker.recordFailure("anthropic", connectionRefused());
		}
		expect(tracker.snapshot().unreachable).toEqual(["anthropic"]);
		advance(WINDOW_MS + 60_000);
		const snapshot = tracker.snapshot();
		expect(snapshot.unreachable).toEqual([]);
		expect(snapshot.providers.anthropic).toMatchObject({
			state: "unknown",
			responses: 0,
			failures: 0,
		});
		// Timestamps survive the window so a reader can still see when.
		expect(snapshot.providers.anthropic?.lastFailureAt).not.toBeNull();
	});

	test("window counts drop old buckets but keep recent ones", () => {
		const { tracker, advance } = trackerAt();
		tracker.recordResponse("anthropic");
		advance(WINDOW_MS - 30_000);
		tracker.recordResponse("anthropic");
		expect(tracker.snapshot().providers.anthropic?.responses).toBe(2);
		advance(90_000);
		expect(tracker.snapshot().providers.anthropic?.responses).toBe(1);
	});

	test("failure codes are short tokens, never error messages", () => {
		const { tracker } = trackerAt();
		tracker.recordFailure(
			"anthropic",
			Object.assign(new Error("secret https://internal.example/path?k=v"), {
				code: "has spaces and https://internal.example",
			}),
		);
		expect(tracker.snapshot().providers.anthropic?.lastFailureCode).toBe(
			"Error",
		);
		tracker.recordFailure("anthropic", "not an error object");
		expect(tracker.snapshot().providers.anthropic?.lastFailureCode).toBe(
			"unknown",
		);
		tracker.recordFailure(
			"anthropic",
			Object.assign(new TypeError("x"), {
				code: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
			}),
		);
		expect(tracker.snapshot().providers.anthropic?.lastFailureCode).toBe(
			"UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
		);
	});

	test("labels that are not plain provider names collapse to 'other'", () => {
		const { tracker } = trackerAt();
		tracker.recordResponse("http://100.64.0.1:4000/v1");
		tracker.recordResponse("Anthropic");
		const providers = Object.keys(tracker.snapshot().providers).sort();
		expect(providers).toEqual(["anthropic", "other"]);
	});

	test("the number of tracked labels is bounded", () => {
		const { tracker } = trackerAt();
		for (let i = 0; i < 100; i++) tracker.recordResponse(`provider-${i}`);
		const providers = Object.keys(tracker.snapshot().providers);
		expect(providers.length).toBeLessThanOrEqual(33);
		expect(providers).toContain("other");
	});

	test("reset forgets everything", () => {
		const { tracker } = trackerAt();
		tracker.recordFailure("anthropic", connectionRefused());
		tracker.reset();
		expect(tracker.snapshot().providers).toEqual({});
	});
});
