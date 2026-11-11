/**
 * Fails a pull request whose squash commit release-please cannot parse (#797).
 *
 * release-please drops a commit its parser rejects and logs that only at debug level,
 * so the release run stays green and the change is missing from the release PR. That
 * happened to #795. This check rebuilds the squash commit GitHub writes for this
 * repository (the PR title, " (#N)", and the description rewrapped at 72 columns) and
 * parses it with release-please's own parser, which reads any override block from the
 * description as it does at release time. The verdict comes from that parser alone.
 *
 * Usage: bun run scripts/check-squash-commit-parse.ts "$GITHUB_EVENT_PATH"
 *
 * Remove this script, its step in .github/workflows/prepare-router-artifacts.yml and its
 * test once release-please's parser accepts fixtures/squash-parse/pr795-body.txt.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	type Commit,
	parseConventionalCommits,
} from "release-please/build/src/commit";
import type { Logger } from "release-please/build/src/util/logger";

const WIDTH = 72;
const OVERRIDE_START = "BEGIN_COMMIT_OVERRIDE";
const OVERRIDE_END = "END_COMMIT_OVERRIDE";

export interface PullRequestFacts {
	number: number;
	title: string;
	body: string | null;
}

export interface Located {
	line: number;
	column: number;
	text: string;
}

export interface SquashCheck {
	ok: boolean;
	/** The squash commit GitHub writes. */
	message: string;
	/** What release-please parses: the squash commit, or the description's override text. */
	parsed: string;
	overrideActive: boolean;
	/** The headers release-please records. */
	entries: string[];
	errors: string[];
	/** The lines the errors point at, or null when they could not be named. */
	located: Located[] | null;
}

const codePoints = (text: string) => Array.from(text).length;

/** GitHub's default squash commit: the title, " (#N)", then the rewrapped description. */
export function squashMessage(
	title: string,
	number: number,
	body: string | null,
): string {
	const lines = (body ?? "").replace(/\r\n/g, "\n").split("\n").flatMap(wrap);
	const wrapped = lines.join("\n").replace(/^\n+|\n+$/g, "");
	return `${title} (#${number})${wrapped ? `\n\n${wrapped}` : ""}`;
}

// A line over the width is trimmed and refilled greedily on single spaces. This
// reproduced 76 of the last 80 squash bodies byte for byte; of the other 4, two
// descriptions were edited after the merge and two merges set their message by hand.
function wrap(line: string): string[] {
	if (codePoints(line) <= WIDTH) return [line];
	const out: string[] = [];
	let current = "";
	for (const word of line.trim().split(" ")) {
		const candidate = current ? `${current} ${word}` : word;
		if (codePoints(candidate) > WIDTH) {
			out.push(current);
			current = word;
		} else current = candidate;
	}
	out.push(current);
	return out;
}

function parse(
	message: string,
	pullRequest?: PullRequestFacts,
): { entries: string[]; errors: string[] } {
	// parseConventionalCommits logs only when a part fails, so any logged line fails.
	const logged: string[] = [];
	const record = (line: unknown) => {
		logged.push(String(line));
	};
	const logger: Logger = {
		error: record,
		warn: record,
		info: record,
		debug: record,
		trace: record,
	};
	const commit: Commit = { sha: "0".repeat(40), message, files: [] };
	if (pullRequest)
		commit.pullRequest = {
			headBranchName: "",
			baseBranchName: "main",
			number: pullRequest.number,
			title: pullRequest.title,
			body: pullRequest.body ?? "",
			labels: [],
			files: [],
		};
	const entries = parseConventionalCommits([commit], logger).map(
		(entry) => entry.message,
	);
	const prefix = "error message: ";
	const errors = logged
		.filter((line) => line.startsWith(prefix))
		.map((line) => line.slice(prefix.length));
	return { entries, errors: logged.length && !errors.length ? logged : errors };
}

// Mirrors splitMessages in release-please 17.11.2 only to say which line failed. It
// gives up on nested-commit blocks and on any disagreement with the verdict.
const SPLIT =
	/\r?\n\r?\n(?=(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\(.*?\))?: )/;

function locate(text: string, errors: string[]): Located[] | null {
	if (text.includes("BEGIN_NESTED_COMMIT")) return null;
	const lines = text.split(/\r?\n/);
	const found: Located[] = [];
	const seen: string[] = [];
	let offset = 0;
	for (const part of text.split(SPLIT)) {
		const start = text.indexOf(part, offset);
		offset = start + part.length;
		if (!part) continue;
		const firstLine = text.slice(0, start).split("\n").length;
		for (const error of parse(part).errors) {
			seen.push(error);
			const at = /at (\d+):(\d+)/.exec(error);
			if (!at) return null;
			const line = firstLine + Number(at[1]) - 1;
			found.push({ line, column: Number(at[2]), text: lines[line - 1] ?? "" });
		}
	}
	return seen.join("\n") === errors.join("\n") ? found : null;
}

