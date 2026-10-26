import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function canConnect(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(port, "127.0.0.1");
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

test("real SIGUSR2 releases listener while preserving SSE and pre-header upload, then SIGTERM drains", async () => {
	const dir = mkdtempSync(join(tmpdir(), "hov-quiesce-"));
	const reservation = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response(),
	});
	const port = reservation.port;
	if (port === undefined) throw new Error("TCP reservation has no port");
	reservation.stop(true);
	const child = Bun.spawn(
		[
			process.execPath,
			"run",
			"apps/server/src/server.ts",
			"--port",
			String(port),
		],
		{
			env: {
				...process.env,
				HOME: dir,
				XDG_CONFIG_HOME: dir,
				BETTER_CCFLARE_DB_PATH: join(dir, "test.db"),
				CCFLARE_SHUTDOWN_DRAIN_MS: "1000",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	// Consume both pipes continuously so logging cannot stall the child.
	const out = new Response(child.stdout).text();
	const err = new Response(child.stderr).text();
	let upload: Socket | undefined;
	let replacement: ReturnType<typeof Bun.serve> | undefined;
	try {
		let health: Record<string, unknown> | undefined;
		const deadline = Date.now() + 25000;
		while (Date.now() < deadline) {
			try {
				health = (await (
					await fetch(`http://127.0.0.1:${port}/health`)
				).json()) as Record<string, unknown>;
				break;
			} catch {
				await sleep(100);
			}
		}
		expect(health).toBeDefined();
		expect(health?.accounts).toBe(0);
		expect(health?.handoff).toEqual({ protocol: "quiesce-v1", pid: child.pid });
		const sse = await fetch(`http://127.0.0.1:${port}/api/logs/stream`);
		expect(sse.status).toBe(200);
		if (!sse.body) throw new Error("SSE response has no body");
		const streamReader = sse.body.getReader();
		expect((await streamReader.read()).done).toBe(false);
		let ended = false;
		const readNext = async () => {
			while (!(await streamReader.read()).done) {}
			ended = true;
		};
		const reading = readNext().catch(() => {
			ended = true;
		});
		upload = connect(port, "127.0.0.1");
		await new Promise<void>((resolve, reject) => {
			upload?.once("connect", resolve);
			upload?.once("error", reject);
		});
		let response = "";
		upload.on("data", (chunk) => {
			response += chunk.toString();
		});
		const body = '{"enabled":false}';
		upload.write(
			`POST /api/config/combos-enabled HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n{`,
		);
		await sleep(100);
		expect(response).toBe("");
		child.kill("SIGUSR2");
		const signalAt = Date.now();
		while (await canConnect(port)) {
			if (Date.now() - signalAt > 2000)
				throw new Error("listener did not release within 2 seconds");
			await sleep(20);
		}
		expect(ended).toBe(false);
		expect(child.exitCode).toBeNull();
		child.kill("SIGUSR2");
		replacement = Bun.serve({
			port,
			hostname: "127.0.0.1",
			fetch: () => new Response("replacement"),
		});
		upload.write(body.slice(1));
		const responseDeadline = Date.now() + 2000;
		while (!response.includes("HTTP/1.1") && Date.now() < responseDeadline)
			await sleep(10);
		expect(response).toMatch(/^HTTP\/1\.1 200/);
		await sleep(100);
		expect(ended).toBe(false);
		child.kill("SIGTERM");
		await sleep(50);
		child.kill("SIGUSR2");
		expect(
			await Promise.race([child.exited, sleep(6000).then(() => "timeout")]),
		).toBe(0);
		await reading;
	} finally {
		upload?.destroy();
		replacement?.stop(true);
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		console.error(await err);
		const output = await out;
		if (child.exitCode !== 0) console.error(output);
		rmSync(dir, { recursive: true, force: true });
	}
}, 35000);

test("idle quiesced backend stays alive until SIGTERM", async () => {
	const dir = mkdtempSync(join(tmpdir(), "hov-idle-quiesce-"));
	const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
	const port = reservation.port;
	reservation.stop(true);
	if (port === undefined) throw new Error("TCP reservation has no port");
	const child = Bun.spawn(
		[
			process.execPath,
			"run",
			"apps/server/src/server.ts",
			"--port",
			String(port),
		],
		{
			env: {
				...process.env,
				HOME: dir,
				XDG_CONFIG_HOME: dir,
				BETTER_CCFLARE_DB_PATH: join(dir, "test.db"),
				CCFLARE_SHUTDOWN_DRAIN_MS: "1000",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const out = new Response(child.stdout).text();
	const err = new Response(child.stderr).text();
	try {
		const deadline = Date.now() + 25000;
		let ready = false;
		while (Date.now() < deadline) {
			try {
				const health = await (
					await fetch(`http://127.0.0.1:${port}/health`)
				).json();
				expect(health.accounts).toBe(0);
				ready = true;
				break;
			} catch {
				await sleep(100);
			}
		}
		expect(ready).toBe(true);
		child.kill("SIGUSR2");
		const signalAt = Date.now();
		while (await canConnect(port)) {
			if (Date.now() - signalAt > 2000)
				throw new Error("idle listener did not release");
			await sleep(20);
		}
		await sleep(300);
		expect(child.exitCode).toBeNull();
		child.kill("SIGUSR2");
		await sleep(100);
		expect(child.exitCode).toBeNull();
		child.kill("SIGTERM");
		expect(
			await Promise.race([child.exited, sleep(6000).then(() => "timeout")]),
		).toBe(0);
		const output = await out;
		expect(output.split('"event":"backend_quiesced"').length - 1).toBe(1);
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		console.error(await err);
		if (child.exitCode !== 0) console.error(await out);
		rmSync(dir, { recursive: true, force: true });
	}
}, 35000);
