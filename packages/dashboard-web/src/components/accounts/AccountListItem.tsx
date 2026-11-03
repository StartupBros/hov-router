import { PRODUCT_NAME } from "@better-ccflare/core/product-identity";
import type { BankedResets } from "@better-ccflare/types";
import { AccountPresenter } from "@better-ccflare/ui-common";
import {
	AlertCircle,
	Edit2,
	Ellipsis,
	Globe,
	Hash,
	KeyRound,
	Pause,
	Play,
	RefreshCw,
	Trash2,
	Zap,
} from "lucide-react";
import { useState } from "react";
import type { Account } from "../../api";
import {
	providerShowsCreditsBalance,
	providerShowsWeeklyUsage,
	providerSupportsAutoFeatures,
	providerSupportsCustomBilling,
} from "../../utils/provider-utils";
import { OAuthTokenStatusWithBoundary } from "../OAuthTokenStatus";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Switch } from "../ui/switch";
import type { AccountFamilyRoutingState } from "./account-routing";
import {
	describeBankedResetExpiry,
	formatBankedResetExpiry,
} from "./BankedResetsSummary";
import { pauseStatusDisplay } from "./pause-status";
import { RateLimitProgress } from "./RateLimitProgress";
import {
	describeBindingConstraint,
	formatRateLimitStatus,
} from "./rate-limit-helpers";

function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function formatPauseReason(reason: string | null): string | null {
	// Keep internal/future pause reasons private and safely renderable. Only
	// reasons with intentional operator-facing copy are expanded here.
	switch (reason) {
		case "manual":
			return "manual";
		case "failure_threshold":
			return "failure threshold";
		case "overage":
			return "overage";
		default:
			return null;
	}
}

function formatRoutingFamily(family: string): string {
	return family.charAt(0).toUpperCase() + family.slice(1);
}

type StatusTone = "ok" | "warning" | "bad" | "muted";

const STATUS_PILL_CLASS =
	"inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium";

const STATUS_TONE_CLASS: Record<StatusTone, string> = {
	ok: "bg-green-500/10 text-green-800 dark:text-green-400",
	warning: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
	bad: "bg-destructive/10 text-red-700 dark:text-red-400",
	muted: "bg-muted text-foreground",
};

function rateLimitStatusTone(status: string): StatusTone {
	const lower = status.toLowerCase();
	if (lower.startsWith("allowed_warning")) return "warning";
	if (lower.startsWith("allowed")) return "ok";
	return "bad";
}

// The accounts API sends "-" (and some add-account responses "No active
// session") when nothing is active; neither carries information worth a slot.
const EMPTY_SESSION_INFO = new Set(["", "-", "No active session"]);

/** Label + switch pair used in the per-account settings row. */
const SETTING_CLASS = "flex items-center gap-2 whitespace-nowrap";

/**
 * Codex-only usage extras (plan_type, credits_balance) come from the free
 * wham/usage poller and can be ABSENT from usageData at any moment -- live
 * traffic overwrites cached extras between polls. Not part of the public
 * FullUsageData union (see @better-ccflare/types), so every read here is
 * null-safe and simply omits the corresponding element when absent. Mirrors
 * the CodexUsageExtras cast in RateLimitProgress.tsx for the sibling
 * code_review_* extras.
 */
interface CodexUsageExtras {
	plan_type?: string | null;
	credits_balance?: number | null;
}

function getCodexUsageExtras(account: Account): CodexUsageExtras | null {
	if (account.provider !== "codex" || !account.usageData) return null;
	return account.usageData as CodexUsageExtras;
}

function routingAvailabilityOverlay(
	state: AccountFamilyRoutingState,
): { label: string; variant: "destructive" | "warning" } | null {
	if (state.availability === null) return null;
	switch (state.availability) {
		case "available":
			return null;
		case "paused":
			return { label: "Paused", variant: "warning" };
		case "requires_reauth":
			return { label: "Needs authentication", variant: "destructive" };
		case "rate_limited":
			return { label: "Rate limited", variant: "warning" };
		case "model_exhausted":
			return { label: "Model exhausted", variant: "warning" };
	}
}

