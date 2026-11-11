/**
 * P2 review fix (U8 OAuth control-plane hotfix): render-level coverage for
 * R25 -- reauthentication must read as the PRIMARY action for a terminal
 * auth pause (pauseReason "oauth_invalid_grant"), while every other pause
 * reason (a known non-terminal reason like "manual", or any unrecognized/
 * legacy string) must fall back to generic "Paused" copy with no reauth
 * emphasis. pause-status.test.ts already unit-tests pauseStatusDisplay()
 * itself; this file proves AccountListItem actually wires that result into
 * the rendered markup (copy + which button reads as primary), the same
 * renderToStaticMarkup pattern RateLimitProgress.test.tsx uses in this
 * directory.
 */
import { describe, expect, it, mock } from "bun:test";
import type { BankedResets, FullUsageData } from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../../api";
import { AccountList, accountListItems } from "./AccountList";
import {
	AccountListItem,
	CodexCreditDrainControl,
	PublicValueControl,
} from "./AccountListItem";
import { mergeAccountModelMappings } from "./AccountModelMappingsDialog";
import type { AccountFamilyRoutingState } from "./account-routing";

// SSR omits closed portals. Exercise provider controls at the content boundary;
// this mock does not establish browser dialog or focus behavior.
const dialogPrimitives = await import("../ui/dialog");
mock.module("../ui/dialog", () => ({
	...dialogPrimitives,
	DialogContent: ({ children }: { children: React.ReactNode }) => (
		<div data-testid="details-content">{children}</div>
	),
}));

function noop() {}
function withoutDetailsContent(html: string): string {
	const start = html.indexOf('<div data-testid="details-content">');
	if (start < 0) return html;
	const tags = /<div\b[^>]*>|<\/div>/g;
	tags.lastIndex = start;
	let depth = 0;
	for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
		depth += tag[0].startsWith("</") ? -1 : 1;
		if (depth === 0) return html.slice(0, start) + html.slice(tags.lastIndex);
	}
	throw new Error("Unclosed details content");
}
async function noopAsync() {}

describe("account scan layout", () => {
	it("distinguishes unavailable data from an empty collection", () => {
		const unavailable = renderToStaticMarkup(
			<AccountList accounts={undefined} {...requiredHandlers} />,
		);
		expect(unavailable).toContain("Account data unavailable");
		expect(unavailable).not.toContain("No accounts yet");
		expect(
			renderToStaticMarkup(<AccountList accounts={[]} {...requiredHandlers} />),
		).toContain("No accounts yet");
	});
	it("renders labeled scan controls and result count", () => {
		const html = renderToStaticMarkup(
			<AccountList accounts={[makeAccount()]} {...requiredHandlers} />,
		);
		for (const text of [
			"Search accounts",
			"All providers",
			"Needs attention",
			"Paused",
			"Showing 1 of 1 accounts",
			'aria-pressed="true"',
		])
			expect(html).toContain(text);
	});
	it("collapses routine settings and family details while keeping recovery visible", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({ provider: "codex", requiresReauth: true })}
				{...requiredHandlers}
				onCodexReauth={noop}
				onCodexCreditDrainToggle={noop}
				routingStates={[
					routingState({ reason: "ambiguous", reasonLabel: "Ambiguous" }),
				]}
			/>,
		);
		expect(html).toContain('aria-haspopup="dialog"');
		expect(html).not.toContain("<details");
		expect(html).toContain("Drain credits");
		const visible = withoutDetailsContent(html);
		expect(visible).toContain("Re-authenticate");
		expect(visible).toContain("Action required");
		expect(visible).not.toContain("No account block reported");
	});
	it("uses the reported normal state without a duplicate fallback label", () => {
		const allowed = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({ paused: false, rateLimitStatus: "allowed" })}
				{...requiredHandlers}
			/>,
		);
		expect(allowed).toContain("Allowed");
		expect(allowed).not.toContain("No account block reported");
		const unspecified = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({ paused: false })}
				{...requiredHandlers}
			/>,
		);
		expect(unspecified).toContain("No account block reported");
	});
	it("keeps force reset outside disclosures and missing quota explicit", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					paused: false,
					rateLimitedUntil: Date.now() + 60000,
					usageUtilization: 20,
				})}
				{...requiredHandlers}
			/>,
		);
		const visible = withoutDetailsContent(html);
		expect(visible).toContain("Force Reset");
		expect(visible).toContain("Stale lock detected");
		expect(visible).not.toContain("No account block reported");
		expect(visible).toContain("Not reported");
	});
});

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "acc-1",
		provider: "anthropic",
		requestCount: 0,
		totalRequests: 0,
		lastUsed: null,
		created: new Date().toISOString(),
		paused: true,
		requiresReauth: false,
		pauseReason: null,
		tokenStatus: "valid",
		tokenExpiresAt: null,
		rateLimitStatus: "OK",
		rateLimitReset: null,
		rateLimitRemaining: null,
		rateLimitedUntil: null,
		rateLimitedReason: null,
		rateLimitedAt: null,
		sessionInfo: "No active session",
		priority: 0,
		autoFallbackEnabled: false,
		customEndpoint: null,
		modelMappings: null,
		usageUtilization: null,
		usageWindow: null,
		usageData: null,
		usageRateLimitedUntil: null,
		usageThrottledUntil: null,
		usageThrottledWindows: [],
		hasRefreshToken: true,
		sessionStats: null,
		isPrimary: false,
		...overrides,
	};
}

