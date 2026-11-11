import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSquashCommit, squashMessage } from "../check-squash-commit-parse";

// Real PR descriptions and the squash commits GitHub wrote for them (#797).
const fixtures = join(import.meta.dir, "fixtures/squash-parse");
const fixture = (name: string) => readFileSync(join(fixtures, name), "utf8");
const commitFixture = (name: string) => fixture(name).replace(/\n+$/, "");
const script = join(import.meta.dir, "../check-squash-commit-parse.ts");

const t795 = "fix(codex): pause an account whose token refresh OpenAI refuses";
const t792 =
	"refactor: drop the startup warning for retired Codex settings after 5.0.0";
// The text GitHub's 72-column rewrap moved to a line start in #795's squash commit.
const line103 =
	"`Boolean(getOAuthErrorCode(error))`, which is false for a typed";

describe("squashMessage", () => {
	test("reproduces GitHub's squash commits for #795 and #792 byte for byte", () => {
		expect(squashMessage(t795, 795, fixture("pr795-body.txt"))).toBe(
			commitFixture("pr795-squash-commit.txt"),
		);
		expect(squashMessage(t792, 792, fixture("pr792-body.txt"))).toBe(
			commitFixture("pr792-squash-commit.txt"),
		);
	});

	test("rewraps a line over 72 code points and keeps shorter lines", () => {
		const long = `${"word ".repeat(20).trim()}`;
		expect(Array.from(long).length).toBeGreaterThan(72);
		const kept = "x".repeat(72);
		expect(squashMessage("fix: x", 1, `${long}\r\n${kept}`)).toBe(
			`fix: x (#1)\n\n${"word ".repeat(14).trim()}\n${"word ".repeat(6).trim()}\n${kept}`,
		);
	});

	test("an empty description leaves only the subject", () => {
		expect(squashMessage("fix: x", 1, null)).toBe("fix: x (#1)");
		expect(squashMessage("fix: x", 1, "\r\n\r\n")).toBe("fix: x (#1)");
	});
});

describe("checkSquashCommit", () => {
	test("#795's original description fails, naming the line release-please cannot read", () => {
		const check = checkSquashCommit({
			number: 795,
			title: t795,
			body: fixture("pr795-body.txt"),
		});
		expect(check.ok).toBe(false);
		expect(check.overrideActive).toBe(false);
		expect(check.entries).toEqual([]);
		expect(check.errors).toEqual([
			"Error: unexpected token '(' at 103:27, valid tokens [)]",
		]);
		expect(check.located).toEqual([{ line: 103, column: 27, text: line103 }]);
	});

	test("the same description with its override block passes", () => {
		const check = checkSquashCommit({
			number: 795,
			title: t795,
			body: fixture("pr795-override-body.txt"),
		});
		expect(check.ok).toBe(true);
		expect(check.overrideActive).toBe(true);
		expect(check.entries).toEqual([`${t795} (#795)`]);
		expect(check.errors).toEqual([]);
	});

	test("the override block still parses after a web edit stores CRLF line endings", () => {
		const body = fixture("pr795-override-body.txt").replace(/\n/g, "\r\n");
		const check = checkSquashCommit({ number: 795, title: t795, body });
		expect(check.ok).toBe(true);
		expect(check.entries).toEqual([`${t795} (#795)`]);
	});

	test("release PRs #793 and #732 and ordinary PR #792 pass", () => {
		for (const [number, title, file] of [
			[793, "chore(main): release 5.0.1", "pr793-body.txt"],
			[732, "chore(main): release 5.0.0", "pr732-body.txt"],
			[792, t792, "pr792-body.txt"],
		] as const) {
			const check = checkSquashCommit({ number, title, body: fixture(file) });
			expect(check.errors).toEqual([]);
			expect(check.entries).toEqual([`${title} (#${number})`]);
			expect(check.ok).toBe(true);
		}
	});

	test("an empty description passes", () => {
		const check = checkSquashCommit({
			number: 9,
			title: "docs: x",
			body: null,
		});
		expect(check.ok).toBe(true);
		expect(check.entries).toEqual(["docs: x (#9)"]);
	});

	test("a title release-please cannot read fails on line 1", () => {
		const title = 'Revert "fix: x"';
		const check = checkSquashCommit({ number: 5, title, body: "Undo it." });
		expect(check.ok).toBe(false);
		expect(check.located?.[0]).toMatchObject({
			line: 1,
			text: `${title} (#5)`,
		});
	});

	test("a description that only mentions the override marker in a sentence fails", () => {
		// release-please reads everything after the first marker as the commit message.
		const check = checkSquashCommit({
			number: 6,
			title: "docs: explain the override",
			body: "The repair was a `BEGIN_COMMIT_OVERRIDE` block in the description.",
		});
		expect(check.ok).toBe(false);
		expect(check.overrideActive).toBe(true);
		expect(check.entries).toEqual([]);
		expect(check.located).toEqual([
			{ line: 1, column: 2, text: "` block in the description." },
		]);
	});

	test("a second entry in the description fails alone, on its own line", () => {
		// A paragraph that starts with a prefix becomes its own release-please entry.
		const check = checkSquashCommit({
			number: 7,
			title: "feat: add x",
			body: "Summary.\n\nfix(api(v2)): repair y",
		});
		expect(check.ok).toBe(false);
		expect(check.entries).toEqual(["feat: add x (#7)"]);
		expect(check.errors).toHaveLength(1);
		expect(check.located).toEqual([
			{ line: 5, column: 8, text: "fix(api(v2)): repair y" },
		]);
	});

	test("a second entry that parses is recorded beside the first", () => {
		const check = checkSquashCommit({
			number: 8,
			title: "feat: add x",
			body: "Summary.\n\nfix(api): repair y",
		});
		expect(check.ok).toBe(true);
		expect(check.entries).toEqual(["feat: add x (#8)", "fix(api): repair y"]);
	});
});

