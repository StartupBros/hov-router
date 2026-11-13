import { describe, expect, it, mock } from "bun:test";
import type {
	AccountRoutingOverview,
	EffectiveComboRoutingView,
} from "@better-ccflare/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../api";
import { getAccountRoutingOverviewQueryOptions } from "../hooks/queries";
import { queryKeys } from "../lib/query-keys";
import {
	AccountsTab,
	buildRoutingByAccountId,
	createAccountCreationCallbacks,
} from "./AccountsTab";

// Exercise the real row's Routing tab from the production query-cache wiring.
// SSR cannot click the disclosure; only its local open/tab state is supplied here.
const rowModule = await import("./accounts/AccountListItem");
const RealAccountListItem = rowModule.AccountListItem;
mock.module("./accounts/AccountListItem", () => ({
	...rowModule,
	AccountListItem: (props: Parameters<typeof RealAccountListItem>[0]) => {
		const React = require("react");
		const internals =
			React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
		const previous = internals.H;
		let index = 0;
		internals.H = {
			...previous,
			useState: (initial: unknown) => {
				const slot = index++;
				return [slot === 1 ? true : slot === 2 ? "routing" : initial, () => {}];
			},
		};
		try {
			return RealAccountListItem(props);
		} finally {
			internals.H = previous;
		}
	},
}));

const creationMethodNames = [
	"completeAddAccount",
	"addVertexAIAccount",
	"addBedrockAccount",
	"addZaiAccount",
	"addMinimaxAccount",
	"addDeepseekAccount",
	"addMetaAccount",
	"addNanoGPTAccount",
	"addAlibabaCodingPlanAccount",
	"addKiloAccount",
	"addOpenRouterAccount",
	"addAnthropicCompatibleAccount",
	"addOpenAIAccount",
	"addOllamaAccount",
	"addOllamaCloudAccount",
] as const;

const creationCallbackNames = [
	"onCompleteAccount",
	"onAddVertexAIAccount",
	"onAddBedrockAccount",
	"onAddZaiAccount",
	"onAddMinimaxAccount",
	"onAddDeepseekAccount",
	"onAddMetaAccount",
	"onAddNanoGPTAccount",
	"onAddAlibabaCodingPlanAccount",
	"onAddKiloAccount",
	"onAddOpenRouterAccount",
	"onAddAnthropicCompatibleAccount",
	"onAddOpenAIAccount",
	"onAddOllamaAccount",
	"onAddOllamaCloudAccount",
] as const;

function routingView(
	accountId: string,
	overrides: Partial<EffectiveComboRoutingView> = {},
): EffectiveComboRoutingView {
	return {
		family: "opus",
		policy: {
			family: "opus",
			combo: {
				id: "combo-opus",
				name: "Opus priority",
			},
		},
		resolution: {
			active: true,
			members: [
				{
					id: "member-opus",
					account_id: accountId,
					account_name: "duplicate-name",
					source: "managed",
					tier: 0,
					logical_model: "claude-opus-latest",
					reason: "included",
					availability: { available: true, reason: "available" },
					identity_provisional: false,
					rule_id: "rule-opus",
				},
			],
			decisions: [],
		},
		...overrides,
	} as EffectiveComboRoutingView;
}