const requiredHandlers = {
	onPauseToggle: noop,
	onForceResetRateLimit: noop,
	onRefreshUsage: noopAsync,
	onRemove: noop,
	onRename: noop,
	onPriorityChange: noop,
	onAutoFallbackToggle: noop,
	onBillingTypeToggle: noop,
};

function routingState(
	overrides: Partial<AccountFamilyRoutingState> = {},
): AccountFamilyRoutingState {
	return {
		family: "opus",
		comboId: "combo-opus",
		comboName: "Opus priority",
		active: true,
		membershipLabel: "Managed",
		tier: 0,
		logicalModel: "claude-opus-4-8",
		reason: "included",
		reasonLabel: "Included",
		availability: "available",
		availabilityLabel: "Available",
		managedRouteAvailable: false,
		...overrides,
	};
}

describe("account model mapping edits", () => {
	it("preserves unrelated exact pins and one-element ordered arrays", () => {
		const existing = {
			"claude-sonnet-4-8": ["private-a", "private-b"],
			fable: ["pinned-a"],
			opus: "pinned-b",
		};
		const merged = mergeAccountModelMappings(existing, {
			fable: "pinned-a",
			opus: "",
			sonnet: "fresh",
			haiku: "",
		});
		expect(merged).toEqual({
			"claude-sonnet-4-8": ["private-a", "private-b"],
			fable: ["pinned-a"],
			sonnet: "fresh",
		});
		expect(existing.opus).toBe("pinned-b");
	});
});

function reauthButton(html: string): string | undefined {
	return (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []).find(
		(button) => button.includes(">Re-authenticate</button>"),
	);
}

describe("AccountListItem (P2 review: pause-reason rendering)", () => {
	it("renders the derived requiresReauth signal as the same primary recovery action", () => {
		const account = makeAccount({
			requiresReauth: true,
			pauseReason: "oauth_invalid_grant",
		});
		const html = renderToStaticMarkup(
			<AccountListItem
				account={account}
				{...requiredHandlers}
				onAnthropicReauth={noop}
			/>,
		);

		expect(html).toContain("Re-authentication required");
		expect(html).toContain("Refresh token invalid — re-authenticate");
		expect(html).toContain(">Re-authenticate<");
		expect(reauthButton(html)).toContain(" bg-primary ");
		expect(reauthButton(html)).toContain("text-black");
	});

	it("renders reauth-required copy and a primary Re-authenticate button for oauth_invalid_grant", () => {
		const account = makeAccount({ pauseReason: "oauth_invalid_grant" });
		const html = renderToStaticMarkup(
			<AccountListItem
				account={account}
				{...requiredHandlers}
				onAnthropicReauth={noop}
			/>,
		);

		expect(html).toContain("Re-authentication required");
		// The visible button label (as opposed to its static tooltip title,
		// which always reads "Re-authenticate this Anthropic account..."
		// regardless of pause reason) -- ">Re-authenticate<" only appears when
		// pauseStatus.reauthRequired renders the label text inside the button.
		expect(html).toContain(">Re-authenticate<");
		// Assert the recovery button itself, not unrelated switches that also
		// carry bg-primary. Dark ink keeps the primary orange action readable.
		expect(reauthButton(html)).toContain(" bg-primary ");
		expect(reauthButton(html)).toContain("text-black");
	});

	it("renders generic Paused copy with no reauth emphasis for a manual pause", () => {
		const account = makeAccount({ pauseReason: "manual" });
		const html = renderToStaticMarkup(
			<AccountListItem
				account={account}
				{...requiredHandlers}
				onAnthropicReauth={noop}
			/>,
		);

		expect(html).toContain("Paused");
		expect(html).not.toContain("Re-authentication required");
		expect(html).not.toContain(">Re-authenticate<");
		expect(reauthButton(html)).toBeUndefined();
	});

	it("shows a human-readable known automatic pause reason", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({ pauseReason: "failure_threshold" })}
				{...requiredHandlers}
				onAnthropicReauth={noop}
			/>,
		);

		expect(html).toContain("Paused (failure threshold)");
	});

	it("renders generic Paused copy with no reauth emphasis for an unrecognized pause reason", () => {
		const account = makeAccount({
			pauseReason: "some_future_reason_this_build_does_not_know_about",
		});
		const html = renderToStaticMarkup(
			<AccountListItem
				account={account}
				{...requiredHandlers}
				onAnthropicReauth={noop}
			/>,
		);

		expect(html).toContain("Paused");
		expect(html).not.toContain(
			"some future reason this build does not know about",
		);
		expect(html).not.toContain("Re-authentication required");
		expect(html).not.toContain(">Re-authenticate<");
		expect(reauthButton(html)).toBeUndefined();
	});
});