interface AccountListItemProps {
	account: Account;
	routingStates?: readonly AccountFamilyRoutingState[];
	isPrimary?: boolean;
	onPauseToggle: (account: Account) => void;
	onForceResetRateLimit: (account: Account) => void;
	onRefreshUsage: (account: Account) => Promise<void>;
	onRemove: (account: Account) => void;
	onRename: (account: Account) => void;
	onPriorityChange: (account: Account) => void;
	onAutoFallbackToggle: (account: Account) => void;
	onAutoRefreshToggle: (account: Account) => void;
	onBillingTypeToggle: (account: Account) => void;
	onAutoPauseOnOverageToggle?: (account: Account) => void;
	onCodexCreditDrainToggle?: (account: Account) => void;
	onPublicValueToggle?: (account: Account) => void;
	onPublicValueEditLabel?: (account: Account) => void;
	onPeakHoursPauseToggle?: (account: Account) => void;
	onCustomEndpointChange?: (account: Account) => void;
	onModelMappingsChange?: (account: Account) => void;
	onReauth?: (account: Account) => void;
	onAnthropicReauth?: (account: Account) => void;
	onCodexReauth?: (account: Account) => void;
}

/**
 * Per-account Codex credit drain switch. Hook-free so tests can call it
 * directly and inspect the Switch props.
 */
export function CodexCreditDrainControl({
	account,
	onToggle,
}: {
	account: Account;
	onToggle: (account: Account) => void;
}) {
	return (
		<div className={SETTING_CLASS}>
			<span className="text-xs text-muted-foreground">Drain credits:</span>
			<Switch
				checked={account.codexCreditDrainEnabled ?? false}
				aria-label={`Drain credits for ${account.name}`}
				onCheckedChange={() => onToggle(account)}
				title={`Lets ${PRODUCT_NAME} keep routing to this account after its plan window is spent, which spends purchased credits. Applies only while fresh usage data confirms credits are available.`}
			/>
			{account.codexCreditDrainServing && (
				<span
					className="text-xs font-medium text-amber-700 dark:text-amber-400"
					title="Plan window is spent; requests are being served from purchased credits"
				>
					on credits
				</span>
			)}
		</div>
	);
}

/**
 * Codex banked resets on the card: OpenAI's count, the soonest expiry and
 * whether one applies now. A stale account keeps its last values with a stale
 * mark, and an account that cannot report resets says so instead of showing 0.
 */
export function BankedResetsStatus({ resets }: { resets: BankedResets }) {
	if (!resets.tracked) {
		return (
			<span
				className="whitespace-nowrap text-muted-foreground"
				title="This account uses a custom endpoint, which does not report banked resets"
			>
				Banked resets: not tracked
			</span>
		);
	}
	const count = resets.availableCount;
	if (count === null) {
		return (
			<span
				className="whitespace-nowrap text-muted-foreground"
				title="No usage poll has reported banked resets for this account yet"
			>
				Banked resets: unknown
			</span>
		);
	}
	return (
		<span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
			<span className="whitespace-nowrap tabular-nums text-muted-foreground">
				{count} banked {count === 1 ? "reset" : "resets"}
			</span>
			{count > 0 && resets.soonestExpiresAt !== null && (
				<span
					className="whitespace-nowrap text-muted-foreground"
					title={describeBankedResetExpiry(resets.soonestExpiresAt)}
				>
					expires {formatBankedResetExpiry(resets.soonestExpiresAt)}
				</span>
			)}
			{count > 0 && resets.doesNotExpire && (
				<span className="whitespace-nowrap text-muted-foreground">
					does not expire
				</span>
			)}
			{resets.appliesNow && (
				<span
					className={`${STATUS_PILL_CLASS} ${STATUS_TONE_CLASS.ok}`}
					title="OpenAI says a banked reset would apply to this account right now"
				>
					applies now
				</span>
			)}
			{resets.stale && (
				<span
					className={`${STATUS_PILL_CLASS} ${STATUS_TONE_CLASS.warning}`}
					title={
						resets.observedAt !== null
							? `Last read ${new Date(resets.observedAt).toLocaleString()}; these are the last known values`
							: "These are the last known values"
					}
				>
					stale
				</span>
			)}
		</span>
	);
}

