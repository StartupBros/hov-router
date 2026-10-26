import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	durableWrite,
	fileHash,
	processExists,
	recoverTransaction,
} from "../ccflare-deployment-transaction.mjs";
import { resolveNodeExecutable } from "./node-runtime";

// Overlap handoff: a quiesce-capable backend releases the port on SIGUSR2 and
// keeps streaming while its replacement serves new work. The drain handoff is
// covered by ccflare-deployment-rehearsal.test.ts.
const root = join(import.meta.dir, "..", "..");
async function port() {
	const s = net.createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const p = (s.address() as net.AddressInfo).port;
	await new Promise<void>((r) => s.close(() => r()));
	return p;
}
async function until<T>(f: () => T | Promise<T>) {
	for (let i = 0; i < 400; i++) {
		try {
			const value = await f();
			if (value) return value;
		} catch {}
		await Bun.sleep(20);
	}
	throw new Error("rehearsal condition timeout");
}
// Every process the runner owns names the fixture directory in its argv: the
// fixture binaries, the transaction listener, and guard control clients
// (TMPDIR puts the control socket there).
function strayProcesses(dir: string) {
	const pids: number[] = [];
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
		try {
			if (readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(dir))
				pids.push(Number(entry));
		} catch {}
	}
	return pids;
}
test.each([
	"overlap",
	"port_stuck",
	"term_mid_retire",
])("compiled Bun backend %s handoff keeps the old stream while its replacement binds the port", async (mode) => {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-overlap-rehearsal-")),
		control = join(dir, "transaction"),
		pin = join(dir, "pin"),
		node = resolveNodeExecutable(),
		guardPort = await port(),
		upstreamPort = await port(),
		streamRelease = join(dir, "release-stream"),
		events = join(dir, "events");
	const oldSource = "a".repeat(40),
		newSource = "b".repeat(40),
		schema = "c".repeat(64);
	let runner: ReturnType<typeof spawn> | undefined,
		logs = "";
	const intent = () =>
		JSON.parse(readFileSync(join(control, "intent.json"), "utf8"));
	const lifecycle = async () =>
		(await (await fetch(`http://127.0.0.1:${guardPort}/_guard/health`)).json())
			.lifecycle;
	try {
		for (const [name, sha, delay] of [
			["old", oldSource, 0],
			["candidate", newSource, 400],
		] as const) {
			const source = join(dir, `${name}.ts`),
				binary = join(dir, name);
			// The owner lock models the database owner: a replacement can open it
			// only after the quiesced backend has released it.
			const onQuiesce =
				name === "old" && mode === "port_stuck"
					? `appendFileSync(process.env.FIXTURE_EVENTS,"quiesce-ignored:"+process.pid+"\\n");`
					: `if(quiesced)return;quiesced=true;setInterval(()=>{},1000);closeSync(owner);unlinkSync(lock);server.stop(false);appendFileSync(process.env.FIXTURE_EVENTS,"quiesce:"+process.pid+"\\n");`;
			writeFileSync(
				source,
				`import {Database} from "bun:sqlite";import {openSync,closeSync,unlinkSync,appendFileSync,existsSync} from "node:fs";import {createManagedIngress} from ${JSON.stringify(join(root, "apps/server/src/managed-ingress.ts"))};
 const lock=process.env.FIXTURE_DB+".owner";const owner=openSync(lock,"wx");const db=new Database(process.env.FIXTURE_DB);db.exec("CREATE TABLE IF NOT EXISTS calls(generation INTEGER,path TEXT)");appendFileSync(process.env.FIXTURE_EVENTS,"open:"+process.pid+"\\n");
 await Bun.sleep(${delay});const ingress=createManagedIngress({enabled:true,secret:Buffer.from(process.env.CCFLARE_GUARD_CORRELATION_SECRET,"base64url"),generation:Number(process.env.CCFLARE_MANAGED_GENERATION),ingressNonce:process.env.CCFLARE_MANAGED_INGRESS_NONCE,candidateNonce:process.env.CCFLARE_MANAGED_CANDIDATE_NONCE,sourceSha:process.env.CCFLARE_SOURCE_SHA});
 let quiesced=false;const server=Bun.serve({hostname:"127.0.0.1",port:Number(process.env.PORT),fetch:r=>ingress(r,async req=>{const url=new URL(req.url);if(url.pathname==="/health")return Response.json({status:"ok",git_sha:${JSON.stringify(sha)},handoff:{protocol:"quiesce-v1",pid:process.pid}});db.query("INSERT INTO calls VALUES(?,?)").run(Number(process.env.CCFLARE_MANAGED_GENERATION),url.pathname);if(url.pathname==="/v1/slow")return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode("first"));const timer=setInterval(()=>{if(existsSync(process.env.FIXTURE_STREAM_RELEASE)){clearInterval(timer);c.enqueue(new TextEncoder().encode("last"));c.close();}},10);}}));return new Response(${JSON.stringify(sha)});})});
 process.on("SIGUSR2",()=>{${onQuiesce}});
 process.on("SIGTERM",()=>{server.stop(true);db.close();if(!quiesced){closeSync(owner);unlinkSync(lock);}appendFileSync(process.env.FIXTURE_EVENTS,"close:"+process.pid+"\\n");process.exit(0);});`,
			);
			const result = spawnSync(
				process.execPath,
				["build", "--compile", source, "--outfile", binary],
				{ cwd: root, encoding: "utf8", timeout: 15000 },
			);
			if (result.status !== 0) throw new Error(result.stderr);
			chmodSync(binary, 0o555);
		}
		writeFileSync(pin, "previous-pin");
		const nextPin = join(dir, "next-pin");
		writeFileSync(nextPin, "candidate-pin");
		runner = spawn("bash", [join(root, "scripts/run-ccflare-stack.sh")], {
			cwd: root,
			env: {
				...process.env,
				HOME: dir,
				USER: "fixture",
				TMPDIR: dir,
				NODE_BIN: node,
				CCFLARE_BIN: join(dir, "old"),
				GUARD_SCRIPT: join(root, "scripts/ccflare-guard.mjs"),
				GUARD_SOURCE_ID: oldSource,
				CCFLARE_SOURCE_SHA: oldSource,
				CCFLARE_GIT_SHA: oldSource,
				CCFLARE_SCHEMA_DIGEST: schema,
				CCFLARE_PIN_PATH: pin,
				CCFLARE_TRANSACTION_DIR: control,
				CCFLARE_MANAGED_TIMING: "1",
				CCFLARE_UPSTREAM_PORT: String(upstreamPort),
				GUARD_PORT: String(guardPort),
				GUARD_TOTAL_DEADLINE_MS: "10000",
				GUARD_RETRY_ATTEMPT_HEADROOM_MS: "1",
				GUARD_MAX_RECOVERY_SLEEP_MS: "100",
				GUARD_SHUTDOWN_GRACE_MS: "10000",
				GUARD_SHUTDOWN_CUSHION_MS: "100",
				RUNNER_HEALTH_POLL_INTERVAL_MS: "10",
				RUNNER_HEALTH_STABILITY_DELAY_MS: "0",
				RUNNER_QUIESCE_PORT_TIMEOUT_MS: mode === "port_stuck" ? "300" : "5000",
				AI_GATEWAY_TUNNEL_ENABLED: "0",
				AI_GATEWAY_TUNNEL_REQUIRED: "0",
				FIXTURE_DB: join(dir, "fixture.db"),
				FIXTURE_EVENTS: events,
				FIXTURE_STREAM_RELEASE: streamRelease,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		runner.stdout!.on("data", (c) => {
			logs += c;
		});
		runner.stderr!.on("data", (c) => {
			logs += c;
		});
		const base = `http://127.0.0.1:${guardPort}`;
		const health = await until(async () => {
			const h = await (await fetch(base + "/_guard/health")).json();
			return existsSync(join(control, "runtime.json")) && h;
		});
		const guardPid = health.runtime.process.guardPid;
		const runtime = JSON.parse(
			readFileSync(join(control, "runtime.json"), "utf8"),
		);
		expect(runtime.retiring).toBeUndefined();
		const response = await fetch(base + "/v1/slow", {
			method: "POST",
			body: "{}",
		});
		const oldBody = response.text();
		const manifest = {
			transactionId: crypto.randomUUID(),
			expectedGeneration: runtime.generation,
			oldPid: runtime.oldPid,
			oldStartTime: runtime.oldStartTime,
			previousPinHash: runtime.pinHash,
			candidatePinHash: fileHash(nextPin),
			candidateBinary: join(dir, "candidate"),
			candidateHash: fileHash(join(dir, "candidate")),
			candidateSourceSha: newSource,
			candidateNonce: "d".repeat(32),
			schemaDigest: schema,
			ingress: runtime.ingress,
		};
		const command = join(dir, "command.json");
		writeFileSync(command, JSON.stringify({ command: "prepare", manifest }));
		const client = spawnSync(
			node,
			[
				join(root, "scripts/ccflare-deployment-transaction.mjs"),
				"client",
				control,
				command,
			],
			{ encoding: "utf8", timeout: 3000 },
		);
		expect(client.status).toBe(0);
		await until(() => logs.includes("backend handoff mode=overlap"));

		if (mode === "port_stuck") {
			// The old backend kept its listener: the runner drains it like a
			// legacy handoff, so its stream must finish before the candidate starts.
			await until(() => logs.includes("falling back to drain"));
			expect(processExists(runtime.oldPid, runtime.oldStartTime)).toBe(true);
			writeFileSync(streamRelease, "release\n");
			expect(await oldBody).toBe("firstlast");
		}
		const verified = await until(
			() => intent().phase === "candidate_verified" && intent(),
		);
		if (mode === "port_stuck") {
			expect(processExists(runtime.oldPid, runtime.oldStartTime)).toBe(false);
			expect(verified.backendPort).toBeUndefined();
		} else {
			// The quiesced backend outlives its replacement's start, its stream
			// still open, and the transaction recorded the released port.
			expect(processExists(runtime.oldPid, runtime.oldStartTime)).toBe(true);
			expect(verified.backendPort).toBe(upstreamPort);
		}
		renameSync(nextPin, pin);
		const fd = openSync(dir, "r");
		fsyncSync(fd);
		closeSync(fd);
		durableWrite(join(control, "commit.json"), {
			transactionId: manifest.transactionId,
			pinHash: manifest.candidatePinHash,
		});
		await until(() => intent().phase === "attached");
		const attachedAt = performance.now();
		expect(
			await (await fetch(base + "/v1/new", { method: "POST", body: "{}" })).text(),
		).toBe(newSource);
		const servedNewWorkMs = performance.now() - attachedAt;
		const fixtureEvents = () => readFileSync(events, "utf8").split("\n");

		if (mode === "port_stuck") {
			expect(fixtureEvents()).toEqual([
				`open:${runtime.oldPid}`,
				`quiesce-ignored:${runtime.oldPid}`,
				`close:${runtime.oldPid}`,
				`open:${verified.candidatePid}`,
				"",
			]);
			expect((await lifecycle()).retiring).toBeNull();
			return;
		}

		expect(processExists(runtime.oldPid, runtime.oldStartTime)).toBe(true);
		const during = await lifecycle();
		expect(during.state).toBe("serving");
		expect(during.retiring).toEqual({
			generation: runtime.generation,
			dispatched: 1,
		});
		const nextRuntime = await until(() => {
			const r = JSON.parse(readFileSync(join(control, "runtime.json"), "utf8"));
			return r.generation === runtime.generation + 1 && r;
		});
		expect(nextRuntime.retiring).toEqual({
			pid: runtime.oldPid,
			startTime: runtime.oldStartTime,
		});

		if (mode === "term_mid_retire") {
			const exited = new Promise<number | null>((resolve) =>
				runner!.once("exit", (code) => resolve(code)),
			);
			runner.kill("SIGTERM");
			// The guard drains the retiring generation before anything is stopped.
			await until(() => logs.includes("shutdown requested"));
			expect(processExists(runtime.oldPid, runtime.oldStartTime)).toBe(true);
			writeFileSync(streamRelease, "release\n");
			expect(await oldBody).toBe("firstlast");
			expect(await exited).toBe(143);
			expect(processExists(runtime.oldPid, runtime.oldStartTime)).toBe(false);
			expect(
				processExists(verified.candidatePid, verified.candidateStartTime),
			).toBe(false);
			expect(strayProcesses(dir)).toEqual([]);
			expect(fixtureEvents()).toContain(`close:${runtime.oldPid}`);
			expect(fixtureEvents()).toContain(`close:${verified.candidatePid}`);
			expect(recoverTransaction(control)).toEqual({ action: "start_candidate" });
			return;
		}

		writeFileSync(streamRelease, "release\n");
		expect(await oldBody).toBe("firstlast");
		await until(() => logs.includes("retiring backend reaped"));
		expect(processExists(runtime.oldPid, runtime.oldStartTime)).toBe(false);
		expect(fixtureEvents()).toEqual([
			`open:${runtime.oldPid}`,
			`quiesce:${runtime.oldPid}`,
			`open:${verified.candidatePid}`,
			`close:${runtime.oldPid}`,
			"",
		]);
		const after = await (await fetch(base + "/_guard/health")).json();
		expect(after.lifecycle.retiring).toBeNull();
		expect(after.lifecycle.lastRetireOutcome).toEqual({
			generation: runtime.generation,
			outcome: "natural",
		});
		expect(after.runtime.process.guardPid).toBe(guardPid);
		expect(after.backendSourceSha).toBe(newSource);
		expect(logs).not.toContain("restarting stack");
		const inspection = new Database(join(dir, "fixture.db"), {
			readonly: true,
		});
		expect(
			inspection
				.query("SELECT generation, path FROM calls ORDER BY rowid")
				.all(),
		).toEqual([
			{ generation: runtime.generation, path: "/v1/slow" },
			{ generation: runtime.generation + 1, path: "/v1/new" },
		]);
		inspection.close();
		console.info(
			JSON.stringify({
				fixture: "compiled-overlap-handoff",
				servedNewWorkMs: Math.round(servedNewWorkMs),
				oldStreamCompleted: true,
			}),
		);
	} catch (error) {
		throw new Error(`${error}\n${logs.slice(-6000)}`, { cause: error });
	} finally {
		if (!existsSync(streamRelease)) writeFileSync(streamRelease, "release\n");
		if (runner && runner.exitCode === null && runner.signalCode === null) {
			runner.kill("SIGTERM");
			await Promise.race([
				new Promise((r) => runner!.once("exit", r)),
				Bun.sleep(5000),
			]);
			if (runner.exitCode === null) runner.kill("SIGKILL");
		}
		for (const pid of strayProcesses(dir)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		rmSync(dir, { recursive: true, force: true });
	}
}, 40000);