describe("AccountListItem authoritative family routing", () => {
	it("renders server-owned Managed source, model, effective tier, and reason", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({ paused: false })}
				{...requiredHandlers}
				routingStates={[routingState()]}
			/>,
		);

		expect(html).toContain("Family routing");
		expect(html).toContain("Opus");
		expect(html).toContain("Managed");
		expect(html).toContain("claude-opus-4-8");
		expect(html).toContain("Tier 0");
		expect(html).toContain("Included");
	});

	it("renders a Manual membership without duplicating manual_override as a warning", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({ paused: false })}
				{...requiredHandlers}
				routingStates={[
					routingState({
						membershipLabel: "Manual",
						reason: "manual_override",
						reasonLabel: "Manual override",
						tier: 7,
					}),
				]}
			/>,
		);

		expect(html).toContain(">Manual<");
		expect(html).toContain("Tier 7");
		expect(html).not.toContain("Manual override");
		expect(html).not.toContain("Action required");
	});

	for (const [availability, expected] of [
		["paused", "Paused"],
		["requires_reauth", "Needs authentication"],
		["rate_limited", "Rate limited"],
		["model_exhausted", "Model exhausted"],
	] as const) {
		it(`renders the distinct ${availability} operational overlay`, () => {
			const html = renderToStaticMarkup(
				<AccountListItem
					account={makeAccount({ paused: false })}
					{...requiredHandlers}
					routingStates={[routingState({ availability })]}
				/>,
			);

			expect(html).toContain(expected);
			expect(html).toContain("membership is unchanged");
		});
	}

	for (const [reason, expected, actionRequired] of [
		["excluded", "Excluded from managed routing", false],
		["unsupported", "Logical model unsupported", false],
		["unknown", "Capability unknown", false],
		["disabled", "Family routing disabled", false],
		["ambiguous", "Ambiguous server proposal", true],
		["new_billing_class", "New billing class requires review", true],
	] as const) {
		it(`renders ${reason} only from the supplied server decision`, () => {
			const html = renderToStaticMarkup(
				<AccountListItem
					account={makeAccount({ paused: false, priority: 0 })}
					{...requiredHandlers}
					routingStates={[
						routingState({
							membershipLabel: null,
							tier: null,
							reason,
							reasonLabel: expected,
						}),
					]}
				/>,
			);

			expect(html).toContain(expected);
			expect(html.includes("Action required")).toBe(actionRequired);
		});
	}

	it("does not infer an outside-route warning from account priority", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({ paused: false, priority: 0 })}
				{...requiredHandlers}
			/>,
		);

		expect(html).not.toContain("Family routing");
		expect(html).not.toContain("Outside active route");
		expect(html).not.toContain("Action required");
	});

	it("directs an outside-route account with a server-approved proposal to Combos without claiming membership", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({ paused: false })}
				{...requiredHandlers}
				routingStates={[
					routingState({
						membershipLabel: null,
						tier: null,
						reason: "unknown",
						reasonLabel: "Capability unknown",
						managedRouteAvailable: true,
					}),
				]}
			/>,
		);

		expect(html).toContain("Managed route available");
		expect(html).toContain("Review in Combos");
		expect(html).toContain("Capability unknown");
		expect(html).not.toContain(">Managed<");
		expect(html).not.toContain("Already a managed member");
	});

	it("keys cards and resolves routing state by immutable account ID", () => {
		const firstRouting = [routingState({ family: "opus" })];
		const secondRouting = [routingState({ family: "fable" })];
		const children = accountListItems({
			accounts: [
				makeAccount({ id: "account-a", name: "duplicate-name" }),
				makeAccount({ id: "account-b", name: "duplicate-name" }),
			],
			routingByAccountId: {
				"account-a": firstRouting,
				"account-b": secondRouting,
			},
			...requiredHandlers,
		});

		expect(children.map((child) => child.key)).toEqual([
			"account-a",
			"account-b",
		]);
		expect(children[0]?.props.routingStates).toBe(firstRouting);
		expect(children[1]?.props.routingStates).toBe(secondRouting);
	});
});

