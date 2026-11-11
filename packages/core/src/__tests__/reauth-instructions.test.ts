import { describe, expect, it } from "bun:test";
import { COMMAND_NAME } from "../product-identity";
import {
	CLI_REAUTH_PROVIDERS,
	reauthCommand,
	reauthInstruction,
	supportsCliReauthentication,
} from "../reauth-instructions";

const DASHBOARD =
	"open the dashboard's Accounts page and choose Re-authenticate";

describe("reauthCommand", () => {
	it("leaves a plain account name bare", () => {
		expect(reauthCommand("work-1")).toBe(
			`${COMMAND_NAME} --reauthenticate work-1`,
		);
	});

	it("single-quotes a name the shell would split or expand", () => {
		expect(reauthCommand("my account")).toBe(
			`${COMMAND_NAME} --reauthenticate 'my account'`,
		);
		expect(reauthCommand("it's $(x)")).toBe(
			`${COMMAND_NAME} --reauthenticate 'it'\\''s $(x)'`,
		);
	});
});

describe("supportsCliReauthentication", () => {
	it("is exactly Anthropic, Qwen and xAI", () => {
		expect([...CLI_REAUTH_PROVIDERS]).toEqual(["anthropic", "qwen", "xai"]);
		for (const provider of ["anthropic", "qwen", "xai"]) {
			expect(supportsCliReauthentication(provider)).toBe(true);
		}
		for (const provider of ["codex", "openrouter", "bedrock", ""]) {
			expect(supportsCliReauthentication(provider)).toBe(false);
		}
	});
});

describe("reauthInstruction", () => {
	it("sends Codex to the dashboard only", () => {
		const text = reauthInstruction("codex", "work-1");
		expect(text).toContain(DASHBOARD);
		expect(text).not.toContain("--reauthenticate");
	});

	it("offers the dashboard and the CLI for Qwen and OAuth Anthropic", () => {
		for (const provider of ["qwen", "anthropic"]) {
			const text = reauthInstruction(provider, "work-1");
			expect(text).toContain(DASHBOARD);
			expect(text).toContain(`${COMMAND_NAME} --reauthenticate work-1`);
		}
	});

	it("offers only the CLI for an Anthropic account without a refresh token", () => {
		const text = reauthInstruction("anthropic", "work-1", {
			hasRefreshToken: false,
		});
		expect(text).toBe(`run \`${COMMAND_NAME} --reauthenticate work-1\``);
	});

	it("sends xAI through a fresh Grok sign-in, then the CLI", () => {
		expect(reauthInstruction("xai", "work-1")).toBe(
			`sign in again with \`grok --oauth\`, then run \`${COMMAND_NAME} --reauthenticate work-1\``,
		);
	});

	it("tells other providers to remove and re-add the account", () => {
		expect(reauthInstruction("openrouter", "work-1")).toBe(
			"remove the account and add it again",
		);
	});

	it("names the button, not the page, for a reader already on the dashboard", () => {
		const text = reauthInstruction("codex", "work-1", {
			audience: "dashboard",
		});
		expect(text).toStartWith("choose Re-authenticate on this account");
		expect(text).not.toContain("Accounts page");
	});
});
