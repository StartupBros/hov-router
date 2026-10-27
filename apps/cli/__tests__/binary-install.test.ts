import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { COMMAND_NAMES } from "../../../packages/core/src/product-identity";

const root = resolve(import.meta.dir, "../../..");
const reference = readFileSync(join(root, "docs/reference.md"), "utf8");
const releaseGuide = readFileSync(
	join(root, "docs/hov-router-releases.md"),
	"utf8",
);
const migrationGuide = readFileSync(
	join(root, "docs/hov-router-migration.md"),
	"utf8",
);
const releaseDigest =
	"f6e6ee137d0766eb6df9d6c76d264603e9696c12797e1570b8ad6b9648d0b12c";
const releaseUrl =
	"https://github.com/StartupBros/hov-router/releases/download/v3.7.1/better-ccflare-linux-amd64";
const sourceSha = "6b88f789e30c3a86ee918d35a6673e7be12f9243";
const historicalDigest =
	"b01a4989323ecf4e2d0a68394b45828741430d89eb35288f7318a28c45b4c9d7";
const historicalSha = "5d7b2a888a9b61d87916332b414e46606498d896";
// Synthetic downloads only: this is not proof of the real published releases.
// Only the expected digests are substituted; Bash and sha256sum remain real.
function syntheticBinary(display: string, version: string, sha: string) {
	return `#!/bin/sh
printf 'executed\\n' >> "$HOME/executed"
case "$1" in
  --help) printf '${display}\\n';;
  --version) printf '${display} v${version}\\n';;
  --git-sha) printf '${sha}\\n';;
esac
`;
}
const payload = syntheticBinary("HoV Router", "3.7.1", sourceSha);
const historicalPayload = syntheticBinary(
	"wstack Router",
	"3.6.2",
	historicalSha,
);
// The earlier HoV Router release; its guide installed under hov-router/3.7.0.
const previousPayload = syntheticBinary(
	"HoV Router",
	"3.7.0",
	"79a957526bd1994cb3c52b6a110de3c70c1e5c6f",
);
const fixtureDigest = createHash("sha256").update(payload).digest("hex");
const historicalFixtureDigest = createHash("sha256")
	.update(historicalPayload)
	.digest("hex");
const historicalRun =
	'"$HOME/.local/lib/wstack-router/3.6.2/wstack-router" --help\n';
// Guides for 3.6.2 through 3.7.1 created all three names; new installs create
// COMMAND_NAMES only, and upgrades repoint an existing wstack-router link.
const earlierGuideAliases = [
	"hov-router",
	"wstack-router",
	"better-ccflare",
] as const;
const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

function block(marker: string) {
	const document = marker.startsWith("router-release-provenance")
		? releaseGuide
		: reference;
	const sections = document.split(`<!-- ${marker} -->`);
	expect(sections, `reference block ${marker}`).toHaveLength(2);
	return sections[1]
		.split(`<!-- /${marker} -->`)[0]
		.split("```bash\n")[1]
		.split("```")[0];
}

