import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTER_REPOSITORY_ID } from "../../packages/core/src/router-repository";

const file = join(
	import.meta.dir,
	"../../.github/workflows/tool-drop-announce.yml",
);
const workflow = Bun.YAML.parse(readFileSync(file, "utf8")) as {
	on: { release: { types: string[] } };
	permissions: Record<string, string>;
	jobs: Record<
		string,
		{ if: string; permissions: Record<string, string>; uses: string }
	>;
};
const announce = workflow.jobs.announce;

// Fixture evaluation of the checked-in condition, not proof of real GitHub execution.
function runs(github: unknown) {
	return Function("github", `return (${announce.if});`)(github) as boolean;
}

function event(
	repositoryId: string | undefined,
	release: { draft: boolean; prerelease: boolean },
) {
	return { repository_id: repositoryId, event: { release } };
}

test("runs on published and edited releases only", () => {
	expect(Object.keys(workflow.on)).toEqual(["release"]);
	expect(workflow.on.release.types).toEqual(["published", "edited"]);
});

test("grants no token scope beyond reading and minting the release token", () => {
	expect(workflow.permissions).toEqual({});
	expect(Object.keys(workflow.jobs)).toEqual(["announce"]);
	expect(announce.permissions).toEqual({
		contents: "read",
		"id-token": "write",
	});
});

// pushbot accepts the token only from this workflow at a commit that descends
// from its hardened baseline and is on hov-stack's main, so a branch or tag ref
// here would be refused; a full SHA is also the only immutable pin.
test("calls hov-stack's announce workflow at a full commit SHA", () => {
	expect(announce.uses).toMatch(
		/^StartupBros-com\/hov-stack\/\.github\/workflows\/hov-tool-drop-announce\.yml@[0-9a-f]{40}$/,
	);
});

test("announces only full releases of this repository, by id", () => {
	const id = String(ROUTER_REPOSITORY_ID);
	const full = { draft: false, prerelease: false };
	expect(runs(event(id, full))).toBe(true);
	for (const other of [undefined, "", "1", `0${id}`, `${id}-extra`])
		expect(runs(event(other, full))).toBe(false);
	expect(runs(event(id, { draft: true, prerelease: false }))).toBe(false);
	expect(runs(event(id, { draft: false, prerelease: true }))).toBe(false);
});
