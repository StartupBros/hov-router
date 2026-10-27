import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");

// Reachable only through runCli (packages/cli-commands/src/runner.ts), which
// nothing calls; its subcommands are not the binary's syntax.
const UNREACHABLE = new Set([
	"packages/cli-commands/src/runner.ts",
	"packages/cli-commands/src/commands/token-health.ts",
]);

// A command name, or the source-checkout script, followed by its first flag.
const HINT =
	/(?:\$\{COMMAND_NAME\}|\$\{LEGACY_COMMAND_NAME\}|\bbun run cli|(?<![\w/.~-])(?:hov-router|better-ccflare))\s+(--[a-z][a-z0-9-]*)/g;

function runtimeSources(): { path: string; lines: string[] }[] {
	const paths = [
		...new Bun.Glob("apps/*/src/**/*.{ts,tsx}").scanSync({ cwd: root }),
		...new Bun.Glob("packages/*/src/**/*.{ts,tsx}").scanSync({ cwd: root }),
	];
	return paths
		.filter(
			(path) =>
				!path.includes("/__tests__/") &&
				!/\.test\.tsx?$/.test(path) &&
				!/^inline-.*worker\.ts$/.test(basename(path)) &&
				!UNREACHABLE.has(path),
		)
		.sort()
		.map((path) => ({
			path,
			lines: readFileSync(join(root, path), "utf8").split("\n"),
		}));
}

function acceptedFlags(): Set<string> {
	const main = readFileSync(join(root, "apps/cli/src/main.ts"), "utf8");
	return new Set(
		[...main.matchAll(/case "(--[a-z0-9-]+)":/g)].map((match) => match[1]),
	);
}

describe("runtime command hints", () => {
	const sources = runtimeSources();

	test("name the installed command, not a source-checkout script", () => {
		const offenders = sources.flatMap(({ path, lines }) =>
			lines.flatMap((line, index) =>
				/\bbun run cli\b|\bbun start\b/.test(line)
					? [`${path}:${index + 1}: ${line.trim()}`]
					: [],
			),
		);
		expect(offenders).toEqual([]);
	});

	test("name only flags the CLI accepts", () => {
		const flags = acceptedFlags();
		expect(flags.has("--reauthenticate")).toBe(true);
		expect(flags.has("--serve")).toBe(true);

		const hints = sources.flatMap(({ path, lines }) =>
			lines.flatMap((line, index) =>
				[...line.matchAll(HINT)].map((match) => ({
					where: `${path}:${index + 1}`,
					flag: match[1],
				})),
			),
		);
		expect(hints.length).toBeGreaterThanOrEqual(20);
		expect(hints.filter(({ flag }) => !flags.has(flag))).toEqual([]);
	});
});