function fixture(mode = "ok") {
	const home = mkdtempSync(join(tmpdir(), "hov-binary-install-"));
	homes.push(home);
	const tools = join(home, "tools");
	mkdirSync(tools);
	writeFileSync(join(home, "payload"), payload);
	writeFileSync(join(home, "bundle-fixture"), "synthetic attestation bundle\n");
	for (const profile of [".profile", ".bashrc", ".zshrc"])
		writeFileSync(join(home, profile), "keep profile\n");
	// This stand-in is transport. Record every request and honor --output;
	// no network, provider requests, credential environment, or fake checksum pass.
	writeFileSync(
		join(tools, "curl"),
		`#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$HOME/downloads"
output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift ;;
  esac
  shift
done
case "$DOWNLOAD_MODE" in
  fail) exit 22 ;;
  corrupt) printf 'corrupt\\n' > "$output" ;;
  *) cp "$HOME/payload" "$output" ;;
esac
`,
		{ mode: 0o755 },
	);
	// A strict policy stand-in, not a cryptographic verifier. The real checksum
	// and extracted documentation run unchanged except for the fixture digests.
	// The current release verifies in place; 3.6.2 verifies a downloaded bundle.
	writeFileSync(
		join(tools, "gh"),
		`#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$HOME/attestations"
binary="$HOME/.local/lib/hov-router/3.7.1/hov-router"
historical="$HOME/.local/lib/wstack-router/3.6.2/wstack-router"
bundle="$PWD/sha256:${historicalFixtureDigest}.jsonl"
case "$1 $2" in
  'attestation download')
    [ "$#" -eq 5 ] && [ "$3" = "$historical" ] && [ "$4" = --repo ] && [ "$5" = StartupBros/hov-router ] || exit 91
    [ "$DOWNLOAD_MODE" != attestation-fail ] || exit 22
    cp "$HOME/bundle-fixture" "$bundle"
    if [ "$DOWNLOAD_MODE" = bad-bundle ]; then printf 'corrupt\\n' > "$bundle"; fi
    ;;
  'attestation verify')
    if [ "$3" = "$binary" ]; then
      [ "$DOWNLOAD_MODE" != attestation-fail ] || exit 1
      expected=(attestation verify "$binary" --repo StartupBros/hov-router
        --source-digest ${sourceSha} --source-ref refs/tags/v3.7.1
        --cert-identity https://github.com/StartupBros/hov-router/.github/workflows/router-release-artifacts.yml@refs/tags/v3.7.1
        --signer-digest ${sourceSha} --deny-self-hosted-runners)
      [ "$#" -eq "\${#expected[@]}" ] || exit 92
      for arg in "\${expected[@]}"; do [ "$1" = "$arg" ] || exit 92; shift; done
      printf '%s  %s\\n' '${fixtureDigest}' "$binary" | sha256sum --check --strict -
    else
      expected=(attestation verify "$historical" --repo StartupBros/wstack-router
        --source-digest ${historicalSha} --source-ref refs/tags/v3.6.2
        --cert-identity https://github.com/StartupBros/wstack-router/.github/workflows/router-release-artifacts.yml@refs/tags/v3.6.2
        --signer-digest ${historicalSha} --deny-self-hosted-runners --bundle "$bundle")
      [ "$#" -eq "\${#expected[@]}" ] || exit 92
      for arg in "\${expected[@]}"; do [ "$1" = "$arg" ] || exit 92; shift; done
      cmp "$HOME/bundle-fixture" "$bundle"
      printf '%s  %s\\n' '${historicalFixtureDigest}' "$historical" | sha256sum --check --strict -
    fi
    ;;
  *) exit 93 ;;
esac
`,
		{ mode: 0o755 },
	);
	const binDir = join(home, ".local/bin");
	const historicalBinary = join(
		home,
		".local/lib/wstack-router/3.6.2/wstack-router",
	);
	const previousBinary = join(home, ".local/lib/hov-router/3.7.0/hov-router");
	return {
		home,
		binary: join(home, ".local/lib/hov-router/3.7.1/hov-router"),
		versionDir: join(home, ".local/lib/hov-router/3.7.1"),
		historicalBinary,
		previousBinary,
		binDir,
		// Plant the layout that earlier versions of this guide produced for 3.6.2.
		installHistorical(aliases: readonly string[] = earlierGuideAliases) {
			mkdirSync(dirname(historicalBinary), { recursive: true });
			writeFileSync(historicalBinary, historicalPayload, { mode: 0o755 });
			mkdirSync(binDir, { recursive: true });
			for (const name of aliases)
				symlinkSync(historicalBinary, join(binDir, name));
		},
		// Plant the layout that the 3.7.0 version of this guide produced.
		installPrevious(aliases: readonly string[] = earlierGuideAliases) {
			mkdirSync(dirname(previousBinary), { recursive: true });
			writeFileSync(previousBinary, previousPayload, { mode: 0o755 });
			mkdirSync(binDir, { recursive: true });
			for (const name of aliases)
				symlinkSync(previousBinary, join(binDir, name));
		},
		run(
			marker: string,
			rewrite = (script: string) => script,
			then: string | false = false,
		) {
			const script = rewrite(
				block(marker)
					.replaceAll(releaseDigest, fixtureDigest)
					.replaceAll(historicalDigest, historicalFixtureDigest),
			);
			return spawnSync(
				"/bin/bash",
				[
					"--noprofile",
					"--norc",
					"-eu",
					"-c",
					script + (then ? `\n${then}` : ""),
				],
				{
					cwd: home,
					env: {
						HOME: home,
						TMPDIR: home,
						PATH: `${tools}:/usr/bin:/bin`,
						DOWNLOAD_MODE: mode,
					},
					encoding: "utf8",
					timeout: 10000,
				},
			);
		},
	};
}

