import type {
	Account,
	AccountDisplay,
	AccountResponse,
} from "@better-ccflare/types";
import { formatTimestamp } from "./formatters";

/**
 * Account presenter - formats account data for display
 */
export class AccountPresenter {
	constructor(private account: Account | AccountResponse | AccountDisplay) {}

	get tokenStatus(): "valid" | "expired" {
		if ("tokenStatus" in this.account) {
			return this.account.tokenStatus;
		}
		if ("access_token" in this.account) {
			return this.account.access_token ? "valid" : "expired";
		}
		return "expired";
	}

	get rateLimitStatus(): string {
		if ("rateLimitStatus" in this.account) {
			return this.account.rateLimitStatus;
		}

		if (
			"rate_limited_until" in this.account &&
			this.account.rate_limited_until
		) {
			const isRateLimited = this.account.rate_limited_until > Date.now();
			return isRateLimited
				? `Rate limited until ${formatTimestamp(this.account.rate_limited_until)}`
				: "OK";
		}
		return "OK";
	}

	get sessionInfo(): string {
		if ("sessionInfo" in this.account) {
			return this.account.sessionInfo;
		}

		if ("session_start" in this.account && this.account.session_start) {
			const count =
				"session_request_count" in this.account
					? this.account.session_request_count
					: 0;
			return `Session: ${count} requests`;
		}
		return "No active session";
	}

	get requestCount(): number {
		return "requestCount" in this.account
			? this.account.requestCount
			: this.account.request_count;
	}

	get totalRequests(): number {
		return "totalRequests" in this.account
			? this.account.totalRequests
			: this.account.total_requests;
	}

	get isPaused(): boolean {
		if ("paused" in this.account) {
			return this.account.paused;
		}
		return false;
	}

	get isRateLimited(): boolean {
		if ("rate_limited_until" in this.account) {
			return Boolean(
				this.account.rate_limited_until &&
					this.account.rate_limited_until > Date.now(),
			);
		}
		const status = this.rateLimitStatus.toLowerCase();
		return status !== "ok" && !status.startsWith("allowed");
	}
}
