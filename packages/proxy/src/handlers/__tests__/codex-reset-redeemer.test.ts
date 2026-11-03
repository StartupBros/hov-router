import { afterEach, describe, expect, it } from "bun:test";
import { hashChatGptAccountId } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../proxy-types";
import {
	type CodexResetRedeemDispatch,
	clearStaleTokenRefreshState,
	codexTokenNamesAccount,
	hasCodexResetRedeemer,
	isStaleTokenRefreshCoolingDown,
	redeemCodexResetCreditForAccount,
	refreshCodexUsageForAccount,
	refreshTokenAfterRejectedRedemption,
	registerCodexResetRedeemer,
	registerCodexUsageRefresher,
	tryAcquireStaleTokenRefresh,
	unregisterCodexResetRedeemer,
	unregisterCodexUsageRefresher,
} from "../token-manager";

const REQUEST = { redeemRequestId: "req-1", creditId: "credit-a" };

const answered: CodexResetRedeemDispatch = {
	sent: true,
	result: { kind: "answered", status: 200, code: "reset", windowsReset: 1 },
};

afterEach(() => {
	unregisterCodexResetRedeemer("server-a");
	unregisterCodexResetRedeemer("server-b");
});

describe("codex reset redeemer registry", () => {
	it("reports that nothing was sent when no redeemer is registered", async () => {
		expect(hasCodexResetRedeemer()).toBe(false);
		expect(
			await redeemCodexResetCreditForAccount("acct", REQUEST, "hash-a"),
		).toEqual({
			sent: false,
			reason: "no_redeemer",
		});
	});

	it("dispatches to the registered redeemer with the account, request and expected ChatGPT account", async () => {
		const calls: unknown[] = [];
		registerCodexResetRedeemer(
			"server-a",
			async (accountId, request, expectedChatGptAccountHash) => {
				calls.push({ accountId, request, expectedChatGptAccountHash });
				return answered;
			},
		);
		expect(hasCodexResetRedeemer()).toBe(true);
		expect(
			await redeemCodexResetCreditForAccount("acct", REQUEST, "hash-a"),
		).toEqual(answered);
		expect(
			await redeemCodexResetCreditForAccount("acct", REQUEST, null),
		).toEqual(answered);
		expect(calls).toEqual([
			{
				accountId: "acct",
				request: REQUEST,
				expectedChatGptAccountHash: "hash-a",
			},
			{ accountId: "acct", request: REQUEST, expectedChatGptAccountHash: null },
		]);
	});

	it("holds one redeemer and never falls through to an earlier one", async () => {
		const used: string[] = [];
		registerCodexResetRedeemer("server-a", async () => {
			used.push("a");
			return answered;
		});
		registerCodexResetRedeemer("server-b", async () => {
			used.push("b");
			return { sent: false, reason: "token_unavailable" };
		});
		expect(
			await redeemCodexResetCreditForAccount("acct", REQUEST, "hash-a"),
		).toEqual({
			sent: false,
			reason: "token_unavailable",
		});
		expect(used).toEqual(["b"]);
	});

	it("ignores an unregister from a server that no longer holds the slot", async () => {
		registerCodexResetRedeemer("server-a", async () => answered);
		registerCodexResetRedeemer("server-b", async () => answered);
		unregisterCodexResetRedeemer("server-a");
		expect(hasCodexResetRedeemer()).toBe(true);
		unregisterCodexResetRedeemer("server-b");
		expect(hasCodexResetRedeemer()).toBe(false);
	});

	it("reports a throwing redeemer as an unclear outcome without its message", async () => {
		const logged: string[] = [];
		const methods = ["log", "info", "warn", "error", "debug"] as const;
		const originals = methods.map((m) => console[m]);
		for (const m of methods) {
			console[m] = (...args: unknown[]) => {
				logged.push(args.map(String).join(" "));
			};
		}
		let result: CodexResetRedeemDispatch;
		try {
			registerCodexResetRedeemer("server-a", async () => {
				throw new Error("DISTINCT-SECRET-TOKEN-TEXT");
			});
			result = await redeemCodexResetCreditForAccount(
				"acct",
				REQUEST,
				"hash-a",
			);
		} finally {
			methods.forEach((m, i) => {
				console[m] = originals[i];
			});
		}
		// It may have sent the request, so the caller must treat it as unclear.
		expect(result).toEqual({ sent: true, result: { kind: "network" } });
		expect(logged.join("\n")).not.toContain("DISTINCT-SECRET-TOKEN-TEXT");
	});
});

describe("codexTokenNamesAccount", () => {
	function token(chatgptAccountId?: string): string {
		const claims =
			chatgptAccountId === undefined
				? { sub: "user-1" }
				: {
						"https://api.openai.com/auth": {
							chatgpt_account_id: chatgptAccountId,
						},
					};
		const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
		return `header.${payload}.signature`;
	}

	it("accepts a token that names the account the request was confirmed for", () => {
		expect(
			codexTokenNamesAccount(token("acct-1"), hashChatGptAccountId("acct-1")),
		).toBe(true);
	});

	it("refuses a token that names a different account", () => {
		expect(
			codexTokenNamesAccount(token("acct-2"), hashChatGptAccountId("acct-1")),
		).toBe(false);
	});

	it("refuses a token that names an account when the request was confirmed for none, and the reverse", () => {
		expect(codexTokenNamesAccount(token("acct-1"), null)).toBe(false);
		expect(
			codexTokenNamesAccount(token(), hashChatGptAccountId("acct-1")),
		).toBe(false);
	});

	it("accepts a token that names no account when the request was confirmed for none", () => {
		expect(codexTokenNamesAccount(token(), null)).toBe(true);
		expect(codexTokenNamesAccount("opaque-token", null)).toBe(true);
	});
});