/**
 * Per-account "Public value" switch: publishes the account's API-equivalent
 * value on the public House of Vibe feed under a public label. Hook-free so
 * tests can call it directly and inspect the Switch props.
 */
export function PublicValueControl({
	account,
	onToggle,
	onEditLabel,
}: {
	account: Account;
	onToggle: (account: Account) => void;
	onEditLabel?: (account: Account) => void;
}) {
	const enabled = account.publicValueEnabled ?? false;
	return (
		<div className={SETTING_CLASS}>
			<span className="text-xs text-muted-foreground">Public value:</span>
			<Switch
				checked={enabled}
				aria-label={`Public value for ${account.name}`}
				onCheckedChange={() => onToggle(account)}
				title="Publishes this account's subscription value on the public House of Vibe site under a public label (never the account name)."
			/>
			{enabled && account.publicValueLabel && (
				<span
					className="text-xs font-medium"
					title="Public label shown on the House of Vibe site"
				>
					{account.publicValueLabel}
				</span>
			)}
			{enabled && onEditLabel && (
				<Button
					variant="ghost"
					size="sm"
					className="h-6 px-1"
					onClick={() => onEditLabel(account)}
					aria-label="Edit public label"
					title="Edit public label"
				>
					<Edit2 className="h-3 w-3" />
				</Button>
			)}
		</div>
	);
}