describe("command line", () => {
	const repository = { full_name: "StartupBros/hov-router" };
	const pullRequest = (
		title: string,
		body: string | null,
		headRepository: { full_name: string } | null = repository,
	) => ({
		pull_request: {
			number: 795,
			title,
			body,
			head: { repo: headRepository },
			base: { repo: repository },
		},
	});
	function run(payload: unknown) {
		const root = mkdtempSync(join(tmpdir(), "squash-parse-"));
		try {
			const event = join(root, "event.json");
			writeFileSync(event, JSON.stringify(payload));
			const result = Bun.spawnSync([process.execPath, script, event], {
				env: { PATH: process.env.PATH },
			});
			return {
				code: result.exitCode,
				stdout: result.stdout.toString(),
				stderr: result.stderr.toString(),
			};
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
	// A model of how the Actions runner reads output (actions/runner ActionCommand.cs and
	// ActionCommandManager.cs): "::name ...::data" after leading whitespace, the older
	// "##[name ...]data" anywhere in a line, and nothing but the resume token between
	// "::stop-commands::<token>" and "::<token>::". It treats every name as a known
	// command, so it reports at least what the runner would process.
	function commandName(line: string): string | null {
		const trimmed = line.trimStart();
		if (trimmed.startsWith("::")) {
			const end = trimmed.indexOf("::", 2);
			if (end >= 0) return trimmed.slice(2, end).split(" ")[0] ?? null;
		}
		const start = line.indexOf("##[");
		const end = start < 0 ? -1 : line.indexOf("]", start);
		return end < 0 ? null : (line.slice(start + 3, end).split(" ")[0] ?? null);
	}
	function processedCommands(stdout: string): string[] {
		const processed: string[] = [];
		let stopToken: string | null = null;
		for (const line of stdout.split("\n")) {
			const name = commandName(line);
			if (name === null) continue;
			if (stopToken !== null) {
				if (name.toLowerCase() === stopToken.toLowerCase()) {
					processed.push("resume");
					stopToken = null;
				}
				continue;
			}
			if (name === "stop-commands") {
				stopToken = line.trimStart().slice("::stop-commands::".length);
				expect(stopToken).toMatch(/^[0-9a-f-]{36}$/);
			}
			processed.push(name);
		}
		expect(stopToken).toBeNull();
		return processed;
	}
	const annotationOf = (stdout: string) =>
		stdout.split("\n").filter((line) => line.startsWith("::error "));

	test("passes a readable squash commit and prints the entries release-please records", () => {
		const result = run(pullRequest(t795, fixture("pr795-override-body.txt")));
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`  | ${t795} (#795)`);
		expect(processedCommands(result.stdout)).toEqual([
			"stop-commands",
			"resume",
		]);
	});

	test("fails #795's original description with one annotation naming the line and the repairs", () => {
		const result = run(pullRequest(t795, fixture("pr795-body.txt")));
		expect(result.code).toBe(1);
		expect(processedCommands(result.stdout)).toEqual([
			"error",
			"stop-commands",
			"resume",
		]);
		const [annotation] = annotationOf(result.stdout);
		expect(annotation).toStartWith("::error title=");
		expect(annotation).toContain("Line 103, column 27");
		expect(annotation).toContain(JSON.stringify(line103));
		expect(annotation).toContain("BEGIN_COMMIT_OVERRIDE");
		expect(annotation).toContain("Editing the description re-runs this check");
		expect(result.stdout).toContain(` 103 | ${line103}`);
	});

	test("the runner processes no workflow command written in the title or description", () => {
		const forged =
			"::stop-commands::token\n::error::forged\ntext ##[error]forged\n::token::\n##[set-output name=x]y";
		const failing = run(pullRequest('Revert "fix: x ##[warning]t"', forged));
		expect(failing.code).toBe(1);
		expect(processedCommands(failing.stdout)).toEqual([
			"error",
			"stop-commands",
			"resume",
		]);
		expect(failing.stdout).toContain("text ##[error]forged");

		const passing = run(pullRequest("fix: x ##[error]forged", forged));
		expect(passing.code).toBe(0);
		expect(passing.stdout).toContain("  | fix: x ##[error]forged (#795)");
		expect(processedCommands(passing.stdout)).toEqual([
			"stop-commands",
			"resume",
		]);
	});

	test("an event without a pull request has nothing to check", () => {
		const result = run({ inputs: {} });
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("no pull request");
	});

	test("a pull request from another repository is not checked, because it merges with --no-ff", () => {
		for (const head of [{ full_name: "someone/hov-router" }, null]) {
			const result = run(pullRequest('Revert "fix: x"', null, head));
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("--no-ff");
		}
	});

	test("an unreadable event payload is a usage error", () => {
		const result = Bun.spawnSync([
			process.execPath,
			script,
			join(tmpdir(), "squash-parse-missing", "event.json"),
		]);
		expect(result.exitCode).toBe(2);
	});
});
