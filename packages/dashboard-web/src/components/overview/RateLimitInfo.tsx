import type { AccountResponse } from "@better-ccflare/types";
import {
	classifyAccountStatus,
	isFutureDeadline,
} from "@better-ccflare/ui-common";
import { AlertCircle } from "lucide-react";
import { formatShortDuration } from "../../lib/utils";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";

interface RateLimitInfoProps {
	accounts: AccountResponse[];
	now?: number;
}

export function RateLimitInfo({
	accounts,
	now = Date.now(),
}: RateLimitInfoProps) {
	const limited = accounts
		.map((account) => ({
			account,
			status: classifyAccountStatus(account, now),
		}))
		.filter(({ status }) => status.overview);
	if (limited.length === 0) return null;
	return (
		<Card>
			<CardHeader>
				<CardTitle>Rate Limit Info</CardTitle>
				<CardDescription>
					Reported limits, local cooldowns and pacing
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-3">
					{limited.map(({ account, status }) => {
						const headerReset = account.rateLimitReset
							? Date.parse(account.rateLimitReset)
							: null;
						const reset =
							status.reason === "hard-limit" &&
							isFutureDeadline(headerReset, now)
								? headerReset
								: null;
						const deadline =
							status.routerRetryAt ??
							(status.reason === "pacing"
								? account.usageThrottledUntil
								: reset);
						const label =
							status.routerRetryAt != null
								? "Router retry"
								: status.reason === "pacing"
									? "Pacing until"
									: "Resets in";
						const severe = status.tone === "bad";
						return (
							<div
								key={account.id}
								className={`flex flex-wrap items-center justify-between gap-3 rounded-lg p-4 ${severe ? "bg-destructive/10" : "bg-warning/10"}`}
							>
								<div className="flex min-w-0 items-center gap-3">
									<AlertCircle
										aria-hidden="true"
										className={`h-5 w-5 shrink-0 ${severe ? "text-destructive" : "text-warning"}`}
									/>
									<div className="min-w-0 break-words">
										<p className="font-medium">{account.name}</p>
										<p className="text-sm text-muted-foreground">
											{status.label}
											{status.reason === "pacing" && " · may be model-specific"}
										</p>
										{status.reason === "hard-limit" &&
											account.rateLimitRemaining !== null && (
												<p className="text-xs text-muted-foreground">
													{account.rateLimitRemaining} requests remaining
													reported
												</p>
											)}
										{status.reason === "exhausted" && (
											<p className="text-xs text-muted-foreground">
												See usage windows for reset times
											</p>
										)}
									</div>
								</div>
								{isFutureDeadline(deadline, now) && (
									<div className="text-right">
										<p className="text-sm font-medium">
											{label} {formatShortDuration(deadline - now)}
										</p>
										<p
											className="text-xs text-muted-foreground"
											title={new Date(deadline).toLocaleString()}
										>
											{new Date(deadline).toLocaleTimeString(undefined, {
												hour: "2-digit",
												minute: "2-digit",
												second: "2-digit",
											})}{" "}
											(local)
										</p>
									</div>
								)}
							</div>
						);
					})}
				</div>
			</CardContent>
		</Card>
	);
}
