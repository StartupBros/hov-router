import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	KNOWN_FLAGS,
	nearestKnownArgument,
	unknownArgumentLines,
} from "../unknown-argument";

const MAIN_PATH = join(import.meta.dir, "..", "main.ts");

/** Every flag label of a `case` in main.ts's parseArgs switch. */
function parseArgsCaseLabels(): string[] {
	const source = readFileSync(MAIN_PATH, "utf8");
	const start = source.indexOf("function parseArgs(");
	const end = source.indexOf("function hasRecorderCommandConflict(");
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return [...source.slice(start, end).matchAll(/case "(-{1,2}[a-z0-9-]+)":/g)]
		.map((match) => match[1])
		.sort();
}

/**
 * Run the CLI in a throwaway home with a high random port, so an argument the
 * CLI wrongly accepts boots a server only on that port, never on 8080 and
 * never against the real config directory. The process is killed after a
 * deadline; a killed run reports exitCode null.
 */
function runCli(
	args: string[],
	deadlineMs = 8000,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const home = mkdtempSync(join(tmpdir(), "hov-unknown-arg-"));
	const port = String(30000 + Math.floor(Math.random() * 20000));
	return new Promise((resolve) => {
		const child = spawn("bun", ["run", MAIN_PATH, ...args], {
			env: {
				...process.env,
				NODE_ENV: "test",
				HOME: home,
				XDG_CONFIG_HOME: join(home, "config"),
				BETTER_CCFLARE_CONFIG_PATH: join(home, "config.json"),
				BETTER_CCFLARE_DB_PATH: join(home, "test.db"),
				PORT: port,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), deadlineMs);
		child.on("close", (exitCode) => {
			clearTimeout(timer);
			rmSync(home, { recursive: true, force: true });
			resolve({ exitCode, stdout, stderr });
		});
	});
}

describe("KNOWN_FLAGS", () => {
	test("matches the case labels of parseArgs, plus the ignored --smol", () => {
		const labels = new Set(parseArgsCaseLabels());
		labels.add("--smol");
		expect([...KNOWN_FLAGS].sort()).toEqual([...labels].sort());
	});
});

describe("unknownArgumentLines", () => {
	test("names the argument and points at --help", () => {
		const lines = unknownArgumentLines("serve");
		expect(lines[0]).toContain("unknown argument: serve");
		expect(lines.at(-1)).toContain("--help");
	});

	test("suggests the nearest flag for a transposed typo", () => {
		expect(nearestKnownArgument("--lsit")).toBe("--list");
		expect(unknownArgumentLines("--lsit")).toContain("Did you mean: --list?");
	});

	test("explains --flag=value instead of guessing", () => {
		const lines = unknownArgumentLines("--port=8081");
		expect(lines.join("\n")).toContain("--port 8081");
	});

	test("suggests nothing for a token far from every flag", () => {
		expect(nearestKnownArgument("completely-different")).toBeNull();
		expect(
			unknownArgumentLines("completely-different").some((line) =>
				line.startsWith("Did you mean"),
			),
		).toBe(false);
	});

	test("shows an empty argument as quotes", () => {
		expect(unknownArgumentLines("")[0]).toContain('""');
	});
});

describe("CLI unknown arguments", () => {
	test.each([["--lsit"], ["serve"], ["--port=8081"]])(
		"%s exits 1 with an error and starts nothing",
		async (arg) => {
			const result = await runCli([arg]);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("unknown argument");
		},
		20000,
	);

	test("--smol is still accepted, as the systemd unit ships it", async () => {
		const result = await runCli(["--smol", "--version"]);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).not.toContain("unknown argument");
	}, 20000);
});
