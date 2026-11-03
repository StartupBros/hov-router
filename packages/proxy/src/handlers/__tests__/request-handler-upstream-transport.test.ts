import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { upstreamTransportTracker } from "../../upstream-transport-health";
import { makeProxyRequest } from "../request-handler";

const originalFetch = globalThis.fetch;

function stubFetch(
	impl: (signal: AbortSignal | undefined) => Promise<Response>,
) {
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const signal = input instanceof Request ? input.signal : init?.signal;
		return impl(signal ?? undefined);
	}) as typeof fetch;
}

function connectionRefused(): Error {
	return Object.assign(
		new TypeError("Unable to connect. Is the computer able to access the url?"),
		{ code: "ConnectionRefused" },
	);
}

describe("makeProxyRequest upstream transport recording", () => {
	beforeEach(() => {
		upstreamTransportTracker.reset();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		upstreamTransportTracker.reset();
	});

	it("records an answer for the labelled provider, whatever its status", async () => {
		stubFetch(async () => new Response("overloaded", { status: 529 }));
		const response = await makeProxyRequest(
			new Request("https://api.anthropic.com/v1/messages", { method: "POST" }),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"anthropic",
		);
		expect(response.status).toBe(529);
		const provider = upstreamTransportTracker.snapshot().providers.anthropic;
		expect(provider?.responses).toBe(1);
		expect(provider?.failures).toBe(0);
	});

	it("records a fetch that fails on its own and still rethrows it", async () => {
		const failure = connectionRefused();
		stubFetch(async () => {
			throw failure;
		});
		await expect(
			makeProxyRequest(
				"https://api.anthropic.com/v1/messages",
				"POST",
				new Headers(),
				undefined,
				false,
				undefined,
				"anthropic",
			),
		).rejects.toBe(failure);
		const provider = upstreamTransportTracker.snapshot().providers.anthropic;
		expect(provider?.failures).toBe(1);
		expect(provider?.lastFailureCode).toBe("ConnectionRefused");
	});

	it("does not count a fetch the caller aborted", async () => {
		const controller = new AbortController();
		stubFetch(
			(signal) =>
				new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				}),
		);
		const pending = makeProxyRequest(
			new Request("https://api.anthropic.com/v1/messages", { method: "POST" }),
			undefined,
			undefined,
			undefined,
			undefined,
			controller.signal,
			"anthropic",
		);
		controller.abort(new DOMException("client went away", "AbortError"));
		await expect(pending).rejects.toBeDefined();
		expect(upstreamTransportTracker.snapshot().providers).toEqual({});
	});

	it("records nothing when the caller passes no label", async () => {
		stubFetch(async () => {
			throw connectionRefused();
		});
		await expect(
			makeProxyRequest(new Request("https://api.anthropic.com/v1/messages")),
		).rejects.toBeDefined();
		expect(upstreamTransportTracker.snapshot().providers).toEqual({});
	});
});
