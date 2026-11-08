// Import provider definitions from the centralized provider-config module
// This avoids circular dependencies
import {
	getDefaultEndpoint,
	isKnownProvider,
	PROVIDER_CONFIG,
	PROVIDER_NAMES,
	type ProviderName,
	requiresSessionDurationTracking,
	supportsOAuth,
	supportsUsageTracking,
} from "./provider-config";

// Re-export the imported types and constants
export {
	getDefaultEndpoint,
	isKnownProvider,
	PROVIDER_CONFIG,
	PROVIDER_NAMES,
	type ProviderName,
	requiresSessionDurationTracking,
	supportsOAuth,
	supportsUsageTracking,
};

/**
 * Account modes for adding new accounts
 */
export const ACCOUNT_MODES = {
	CLAUDE_OAUTH: "claude-oauth", // Claude CLI OAuth account
	CONSOLE: "console", // Claude API account
	ZAI: "zai", // z.ai account (API key)
	MINIMAX: "minimax", // Minimax account (API key)
	DEEPSEEK: "deepseek", // DeepSeek account (API key)
	ANTHROPIC_COMPATIBLE: "anthropic-compatible", // Anthropic-compatible provider (API key)
	OPENAI_COMPATIBLE: "openai-compatible", // OpenAI-compatible provider (API key)
	NANOGPT: "nanogpt", // NanoGPT provider (API key)
	XAI: "xai", // xAI/Grok account (Grok CLI OAuth)
	OLLAMA: "ollama", // Ollama local provider (v0.14.0+, no API key required)
	META: "meta", // Meta Model API / Muse Spark (API key)
} as const;

export type AccountMode = (typeof ACCOUNT_MODES)[keyof typeof ACCOUNT_MODES];

// The usesApiKey function needs to be defined here to avoid circular dependencies
// since it depends on both isKnownProvider and the supportsOAuth function
// For now, we'll implement it directly based on our knowledge of which providers use API keys
export function usesApiKey(provider: string): boolean {
	if (!isKnownProvider(provider)) {
		return false; // Unknown providers don't use API key authentication by default
	}
	return !supportsOAuth(provider);
}
