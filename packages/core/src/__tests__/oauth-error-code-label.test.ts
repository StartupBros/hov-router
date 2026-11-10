import { describe, expect, it } from "bun:test";
import {
	getOAuthErrorCode,
	getOAuthErrorCodeCandidates,
	getOAuthErrorCodeLabel,
	OAuthRefreshTokenError,
} from "../errors";

describe("terminal refresh codes", () => {
	for (const code of ["refresh_token_expired", "refresh_token_invalidated"]) {
		it(`treats ${code} as a terminal refresh-token code`, () => {
			expect(getOAuthErrorCode({ error: code })).toBe(code);
			expect(getOAuthErrorCode({ error: { code } })).toBe(code);
			expect(
				new OAuthRefreshTokenError("acc", "msg", code).oauthErrorCode,
			).toBe(code);
		});
	}

	it("still ignores a raw string, which is not a structured payload", () => {
		expect(getOAuthErrorCode("refresh_token_expired")).toBe("");
	});
});

describe("getOAuthErrorCodeCandidates", () => {
	it("returns every machine-code field in precedence order", () => {
		expect(
			getOAuthErrorCodeCandidates(
				JSON.stringify({
					error: { code: "nested_code", type: "nested_type" },
					code: "root_code",
				}),
			),
		).toEqual(["nested_code", "nested_type", "root_code"]);
	});

	it("reads a flat RFC 6749 error string", () => {
		expect(
			getOAuthErrorCodeCandidates({
				error: "invalid_client",
				error_description: "Client authentication failed",
			}),
		).toEqual(["invalid_client"]);
	});

	it("treats a non-JSON body as one candidate", () => {
		expect(getOAuthErrorCodeCandidates(" Unauthorized_Client \n")).toEqual([
			"unauthorized_client",
		]);
	});

	it("never returns description text", () => {
		expect(
			getOAuthErrorCodeCandidates({
				error: { message: "invalid_client mentioned in prose" },
			}),
		).toEqual([]);
	});

	it("returns nothing for an empty or oversized body", () => {
		expect(getOAuthErrorCodeCandidates("")).toEqual([]);
		expect(getOAuthErrorCodeCandidates(`"${"a".repeat(70 * 1024)}"`)).toEqual(
			[],
		);
	});
});

describe("getOAuthErrorCodeLabel", () => {
	it("returns the first code-shaped candidate", () => {
		expect(
			getOAuthErrorCodeLabel(
				JSON.stringify({
					error: {
						code: "token_expired",
						message: "Your refresh token has expired",
					},
				}),
			),
		).toBe("token_expired");
	});

	it("skips a candidate that is not code-shaped", () => {
		expect(
			getOAuthErrorCodeLabel({
				error: { code: "Not A Code", type: "invalid_request_error" },
			}),
		).toBe("invalid_request_error");
	});

	it("rejects mixed case, digits first, punctuation and long values", () => {
		expect(getOAuthErrorCodeLabel({ error: "Rt_AbCdEf123" })).toBe("");
		expect(getOAuthErrorCodeLabel({ error: "9code" })).toBe("");
		expect(getOAuthErrorCodeLabel({ error: "rt.abc-def" })).toBe("");
		expect(getOAuthErrorCodeLabel({ error: `a${"b".repeat(40)}` })).toBe("");
	});

	it("returns nothing for a body without a code field", () => {
		expect(getOAuthErrorCodeLabel("")).toBe("");
		expect(getOAuthErrorCodeLabel({ error_description: "expired" })).toBe("");
	});
});
