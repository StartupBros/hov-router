import { describe, expect, it } from "bun:test";
import { PRODUCT_NAME } from "@better-ccflare/core/product-identity";
import { HttpError } from "@better-ccflare/http-common";
import {
	authenticateErrorMessage,
	isKeyRejection,
	runStartupCheck,
	startupRetryDelayMs,
} from "../startup-check";

const ok = async () => ({});
const failWith = (error: unknown) => async () => {
	throw error;
};

describe("runStartupCheck", () => {
	it("is ready when the access check succeeds, and needs auth only with a stored key", async () => {
		expect(await runStartupCheck(ok, () => true)).toEqual({
			kind: "ready",
			authRequired: true,
		});
		expect(await runStartupCheck(ok, () => false)).toEqual({
			kind: "ready",
			authRequired: false,
		});
	});

	it("asks for a key with no error text when none was sent", async () => {
		expect(
			await runStartupCheck(
				failWith(new HttpError(401, "API key required")),
				() => false,
			),
		).toEqual({ kind: "auth_required", message: null });
	});

	it("shows the router's reason when it rejects the stored key", async () => {
		// The router answers every auth and authz failure with a 401 (router.ts).
		expect(
			await runStartupCheck(
				failWith(
					new HttpError(
						401,
						"Unauthorized: This API key does not have dashboard access",
					),
				),
				() => true,
			),
		).toEqual({
			kind: "auth_required",
			message: "Unauthorized: This API key does not have dashboard access",
		});
		expect(
			await runStartupCheck(
				failWith(new HttpError(401, "Invalid API key")),
				() => true,
			),
		).toEqual({ kind: "auth_required", message: "Invalid API key" });
	});

	it("checks for a stored key before the request, since a 401 clears it", async () => {
		// api.request dispatches auth-required on a 401, and App's listener
		// clears the stored key before the error reaches the startup check.
		let stored = true;
		const clearsKeyThenRejects = async () => {
			stored = false;
			throw new HttpError(401, "Invalid API key");
		};
		expect(await runStartupCheck(clearsKeyThenRejects, () => stored)).toEqual({
			kind: "auth_required",
			message: "Invalid API key",
		});
	});

	it("asks for a key on 403 and shows the reason", async () => {
		expect(
			await runStartupCheck(
				failWith(
					new HttpError(
						403,
						"Unauthorized: This API key does not have dashboard access",
					),
				),
				() => true,
			),
		).toEqual({
			kind: "auth_required",
			message: "Unauthorized: This API key does not have dashboard access",
		});
	});

	it("reports the router unreachable on a timeout instead of rendering an empty page", async () => {
		expect(
			await runStartupCheck(
				failWith(new HttpError(408, "Request timeout")),
				() => true,
			),
		).toEqual({ kind: "unreachable", message: "Request timeout" });
	});

	it("reports the router unreachable on a 5xx", async () => {
		expect(
			await runStartupCheck(
				failWith(new HttpError(503, "Service Unavailable")),
				() => false,
			),
		).toEqual({ kind: "unreachable", message: "Service Unavailable" });
	});

	it("reports the router unreachable on a network failure", async () => {
		expect(
			await runStartupCheck(
				failWith(new TypeError("Failed to fetch")),
				() => false,
			),
		).toEqual({ kind: "unreachable", message: "Failed to fetch" });
		expect(await runStartupCheck(failWith("boom"), () => false)).toEqual({
			kind: "unreachable",
			message: "boom",
		});
	});
});

describe("isKeyRejection", () => {
	it("is true only for 401 and 403", () => {
		expect(isKeyRejection(new HttpError(401, "x"))).toBe(true);
		expect(isKeyRejection(new HttpError(403, "x"))).toBe(true);
		expect(isKeyRejection(new HttpError(408, "x"))).toBe(false);
		expect(isKeyRejection(new HttpError(429, "x"))).toBe(false);
		expect(isKeyRejection(new HttpError(500, "x"))).toBe(false);
		expect(isKeyRejection(new TypeError("Failed to fetch"))).toBe(false);
		expect(isKeyRejection(null)).toBe(false);
	});
});

describe("authenticateErrorMessage", () => {
	it("passes through the server's reason for a rejected key", () => {
		expect(
			authenticateErrorMessage(
				new HttpError(403, "This API key does not have dashboard access"),
			),
		).toBe("This API key does not have dashboard access");
		expect(authenticateErrorMessage(new HttpError(401, ""))).toBe(
			"Invalid API key",
		);
	});

	it("says the router may be restarting when it did not answer", () => {
		const message = authenticateErrorMessage(
			new HttpError(408, "Request timeout"),
		);
		expect(message).toContain(`Can't reach ${PRODUCT_NAME}`);
		expect(message).toContain("restarting");
		expect(message).toContain("Request timeout");
	});
});

describe("startupRetryDelayMs", () => {
	it("backs off from 2 s and caps at 15 s", () => {
		expect([0, 1, 2, 3, 4, 20].map(startupRetryDelayMs)).toEqual([
			2_000, 4_000, 8_000, 15_000, 15_000, 15_000,
		]);
	});
});