describe("documented binary install (synthetic downloads)", () => {
	it("offers the full pinned provenance policy before the first run", () => {
		const link =
			"hov-router-releases.md#optional-consumer-provenance-verification";
		expect(reference.indexOf(link)).toBeGreaterThan(0);
		expect(reference.indexOf(link)).toBeLessThan(
			reference.indexOf("<!-- router-release-run -->"),
		);
		const policy = block("router-release-provenance");
		// This checks documented policy, not live GitHub signatures or authenticity.
		for (const pin of [
			'binary="$HOME/.local/lib/hov-router/3.7.1/hov-router"',
			`source_sha=${sourceSha}`,
			`digest=${releaseDigest}`,
			'gh attestation verify "$binary"',
			"--repo StartupBros/hov-router",
			'--source-digest "$source_sha"',
			"--source-ref refs/tags/v3.7.1",
			"--cert-identity https://github.com/StartupBros/hov-router/.github/workflows/router-release-artifacts.yml@refs/tags/v3.7.1",
			'--signer-digest "$source_sha"',
			"--deny-self-hosted-runners",
		])
			expect(policy).toContain(pin);
		// The current release must not borrow the historical signing identity.
		expect(policy).not.toContain("wstack-router");
		// The former name is recorded once, in the migration guide's move history.
		expect(migrationGuide.replace(/\s+/g, " ")).toContain(
			"renamed from `StartupBros/wstack-router` on 2026-10-21",
		);
		for (const document of [reference, releaseGuide]) {
			expect(document).toContain("`StartupBros/hov-router`");
			expect(document).toContain("1278801682");
			expect(document).toContain("hov-router-migration.md#repository-move");
			expect(document).not.toContain("Before the repository rename");
		}
	});

	it("downloads one pinned binary, verifies it, and waits for a separate run step", () => {
		const commands = block("router-release-install");
		expect(commands).not.toMatch(/\b(gh|node|bun)\b/);
		expect(commands.trim().split("\n").length).toBeLessThanOrEqual(15);
		expect(commands).toContain(releaseDigest);
		expect(commands).toContain(releaseUrl);
		const f = fixture();
		const result = f.run("router-release-install");
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("hov-router: OK");
		expect(readFileSync(f.binary, "utf8")).toBe(payload);
		expect(statSync(f.binary).mode & 0o100).toBe(0o100);
		expect(
			readFileSync(join(f.home, "downloads"), "utf8").trim().split("\n"),
		).toHaveLength(1);
		expect(readFileSync(join(f.home, "downloads"), "utf8")).toContain(
			releaseUrl,
		);
		expect(existsSync(join(f.home, "executed"))).toBe(false);
		expect(existsSync(f.binDir)).toBe(false);
		expect(f.run("router-release-run").status).toBe(0);
		expect(readFileSync(join(f.home, "executed"), "utf8")).toBe("executed\n");
	});

	it("rejects corrupt bytes before granting executable permissions", () => {
		const f = fixture("corrupt");
		const result = f.run("router-release-install");
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("hov-router: FAILED");
		expect(statSync(f.binary).mode & 0o111).toBe(0);
		expect(existsSync(join(f.home, "executed"))).toBe(false);
	});

	it("stops when the download fails", () => {
		const f = fixture("fail");
		const result = f.run("router-release-install");
		expect(result.status).toBe(22);
		expect(result.stdout).not.toContain("OK");
		expect(existsSync(f.binary)).toBe(false);
		expect(existsSync(join(f.home, "executed"))).toBe(false);
	});

	it.each([
		"directory",
		"symlink",
		"broken symlink",
		"file",
	])("preserves an existing version path (%s) without downloading", (kind) => {
		const f = fixture();
		mkdirSync(join(f.home, ".local/lib/hov-router"), { recursive: true });
		const target = join(f.home, "previous-install");
		mkdirSync(target);
		writeFileSync(join(target, "sentinel"), "keep");
		if (kind === "directory") {
			mkdirSync(f.versionDir);
			writeFileSync(join(f.versionDir, "sentinel"), "keep");
		} else if (kind === "file") {
			writeFileSync(f.versionDir, "keep");
		} else {
			symlinkSync(
				kind === "symlink" ? target : `${target}-missing`,
				f.versionDir,
			);
		}
		const before = lstatSync(f.versionDir);
		expect(f.run("router-release-install").status).not.toBe(0);
		expect(lstatSync(f.versionDir).ino).toBe(before.ino);
		if (kind === "directory")
			expect(readFileSync(join(f.versionDir, "sentinel"), "utf8")).toBe("keep");
		else if (kind === "file")
			expect(readFileSync(f.versionDir, "utf8")).toBe("keep");
		else
			expect(readlinkSync(f.versionDir)).toBe(
				kind === "symlink" ? target : `${target}-missing`,
			);
		expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("keep");
		expect(existsSync(join(target, "hov-router"))).toBe(false);
		expect(existsSync(join(f.home, "downloads"))).toBe(false);
	});

	it("leaves an earlier 3.6.2 install untouched", () => {
		const f = fixture();
		f.installHistorical();
		expect(f.run("router-release-install").status).toBe(0);
		expect(readFileSync(f.historicalBinary, "utf8")).toBe(historicalPayload);
		for (const name of earlierGuideAliases)
			expect(readlinkSync(join(f.binDir, name))).toBe(f.historicalBinary);
	});

	it("creates both optional command aliases to the same verified binary without running it", () => {
		const f = fixture();
		expect(f.run("router-release-install").status).toBe(0);
		expect(f.run("router-release-path").status).toBe(0);
		for (const name of COMMAND_NAMES) {
			expect(readlinkSync(join(f.binDir, name))).toBe(f.binary);
			expect(readFileSync(join(f.binDir, name), "utf8")).toBe(payload);
		}
		expect(readdirSync(f.binDir).sort()).toEqual([...COMMAND_NAMES].sort());
		expect(() => lstatSync(join(f.binDir, "wstack-router"))).toThrow();
		for (const profile of [".profile", ".bashrc", ".zshrc"])
			expect(readFileSync(join(f.home, profile), "utf8")).toBe(
				"keep profile\n",
			);
		expect(existsSync(join(f.home, "executed"))).toBe(false);
	});

	it("leaves an existing wstack-router entry alone, since new installs no longer create it", () => {
		const f = fixture();
		expect(f.run("router-release-install").status).toBe(0);
		mkdirSync(f.binDir, { recursive: true });
		const earlier = join(f.binDir, "wstack-router");
		writeFileSync(earlier, "keep");
		const result = f.run("router-release-path");
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(earlier, "utf8")).toBe("keep");
		for (const name of COMMAND_NAMES)
			expect(readlinkSync(join(f.binDir, name))).toBe(f.binary);
	});

	it("reports the release display and source SHA through both installed aliases (fixture)", () => {
		expect(reference).toContain("HoV Router v3.7.1");
		const f = fixture();
		expect(f.run("router-release-install").status).toBe(0);
		expect(f.run("router-release-path").status).toBe(0);
		for (const name of COMMAND_NAMES) {
			for (const [flag, output] of [
				["--version", "HoV Router v3.7.1\n"],
				["--git-sha", `${sourceSha}\n`],
			]) {
				const result = spawnSync(join(f.binDir, name), [flag], {
					cwd: f.home,
					env: { HOME: f.home, PATH: "/usr/bin:/bin" },
					encoding: "utf8",
					timeout: 10000,
				});
				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout).toBe(output);
			}
		}
	});

	for (const name of COMMAND_NAMES) {
		it.each([
			"file",
			"symlink",
			"broken symlink",
			"directory",
		])(`refuses an existing ${name} (%s) before creating any missing alias`, (kind) => {
			const f = fixture();
			expect(f.run("router-release-install").status).toBe(0);
			mkdirSync(f.binDir, { recursive: true });
			const collision = join(f.binDir, name);
			if (kind === "file") writeFileSync(collision, "keep");
			else if (kind === "symlink") symlinkSync(f.binary, collision);
			else if (kind === "broken symlink")
				symlinkSync("missing-command", collision);
			else {
				mkdirSync(collision);
				writeFileSync(join(collision, "sentinel"), "keep");
			}
			const before = lstatSync(collision);
			const result = f.run("router-release-path");
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("Refusing existing command:");
			expect(lstatSync(collision).ino).toBe(before.ino);
			if (kind === "file") expect(readFileSync(collision, "utf8")).toBe("keep");
			else if (kind === "symlink")
				expect(readlinkSync(collision)).toBe(f.binary);
			else if (kind === "broken symlink")
				expect(readlinkSync(collision)).toBe("missing-command");
			else {
				expect(readFileSync(join(collision, "sentinel"), "utf8")).toBe("keep");
				expect(readdirSync(collision)).toEqual(["sentinel"]);
			}
			for (const other of COMMAND_NAMES.filter((alias) => alias !== name))
				expect(() => lstatSync(join(f.binDir, other))).toThrow();
			expect(readFileSync(f.binary, "utf8")).toBe(payload);
		});
	}
});

