import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A refused start must exit on its own, open no database file, and never echo
// the URL's password (AE1). No account exists in the temporary home, so
// nothing here can reach a provider.
const CLI_PATH = join(process.cwd(), "apps/cli/src/main.ts");
const PASSWORD = "s3cret";
const POSTGRES_URL = `postgresql://user:${PASSWORD}@synthetic.invalid/never-connect`;
const TIMEOUT_MS = 20_000;

let home: string;

interface CliResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

function runCli(
	args: string[],
	options: { cwd?: string; databaseUrl?: string } = {},
): Promise<CliResult> {
	const env: Record<string, string | undefined> = {
		...process.env,
		NODE_ENV: "test",
		HOME: home,
		XDG_CONFIG_HOME: join(home, "config"),
	};
	delete env.DATABASE_URL;
	delete env.BETTER_CCFLARE_DB_PATH;
	delete env.ccflare_DB_PATH;
	if (options.databaseUrl !== undefined) env.DATABASE_URL = options.databaseUrl;

	return new Promise((resolve) => {
		const proc = spawn("bun", ["run", CLI_PATH, ...args], {
			cwd: options.cwd ?? process.cwd(),
			env,
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGKILL");
		}, TIMEOUT_MS);
		proc.on("close", (exitCode) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, exitCode, timedOut });
		});
	});
}

function databaseFiles(): string[] {
	return readdirSync(home, { recursive: true })
		.map(String)
		.filter((name) => /better-ccflare\.db/.test(name));
}

function expectRefused(result: CliResult): void {
	expect(result.timedOut).toBe(false);
	expect(result.exitCode).not.toBe(0);
	expect(result.stderr).toContain("PostgreSQL support was removed");
	expect(result.stderr).toContain(
		'"PostgreSQL support removed" in docs/hov-router-migration.md',
	);
	expect(`${result.stdout}${result.stderr}`).not.toContain(PASSWORD);
	expect(databaseFiles()).toEqual([]);
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "hov-cli-pg-refusal-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("CLI refuses a PostgreSQL DATABASE_URL", () => {
	it(
		"--serve exits non-zero with the refusal and opens no database file",
		async () => {
			const port = await freePort();
			const result = await runCli(["--serve", "--port", String(port)], {
				databaseUrl: POSTGRES_URL,
			});
			expectRefused(result);
		},
		TIMEOUT_MS + 5_000,
	);

	it(
		"--list exits non-zero with the refusal",
		async () => {
			const result = await runCli(["--list"], { databaseUrl: POSTGRES_URL });
			expectRefused(result);
		},
		TIMEOUT_MS + 5_000,
	);

	it(
		"--cache-flight-recorder-health prints the refusal instead of its generic failure",
		async () => {
			const result = await runCli(["--cache-flight-recorder-health"], {
				databaseUrl: POSTGRES_URL,
			});
			expectRefused(result);
		},
		TIMEOUT_MS + 5_000,
	);

	it(
		"--version still works because it never opens the database",
		async () => {
			const result = await runCli(["--version"], {
				databaseUrl: POSTGRES_URL,
			});
			expect(result.timedOut).toBe(false);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toMatch(/v\d+\.\d+\.\d+/);
			expect(databaseFiles()).toEqual([]);
		},
		TIMEOUT_MS + 5_000,
	);

	it(
		"a .env in the working directory that supplies the URL is refused the same way",
		async () => {
			const work = join(home, "work");
			mkdirSync(work);
			writeFileSync(join(work, ".env"), `DATABASE_URL=${POSTGRES_URL}\n`);
			const result = await runCli(["--list"], { cwd: work });
			expectRefused(result);
			expect(existsSync(join(work, "better-ccflare.db"))).toBe(false);
		},
		TIMEOUT_MS + 5_000,
	);
});