export function AccountListItem({
	account,
	routingStates = [],
	isPrimary = false,
	onPauseToggle,
	onForceResetRateLimit,
	onRefreshUsage,
	onRemove,
	onRename,
	onPriorityChange,
	onAutoFallbackToggle,
	onAutoRefreshToggle,
	onBillingTypeToggle,
	onAutoPauseOnOverageToggle,
	onCodexCreditDrainToggle,
	onPublicValueToggle,
	onPublicValueEditLabel,
	onPeakHoursPauseToggle,
	onCustomEndpointChange,
	onModelMappingsChange,
	onReauth,
	onAnthropicReauth,
	onCodexReauth,
}: AccountListItemProps) {
	const [isRefreshingUsage, setIsRefreshingUsage] = useState(false);
	const presenter = new AccountPresenter(account);
	const pauseStatus = pauseStatusDisplay(account.pauseReason);
	// Display-only: the window actually closest to blocking this account,
	// including per-model caps that the routing utilization deliberately omits.
	const bindingConstraint = describeBindingConstraint(
		account.bindingConstraint,
		account.usageWindow,
	);
	// requiresReauth is derived from the authoritative oauth_invalid_grant
	// pause reason by the API. The OR keeps older API payloads compatible.
	const reauthRequired = account.requiresReauth || pauseStatus.reauthRequired;
	// Only hard-limit statuses mean the account is actually blocked; soft warnings
	// like "allowed_warning" / "queueing_soft" mean the account is still usable.
	const HARD_LIMIT_PREFIXES = [
		"rate_limited",
		"blocked",
		"queueing_hard",
		"payment_required",
	];
	const isHardLimited = HARD_LIMIT_PREFIXES.some((prefix) =>
		presenter.rateLimitStatus.toLowerCase().startsWith(prefix),
	);
	// Also show Force Reset when rate_limited_until is in the future even if
	// rate_limit_status is soft/OK — the selector still skips the account.
	const isBlockedByLegacyLock =
		typeof account.rateLimitedUntil === "number" &&
		account.rateLimitedUntil > Date.now();
	const showForceReset =
		(isHardLimited || isBlockedByLegacyLock) && !presenter.isPaused;
	// staleLockDetected only fires when numeric usage data exists (Anthropic accounts);
	// Zai/NanoGPT accounts have usageUtilization === null and are correctly excluded
	const staleLockDetected =
		showForceReset &&
		typeof account.usageUtilization === "number" &&
		account.usageUtilization < 100;
	const isUsageThrottled =
		typeof account.usageThrottledUntil === "number" &&
		account.usageThrottledUntil > Date.now();
	const codexUsageExtras = getCodexUsageExtras(account);
	const codexCreditsBalance =
		typeof codexUsageExtras?.credits_balance === "number" &&
		codexUsageExtras.credits_balance > 0
			? codexUsageExtras.credits_balance
			: null;

	// Parse Bedrock profile and region from custom_endpoint
	let bedrockProfile: string | null = null;
	let bedrockRegion: string | null = null;
	let bedrockCrossRegionMode: string | null = null;
	if (account.provider === "bedrock" && account.customEndpoint) {
		const match = account.customEndpoint.match(/^bedrock:([^:]+):(.+)$/);
		if (match) {
			bedrockProfile = match[1];
			bedrockRegion = match[2];
		}
		bedrockCrossRegionMode = account.crossRegionMode || "geographic";
	}

	const pauseReasonLabel = formatPauseReason(account.pauseReason);
	const showRateLimitStatus =
		!presenter.isPaused && presenter.rateLimitStatus !== "OK";
	const sessionInfo = presenter.sessionInfo;
	const showSessionInfo = !EMPTY_SESSION_INFO.has(sessionInfo);
	const modelMappingCount = account.modelMappings
		? Object.keys(account.modelMappings).length
		: 0;
	const canRefreshUsage =
		account.provider === "anthropic" || account.provider === "codex";
	// One re-authentication path per provider, same gates as before.
	const reauth =
		account.provider === "qwen" && onReauth
			? {
					handler: onReauth,
					title: "Re-authenticate this Qwen account (preserves all metadata)",
				}
			: account.provider === "anthropic" &&
					account.hasRefreshToken &&
					onAnthropicReauth
				? {
						handler: onAnthropicReauth,
						title:
							"Re-authenticate this Anthropic account (preserves all metadata)",
					}
				: account.provider === "codex" && onCodexReauth
					? {
							handler: onCodexReauth,
							title:
								"Re-authenticate this Codex account (preserves all metadata)",
						}
					: null;
	const showAutoFeatures = providerSupportsAutoFeatures(account.provider);
	const showPlanBilling = providerSupportsCustomBilling(account.provider);
	const showAutoPause =
		account.provider === "anthropic" && Boolean(onAutoPauseOnOverageToggle);
	const showCreditDrain =
		account.provider === "codex" && Boolean(onCodexCreditDrainToggle);
	const showPeakHoursPause =
		account.provider === "zai" && Boolean(onPeakHoursPauseToggle);
	const hasSettings =
		showAutoFeatures ||
		showPlanBilling ||
		showAutoPause ||
		showCreditDrain ||
		Boolean(onPublicValueToggle) ||
		showPeakHoursPause;

	return (
		<article
			aria-label={account.name}
			className={`space-y-3 rounded-lg border p-4 transition-colors ${
				isPrimary
					? "border-primary bg-primary/5 shadow-sm"
					: "border-border hover:border-muted-foreground/50"
			}`}
		>
			{/* Identity on the left, actions on the right; wraps instead of overflowing. */}
			<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
				<div className="min-w-0 flex-1 space-y-1">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<h3 className="font-medium leading-tight [overflow-wrap:anywhere]">
							{account.name}
						</h3>
						{isPrimary && (
							<span className="px-2 py-0.5 text-xs font-medium bg-primary text-primary-foreground rounded-full">
								Primary
							</span>
						)}
						<span className="whitespace-nowrap rounded-full bg-secondary px-2 py-0.5 text-xs font-medium tabular-nums text-secondary-foreground">
							Priority {account.priority}
						</span>
						{codexUsageExtras?.plan_type && (
							<span className="px-2 py-0.5 text-xs font-medium bg-secondary text-secondary-foreground rounded-full">
								{codexUsageExtras.plan_type}
							</span>
						)}
						<OAuthTokenStatusWithBoundary
							accountName={account.name}
							hasRefreshToken={account.hasRefreshToken}
						/>
					</div>
					{/* No bullet separators: they strand at line ends when this wraps. */}
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
						<span>{account.provider}</span>
						{account.provider === "bedrock" && bedrockProfile && (
							<>
								<span className="whitespace-nowrap">
									Profile: {bedrockProfile}
								</span>
								{bedrockRegion && (
									<span
										className="inline-flex items-center gap-1 whitespace-nowrap"
										title={`Region: ${bedrockRegion}`}
									>
										<Globe className="h-3 w-3" />
										{bedrockRegion}
									</span>
								)}
								{bedrockCrossRegionMode && (
									<span title="Cross-region inference mode">
										{bedrockCrossRegionMode}
									</span>
								)}
							</>
						)}
						{account.provider !== "bedrock" && account.customEndpoint && (
							<span
								className="inline-flex items-center gap-1 whitespace-nowrap"
								title={`Custom endpoint: ${account.customEndpoint}`}
							>
								<Globe className="h-3 w-3" />
								custom endpoint
							</span>
						)}
						{modelMappingCount > 0 && (
							<span className="inline-flex items-center gap-1 whitespace-nowrap">
								<Hash className="h-3 w-3" />
								{modelMappingCount} model{" "}
								{modelMappingCount === 1 ? "mapping" : "mappings"}
							</span>
						)}
					</div>
				</div>
				<div className="flex shrink-0 flex-wrap items-center gap-1">
					{showForceReset && (
						<Button
							variant="outline"
							size="sm"
							className="h-8 gap-1 text-xs"
							onClick={() => onForceResetRateLimit(account)}
							title={
								staleLockDetected
									? "Reset stale rate limit lock (usage shows capacity available)"
									: "Force clear rate limit state from database"
							}
						>
							<RefreshCw className="h-3.5 w-3.5" />
							Force Reset
						</Button>
					)}
					{reauth && reauthRequired && (
						<Button
							variant="default"
							size="sm"
							className="gap-1 text-xs"
							onClick={() => reauth.handler(account)}
							title={reauth.title}
						>
							<KeyRound className="h-4 w-4" />
							Re-authenticate
						</Button>
					)}
					{canRefreshUsage && (
						<Button
							variant="ghost"
							size="sm"
							className="h-8 w-8 p-0"
							disabled={isRefreshingUsage}
							onClick={async () => {
								setIsRefreshingUsage(true);
								try {
									await onRefreshUsage(account);
								} finally {
									setIsRefreshingUsage(false);
								}
							}}
							aria-label="Refresh usage"
							title={
								account.provider === "codex"
									? "Refresh usage data (free ChatGPT usage endpoint; falls back to a minimal quota-consuming request on custom endpoints or when the free endpoint fails)"
									: "Refresh usage data (restarts usage polling and refreshes token if expired)"
							}
						>
							<RefreshCw
								className={`h-3.5 w-3.5 ${isRefreshingUsage ? "animate-spin" : ""}`}
							/>
						</Button>
					)}
					<Button
						variant="ghost"
						size="sm"
						className="h-8 w-8 p-0"
						onClick={() => onPauseToggle(account)}
						aria-label={account.paused ? "Resume account" : "Pause account"}
						title={account.paused ? "Resume account" : "Pause account"}
					>
						{account.paused ? (
							<Play className="h-4 w-4" />
						) : (
							<Pause className="h-4 w-4" />
						)}
					</Button>
					{/* modal={false}: every item opens a Radix dialog, and a modal menu
					    closing underneath one can leave pointer-events disabled on body. */}
					<DropdownMenu modal={false}>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="sm"
								className="h-8 w-8 p-0"
								aria-label={`More actions for ${account.name}`}
								title="More actions"
							>
								<Ellipsis className="h-4 w-4" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-52">
							<DropdownMenuItem
								className="gap-2"
								onSelect={() => onRename(account)}
							>
								<Edit2 className="h-4 w-4" />
								Rename…
							</DropdownMenuItem>
							<DropdownMenuItem
								className="gap-2"
								onSelect={() => onPriorityChange(account)}
							>
								<Zap className="h-4 w-4" />
								Change priority…
							</DropdownMenuItem>
							{onCustomEndpointChange && (
								<DropdownMenuItem
									className="gap-2"
									onSelect={() => onCustomEndpointChange(account)}
								>
									<Globe className="h-4 w-4" />
									Custom endpoint…
								</DropdownMenuItem>
							)}
							{onModelMappingsChange && (
								<DropdownMenuItem
									className="gap-2"
									onSelect={() => onModelMappingsChange(account)}
								>
									<Hash className="h-4 w-4" />
									Model mappings…
								</DropdownMenuItem>
							)}
							{reauth && !reauthRequired && (
								<DropdownMenuItem
									className="gap-2"
									onSelect={() => reauth.handler(account)}
								>
									<KeyRound className="h-4 w-4" />
									Re-authenticate…
								</DropdownMenuItem>
							)}
							<DropdownMenuSeparator />
							<DropdownMenuItem
								className="gap-2 text-destructive focus:text-destructive"
								onSelect={() => onRemove(account)}
							>
								<Trash2 className="h-4 w-4" />
								Remove account…
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>

			{/* Status first, then counters. */}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
				{reauthRequired ? (
					<Badge
						variant="destructive"
						title="Refresh token invalid — re-authenticate"
					>
						Re-authentication required
					</Badge>
				) : (
					presenter.isPaused && (
						<span className={`${STATUS_PILL_CLASS} ${STATUS_TONE_CLASS.muted}`}>
							{pauseReasonLabel ? `Paused (${pauseReasonLabel})` : "Paused"}
						</span>
					)
				)}
				{showRateLimitStatus && (
					<span
						className={`${STATUS_PILL_CLASS} ${
							STATUS_TONE_CLASS[rateLimitStatusTone(presenter.rateLimitStatus)]
						}`}
					>
						<span
							aria-hidden="true"
							className="h-1.5 w-1.5 rounded-full bg-current"
						/>
						{formatRateLimitStatus(presenter.rateLimitStatus)}
					</span>
				)}
				{presenter.isRateLimited && (
					<span title="Account is rate limited. Requests are rejected until the limit resets.">
						<AlertCircle
							className="h-4 w-4 text-yellow-600"
							aria-hidden="true"
						/>
						<span className="sr-only">
							Account is rate limited. Requests are rejected until the limit
							resets.
						</span>
					</span>
				)}
				{staleLockDetected && (
					<span
						className={`${STATUS_PILL_CLASS} ${STATUS_TONE_CLASS.warning}`}
						title="Stale lock detected: usage data shows available capacity but account is still rate-limited"
					>
						Stale lock detected
					</span>
				)}
				{isUsageThrottled && (
					<span
						className={`${STATUS_PILL_CLASS} ${STATUS_TONE_CLASS.warning}`}
						title="Usage throttling is delaying requests for this account until pacing catches up"
					>
						Usage throttled
					</span>
				)}
				<span className="whitespace-nowrap tabular-nums text-muted-foreground">
					{presenter.requestCount.toLocaleString()} requests
				</span>
				{showSessionInfo && (
					<span className="whitespace-nowrap tabular-nums text-muted-foreground">
						{sessionInfo}
					</span>
				)}
				{codexCreditsBalance !== null && (
					<span className="whitespace-nowrap tabular-nums text-muted-foreground">
						{codexCreditsBalance.toLocaleString()} credits
					</span>
				)}
				{account.provider === "codex" && account.bankedResets && (
					<BankedResetsStatus resets={account.bankedResets} />
				)}
			</div>

			{hasSettings && (
				<div className="flex flex-wrap items-center gap-x-5 gap-y-2">
					{showAutoFeatures && (
						<>
							<div className={SETTING_CLASS}>
								<span className="text-xs text-muted-foreground">
									Auto-fallback:
								</span>
								<Switch
									checked={account.autoFallbackEnabled}
									aria-label={`Auto-fallback for ${account.name}`}
									onCheckedChange={() => onAutoFallbackToggle(account)}
									title="Automatically switch back to this account from lower-priority ones when its rate limit resets. Requires multiple accounts with different priorities."
								/>
							</div>
							<div className={SETTING_CLASS}>
								<span className="text-xs text-muted-foreground">
									Auto-refresh:
								</span>
								<Switch
									checked={account.autoRefreshEnabled}
									aria-label={`Auto-refresh for ${account.name}`}
									onCheckedChange={() => onAutoRefreshToggle(account)}
									title="Automatically sends a minimal message when the usage window resets to avoid cold-start latency. Does not affect OAuth token refreshing."
								/>
							</div>
						</>
					)}
					{showPlanBilling && (
						<div className={SETTING_CLASS}>
							<span className="text-xs text-muted-foreground">
								Plan billing:
							</span>
							<Switch
								checked={account.billingType === "plan"}
								aria-label={`Plan billing for ${account.name}`}
								onCheckedChange={() => onBillingTypeToggle(account)}
								title="Toggle plan billing for this account"
							/>
						</div>
					)}
					{showAutoPause && onAutoPauseOnOverageToggle && (
						<div className={SETTING_CLASS}>
							<span className="text-xs text-muted-foreground">
								Auto-pause on overage:
							</span>
							<Switch
								checked={account.autoPauseOnOverageEnabled ?? false}
								aria-label={`Auto-pause on overage for ${account.name}`}
								onCheckedChange={() => onAutoPauseOnOverageToggle(account)}
								title="Automatically pause account when overage usage is detected. Note: detection only happens when Anthropic API reports overage, so some overage usage may occur before pausing. Account resumes when usage window resets."
							/>
						</div>
					)}
					{showCreditDrain && onCodexCreditDrainToggle && (
						<CodexCreditDrainControl
							account={account}
							onToggle={onCodexCreditDrainToggle}
						/>
					)}
					{onPublicValueToggle && (
						<PublicValueControl
							account={account}
							onToggle={onPublicValueToggle}
							onEditLabel={onPublicValueEditLabel}
						/>
					)}
					{showPeakHoursPause && onPeakHoursPauseToggle && (
						<div className={SETTING_CLASS}>
							<span className="text-xs text-muted-foreground">
								Peak hours pause:
							</span>
							<Switch
								checked={account.peakHoursPauseEnabled ?? false}
								aria-label={`Peak hours pause for ${account.name}`}
								onCheckedChange={() => onPeakHoursPauseToggle(account)}
								title="Automatically pause this account during Zai peak hours (14:00–18:00 SGT)"
							/>
						</div>
					)}
				</div>
			)}
			{routingStates.length > 0 && (
				<section
					aria-label={`Family routing for ${account.name}`}
					className="space-y-2"
				>
					<p className="text-xs font-medium text-muted-foreground">
						Family routing
					</p>
					<div className="flex flex-wrap gap-2">
						{routingStates.map((state) => {
							const availability = routingAvailabilityOverlay(state);
							const actionRequired =
								state.reason === "ambiguous" ||
								state.reason === "new_billing_class";
							const reasonDuplicatesMembership =
								state.membershipLabel === "Manual" &&
								state.reason === "manual_override";

							return (
								<div
									key={`${state.family}:${state.comboId ?? "none"}`}
									className="flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/20 px-2 py-1.5 text-xs"
								>
									<Badge variant="outline">
										{formatRoutingFamily(state.family)}
									</Badge>
									{state.membershipLabel && (
										<Badge
											variant={
												state.membershipLabel === "Managed"
													? "success"
													: "secondary"
											}
										>
											{state.membershipLabel}
										</Badge>
									)}
									{state.logicalModel && <span>{state.logicalModel}</span>}
									{state.tier !== null && <span>Tier {state.tier}</span>}
									{state.reasonLabel && !reasonDuplicatesMembership && (
										<span className="text-muted-foreground">
											{state.reasonLabel}
										</span>
									)}
									{actionRequired && (
										<Badge variant="warning">Action required</Badge>
									)}
									{state.managedRouteAvailable && (
										<>
											<Badge variant="warning">Managed route available</Badge>
											<span className="text-muted-foreground">
												Review in Combos
											</span>
										</>
									)}
									{availability && (
										<>
											<Badge
												variant={availability.variant}
												title={state.availabilityLabel ?? undefined}
											>
												{availability.label}
											</Badge>
											<span className="text-muted-foreground">
												membership is unchanged
											</span>
										</>
									)}
								</div>
							);
						})}
					</div>
				</section>
			)}
			{account.sessionStats && (
				<div className="text-xs text-muted-foreground">
					Session: {account.sessionStats.requests} req
					{" · "}↑{formatTokenCount(account.sessionStats.inputTokens)} in
					{" · "}✦
					{formatTokenCount(account.sessionStats.cacheCreationInputTokens)}{" "}
					cache↑
					{" · "}✦{formatTokenCount(account.sessionStats.cacheReadInputTokens)}{" "}
					cache↓
					{" · "}↓{formatTokenCount(account.sessionStats.outputTokens)} out
					{account.sessionStats.planCostUsd > 0 && (
						<>
							{" · "}${account.sessionStats.planCostUsd.toFixed(2)} plan
						</>
					)}
					{account.sessionStats.apiCostUsd > 0 && (
						<>
							{" · "}${account.sessionStats.apiCostUsd.toFixed(2)} api
						</>
					)}
				</div>
			)}
			{bindingConstraint && (
				// Deliberately NOT a replacement for the routing utilization badge
				// above: routing asks how much account-wide capacity is left, this
				// asks what is actually stopping you. Collapsing the two is what let
				// a 100% model-scoped cap hide behind a 64% account-wide badge.
				<div
					className="text-xs text-muted-foreground"
					data-testid="binding-constraint"
				>
					{bindingConstraint.divergesFromRouting ? (
						<>
							Binding limit: {bindingConstraint.label}{" "}
							{Math.round(bindingConstraint.utilization)}%
							{bindingConstraint.scope === "family"
								? " — model-scoped, not counted in the routing % above"
								: " — not the window shown above"}
						</>
					) : (
						<>
							Binding limit: {bindingConstraint.label}{" "}
							{Math.round(bindingConstraint.utilization)}% — account-wide
						</>
					)}
				</div>
			)}
			{(account.rateLimitReset ||
				account.usageData ||
				account.usageRateLimitedUntil ||
				// Codex quota data only arrives piggybacked on real traffic (no usage
				// polling endpoint), so gaps are routine. Mount the bar anyway: it
				// renders the weekly window as "Data unavailable" instead of
				// disappearing, and a missing quota bar reads as "no limit".
				account.provider === "codex" ||
				providerShowsCreditsBalance(account.provider)) && (
				<RateLimitProgress
					resetIso={account.rateLimitReset}
					usageUtilization={account.usageUtilization}
					usageWindow={account.usageWindow}
					usageData={account.usageData}
					usageRateLimitedUntil={account.usageRateLimitedUntil}
					usageThrottledUntil={account.usageThrottledUntil}
					usageThrottledWindows={account.usageThrottledWindows}
					provider={account.provider}
					showWeekly={providerShowsWeeklyUsage(account.provider)}
				/>
			)}
		</article>
	);
}