describe("documented upgrade of an earlier binary install (synthetic)", () => {
	const currentBinaryLine =
		'binary="$HOME/.local/lib/hov-router/3.7.1/hov-router"';
	const toHistorical = (script: string) =>
		script.replace(
			currentBinaryLine,
			'binary="$HOME/.local/lib/wstack-router/3.6.2/wstack-router"',
		);
	const toPrevious = (script: string) =>
		script.replace(
			currentBinaryLine,
			'binary="$HOME/.local/lib/hov-router/3.7.0/hov-router"',
		);

	it("only links, renames, and checks; it never deletes or forces", () => {
		const commands = block("router-release-upgrade");
		expect(commands).toContain(currentBinaryLine);
		expect(commands).not.toMatch(/\b(rm|gh|node|bun|sudo)\b/);
		expect(commands).not.toMatch(/\b(ln|mv) -[A-Za-z]*f/);
		expect(toHistorical(commands)).not.toBe(commands);
	});

	it("repoints 3.6.2 aliases to the verified release, keeps 3.6.2, and rolls back", () => {
		const f = fixture();
		f.installHistorical();
		expect(f.run("router-release-install").status).toBe(0);
		const upgraded = f.run("router-release-upgrade");
		expect(upgraded.status, upgraded.stderr).toBe(0);
		expect(upgraded.stderr).toBe("");
		for (const name of earlierGuideAliases)
			expect(readlinkSync(join(f.binDir, name))).toBe(f.binary);
		expect(readdirSync(f.binDir).sort()).toEqual(
			[...earlierGuideAliases].sort(),
		);
		expect(readFileSync(f.historicalBinary, "utf8")).toBe(historicalPayload);
		for (const profile of [".profile", ".bashrc", ".zshrc"])
			expect(readFileSync(join(f.home, profile), "utf8")).toBe(
				"keep profile\n",
			);
		expect(existsSync(join(f.home, "executed"))).toBe(false);

		const rolledBack = f.run("router-release-upgrade", toHistorical);
		expect(rolledBack.status, rolledBack.stderr).toBe(0);
		for (const name of earlierGuideAliases)
			expect(readlinkSync(join(f.binDir, name))).toBe(f.historicalBinary);

		expect(f.run("router-release-upgrade").status).toBe(0);
		for (const name of earlierGuideAliases)
			expect(readlinkSync(join(f.binDir, name))).toBe(f.binary);
		expect(readdirSync(f.binDir).sort()).toEqual(
			[...earlierGuideAliases].sort(),
		);
	});

	it("repoints 3.7.0 aliases to the verified release, keeps 3.7.0, and rolls back", () => {
		const f = fixture();
		f.installPrevious();
		expect(f.run("router-release-install").status).toBe(0);
		const upgraded = f.run("router-release-upgrade");
		expect(upgraded.status, upgraded.stderr).toBe(0);
		expect(upgraded.stderr).toBe("");
		for (const name of earlierGuideAliases)
			expect(readlinkSync(join(f.binDir, name))).toBe(f.binary);
		expect(readdirSync(f.binDir).sort()).toEqual(
			[...earlierGuideAliases].sort(),
		);
		expect(readFileSync(f.previousBinary, "utf8")).toBe(previousPayload);
		expect(existsSync(join(f.home, "executed"))).toBe(false);

		const rolledBack = f.run("router-release-upgrade", toPrevious);
		expect(rolledBack.status, rolledBack.stderr).toBe(0);
		for (const name of earlierGuideAliases)
			expect(readlinkSync(join(f.binDir, name))).toBe(f.previousBinary);
	});

	it("creates missing aliases while repointing the rest, but never creates wstack-router", () => {
		const f = fixture();
		f.installHistorical([COMMAND_NAMES[0]]);
		expect(f.run("router-release-install").status).toBe(0);
		const upgraded = f.run("router-release-upgrade");
		expect(upgraded.status, upgraded.stderr).toBe(0);
		for (const name of COMMAND_NAMES)
			expect(readlinkSync(join(f.binDir, name))).toBe(f.binary);
		expect(readdirSync(f.binDir).sort()).toEqual([...COMMAND_NAMES].sort());
		expect(() => lstatSync(join(f.binDir, "wstack-router"))).toThrow();
	});

	it("refuses before the new release is installed", () => {
		const f = fixture();
		f.installHistorical();
		expect(f.run("router-release-upgrade").status).not.toBe(0);
		for (const name of earlierGuideAliases)
			expect(readlinkSync(join(f.binDir, name))).toBe(f.historicalBinary);
	});

	it("refuses a leftover temporary link before changing any alias", () => {
		const f = fixture();
		f.installHistorical();
		expect(f.run("router-release-install").status).toBe(0);
		const last = COMMAND_NAMES[COMMAND_NAMES.length - 1];
		const leftover = join(f.binDir, `.${last}.new`);
		writeFileSync(leftover, "keep");
		const result = f.run("router-release-upgrade");
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Refusing leftover file:");
		expect(readFileSync(leftover, "utf8")).toBe("keep");
		for (const name of earlierGuideAliases)
			expect(readlinkSync(join(f.binDir, name))).toBe(f.historicalBinary);
	});

	for (const name of earlierGuideAliases) {
		it.each([
			"file",
			"directory",
			"symlink elsewhere",
			"broken symlink",
		])(`refuses a foreign ${name} (%s) before changing any alias`, (kind) => {
			const f = fixture();
			f.installHistorical(
				earlierGuideAliases.filter((alias) => alias !== name),
			);
			expect(f.run("router-release-install").status).toBe(0);
			const collision = join(f.binDir, name);
			// Ends in the command name but sits outside this guide's install roots.
			const elsewhere = join(f.home, ".local/lib/other/3.7.1/hov-router");
			if (kind === "file") writeFileSync(collision, "keep");
			else if (kind === "directory") {
				mkdirSync(collision);
				writeFileSync(join(collision, "sentinel"), "keep");
			} else if (kind === "symlink elsewhere")
				symlinkSync(elsewhere, collision);
			else symlinkSync("missing-command", collision);
			const before = lstatSync(collision);
			const result = f.run("router-release-upgrade");
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("Refusing ");
			expect(lstatSync(collision).ino).toBe(before.ino);
			if (kind === "file") expect(readFileSync(collision, "utf8")).toBe("keep");
			else if (kind === "directory")
				expect(readdirSync(collision)).toEqual(["sentinel"]);
			else
				expect(readlinkSync(collision)).toBe(
					kind === "symlink elsewhere" ? elsewhere : "missing-command",
				);
			for (const other of earlierGuideAliases.filter((alias) => alias !== name))
				expect(readlinkSync(join(f.binDir, other))).toBe(f.historicalBinary);
			expect(
				readdirSync(f.binDir).filter((entry) => entry.endsWith(".new")),
			).toEqual([]);
		});
	}
});