describe("AccountListItem codex usage extras", () => {
	// plan_type / credits_balance are polling-only extras from the free
	// wham/usage endpoint (see api-usage.ts) -- NOT part of the public
	// FullUsageData union, so callers cast. Live traffic can overwrite the
	// cached snapshot and drop them at any moment, so every read must be
	// null-safe and simply omit the element when absent (see
	// RateLimitProgress.tsx's CodexUsageExtras for the sibling code_review_*
	// extras, which follow the same contract).
	function codexUsageData(
		extras: Record<string, unknown>,
	): NonNullable<Account["usageData"]> {
		return {
			five_hour: { utilization: 10, resets_at: null },
			seven_day: { utilization: 20, resets_at: null },
			...extras,
		} as unknown as FullUsageData;
	}

	it("renders a plan_type badge near the account name when present", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "codex",
					usageData: codexUsageData({ plan_type: "pro" }),
				})}
				{...requiredHandlers}
			/>,
		);

		expect(html).toContain(">pro<");
	});

	it("omits the plan_type badge when absent from usageData", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "codex",
					usageData: codexUsageData({}),
				})}
				{...requiredHandlers}
			/>,
		);

		expect(html).not.toContain(">pro<");
	});

	it("renders credits_balance as a compact stat when positive", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "codex",
					usageData: codexUsageData({ credits_balance: 1234 }),
				})}
				{...requiredHandlers}
			/>,
		);

		expect(html).toContain("1,234 credits");
	});

	it("omits the credits_balance stat when it is zero (noise, not a real balance)", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "codex",
					usageData: codexUsageData({ credits_balance: 0 }),
				})}
				{...requiredHandlers}
			/>,
		);

		expect(html).not.toContain("credits</span>");
		expect(html).not.toContain("0 credits");
	});

	it("omits the credits_balance stat when absent from usageData", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "codex",
					usageData: codexUsageData({}),
				})}
				{...requiredHandlers}
			/>,
		);

		expect(html).not.toContain("credits</span>");
	});

	it("omits the credits_balance stat when null", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "codex",
					usageData: codexUsageData({ credits_balance: null }),
				})}
				{...requiredHandlers}
			/>,
		);

		expect(html).not.toContain("credits</span>");
	});

	it("does not render plan_type or credits_balance extras for non-codex providers even if the shape is present", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "anthropic",
					usageData: codexUsageData({
						plan_type: "pro",
						credits_balance: 1234,
					}),
				})}
				{...requiredHandlers}
			/>,
		);

		expect(html).not.toContain(">pro<");
		expect(html).not.toContain("1,234 credits");
	});
});