export function checkSquashCommit(pullRequest: PullRequestFacts): SquashCheck {
	const message = squashMessage(
		pullRequest.title,
		pullRequest.number,
		pullRequest.body,
	);
	const { entries, errors } = parse(message, pullRequest);
	// As preprocessCommitMessage does: the text after the first start marker, up to the
	// end marker, replaces the commit message, even when the marker is only mentioned.
	const override = ((pullRequest.body ?? "").split(OVERRIDE_START)[1] ?? "")
		.split(OVERRIDE_END)[0]
		.trim();
	const parsed = override || message;
	return {
		ok: errors.length === 0 && entries.length > 0,
		message,
		parsed,
		overrideActive: Boolean(override),
		entries,
		errors,
		located: errors.length ? locate(parsed, errors) : [],
	};
}

function repair(check: SquashCheck): string {
	const edit = "Editing the description re-runs this check.";
	if (check.overrideActive)
		return `release-please reads everything after the first ${OVERRIDE_START} in the description, even a mention in a sentence. Make that text a valid commit message that ends at ${OVERRIDE_END}, or remove the marker. ${edit}`;
	if (check.located?.[0]?.line === 1)
		return "Retitle the pull request with a conventional prefix, such as fix: or chore:.";
	return `Reword that line of the description, or put the commit message you want between ${OVERRIDE_START} and ${OVERRIDE_END} lines in the description. ${edit}`;
}

const escapeData = (text: string) =>
	text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

// The Actions runner reads "::name::" at the start of a line and the older "##[name]"
// anywhere in one, so text from the pull request is printed only between stop-commands
// markers. The runner then processes nothing until it sees the random token.
function verbatim(lines: string[], token: string): string[] {
	return [`::stop-commands::${token}`, ...lines, `::${token}::`];
}

export function report(check: SquashCheck, token = randomUUID()): string[] {
	const source = check.overrideActive
		? `the text after ${OVERRIDE_START} in the description`
		: "this pull request's squash commit";
	if (check.ok) {
		const count = check.entries.length;
		return [
			`release-please reads ${source} as ${count} ${count === 1 ? "entry" : "entries"}:`,
			...verbatim(
				check.entries.map((entry) => `  | ${entry}`),
				token,
			),
		];
	}
	const first = check.located?.[0];
	const where = first
		? ` Line ${first.line}, column ${first.column}: ${JSON.stringify(first.text)}.`
		: "";
	const parser = check.errors.length
		? ` Parser: ${check.errors[0]}.`
		: " It records no entry from it.";
	const summary = `release-please cannot parse ${source}, so a release would leave this change out (#797).${where}${parser} ${repair(check)}`;
	const width = String(check.parsed.split("\n").length).length;
	return [
		`::error title=Squash commit unreadable by release-please::${escapeData(summary)}`,
		...verbatim(
			[
				"Parser errors:",
				...check.errors.map((error) => `  | ${error}`),
				`release-please parses this text (${source}):`,
				...check.parsed
					.split(/\r?\n/)
					.map(
						(line, index) => `  ${String(index + 1).padStart(width)} | ${line}`,
					),
			],
			token,
		),
	];
}

type Event = {
	pull_request?: {
		number?: unknown;
		title?: unknown;
		body?: unknown;
		head?: { repo?: { full_name?: string } | null };
		base?: { repo?: { full_name?: string } | null };
	};
};

export function main(
	args: string[],
	write: (line: string) => void = console.log,
): number {
	const [eventPath] = args;
	if (!eventPath) {
		write("usage: check-squash-commit-parse.ts <event.json>");
		return 2;
	}
	let event: Event;
	try {
		event = JSON.parse(readFileSync(eventPath, "utf8")) as Event;
	} catch (error) {
		write(`Cannot read the event payload at ${eventPath}: ${error}`);
		return 2;
	}
	const pullRequest = event.pull_request;
	if (!pullRequest) {
		write(
			"This event has no pull request, so there is no squash commit to check.",
		);
		return 0;
	}
	if (pullRequest.head?.repo?.full_name !== pullRequest.base?.repo?.full_name) {
		write(
			"This pull request comes from another repository. External pull requests merge with --no-ff, not a squash (AGENTS.md), so there is no squash commit to check.",
		);
		return 0;
	}
	const { number, title, body } = pullRequest;
	if (typeof number !== "number" || typeof title !== "string") {
		write("The event payload has no pull request number or title.");
		return 2;
	}
	const check = checkSquashCommit({
		number,
		title,
		body: typeof body === "string" ? body : null,
	});
	for (const line of report(check)) write(line);
	return check.ok ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
