/**
 * The one place that says how an account signs in again. Every error, log
 * line, CLI refusal and dashboard tooltip that tells someone to
 * re-authenticate builds its text here, so the paths it names stay the ones
 * that exist for that provider:
 *
 * - Codex: the dashboard only (OpenAI device sign-in). The CLI refuses it.
 * - Qwen, and Anthropic accounts with a refresh token: the dashboard or the
 *   CLI's `--reauthenticate`.
 * - Anthropic without a refresh token (console/API-key login): the CLI.
 * - xAI: the CLI, which imports a fresh Grok CLI login.
 * - Everything else: remove the account and add it again.
 *
 * The dashboard imports this module, so it may import only product identity,
 * never the core barrel.
 */
import { COMMAND_NAME } from "./product-identity";

/** Providers `--reauthenticate` can sign in again. */
export const CLI_REAUTH_PROVIDERS = ["anthropic", "qwen", "xai"] as const;

export function supportsCliReauthentication(provider: string): boolean {
	return (CLI_REAUTH_PROVIDERS as readonly string[]).includes(provider);
}

const SHELL_SAFE_NAME = /^[A-Za-z0-9._@+-]+$/;

/** The CLI command for one account, quoted so a shell passes the name intact. */
export function reauthCommand(accountName: string): string {
	const name = SHELL_SAFE_NAME.test(accountName)
		? accountName
		: `'${accountName.replaceAll("'", "'\\''")}'`;
	return `${COMMAND_NAME} --reauthenticate ${name}`;
}

export interface ReauthInstructionOptions {
	/** False for an Anthropic account signed in without OAuth. Defaults to true. */
	hasRefreshToken?: boolean;
	/** "dashboard" when the reader is already looking at the account's row. */
	audience?: "operator" | "dashboard";
}

/**
 * How to re-authenticate an account, as a lowercase clause that reads after
 * "To re-authenticate, " or on its own.
 */
export function reauthInstruction(
	provider: string,
	accountName: string,
	options: ReauthInstructionOptions = {},
): string {
	const dashboard =
		options.audience === "dashboard"
			? "choose Re-authenticate on this account (under More actions when no button shows)"
			: "open the dashboard's Accounts page and choose Re-authenticate on the account (under More actions when no button shows)";
	const command = `\`${reauthCommand(accountName)}\``;

	switch (provider) {
		case "codex":
			return dashboard;
		case "qwen":
			return `${dashboard}, or run ${command}`;
		case "anthropic":
			return options.hasRefreshToken === false
				? `run ${command}`
				: `${dashboard}, or run ${command}`;
		case "xai":
			return `sign in again with \`grok --oauth\`, then run ${command}`;
		default:
			return "remove the account and add it again";
	}
}