describe("AccountListItem (binding constraint display)", () => {
	function render(account: Account): string {
		return renderToStaticMarkup(
			<AccountListItem
				account={account}
				{...requiredHandlers}
				onAnthropicReauth={noop}
			/>,
		);
	}

	it("renders nothing when the server sent no binding constraint", () => {
		// Older servers omit the field entirely — no empty row, no placeholder.
		const html = render(makeAccount({ paused: false }));
		expect(html).not.toContain("Binding limit");
	});

	it("marks a family-scoped cap as not counted in the routing percentage", () => {
		// The 2026-08-11 incident: routing badge reads 64% account-wide while a
		// per-model weekly cap sits at 100% and that lane is unroutable.
		const html = render(
			makeAccount({
				paused: false,
				usageUtilization: 64,
				usageWindow: "five_hour",
				bindingConstraint: {
					window: "seven_day_fable",
					utilization: 100,
					resetAtMs: 1_800_000_000_000,
					scope: "family",
					modelFamily: "fable",
				},
			}),
		);

		expect(html).toContain("Binding limit");
		expect(html).toContain("Fable (Weekly)");
		expect(html).toContain("100%");
		expect(html).toContain("model-scoped, not counted in the routing % above");
	});

	it("labels an account-wide constraint as account-wide", () => {
		const html = render(
			makeAccount({
				paused: false,
				usageUtilization: 64,
				usageWindow: "five_hour",
				bindingConstraint: {
					window: "five_hour",
					utilization: 64,
					resetAtMs: 1_800_000_000_000,
					scope: "account",
					modelFamily: null,
				},
			}),
		);

		expect(html).toContain("Binding limit");
		expect(html).toContain("5-hour");
		expect(html).toContain("account-wide");
		expect(html).not.toContain("model-scoped");
	});

	it("keeps the routing utilization badge alongside the binding constraint", () => {
		// The binding constraint must ADD an answer, never replace the routing
		// one — the two questions are different and collapsing them is the bug.
		const html = render(
			makeAccount({
				paused: false,
				usageUtilization: 64,
				usageWindow: "five_hour",
				usageData: {
					five_hour: { utilization: 64, resets_at: null },
				} as FullUsageData,
				bindingConstraint: {
					window: "seven_day_fable",
					utilization: 100,
					resetAtMs: null,
					scope: "family",
					modelFamily: "fable",
				},
			}),
		);

		expect(html).toContain("Binding limit");
		expect(html).toContain("64%");
		expect(html).toContain("100%");
	});
});

describe("AccountListItem Codex credit drain toggle", () => {
	function render(
		account: Account,
		onCodexCreditDrainToggle?: (a: Account) => void,
	) {
		return renderToStaticMarkup(
			<AccountListItem
				account={account}
				{...requiredHandlers}
				onCodexCreditDrainToggle={onCodexCreditDrainToggle}
			/>,
		);
	}

	it("renders the Drain credits switch for codex rows with the spend warning", () => {
		const html = render(makeAccount({ provider: "codex" }), noop);
		expect(html).toContain("Drain credits:");
		expect(html).toContain("spends purchased credits");
	});

	it("does not render for non-codex rows or without a handler", () => {
		expect(render(makeAccount({ provider: "anthropic" }), noop)).not.toContain(
			"Drain credits:",
		);
		expect(render(makeAccount({ provider: "codex" }))).not.toContain(
			"Drain credits:",
		);
	});

	it("reflects codexCreditDrainEnabled", () => {
		const on = render(
			makeAccount({ provider: "codex", codexCreditDrainEnabled: true }),
			noop,
		);
		const off = render(makeAccount({ provider: "codex" }), noop);
		const drainSwitch = (html: string) =>
			html.slice(html.indexOf("Drain credits:"));
		expect(drainSwitch(on)).toContain('aria-checked="true"');
		expect(drainSwitch(off)).not.toContain('aria-checked="true"');
	});

	it("calls the handler with the account when toggled", () => {
		const account = makeAccount({ provider: "codex" });
		const calls: Account[] = [];
		const el = CodexCreditDrainControl({
			account,
			onToggle: (a: Account) => calls.push(a),
		});
		const found = findSwitch(el);
		expect(found).not.toBeNull();
		found?.onCheckedChange?.(true);
		expect(calls).toEqual([account]);
	});

	it("shows the on-credits indicator only when drain is serving from credits", () => {
		const serving = render(
			makeAccount({
				provider: "codex",
				codexCreditDrainEnabled: true,
				codexCreditDrainActive: true,
				codexCreditDrainServing: true,
			}),
			noop,
		);
		const armedOnly = render(
			makeAccount({
				provider: "codex",
				codexCreditDrainEnabled: true,
				codexCreditDrainActive: true,
				codexCreditDrainServing: false,
			}),
			noop,
		);
		const inactive = render(
			makeAccount({ provider: "codex", codexCreditDrainEnabled: true }),
			noop,
		);
		expect(serving).toContain("on credits");
		expect(armedOnly).not.toContain("on credits");
		expect(inactive).not.toContain("on credits");
	});
});

