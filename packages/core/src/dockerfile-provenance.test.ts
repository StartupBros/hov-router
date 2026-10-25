import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBuildProvenance } from "./build-provenance";

const root = join(import.meta.dir, "../../..");
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");

/** Dockerfile instructions with line continuations joined, comments dropped. */
const instructions = dockerfile
	.replace(/\\\n/g, " ")
	.split("\n")
	.map((line) => line.trim())
	.filter((line) => line !== "" && !line.startsWith("#"));

function stageRange(name: string): string[] {
	const start = instructions.findIndex((line) =>
		new RegExp(`^FROM .* AS ${name}$`).test(line),
	);
	expect(start, `stage ${name}`).toBeGreaterThanOrEqual(0);
	const next = instructions.findIndex(
		(line, index) => index > start && line.startsWith("FROM "),
	);
	return instructions.slice(start, next === -1 ? undefined : next);
}

describe("Dockerfile builds HoV Router from source", () => {
	it("compiles in a Bun builder stage and ships only the binary in a slim runtime", () => {
		const builder = stageRange("builder");
		expect(builder[0]).toMatch(/^FROM oven\/bun:\$\{BUN_VERSION\}-debian AS/);
		expect(builder).toContain("RUN bun run build");
		expect(
			builder.some((l) => l.includes("bun install --frozen-lockfile")),
		).toBe(true);
		// Manifests and the lockfile are copied before the full source so the
		// dependency layer caches.
		const lockfileCopy = builder.indexOf("COPY package.json bun.lock ./");
		const install = builder.findIndex((l) => l.includes("bun install"));
		const sourceCopy = builder.indexOf("COPY . .");
		expect(lockfileCopy).toBeGreaterThanOrEqual(0);
		expect(install).toBeGreaterThan(lockfileCopy);
		expect(sourceCopy).toBeGreaterThan(install);

		const froms = instructions.filter((l) => l.startsWith("FROM "));
		expect(froms).toHaveLength(2);
		expect(froms[1]).toBe("FROM debian:trixie-slim");
		expect(dockerfile).toContain(
			"COPY --from=builder /src/apps/cli/dist/better-ccflare /usr/local/bin/better-ccflare",
		);
	});

	it("pins the builder to the repo's Bun version", () => {
		const pinned = readFileSync(join(root, ".bun-version"), "utf8").trim();
		expect(dockerfile).toContain(`ARG BUN_VERSION=${pinned}`);
	});

	it("copies every workspace manifest before installing", () => {
		const manifests = ["apps", "packages"].flatMap((group) =>
			Array.from(
				new Bun.Glob(`${group}/*/package.json`).scanSync({ cwd: root }),
			),
		);
		expect(manifests.length).toBeGreaterThan(10);
		for (const manifest of manifests) {
			expect(dockerfile, manifest).toContain(`COPY ${manifest} ./${manifest}`);
		}
		// A COPY of a removed workspace's manifest fails the build.
		const copied = instructions.flatMap((line) => {
			const match = /^COPY ((?:apps|packages)\/[^/]+\/package\.json) /.exec(
				line,
			);
			return match ? [match[1]] : [];
		});
		expect(copied.sort()).toEqual(manifests.sort());
	});

	it("does not fetch or reference upstream release binaries or images", () => {
		for (const text of [dockerfile, compose]) {
			expect(text).not.toContain("tombii");
			expect(text).not.toContain("ghcr.io");
			expect(text).not.toMatch(/curl[^\n]*-o /);
			expect(text).not.toContain("releases/download");
		}
		// The upstream publisher is gone and must not return in this repo.
		expect(existsSync(join(root, ".github/workflows/docker-publish.yml"))).toBe(
			false,
		);
	});

	it("runs as the non-root ccflare user with persistent /data", () => {
		expect(instructions).toContain("USER ccflare");
		expect(
			instructions.some((l) => /useradd -u 1000 .* ccflare( |$)/.test(l)),
		).toBe(true);
		expect(instructions).toContain('VOLUME ["/data"]');
		expect(instructions).toContain(
			"ENV BETTER_CCFLARE_DB_PATH=/data/better-ccflare.db",
		);
		expect(instructions).toContain("ENV XDG_CONFIG_HOME=/data");
		expect(instructions).toContain("ENV BETTER_CCFLARE_LOG_DIR=/app/logs");
		expect(instructions).toContain("ENV NODE_ENV=production");
	});

	it("serves on 8080 with a /health check and the serve entrypoint", () => {
		expect(instructions).toContain("EXPOSE 8080");
		const health = instructions.find((l) => l.startsWith("HEALTHCHECK"));
		expect(health).toContain("curl -f http://localhost:8080/health");
		expect(instructions).toContain(
			'ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]',
		);
		expect(instructions).toContain('CMD ["--serve", "--port", "8080"]');
		expect(dockerfile).toContain("HoV Router Docker Container");
	});

	it("labels the image as HoV Router from this repository", () => {
		expect(dockerfile).toContain('org.opencontainers.image.title="HoV Router"');
		expect(dockerfile).toContain(
			'org.opencontainers.image.source="https://github.com/StartupBros/hov-router"',
		);
		expect(dockerfile).toContain('org.opencontainers.image.licenses="MIT"');
	});
});

