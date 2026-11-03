import type {
	CodexResetCreditRow,
	DatabaseOperations,
} from "@better-ccflare/database";
import { jsonResponse } from "@better-ccflare/http-common";
import {
	isCodexSubscriptionEndpoint,
	resolveCodexEndpoint,
} from "@better-ccflare/providers";
import type {
	BankedResets,
	BankedResetsAppliesNowEntry,
	BankedResetsSummary,
} from "@better-ccflare/types";
import { assessBankedResets } from "../services/codex-reset-credits";

/** The account columns banked resets need. */
export interface BankedResetsAccount {
	id: string;
	name: string;
	provider: string | null;
	custom_endpoint: string | null;
}

interface AssessedAccount {
	account: BankedResetsAccount;
	resets: BankedResets;
	/**
	 * Groups router accounts signed in to one ChatGPT account. Internal only:
	 * it never leaves this module.
	 */
	chatgptAccountHash: string | null;
}

function emptyResets(tracked: boolean): BankedResets {
	return {
		tracked,
		availableCount: null,
		applicableCount: null,
		soonestExpiresAt: null,
		doesNotExpire: false,
		appliesNow: false,
		// A tracked account with no observation yet has nothing current to show.
		stale: tracked,
		observedAt: null,
	};
}

async function assessCodexAccounts(
	dbOps: DatabaseOperations,
	accounts: BankedResetsAccount[],
	now: number,
): Promise<AssessedAccount[]> {
	const codex = accounts.filter((account) => account.provider === "codex");
	if (codex.length === 0) return [];
	const repo = dbOps.getCodexResetCreditsRepository();
	const [states, credits] = await Promise.all([
		repo.listAllStates(),
		repo.listLiveCredits(),
	]);
	const stateById = new Map(states.map((state) => [state.accountId, state]));
	const creditsById = new Map<string, CodexResetCreditRow[]>();
	for (const credit of credits) {
		const list = creditsById.get(credit.accountId);
		if (list) list.push(credit);
		else creditsById.set(credit.accountId, [credit]);
	}

	return codex.map((account) => {
		// A custom endpoint is not the ChatGPT subscription API, which is the
		// only source of reset counts.
		if (
			!isCodexSubscriptionEndpoint(
				resolveCodexEndpoint(account.custom_endpoint, account.name),
			)
		) {
			return { account, resets: emptyResets(false), chatgptAccountHash: null };
		}
		const state = stateById.get(account.id);
		if (!state) {
			return { account, resets: emptyResets(true), chatgptAccountHash: null };
		}
		return {
			account,
			resets: {
				tracked: true,
				...assessBankedResets(state, creditsById.get(account.id) ?? [], now),
			},
			chatgptAccountHash: state.chatgptAccountHash,
		};
	});
}

/** Banked resets for each Codex account in `accounts`, keyed by account id. */
export async function loadBankedResets(
	dbOps: DatabaseOperations,
	accounts: BankedResetsAccount[],
	now: number,
): Promise<Map<string, BankedResets>> {
	const assessed = await assessCodexAccounts(dbOps, accounts, now);
	return new Map(assessed.map((entry) => [entry.account.id, entry.resets]));
}

/**
 * Fleet view of tracked accounts. The total counts each ChatGPT account once,
 * from its freshest observation, so two router accounts signed in to one
 * ChatGPT account are not double counted.
 */
function summarizeBankedResets(
	assessed: AssessedAccount[],
): BankedResetsSummary {
	const tracked = assessed.filter((entry) => entry.resets.tracked);
	const freshestByChatGptAccount = new Map<string, BankedResets>();
	let soonestExpiresAt: number | null = null;
	const appliesNow: BankedResetsAppliesNowEntry[] = [];
	for (const { account, resets, chatgptAccountHash } of tracked) {
		const key = chatgptAccountHash ?? `account:${account.id}`;
		const held = freshestByChatGptAccount.get(key);
		if (!held || (resets.observedAt ?? -1) > (held.observedAt ?? -1)) {
			freshestByChatGptAccount.set(key, resets);
		}
		if (
			resets.soonestExpiresAt !== null &&
			(soonestExpiresAt === null || resets.soonestExpiresAt < soonestExpiresAt)
		) {
			soonestExpiresAt = resets.soonestExpiresAt;
		}
		if (resets.appliesNow) {
			appliesNow.push({
				accountId: account.id,
				accountName: account.name,
				applicableCount: resets.applicableCount ?? 0,
				stale: resets.stale,
			});
		}
	}
	let totalAvailable = 0;
	for (const resets of freshestByChatGptAccount.values()) {
		totalAvailable += resets.availableCount ?? 0;
	}
	return {
		totalAvailable,
		soonestExpiresAt,
		appliesNow,
		anyStale: tracked.some((entry) => entry.resets.stale),
		trackedAccounts: tracked.length,
	};
}

/** GET /api/banked-resets: the fleet summary of banked Codex resets. */
export function createBankedResetsSummaryHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		const accounts = await dbOps.getAdapter().query<BankedResetsAccount>(
			`SELECT id, name, provider, custom_endpoint FROM accounts
				 WHERE provider = ? ORDER BY name, id`,
			["codex"],
		);
		const assessed = await assessCodexAccounts(dbOps, accounts, Date.now());
		return jsonResponse(summarizeBankedResets(assessed));
	};
}