describe("AccountListItem banked resets", () => {
	const NOV_30 = Date.UTC(2026, 10, 30);
	const tracked: BankedResets = {
		tracked: true,
		availableCount: 2,
		applicableCount: 2,
		soonestExpiresAt: NOV_30,
		doesNotExpire: false,
		appliesNow: true,
		stale: false,
		observedAt: Date.now(),
	};

	function render(account: Account) {
		return renderToStaticMarkup(
			<AccountListItem account={account} {...requiredHandlers} />,
		);
	}

	function codex(bankedResets: BankedResets | undefined) {
		return makeAccount({ provider: "codex", paused: false, bankedResets });
	}

	it("renders the account's banked resets as its own group below the status line", () => {
		const html = render(codex(tracked));
		const group = html.indexOf(
			'<fieldset aria-label="Banked resets for acc-1"',
		);
		expect(group).toBeGreaterThan(-1);
		expect(html).toContain("cannot be undone");
		expect(html).not.toMatch(/would help|expected to help|applies now/i);
		// The status line closes before the group opens: the group is not one of
		// its chips, so it cannot wrap in among the request counters.
		const statusLine = html.indexOf("0 requests");
		expect(statusLine).toBeGreaterThan(-1);
		expect(html.slice(statusLine, group)).toContain("</div>");
	});

	it("never colours a held reset green in the row", () => {
		const html = render(codex(tracked));
		const group = html.slice(html.indexOf("<fieldset"));
		expect(group.slice(0, group.indexOf("</fieldset>"))).not.toMatch(
			/bg-green|text-green/,
		);
	});

	it("shows nothing for accounts without the field or other providers", () => {
		expect(render(codex(undefined))).not.toContain("Banked resets");
		expect(
			render(
				makeAccount({
					provider: "anthropic",
					paused: false,
					bankedResets: tracked,
				}),
			),
		).not.toContain("Banked resets");
	});

	it("offers Use reset only when the list is given a handler", () => {
		// Static markup cannot click, so this covers the pass-through from the
		// list to the row's status block, not the click itself.
		const useResetButton = /<button\b[^>]*>Use reset<\/button>/;
		const accounts = [codex(tracked)];
		expect(
			renderToStaticMarkup(
				<AccountList accounts={accounts} {...requiredHandlers} />,
			),
		).not.toMatch(useResetButton);
		expect(
			renderToStaticMarkup(
				<AccountList
					accounts={accounts}
					{...requiredHandlers}
					onUseReset={() => {}}
				/>,
			),
		).toMatch(useResetButton);
	});
});

describe("AccountListItem header at phone width", () => {
	// At 390px a rate-limited card put Force Reset, Refresh usage, Pause and More
	// beside the name. The name column had a zero flex basis, so it got the ~48px
	// left over and `overflow-wrap: anywhere` split "pro-primary-wmgm" into five
	// mid-word pieces. The column now claims 8rem before the actions may sit
	// beside it, and the name breaks at hyphens before it breaks mid-word.
	function header() {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					name: "pro-primary-wmgm",
					provider: "codex",
					paused: false,
					rateLimitedUntil: Date.now() + 3_600_000,
				})}
				{...requiredHandlers}
			/>,
		);
		const nameEnd = html.indexOf(">pro-primary-wmgm</h3>");
		const headingStart = html.lastIndexOf("<h3", nameEnd);
		const columnStart = html.lastIndexOf('<div class="min-w-0', headingStart);
		return {
			html,
			heading: html.slice(headingStart, nameEnd),
			column: html.slice(columnStart, html.indexOf(">", columnStart)),
		};
	}

	it("gives the name column a real basis so the actions wrap below it", () => {
		const { html, column } = header();
		expect(html).toContain("Force Reset");
		expect(column).toContain("flex-[1_1_8rem]");
		expect(column).not.toMatch(/\bflex-1\b/);
		expect(html).toContain('class="ml-auto flex shrink-0 flex-wrap');
	});

	it("breaks a long name at its hyphens, not anywhere", () => {
		const { heading } = header();
		expect(heading).toContain("break-words");
		expect(heading).not.toContain("anywhere");
	});
});

