import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Logger } from "@better-ccflare/logger";
import { Config } from "./index";

/**
 * The config file holds pg_password, local_control_secret and other secrets,
 * so it must be readable by its owner only.
 *
 * Adapted from SijanC147/better-ccflare config-file-mode.test.ts (f2dc5c8e5),
 * covering the in-place write kept here rather than the fork's temp-file
 * rename.
 *
 * The umask is pinned at 022: under umask 077 the old code already produced
 * 0600, and the tightening assertions would pass against it.
 */
function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

let savedUmask: number;
let dir: string;
let logSpies: ReturnType<typeof spyOn>[];

beforeEach(() => {
	savedUmask = process.umask(0o022);
	dir = mkdtempSync(join(tmpdir(), "hov-config-mode-"));
	logSpies = (["info", "warn", "error"] as const).map((level) =>
		spyOn(Logger.prototype, level).mockImplementation(() => {}),
	);
});

afterEach(() => {
	process.umask(savedUmask);
	for (const spy of logSpies) spy.mockRestore();
	rmSync(dir, { recursive: true, force: true });
});

describe("config file mode", () => {
	it("creates a missing config file 0600", () => {
		const path = join(dir, "better-ccflare.json");
		new Config(path);
		expect(mode(path)).toBe(0o600);
	});

	it("tightens an existing 0644 config on load and keeps it 0600 across saves", () => {
		const path = join(dir, "better-ccflare.json");
		writeFileSync(path, JSON.stringify({ label: "original" }));
		chmodSync(path, 0o644);

		const config = new Config(path);
		expect(mode(path)).toBe(0o600);

		config.set("label", "updated");
		expect(mode(path)).toBe(0o600);
		expect(readJson(path).label).toBe("updated");
	});

	it("writes 0600, not 0400, under umask 0277 so a later save still lands", () => {
		// The create mode is masked by the umask. Left at 0400, the next
		// in-place save fails to open the file for writing.
		process.umask(0o277);
		const path = join(dir, "better-ccflare.json");

		const config = new Config(path);
		expect(mode(path)).toBe(0o600);

		config.set("label", "second-save");
		expect(readJson(path).label).toBe("second-save");
	});

	it("tightens the target of a symlinked config and keeps the link", () => {
		// Dotfiles setups link the config from elsewhere. A save must write
		// through the link, never replace it with a regular file.
		const target = join(dir, "dotfiles", "better-ccflare.json");
		mkdirSync(dirname(target));
		writeFileSync(target, JSON.stringify({ label: "original" }));
		chmodSync(target, 0o644);
		const link = join(dir, "better-ccflare.json");
		symlinkSync(target, link);

		const config = new Config(link);
		config.set("label", "via-link");

		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(mode(target)).toBe(0o600);
		expect(readJson(target).label).toBe("via-link");
	});

	it("leaves a directory at the config path alone", () => {
		// Stripping a directory's execute bits would lock the operator out of
		// the database beside it.
		const path = join(dir, "better-ccflare.json");
		mkdirSync(path);
		chmodSync(path, 0o755);

		new Config(path);

		expect(mode(path)).toBe(0o755);
	});
});

describe("config directory mode", () => {
	it("creates a missing config directory 0700", () => {
		const configDir = join(dir, "better-ccflare");
		new Config(join(configDir, "better-ccflare.json"));
		expect(mode(configDir)).toBe(0o700);
	});

	it("never changes the mode of a config directory that already exists", () => {
		// Production keeps runner scripts and other files in its existing 0755
		// config directory.
		const configDir = join(dir, "existing");
		mkdirSync(configDir);
		chmodSync(configDir, 0o755);

		new Config(join(configDir, "better-ccflare.json"));

		expect(mode(configDir)).toBe(0o755);
	});
});