describe("Docker guide reaches the install's real data volume", () => {
	const guide = readFileSync(join(root, "docs/docker.md"), "utf8");

	it("backs up and restores through the fixed container name", () => {
		// Compose prefixes the volume with the project name, so a bare
		// `-v better-ccflare-data:` mounts a new, empty volume instead.
		expect(guide).not.toMatch(/-v\s+better-ccflare-data:/);
		expect(compose).toContain("container_name: better-ccflare");
		const volumesFrom = guide.match(/--volumes-from better-ccflare /g) ?? [];
		expect(volumesFrom.length).toBeGreaterThanOrEqual(2);
		expect(guide).toContain("test -f /data/better-ccflare.db");
	});

	it("tells upgraders to keep the old compose project name", () => {
		expect(guide).toContain("com.docker.compose.project");
		expect(guide).toContain("COMPOSE_PROJECT_NAME=");
	});
});

describe("Dockerfile provenance wiring", () => {
	const wiring: ReadonlyArray<readonly [string, string]> = [
		["CCFLARE_VERSION", "VERSION"],
		["CCFLARE_GIT_REF", "GIT_REF"],
		["CCFLARE_SOURCE_REF", "GIT_REF"],
		["CCFLARE_CHECKOUT_SHA", "CHECKOUT_SHA"],
		["CCFLARE_EVENT_SHA", "EVENT_SHA"],
		["CCFLARE_TAG_SHA", "TAG_SHA"],
		["CCFLARE_BUILD_DATE", "BUILD_DATE"],
		["CCFLARE_DISTRIBUTION", "DISTRIBUTION"],
		["CCFLARE_PRODUCER", "PRODUCER"],
		["CCFLARE_ARTIFACT_MODE", "ARTIFACT_MODE"],
		["CCFLARE_UPDATE_CHANNEL", "UPDATE_CHANNEL"],
	];

	it("feeds each provenance ENV from its build ARG", () => {
		for (const [env, arg] of wiring) {
			expect(instructions, env).toContain(`ENV ${env}=\${${arg}}`);
		}
		expect(instructions).toContain("ENV CCFLARE_GIT_SHA=${GIT_SHA:-unknown}");
		expect(instructions).toContain(
			"ENV CCFLARE_SOURCE_SHA=${GIT_SHA:-unknown}",
		);
		// /health git_sha comes from this when the binary has no embedded SHA.
		expect(instructions).toContain("ENV BETTER_CCFLARE_GIT_SHA=${GIT_SHA}");
	});

	it("defaults every identity ARG to unknown so a source build proves nothing", () => {
		for (const arg of [
			"DISTRIBUTION",
			"PRODUCER",
			"ARTIFACT_MODE",
			"UPDATE_CHANNEL",
			"VERSION",
		]) {
			expect(instructions, arg).toContain(`ARG ${arg}=unknown`);
		}
	});

	it("resolves the default image environment to an unproven distribution", () => {
		const env: Record<string, string> = {};
		for (const line of instructions) {
			const match = /^ENV (CCFLARE_[A-Z_]+)=(.*)$/.exec(line);
			if (!match) continue;
			// Evaluate ${ARG} / ${ARG:-fallback} with every ARG at its default.
			const [, name, value] = match;
			env[name] = value.replace(
				/\$\{([A-Z_]+)(?::-([^}]*))?\}/g,
				(_all, arg: string, fallback?: string) => {
					const declared = instructions.find((l) =>
						l.startsWith(`ARG ${arg}=`),
					);
					return declared
						? declared.slice(`ARG ${arg}=`.length)
						: (fallback ?? "");
				},
			);
		}
		expect(env.CCFLARE_DISTRIBUTION).toBe("unknown");
		expect(resolveBuildProvenance(env)).toMatchObject({
			proven: false,
			actionable: false,
			reason: "unknown_distribution",
			identity: null,
		});
	});
});
