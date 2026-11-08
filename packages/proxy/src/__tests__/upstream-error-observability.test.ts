import { describe, expect, it } from "bun:test";
import {
	describeUpstreamFailure,
	extractUpstreamErrorTelemetry,
	MAX_UPSTREAM_ERROR_OBSERVATION_BYTES,
} from "../upstream-error-observability";

describe("describeUpstreamFailure", () => {
	it("names the upstream status when there is no body", () => {
		expect(describeUpstreamFailure(null, 500)).toBe("upstream_http_500");
		expect(describeUpstreamFailure(undefined, 502)).toBe("upstream_http_502");
	});

	it("appends the bounded error type and code without the message", () => {
		const result = describeUpstreamFailure(
			new TextEncoder().encode(
				JSON.stringify({
					type: "error",
					error: {
						type: "api_error",
						code: "server_error",
						message: "private prompt and account detail",
					},
				}),
			),
			500,
		);
		expect(result).toBe("upstream_http_500 type=api_error code=server_error");
		expect(result).not.toContain("private");
	});

	it("reads root-level fields but ignores a root envelope type of error", () => {
		expect(
			describeUpstreamFailure(
				JSON.stringify({ type: "rate_limit_error", code: "too_many" }),
				429,
			),
		).toBe("upstream_http_429 type=rate_limit_error code=too_many");
		expect(
			describeUpstreamFailure(
				JSON.stringify({ type: "error", message: "private detail" }),
				500,
			),
		).toBe("upstream_http_500");
	});

	it("keeps only the status for unsafe fields, plain text and oversized bodies", () => {
		expect(
			describeUpstreamFailure(
				JSON.stringify({
					error: {
						type: "api error\nforged-log-line",
						code: "bad code\nwith controls",
					},
				}),
				500,
			),
		).toBe("upstream_http_500");
		expect(describeUpstreamFailure("Internal Server Error", 500)).toBe(
			"upstream_http_500",
		);
		const oversized = `${JSON.stringify({
			error: { type: "api_error", code: "server_error" },
		})}${"x".repeat(MAX_UPSTREAM_ERROR_OBSERVATION_BYTES)}`;
		expect(describeUpstreamFailure(oversized, 500)).toBe("upstream_http_500");
	});

	it("keeps only the code when the type is absent", () => {
		expect(
			describeUpstreamFailure(
				JSON.stringify({ error: { code: "context_length_exceeded" } }),
				400,
			),
		).toBe("upstream_http_400 code=context_length_exceeded");
	});
});

describe("extractUpstreamErrorTelemetry", () => {
	it("extracts bounded type/code and transport status without retaining the message", () => {
		const result = extractUpstreamErrorTelemetry(
			JSON.stringify({
				type: "error",
				error: {
					type: "permission_error",
					code: "login_required",
					status: 403,
					message: "private account and prompt details",
				},
			}),
			403,
		);

		expect(result).toEqual({
			errorType: "permission_error",
			errorCode: "login_required",
			upstreamStatus: 403,
		});
		expect(JSON.stringify(result)).not.toContain("private account");
	});

	it("supports OpenAI/Codex-shaped error envelopes", () => {
		expect(
			extractUpstreamErrorTelemetry(
				JSON.stringify({
					error: {
						type: "invalid_request_error",
						code: "usage_not_included",
						message: "private detail",
					},
				}),
				403,
			),
		).toEqual({
			errorType: "invalid_request_error",
			errorCode: "usage_not_included",
			upstreamStatus: 403,
		});
	});

	it("drops unsafe fields and never parses an oversized body prefix", () => {
		const unsafe = extractUpstreamErrorTelemetry(
			JSON.stringify({
				error: {
					type: "permission error\nforged-log-line",
					code: "bad code\nwith controls",
					message: "private detail",
				},
			}),
			403,
		);
		expect(unsafe).toEqual({ upstreamStatus: 403 });

		const oversized = `${JSON.stringify({
			error: { type: "permission_error", code: "login_required" },
		})}${"x".repeat(MAX_UPSTREAM_ERROR_OBSERVATION_BYTES)}`;
		expect(extractUpstreamErrorTelemetry(oversized, 403)).toEqual({
			upstreamStatus: 403,
		});
	});

	it("does not emit a synthetic upstream error for non-error statuses", () => {
		expect(
			extractUpstreamErrorTelemetry(
				JSON.stringify({
					error: { type: "permission_error", code: "login_required" },
				}),
				200,
			),
		).toBeNull();
	});

	it("keeps a status-only record when a 403 has no parseable JSON body", () => {
		expect(extractUpstreamErrorTelemetry("Forbidden", 403)).toEqual({
			upstreamStatus: 403,
		});
	});
});