type SwitchProps = { onCheckedChange?: (v: boolean) => void };
function findSwitch(node: unknown): SwitchProps | null {
	if (!node || typeof node !== "object") return null;
	if (Array.isArray(node)) {
		for (const n of node) {
			const r = findSwitch(n);
			if (r) return r;
		}
		return null;
	}
	const props = (node as { props?: Record<string, unknown> }).props;
	if (!props) return null;
	if (
		typeof props.title === "string" &&
		props.title.includes("purchased credits") &&
		typeof props.onCheckedChange === "function"
	) {
		return props as SwitchProps;
	}
	return findSwitch(props.children);
}

describe("AccountListItem public value toggle", () => {
	function render(
		account: Account,
		onPublicValueToggle?: (a: Account) => void,
		onPublicValueEditLabel?: (a: Account) => void,
	) {
		return renderToStaticMarkup(
			<AccountListItem
				account={account}
				{...requiredHandlers}
				onPublicValueToggle={onPublicValueToggle}
				onPublicValueEditLabel={onPublicValueEditLabel}
			/>,
		);
	}

	it("renders for every provider and not without a handler", () => {
		for (const provider of ["anthropic", "codex", "zai"]) {
			expect(render(makeAccount({ provider }), noop)).toContain(
				"Public value:",
			);
		}
		expect(render(makeAccount())).not.toContain("Public value:");
	});

	it("reflects publicValueEnabled", () => {
		const on = render(makeAccount({ publicValueEnabled: true }), noop);
		const off = render(makeAccount(), noop);
		const sw = (html: string) => html.slice(html.indexOf("Public value:"));
		expect(sw(on)).toContain('aria-checked="true"');
		expect(sw(off)).not.toContain('aria-checked="true"');
	});

	it("shows the label and edit action only when published", () => {
		const on = render(
			makeAccount({ publicValueEnabled: true, publicValueLabel: "Max #1" }),
			noop,
			noop,
		);
		expect(on).toContain("Max #1");
		expect(on).toContain("Edit public label");
		// A kept label is not shown while unpublished.
		const off = render(
			makeAccount({ publicValueEnabled: false, publicValueLabel: "Max #1" }),
			noop,
			noop,
		);
		expect(off).not.toContain("Max #1");
		expect(off).not.toContain("Edit public label");
	});

	it("calls the toggle handler with the account when switched", () => {
		const account = makeAccount();
		const calls: Account[] = [];
		const el = PublicValueControl({
			account,
			onToggle: (a: Account) => calls.push(a),
		});
		const found = findSwitchByTitle(el, "House of Vibe");
		expect(found).not.toBeNull();
		found?.onCheckedChange?.(true);
		expect(calls).toEqual([account]);
	});
});

describe("AccountListItem row layout", () => {
	function render(account: Account) {
		return renderToStaticMarkup(
			<AccountListItem
				account={account}
				{...requiredHandlers}
				onCustomEndpointChange={noop}
				onModelMappingsChange={noop}
			/>,
		);
	}

	it("surfaces a custom endpoint and the mapping count as visible chips", () => {
		const html = render(
			makeAccount({
				provider: "openai-compatible",
				customEndpoint: "https://gateway.example/v1",
				modelMappings: { opus: "a", sonnet: "b" },
			}),
		);
		expect(html).toContain("custom endpoint");
		expect(html).toContain(
			'title="Custom endpoint: https://gateway.example/v1"',
		);
		expect(html).toContain("2 model mappings");
	});

	it("uses the singular for one mapping and omits both chips when unset", () => {
		expect(render(makeAccount({ modelMappings: { opus: "a" } }))).toContain(
			"1 model mapping<",
		);
		const bare = render(makeAccount());
		expect(bare).not.toContain("custom endpoint");
		expect(bare).not.toContain("model mapping");
	});

	it("shows Bedrock profile details instead of a raw endpoint chip", () => {
		const html = render(
			makeAccount({
				provider: "bedrock",
				customEndpoint: "bedrock:dev-profile:us-east-1",
			}),
		);
		expect(html).toContain("Profile: dev-profile");
		expect(html).toContain("us-east-1");
		expect(html).not.toContain("custom endpoint");
	});

	it("hides the API's empty session placeholders but keeps an active session", () => {
		for (const sessionInfo of ["-", "No active session", ""]) {
			const html = render(makeAccount({ sessionInfo }));
			expect(html).not.toContain(">-<");
			expect(html).not.toContain("No active session");
		}
		expect(render(makeAccount({ sessionInfo: "Active: 12 reqs" }))).toContain(
			"Active: 12 reqs",
		);
	});

	it("groups request counts with thousands separators", () => {
		expect(render(makeAccount({ requestCount: 949516 }))).toContain(
			"949,516 requests",
		);
	});

	it("gives every icon-only action an accessible name", () => {
		const paused = render(makeAccount({ name: "max-a", paused: true }));
		expect(paused).toContain('aria-label="Resume account"');
		expect(paused).toContain('aria-label="More actions for max-a"');
		expect(paused).toContain('aria-label="Refresh usage"');
		expect(render(makeAccount({ paused: false }))).toContain(
			'aria-label="Pause account"',
		);
	});

	it("keeps the closed overflow menu's actions out of the row markup", () => {
		const html = render(makeAccount());
		expect(html).not.toContain("Remove account");
		expect(html).not.toContain("Rename…");
	});
});