describe("documented provenance (synthetic policy fixture, not cryptographic proof)", () => {
	const runStep = () => block("router-release-run");

	it("verifies the installed binary under this repository's exact identity before execution", () => {
		const f = fixture();
		expect(f.run("router-release-install").status).toBe(0);
		const verified = f.run("router-release-provenance");
		expect(verified.status, verified.stderr).toBe(0);
		const calls = readFileSync(join(f.home, "attestations"), "utf8")
			.trim()
			.split("\n");
		expect(calls).toEqual([
			[
				`attestation verify ${f.binary}`,
				"--repo StartupBros/hov-router",
				`--source-digest ${sourceSha}`,
				"--source-ref refs/tags/v3.7.1",
				"--cert-identity https://github.com/StartupBros/hov-router/.github/workflows/router-release-artifacts.yml@refs/tags/v3.7.1",
				`--signer-digest ${sourceSha}`,
				"--deny-self-hosted-runners",
			].join(" "),
		]);
		expect(existsSync(join(f.home, "executed"))).toBe(false);
		expect(f.run("router-release-run").status).toBe(0);
		expect(readFileSync(join(f.home, "executed"), "utf8")).toBe("executed\n");
	});

	it("pins the release and asset evidence", () => {
		for (const pin of [
			"423574844",
			sourceSha,
			"refs/tags/v3.7.1",
			"675765162",
			"97969632",
			releaseDigest,
			"675765600",
			"5e88ab1d8376fe783da736003c40f34a0207db4c71be5f6a5c328d1c30881d0c",
			"675764852",
			"923d6041201ba6ade61ff3dcd2ec200970475076ae7b9af261058211394545e5",
		])
			expect(releaseGuide).toContain(pin);
	});

	it("rejects changed binary bytes before attestation or execution", () => {
		const f = fixture();
		expect(f.run("router-release-install").status).toBe(0);
		writeFileSync(f.binary, "tampered bytes\n");
		expect(
			f.run("router-release-provenance", undefined, runStep()).status,
		).not.toBe(0);
		expect(existsSync(join(f.home, "attestations"))).toBe(false);
		expect(existsSync(join(f.home, "executed"))).toBe(false);
	});

	it("stops on a failed attestation before execution", () => {
		const f = fixture("attestation-fail");
		expect(f.run("router-release-install").status).toBe(0);
		expect(
			f.run("router-release-provenance", undefined, runStep()).status,
		).not.toBe(0);
		expect(
			readFileSync(join(f.home, "attestations"), "utf8").trim().split("\n"),
		).toHaveLength(1);
		expect(existsSync(join(f.home, "executed"))).toBe(false);
	});

	for (const [label, from, to] of [
		[
			"historical verification repository",
			"--repo StartupBros/hov-router",
			"--repo StartupBros/wstack-router",
		],
		[
			"owner-only policy",
			"--repo StartupBros/hov-router",
			"--owner StartupBros",
		],
		[
			"historical certificate",
			"--cert-identity https://github.com/StartupBros/hov-router/",
			"--cert-identity https://github.com/StartupBros/wstack-router/",
		],
		[
			"short source SHA",
			'--source-digest "$source_sha"',
			`--source-digest ${sourceSha.slice(0, 7)}`,
		],
		[
			"wrong signer SHA",
			'--signer-digest "$source_sha"',
			`--signer-digest ${"b".repeat(40)}`,
		],
		[
			"wrong tag",
			"--source-ref refs/tags/v3.7.1",
			"--source-ref refs/heads/main",
		],
		["self-hosted runner allowance", "--deny-self-hosted-runners", ""],
	] as const) {
		it(`rejects ${label} before execution`, () => {
			const f = fixture();
			expect(f.run("router-release-install").status).toBe(0);
			expect(block("router-release-provenance")).toContain(from);
			const result = f.run(
				"router-release-provenance",
				(script) => script.replace(from, to),
				runStep(),
			);
			expect(result.status).not.toBe(0);
			expect(existsSync(join(f.home, "executed"))).toBe(false);
		});
	}
});