function routingOverview(
	effective: EffectiveComboRoutingView[],
	opportunities: AccountRoutingOverview["opportunities"] = [],
): AccountRoutingOverview {
	return { effective, opportunities };
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "account-stable-id",
		name: "duplicate-name",
		provider: "anthropic",
		requestCount: 0,
		totalRequests: 0,
		lastUsed: null,
		created: new Date().toISOString(),
		paused: false,
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

describe("AccountsTab account creation identity", () => {
	it("returns the exact immutable API accountId from all 15 creation callbacks", async () => {
		const calls: string[] = [];
		const client = Object.fromEntries(
			creationMethodNames.map((methodName, index) => [
				methodName,
				mock(async () => {
					calls.push(methodName);
					return { accountId: `server-id-${index}` };
				}),
			]),
		) as unknown as Parameters<typeof createAccountCreationCallbacks>[0];
		const afterCreate = mock(async () => undefined);
		const callbacks = createAccountCreationCallbacks(client, afterCreate);

		const identities = [];
		for (const callbackName of creationCallbackNames) {
			const callback = callbacks[callbackName] as (
				params: never,
			) => Promise<{ accountId: string }>;
			identities.push(await callback(undefined as never));
		}

		expect(Object.keys(callbacks)).toEqual([...creationCallbackNames]);
		expect(calls).toEqual([...creationMethodNames]);
		expect(afterCreate).toHaveBeenCalledTimes(15);
		expect(identities).toEqual(
			creationMethodNames.map((_, index) => ({
				accountId: `server-id-${index}`,
			})),
		);
	});

	it("preserves the created identity when post-create invalidation fails", async () => {
		const refreshError = new Error("routing cache refresh failed");
		const client = Object.fromEntries(
			creationMethodNames.map((methodName) => [
				methodName,
				mock(async () => ({ accountId: "created-on-server" })),
			]),
		) as unknown as Parameters<typeof createAccountCreationCallbacks>[0];
		const afterCreate = mock(async () => {
			throw refreshError;
		});
		const onError = mock(() => undefined);
		const callbacks = createAccountCreationCallbacks(
			client,
			afterCreate,
			onError,
		);

		const identity = await callbacks.onAddZaiAccount(undefined as never);

		expect(identity).toEqual({ accountId: "created-on-server" });
		expect(onError).toHaveBeenCalledWith(refreshError);
	});

	it("rejects an API creation failure and does not run post-create invalidation", async () => {
		const creationError = new Error("account creation failed");
		const client = Object.fromEntries(
			creationMethodNames.map((methodName) => [
				methodName,
				mock(async () => {
					if (methodName === "addZaiAccount") throw creationError;
					return { accountId: "unused" };
				}),
			]),
		) as unknown as Parameters<typeof createAccountCreationCallbacks>[0];
		const afterCreate = mock(async () => undefined);
		const onError = mock(() => undefined);
		const callbacks = createAccountCreationCallbacks(
			client,
			afterCreate,
			onError,
		);

		expect(callbacks.onAddZaiAccount(undefined as never)).rejects.toThrow(
			"account creation failed",
		);
		expect(afterCreate).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledWith(creationError);
	});
});

describe("account routing overview query", () => {
	it("uses one overview query for ten account cards", () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const accounts = Array.from({ length: 10 }, (_, index) =>
			makeAccount({ id: `account-${index}`, name: `Account ${index}` }),
		);
		queryClient.setQueryData(queryKeys.accounts(), accounts);
		queryClient.setQueryData(
			queryKeys.accountRoutingOverview(),
			routingOverview([routingView(accounts[0]?.id ?? "account-0")]),
		);

		renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<AccountsTab />
			</QueryClientProvider>,
		);

		const routingQueryKeys = queryClient
			.getQueryCache()
			.getAll()
			.map((query) => query.queryKey)
			.filter(
				(queryKey) =>
					queryKey[0] === "better-ccflare" && queryKey[1] === "routing",
			);
		expect(routingQueryKeys).toEqual([queryKeys.accountRoutingOverview()]);
		expect(getAccountRoutingOverviewQueryOptions().queryKey).toEqual(
			queryKeys.accountRoutingOverview(),
		);
	});

	it("projects current members only from effective state and opportunities only as warnings", () => {
		const currentMemberId = "current-member";
		const outsideId = "outside-account";
		const result = buildRoutingByAccountId(
			[currentMemberId, outsideId],
			routingOverview(
				[routingView(currentMemberId)],
				[
					{
						account_id: outsideId,
						family: "opus",
						proposal_id: "proposal-opus",
						combo_id: "combo-opus",
						managed_model: "claude-opus-latest",
						tier_source: "account_priority",
						reason: "included",
					},
				],
			),
		);

		expect(result[currentMemberId]?.[0]).toMatchObject({
			membershipLabel: "Managed",
			managedRouteAvailable: false,
		});
		expect(result[outsideId]?.[0]).toMatchObject({
			membershipLabel: null,
			managedRouteAvailable: true,
		});
	});

	it("matches an outside opportunity by the exact immutable account ID", () => {
		const exactId = "acct:opaque/Δ-01";
		const lookalikeId = "acct:opaque/Δ-010";
		const current = routingView("another-account", {
			resolution: {
				family: "opus",
				combo_id: "combo-opus",
				active: true,
				reason: null,
				members: [],
				decisions: [],
			},
		});
		const result = buildRoutingByAccountId(
			[exactId, lookalikeId],
			routingOverview(
				[current],
				[
					{
						account_id: exactId,
						family: "opus",
						proposal_id: "proposal-opus",
						combo_id: "combo-opus",
						managed_model: "claude-opus-latest",
						tier_source: "account_priority",
						reason: "included",
					},
				],
			),
		);

		expect(result[exactId]?.[0]).toMatchObject({
			membershipLabel: null,
			managedRouteAvailable: true,
		});
		expect(result[lookalikeId]).toEqual([]);
	});
});

describe("AccountsTab production routing prop", () => {
	it("shows loading placeholders before accounts arrive", () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const html = renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<AccountsTab />
			</QueryClientProvider>,
		);
		expect(html).toContain("Loading accounts");
		expect(html).toContain("animate-pulse");
		expect(html).not.toContain("No accounts yet");
	});
	it("keeps initial fetch failure distinct from an empty collection", () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false, retryOnMount: false } },
		});
		const query = queryClient
			.getQueryCache()
			.build(queryClient, { queryKey: queryKeys.accounts() });
		query.setState({
			status: "error",
			error: new Error("Accounts fetch failed"),
			fetchStatus: "idle",
		});
		const html = renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<AccountsTab />
			</QueryClientProvider>,
		);
		expect(html).toContain('role="alert"');
		expect(html).toContain(
			"Network error. Please check your connection and try again.",
		);
		expect(html).toContain("Account data unavailable");
		expect(html).not.toContain("No accounts yet");
	});
	it("renders AccountList family routing from the overview cache", () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const account = makeAccount();
		queryClient.setQueryData(queryKeys.accounts(), [account]);
		queryClient.setQueryData(
			queryKeys.accountRoutingOverview(),
			routingOverview([routingView(account.id)]),
		);

		const html = renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<AccountsTab />
			</QueryClientProvider>,
		);

		expect(html).toContain("Family routing");
		expect(html).toContain(">Opus<");
		expect(html).toContain("Managed");
	});
});