function findSwitchByTitle(
	node: unknown,
	titlePart: string,
): SwitchProps | null {
	if (!node || typeof node !== "object") return null;
	if (Array.isArray(node)) {
		for (const n of node) {
			const r = findSwitchByTitle(n, titlePart);
			if (r) return r;
		}
		return null;
	}
	const props = (node as { props?: Record<string, unknown> }).props;
	if (!props) return null;
	if (
		typeof props.title === "string" &&
		props.title.includes(titlePart) &&
		typeof props.onCheckedChange === "function"
	) {
		return props as SwitchProps;
	}
	return findSwitchByTitle(props.children, titlePart);
}

describe("account settings switches", () => {
	function render(account: Account) {
		return renderToStaticMarkup(
			<AccountListItem
				account={account}
				{...requiredHandlers}
				onAutoPauseOnOverageToggle={noop}
				onPeakHoursPauseToggle={noop}
			/>,
		);
	}

	it("gives settings switches explicit 44px targets independent of their borders", () => {
		const html = render(makeAccount({ provider: "anthropic" }));
		const switches = html.match(/<button[^>]*role="switch"[^>]*>/g) ?? [];
		expect(switches.length).toBe(2);
		for (const control of switches) {
			expect(control).toContain("after:h-11");
			expect(control).toContain("after:w-11");
			expect(control).toContain("after:-translate-x-1/2");
			expect(control).toContain("after:-translate-y-1/2");
		}
	});

	it("offers auto-fallback but no auto-refresh switch on an Anthropic row", () => {
		const html = render(makeAccount({ provider: "anthropic" }));
		expect(html).toContain("Auto-fallback:");
		expect(html).not.toContain("Auto-refresh");
	});

	it("keeps the peak-hours toggle on a zai row", () => {
		const html = render(makeAccount({ provider: "zai" }));
		expect(html).toContain("Peak hours pause:");
		expect(html).not.toContain("Auto-refresh");
	});

	it("says an overage pause resumes at window reset only with auto-fallback on", () => {
		const html = render(makeAccount({ provider: "anthropic" }));
		expect(html).toContain(
			"Account resumes when the usage window resets only if auto-fallback is on.",
		);
	});
});

describe("compact hybrid list", () => {
	it("keeps an empty fresh banked balance in Details, while held resets stay visible", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "codex",
					bankedResets: {
						tracked: true,
						availableCount: 0,
						applicableCount: 0,
						soonestExpiresAt: null,
						doesNotExpire: false,
						appliesNow: false,
						stale: false,
						observedAt: Date.now(),
					},
				})}
				{...requiredHandlers}
			/>,
		);
		expect(html).toContain("Banked resets:");
		expect(withoutDetailsContent(html)).not.toContain("Banked resets:");
	});
	it("offers a global review action and aligned comparison headings", () => {
		const html = renderToStaticMarkup(
			<AccountList
				accounts={[makeAccount({ requiresReauth: true })]}
				{...requiredHandlers}
			/>,
		);
		expect(html).toContain('aria-label="Attention across all accounts"');
		expect(html).toContain("1 needs attention");
		expect(html).toContain("Review issues");
		expect(html).toContain("Operational status");
		expect(html).toContain("5-hour used");
		expect(html).toContain("Weekly used");
	});
	it("uses a dialog trigger instead of inline settings disclosures", () => {
		const html = renderToStaticMarkup(
			<AccountListItem account={makeAccount()} {...requiredHandlers} />,
		);
		expect(html).toContain('aria-haspopup="dialog"');
		expect(html).toContain("Details");
		expect(html).not.toContain("<summary");
	});
});