describe("documented historical 3.6.2 provenance (synthetic policy fixture, not cryptographic proof)", () => {
	const marker = "router-release-provenance-v3.6.2";

	it("keeps the full historical policy pinned", () => {
		const policy = block(marker);
		for (const pin of [
			'binary="$HOME/.local/lib/wstack-router/3.6.2/wstack-router"',
			`source_sha=${historicalSha}`,
			`digest=${historicalDigest}`,
			'gh attestation verify "$binary"',
			"--repo StartupBros/wstack-router",
			'--source-digest "$source_sha"',
			"--source-ref refs/tags/v3.6.2",
			"--cert-identity https://github.com/StartupBros/wstack-router/.github/workflows/router-release-artifacts.yml@refs/tags/v3.6.2",
			'--signer-digest "$source_sha"',
			"--deny-self-hosted-runners",
			"retrieval_repo=StartupBros/hov-router",
			'gh attestation download "$binary" --repo "$retrieval_repo"',
			'--bundle "$bundle_dir/sha256:$digest.jsonl"',
		])
			expect(policy).toContain(pin);
	});

	it("retrieves at the intended home and verifies the same local bundle under the exact old identity before execution", () => {
		const f = fixture();
		f.installHistorical();
		const verified = f.run(marker, undefined, historicalRun);
		expect(verified.status, verified.stderr).toBe(0);
		const calls = readFileSync(join(f.home, "attestations"), "utf8")
			.trim()
			.split("\n");
		expect(calls).toHaveLength(2);
		expect(calls[0]).toBe(
			`attestation download ${f.historicalBinary} --repo StartupBros/hov-router`,
		);
		expect(calls[1]).toStartWith(
			`attestation verify ${f.historicalBinary} --repo StartupBros/wstack-router `,
		);
		expect(calls[1]).toContain(`--bundle `);
		expect(calls[1]).toEndWith(`/sha256:${historicalFixtureDigest}.jsonl`);
		expect(readFileSync(join(f.home, "executed"), "utf8")).toBe("executed\n");
	});

	it("pins historical release and asset evidence independently of the new display name", () => {
		for (const pin of [
			"418096444",
			historicalSha,
			"refs/tags/v3.6.2",
			"658578101",
			"97965536",
			historicalDigest,
			"658578455",
			"a90aa5f71ba5ae9f4b255e487c2afc80f39d44bc70a6193da43d83f4b05dc60b",
			"658577847",
			"dee851d757ec92a28946c838a11919d34bf2fc4755613e67b34bd1e3cdf70b29",
		])
			expect(releaseGuide).toContain(pin);
		expect(releaseGuide).toContain("wstack Router v3.6.2");
		expect(releaseGuide).toContain("v1:startupbros-wstack-router-binary");
	});

	it("rejects changed binary bytes before bundle retrieval or execution", () => {
		const f = fixture();
		f.installHistorical();
		writeFileSync(f.historicalBinary, "tampered bytes\n");
		expect(f.run(marker, undefined, historicalRun).status).not.toBe(0);
		expect(existsSync(join(f.home, "attestations"))).toBe(false);
		expect(existsSync(join(f.home, "executed"))).toBe(false);
	});

	for (const mode of ["attestation-fail", "bad-bundle"]) {
		it(`stops on ${mode} before execution`, () => {
			const f = fixture(mode);
			f.installHistorical();
			expect(f.run(marker, undefined, historicalRun).status).not.toBe(0);
			const calls = readFileSync(join(f.home, "attestations"), "utf8")
				.trim()
				.split("\n");
			expect(calls).toHaveLength(mode === "attestation-fail" ? 1 : 2);
			expect(existsSync(join(f.home, "executed"))).toBe(false);
		});
	}

	for (const [label, from, to] of [
		[
			"new verification repository",
			"--repo StartupBros/wstack-router",
			"--repo StartupBros/hov-router",
		],
		[
			"owner-only policy",
			"--repo StartupBros/wstack-router",
			"--owner StartupBros",
		],
		[
			"new certificate",
			"--cert-identity https://github.com/StartupBros/wstack-router/",
			"--cert-identity https://github.com/StartupBros/hov-router/",
		],
		[
			"short source SHA",
			'--source-digest "$source_sha"',
			`--source-digest ${historicalSha.slice(0, 7)}`,
		],
		[
			"wrong signer SHA",
			'--signer-digest "$source_sha"',
			`--signer-digest ${"b".repeat(40)}`,
		],
		[
			"wrong tag",
			"--source-ref refs/tags/v3.6.2",
			"--source-ref refs/heads/main",
		],
		["self-hosted runner allowance", "--deny-self-hosted-runners", ""],
		[
			"different bundle",
			'--bundle "$bundle_dir/sha256:$digest.jsonl"',
			'--bundle "$bundle_dir/other.jsonl"',
		],
	] as const) {
		it(`rejects ${label} before execution`, () => {
			const f = fixture();
			f.installHistorical();
			expect(block(marker)).toContain(from);
			const result = f.run(
				marker,
				(script) => script.replace(from, to),
				historicalRun,
			);
			expect(result.status).not.toBe(0);
			expect(existsSync(join(f.home, "executed"))).toBe(false);
		});
	}
});
