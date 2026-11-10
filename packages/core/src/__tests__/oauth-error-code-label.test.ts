import { describe, expect, it } from "bun:test";
import {
	getOAuthErrorCode,
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

describe("getOAuthErrorCodeLabel", () => {
	it("reads the nested code before the root code", () => {
		expect(
			getOAuthErrorCodeLabel(
				JSON.stringify({
					error: { code: "nested_code", type: "nested_type" },
					code: "root_code",
				}),
			),
		).toBe("nested_code");
	});

	it("reads a flat RFC 6749 error string, never its description", () => {
		expect(
			getOAuthErrorCodeLabel({
				error: "invalid_client",
				error_description: "client_authentication_failed",
			}),
		).toBe("invalid_client");
		expect(
			getOAuthErrorCodeLabel({
				error: { message: "invalid_client mentioned in prose" },
			}),
		).toBe("");
	});

	it("treats a whole non-JSON body as one value", () => {
		expect(getOAuthErrorCodeLabel(" invalid_client \n")).toBe("invalid_client");
		expect(getOAuthErrorCodeLabel("error=invalid_client")).toBe("");
	});

	it("returns nothing for an oversized body", () => {
		expect(getOAuthErrorCodeLabel(`"${"a".repeat(70 * 1024)}"`)).toBe("");
	});

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