describe("Details setting error handling", () => {
	it("catches all six setting failures, clears only the retrying account, and clears on success", async () => {
		const { runAccountSetting } = await import("./AccountsTab");
		const errors: Record<string, string | null> = { other: "other failure" };
		const page: { error: string | null } = { error: null };
		const setError = (id: string, error: string | null) => {
			errors[id] = error;
		};
		for (const setting of [
			"auto-fallback",
			"billing",
			"overage",
			"credit-drain",
			"peak-hours",
			"public-off",
		]) {
			errors.target = "stale";
			await runAccountSetting(
				"target",
				async () => {
					expect(errors.target).toBeNull();
					throw new Error(setting);
				},
				setError,
				(value) => {
					page.error = value;
				},
				(error) => (error as Error).message,
			);
			expect(errors.target).toBe(setting);
			expect(page.error).toBe(setting);
			expect(errors.other).toBe("other failure");
			await runAccountSetting(
				"target",
				async () => {},
				setError,
				(value) => {
					page.error = value;
				},
				String,
			);
			expect(errors.target).toBeNull();
			expect(page.error).toBeNull();
		}
	});
});

it("routes each of the six real AccountsTab callbacks through account-scoped catches", async () => {
	const React = await import("react");
	const { api } = await import("../api");
	const { spyOn } = await import("bun:test");
	const internals = (
		React as unknown as {
			__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
				H: Record<string, unknown>;
			};
		}
	).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const account = { ...makeAccount(), publicValueEnabled: true };
	queryClient.setQueryData(queryKeys.accounts(), [account]);
	const state: unknown[] = [];
	type SettingHandler =
		| "onAutoFallbackToggle"
		| "onBillingTypeToggle"
		| "onAutoPauseOnOverageToggle"
		| "onCodexCreditDrainToggle"
		| "onPeakHoursPauseToggle"
		| "onPublicValueToggle";
	type CapturedProps = Record<
		SettingHandler,
		(account: Account) => Promise<void>
	> & {
		settingsErrors: Record<string, string | null>;
		onClearSettingsError: (accountId: string) => void;
	};
	let props: CapturedProps | undefined;
	function Capture() {
		const dispatcher = internals.H;
		let index = 0;
		internals.H = {
			...dispatcher,
			useState(initial: unknown) {
				const slot = index++;
				if (!(slot in state))
					state[slot] =
						typeof initial === "function"
							? (initial as () => unknown)()
							: initial;
				return [
					state[slot],
					(value: unknown) => {
						state[slot] =
							typeof value === "function" ? value(state[slot]) : value;
					},
				];
			},
		};
		try {
			const tree = AccountsTab();
			function find(node: unknown): CapturedProps | undefined {
				if (!node || typeof node !== "object") return;
				const element = node as {
					props?: Partial<CapturedProps> & { children?: unknown };
				};
				if (element.props?.onAutoFallbackToggle)
					return element.props as CapturedProps;
				for (const child of [element.props?.children].flat(Infinity)) {
					const found = find(child);
					if (found) return found;
				}
			}
			const captured = find(tree);
			if (!captured) throw new Error("AccountList settings callbacks missing");
			props = captured;
		} finally {
			internals.H = dispatcher;
		}
		return null;
	}
	const render = () =>
		renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<Capture />
			</QueryClientProvider>,
		);
	const pairs = [
		["onAutoFallbackToggle", "updateAccountAutoFallback"],
		["onBillingTypeToggle", "updateAccountBillingType"],
		["onAutoPauseOnOverageToggle", "updateAccountAutoPauseOnOverage"],
		["onCodexCreditDrainToggle", "updateAccountCodexCreditDrain"],
		["onPeakHoursPauseToggle", "updateAccountPeakHoursPause"],
		["onPublicValueToggle", "setAccountPublicValue"],
	] as const;
	for (const [handler, method] of pairs) {
		const call = spyOn(api, method).mockRejectedValue(
			new Error("setting failure"),
		);
		try {
			render();
			if (!props) throw new Error("AccountList was not rendered");
			await props[handler](account);
			render();
			expect(call).toHaveBeenCalledTimes(1);
			expect(call.mock.calls[0]?.[0]).toBe(account.id);
			expect(props.settingsErrors[account.id]).toBeTruthy();
			props.onClearSettingsError("other");
			render();
			expect(props.settingsErrors[account.id]).toBeTruthy();
			props.onClearSettingsError(account.id);
			render();
			expect(props.settingsErrors[account.id]).toBeNull();
		} finally {
			call.mockRestore();
		}
	}
	queryClient.clear();
});