describe("refreshCodexUsageForAccount awaitInFlight", () => {
	afterEach(() => {
		unregisterCodexUsageRefresher("server-a");
	});

	function gate() {
		let release = () => {};
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		return { promise, release };
	}

	/** Refresher whose first call waits for `first`; later calls answer at once. */
	function registerCounting(first: Promise<void>, events: string[]) {
		let calls = 0;
		registerCodexUsageRefresher("server-a", async () => {
			const n = ++calls;
			events.push(`start-${n}`);
			if (n === 1) await first;
			events.push(`end-${n}`);
			return { success: true, message: `read ${n}` };
		});
	}

	it("reuses a refresh already in flight by default", async () => {
		const first = gate();
		const events: string[] = [];
		registerCounting(first.promise, events);
		const a = refreshCodexUsageForAccount("acct");
		const b = refreshCodexUsageForAccount("acct");
		first.release();
		expect((await a).message).toBe("read 1");
		expect((await b).message).toBe("read 1");
		expect(events).toEqual(["start-1", "end-1"]);
	});

	it("waits out a refresh in flight and starts a new one when asked", async () => {
		const first = gate();
		const events: string[] = [];
		registerCounting(first.promise, events);
		const stale = refreshCodexUsageForAccount("acct");
		const fresh = refreshCodexUsageForAccount("acct", { awaitInFlight: true });
		await Promise.resolve();
		expect(events).toEqual(["start-1"]);
		first.release();
		expect((await fresh).message).toBe("read 2");
		expect((await stale).message).toBe("read 1");
		expect(events).toEqual(["start-1", "end-1", "start-2", "end-2"]);
	});

	it("starts at once when nothing is in flight", async () => {
		const events: string[] = [];
		registerCounting(Promise.resolve(), events);
		const result = await refreshCodexUsageForAccount("acct", {
			awaitInFlight: true,
		});
		expect(result.message).toBe("read 1");
		expect(events).toEqual(["start-1", "end-1"]);
	});
});

describe("refreshTokenAfterRejectedRedemption", () => {
	const ctx = {} as ProxyContext;

	function codexAccount(overrides: Partial<Account> = {}): Account {
		return {
			id: "acct-redeem-401",
			name: "codex-one",
			provider: "codex",
			api_key: null,
			refresh_token: "rt-codex",
			access_token: "at-rejected",
			expires_at: Date.now() + 3_600_000,
			created_at: 1,
			...overrides,
		} as Account;
	}

	afterEach(() => {
		clearStaleTokenRefreshState("acct-redeem-401");
	});

	it("refreshes an OAuth Codex account once so the next attempt sends a new token", async () => {
		const refreshed: string[] = [];
		const done = await refreshTokenAfterRejectedRedemption(
			codexAccount(),
			ctx,
			async (account) => {
				refreshed.push(account.id);
				return "at-new";
			},
		);
		expect(done).toBe(true);
		expect(refreshed).toEqual(["acct-redeem-401"]);
		// The proxy's reactive refresh shares this cooldown.
		expect(isStaleTokenRefreshCoolingDown("acct-redeem-401")).toBe(true);
	});

	it("leaves an account that has no OAuth refresh alone", async () => {
		let calls = 0;
		const done = await refreshTokenAfterRejectedRedemption(
			codexAccount({ refresh_token: null, api_key: "sk-key" }),
			ctx,
			async () => {
				calls++;
				return "at-new";
			},
		);
		expect(done).toBe(false);
		expect(calls).toBe(0);
	});

	it("does not refresh again inside the shared cooldown", async () => {
		expect(tryAcquireStaleTokenRefresh("acct-redeem-401")).toBe(true);
		let calls = 0;
		const done = await refreshTokenAfterRejectedRedemption(
			codexAccount(),
			ctx,
			async () => {
				calls++;
				return "at-new";
			},
		);
		expect(done).toBe(false);
		expect(calls).toBe(0);
	});

	it("swallows a failed refresh without logging its message", async () => {
		const logged: string[] = [];
		const methods = ["log", "info", "warn", "error", "debug"] as const;
		const originals = methods.map((m) => console[m]);
		for (const m of methods) {
			console[m] = (...args: unknown[]) => {
				logged.push(args.map(String).join(" "));
			};
		}
		let done: boolean;
		try {
			done = await refreshTokenAfterRejectedRedemption(
				codexAccount(),
				ctx,
				async () => {
					throw new Error("DISTINCT-REFRESH-SECRET");
				},
			);
		} finally {
			methods.forEach((m, i) => {
				console[m] = originals[i];
			});
		}
		expect(done).toBe(false);
		expect(logged.join("\n")).not.toContain("DISTINCT-REFRESH-SECRET");
	});
});
