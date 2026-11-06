import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	writeFileSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
	abandonPreparedTransaction,
	prepareTransaction,
	advanceTransaction,
	recoverTransaction,
	fileHash,
	processExists,
	durableWrite,
	prepareBootstrap,
	recordBackendOwner,
	portListening,
} from "../ccflare-deployment-transaction.mjs";
import net from "node:net";
import { resolveNodeExecutable } from "./node-runtime";
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-transaction-")),
		binary = join(dir, "candidate"),
		pin = join(dir, "pin");
	writeFileSync(binary, "candidate", { mode: 0o555 });
	writeFileSync(pin, "old-pin");
	const runtime = {
		generation: 1,
		oldPid: 999999,
		oldStartTime: "1",
		binary,
		binaryHash: fileHash(binary),
		backendSourceSha: "a".repeat(40),
		schemaDigest: "b".repeat(64),
		ingress: {
			runner: "c".repeat(64),
			guard: "d".repeat(64),
			policy: "e".repeat(64),
			timing: "f".repeat(64),
			transaction: "0".repeat(64),
		},
		pinPath: pin,
		pinHash: fileHash(pin),
	};
	const manifest = {
		transactionId: "af4c1b62-5a6c-4c2f-8d3a-2f5e7c8d9a01",
		expectedGeneration: 1,
		oldPid: 999999,
		oldStartTime: "1",
		previousPinHash: runtime.pinHash,
		candidatePinHash: "9".repeat(64),
		candidateBinary: binary,
		candidateHash: fileHash(binary),
		candidateSourceSha: "1".repeat(40),
		candidateNonce: "2".repeat(32),
		schemaDigest: runtime.schemaDigest,
		ingress: runtime.ingress,
	};
	return { dir, pin, runtime, manifest };
}
function started(f: ReturnType<typeof fixture>) {
	prepareTransaction(f.dir, f.manifest, f.runtime);
	advanceTransaction(f.dir, "prepared", "draining");
	advanceTransaction(f.dir, "draining", "old_reaped", {}, () => false);
	advanceTransaction(f.dir, "old_reaped", "candidate_started", {
		candidatePid: 999998,
		candidateStartTime: "2",
	});
}
test("durable preparation verifies immutable manifest and CAS phase", () => {
	const f = fixture();
	try {
		prepareTransaction(f.dir, f.manifest, f.runtime);
		expect(() => prepareTransaction(f.dir, f.manifest, f.runtime)).toThrow();
		expect(() => advanceTransaction(f.dir, "prepared", "old_reaped")).toThrow();
		expect(advanceTransaction(f.dir, "prepared", "draining").phase).toBe(
			"draining",
		);
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});
test.each([
	"candidateHash",
	"schemaDigest",
	"previousPinHash",
	"candidateSourceSha",
	"candidateNonce",
	"expectedGeneration",
])("reject invalid or wrong candidate identity %s before draining", (key) => {
	const f = fixture();
	try {
		expect(() =>
			prepareTransaction(f.dir, { ...f.manifest, [key]: "invalid" }, f.runtime),
		).toThrow();
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});
test("stale ingress artifacts reject compatible-looking candidate", () => {
	const f = fixture();
	try {
		expect(() =>
			prepareTransaction(
				f.dir,
				{
					...f.manifest,
					ingress: { ...f.manifest.ingress, timing: "1".repeat(64) },
				},
				f.runtime,
			),
		).toThrow();
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});
test("old unreaped or ambiguous identity prevents candidate ownership", () => {
	const f = fixture();
	try {
		prepareTransaction(f.dir, f.manifest, f.runtime);
		advanceTransaction(f.dir, "prepared", "draining");
		expect(() =>
			advanceTransaction(f.dir, "draining", "old_reaped", {}, () => true),
		).toThrow();
		expect(() =>
			advanceTransaction(f.dir, "draining", "old_reaped", {}, () => {
				throw new Error("EACCES");
			}),
		).toThrow();
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});
test("only ENOENT proves process absence; read failures hold recovery", () => {
	expect(
		processExists(42, "1", () => {
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		}),
	).toBe(false);
	for (const code of ["EACCES", "EIO"])
		expect(() =>
			processExists(42, "1", () => {
				throw Object.assign(new Error(code), { code });
			}),
		).toThrow();
	expect(() => processExists(42, "1", () => "malformed")).toThrow();
	const f = fixture();
	try {
		prepareTransaction(f.dir, f.manifest, f.runtime);
		expect(
			recoverTransaction(f.dir, () => {
				throw new Error("unknown");
			}).action,
		).toBe("hold");
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});
test("rollback needs durable candidate identity plus positively reaped candidate and old pin", () => {
	const f = fixture();
	try {
		started(f);
		expect(() =>
			advanceTransaction(
				f.dir,
				"candidate_started",
				"rolled_back",
				{},
				() => true,
			),
		).toThrow();
		expect(
			advanceTransaction(
				f.dir,
				"candidate_started",
				"rolled_back",
				{},
				() => false,
			).phase,
		).toBe("rolled_back");
		expect(recoverTransaction(f.dir, () => false).action).toBe(
			"start_previous",
		);
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});
test("candidate cannot attach before exact pin commit", () => {
	const f = fixture();
	try {
		started(f);
		advanceTransaction(
			f.dir,
			"candidate_started",
			"candidate_verified",
			{},
			() => true,
		);
		expect(() =>
			advanceTransaction(f.dir, "candidate_verified", "committed"),
		).toThrow();
		expect(() =>
			advanceTransaction(f.dir, "candidate_verified", "attached"),
		).toThrow();
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});
test.each([
	"prepared",
	"draining",
	"old_reaped",
	"quiescing",
	"old_quiesced",
	"candidate_started",
	"candidate_verified",
	"committed",
	"attached",
])("real child SIGKILL after fsync phase %s leaves one durable authority", (phase) => {
	const f = fixture();
	try {
		prepareTransaction(f.dir, f.manifest, f.runtime);
		const module = new URL(
			"../ccflare-deployment-transaction.mjs",
			import.meta.url,
		).href;
		const child = spawnSync(
			resolveNodeExecutable(),
			[
				"--input-type=module",
				"-e",
				`import {readFileSync} from "node:fs";import {durableWrite} from ${JSON.stringify(module)};const path=process.argv[1];const intent=JSON.parse(readFileSync(path));intent.phase=process.argv[2];intent.candidatePid=999998;intent.candidateStartTime="2";durableWrite(path,intent);process.kill(process.pid,"SIGKILL");`,
				join(f.dir, "intent.json"),
				phase,
			],
			{ timeout: 2000 },
		);
		expect(child.signal).toBe("SIGKILL");
		expect(
			JSON.parse(readFileSync(join(f.dir, "intent.json"), "utf8")).phase,
		).toBe(phase);
		expect(recoverTransaction(f.dir, () => true).action).toBe("hold");
		if (!["prepared"].includes(phase))
			expect(recoverTransaction(f.dir, () => false).action).toBe("hold");
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});
test("a future bootstrap requires exact new immutable artifact, source, schema and pin", () => {
	const f = fixture();
	try {
		prepareTransaction(f.dir, f.manifest, f.runtime);
		const intent = JSON.parse(readFileSync(join(f.dir, "intent.json"), "utf8"));
		intent.phase = "attached";
		durableWrite(join(f.dir, "intent.json"), intent);
		const receipt = {
			binary: f.runtime.binary,
			binaryHash: f.runtime.binaryHash,
			sourceSha: "3".repeat(40),
			schemaDigest: "4".repeat(64),
			pinHash: fileHash(f.pin),
		};
		prepareBootstrap(f.dir, receipt);
		const configured = {
			binary: receipt.binary,
			sourceSha: receipt.sourceSha,
			schemaDigest: receipt.schemaDigest,
			pinPath: f.pin,
		};
		expect(recoverTransaction(f.dir, () => false, configured).action).toBe(
			"start_bootstrap",
		);
		expect(recoverTransaction(f.dir, () => true, configured).action).toBe(
			"hold",
		);
		expect(
			recoverTransaction(f.dir, () => false, {
				...configured,
				sourceSha: "5".repeat(40),
			}).action,
		).toBe("hold");
		writeFileSync(f.pin, "other-pin");
		expect(recoverTransaction(f.dir, () => false, configured).action).toBe(
			"hold",
		);
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});
test("crash before child PID receipt remains held even when prior child is gone", () => {
	const f = fixture();
	try {
		recordBackendOwner(f.dir, "spawning");
		expect(recoverTransaction(f.dir, () => false).action).toBe("hold");
		recordBackendOwner(f.dir, "running", 999998, "2");
		expect(recoverTransaction(f.dir, () => false).action).toBe("start");
		expect(recoverTransaction(f.dir, () => true).action).toBe("hold");
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test("official inline Node bootstrap import does not execute CLI entrypoint", () => {
	const module = new URL(
		"../ccflare-deployment-transaction.mjs",
		import.meta.url,
	).href;
	const child = spawnSync(
		resolveNodeExecutable(),
		["--input-type=module", "-", module],
		{
			input:
				"const mod=await import(process.argv[2]);console.log(typeof mod.prepareBootstrap);",
			encoding: "utf8",
			timeout: 2000,
		},
	);
	expect(child.status).toBe(0);
	expect(child.stdout.trim()).toBe("function");
});

test("malformed running owner receipt holds before any process absence lookup", () => {
	const f = fixture();
	try {
		for (const owner of [
			{ phase: "running" },
			{ phase: "running", pid: 0, start: "2" },
			{ phase: "running", pid: "999998", start: "2" },
			{ phase: "running", pid: 999998, start: undefined },
			{ phase: "running", pid: 999998, start: 2 },
			{ phase: "running", pid: 999998, start: "../../self" },
			{ phase: "running", pid: 999998, start: "0002" },
		]) {
			writeFileSync(join(f.dir, "owner.json"), JSON.stringify(owner));
			let lookups = 0;
			expect(
				recoverTransaction(f.dir, () => {
					lookups++;
					return false;
				}),
			).toEqual({ action: "hold", reason: "unreaped_or_ambiguous_owner" });
			expect(lookups).toBe(0);
		}
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

const tcpHeader =
	"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
const tcpLine = (local: string, state: string, inode = "4242") =>
	`   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;
function procNet(tables: Record<string, string | Error>) {
	return (path: string) => {
		const table = tables[path];
		if (table === undefined)
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		if (table instanceof Error) throw table;
		return table;
	};
}
test("listener probe sees any LISTEN socket on the port; only ENOENT proves a table absent", () => {
	const listen = tcpHeader + tcpLine("0100007F:2255", "0A");
	expect(portListening(8789, procNet({ "/proc/net/tcp": listen }))).toBe(true);
	// Another address on the same port still blocks a same-port bind.
	expect(
		portListening(
			8789,
			procNet({ "/proc/net/tcp": tcpHeader + tcpLine("00000000:2255", "0A") }),
		),
	).toBe(true);
	expect(
		portListening(
			8789,
			procNet({
				"/proc/net/tcp": tcpHeader,
				"/proc/net/tcp6":
					tcpHeader +
					tcpLine("00000000000000000000000001000000:2255", "0A"),
			}),
		),
	).toBe(true);
	// An established connection on the port is not a listener.
	expect(
		portListening(
			8789,
			procNet({ "/proc/net/tcp": tcpHeader + tcpLine("0100007F:2255", "01") }),
		),
	).toBe(false);
	expect(
		portListening(
			8789,
			procNet({ "/proc/net/tcp": tcpHeader + tcpLine("0100007F:2256", "0A") }),
		),
	).toBe(false);
	for (const code of ["EACCES", "EIO"])
		expect(() =>
			portListening(
				8789,
				procNet({
					"/proc/net/tcp": tcpHeader,
					"/proc/net/tcp6": Object.assign(new Error(code), { code }),
				}),
			),
		).toThrow();
	expect(() => portListening(0, procNet({}))).toThrow();
	expect(() => portListening(65536, procNet({}))).toThrow();
});
test("listener probe reads the real kernel table", async () => {
	const server = net.createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as net.AddressInfo).port;
	try {
		expect(portListening(port)).toBe(true);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
	expect(portListening(port)).toBe(false);
});
test("overlap handoff: the old backend may live on, but only after its port is free", () => {
	const f = fixture();
	try {
		prepareTransaction(f.dir, f.manifest, f.runtime);
		expect(() => advanceTransaction(f.dir, "prepared", "old_quiesced")).toThrow();
		advanceTransaction(f.dir, "prepared", "quiescing");
		// A candidate must not start before the port is proven free.
		expect(() =>
			advanceTransaction(f.dir, "quiescing", "candidate_started", {
				candidatePid: 999998,
				candidateStartTime: "2",
			}),
		).toThrow();
		const alive = () => true;
		for (const evidence of [{}, { backendPort: 0 }, { backendPort: "8789" }])
			expect(() =>
				advanceTransaction(
					f.dir,
					"quiescing",
					"old_quiesced",
					evidence,
					alive,
					() => false,
				),
			).toThrow("backend port evidence missing");
		expect(() =>
			advanceTransaction(
				f.dir,
				"quiescing",
				"old_quiesced",
				{ backendPort: 8789 },
				alive,
				() => true,
			),
		).toThrow("previous backend still listens");
		let probed = 0;
		const out = advanceTransaction(
			f.dir,
			"quiescing",
			"old_quiesced",
			{ backendPort: 8789 },
			alive,
			(port: number) => {
				probed = port;
				return false;
			},
		);
		expect(probed).toBe(8789);
		expect(out).toMatchObject({ phase: "old_quiesced", backendPort: 8789 });
		expect(
			advanceTransaction(f.dir, "old_quiesced", "candidate_started", {
				candidatePid: 999998,
				candidateStartTime: "2",
			}).phase,
		).toBe("candidate_started");
		// While the quiesced backend still runs, recovery never starts anything.
		expect(recoverTransaction(f.dir, (pid: number) => pid === 999999)).toEqual({
			action: "hold",
			reason: "unreaped_backend",
		});
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});
test("quiesce fallback reaps the old backend before the candidate may start", () => {
	const f = fixture();
	try {
		prepareTransaction(f.dir, f.manifest, f.runtime);
		advanceTransaction(f.dir, "prepared", "quiescing");
		expect(() =>
			advanceTransaction(f.dir, "quiescing", "old_reaped", {}, () => true),
		).toThrow("previous backend is not reaped");
		advanceTransaction(f.dir, "quiescing", "old_reaped", {}, () => false);
		expect(
			advanceTransaction(f.dir, "old_reaped", "candidate_started", {
				candidatePid: 999998,
				candidateStartTime: "2",
			}).phase,
		).toBe("candidate_started");
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});
test.each(["quiescing", "old_quiesced"])(
	"interrupted %s holds recovery whether or not the old backend survived",
	(phase) => {
		const f = fixture();
		try {
			prepareTransaction(f.dir, f.manifest, f.runtime);
			advanceTransaction(f.dir, "prepared", "quiescing");
			if (phase === "old_quiesced")
				advanceTransaction(
					f.dir,
					"quiescing",
					"old_quiesced",
					{ backendPort: 8789 },
					() => true,
					() => false,
				);
			expect(recoverTransaction(f.dir, () => true)).toEqual({
				action: "hold",
				reason: "unreaped_backend",
			});
			expect(recoverTransaction(f.dir, () => false)).toEqual({
				action: "hold",
				reason: "transaction_ambiguous",
			});
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	},
);
test("a backend still retiring from the previous handoff blocks the next handoff and recovery", () => {
	const f = fixture();
	const retiring = { pid: 999997, startTime: "3" };
	const runtime = { ...f.runtime, retiring };
	const retiringAlive = (pid: number) => pid === retiring.pid;
	try {
		prepareTransaction(f.dir, f.manifest, runtime);
		for (const next of ["quiescing", "draining"])
			expect(() =>
				advanceTransaction(f.dir, "prepared", next, {}, retiringAlive),
			).toThrow("previous handoff is still retiring");
		expect(recoverTransaction(f.dir, retiringAlive)).toEqual({
			action: "hold",
			reason: "unreaped_backend",
		});
		expect(recoverTransaction(f.dir, () => false).action).toBe(
			"start_previous",
		);
		expect(
			advanceTransaction(f.dir, "prepared", "quiescing", {}, () => false).phase,
		).toBe("quiescing");
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});
test.each([
	{ pid: "999997", startTime: "3" },
	{ pid: 0, startTime: "3" },
	{ pid: 999997, startTime: 3 },
	{ pid: 999997, startTime: "../3" },
	{ pid: 999997 },
	"999997",
])("malformed retiring identity %p is refused and holds recovery", (retiring) => {
	const f = fixture();
	try {
		expect(() =>
			prepareTransaction(f.dir, f.manifest, { ...f.runtime, retiring }),
		).toThrow();
		prepareTransaction(f.dir, f.manifest, f.runtime);
		const intent = JSON.parse(readFileSync(join(f.dir, "intent.json"), "utf8"));
		intent.previous.retiring = retiring;
		durableWrite(join(f.dir, "intent.json"), intent);
		let lookups = 0;
		expect(
			recoverTransaction(f.dir, () => {
				lookups++;
				return false;
			}),
		).toEqual({ action: "hold", reason: "identity_unavailable" });
		expect(lookups).toBe(0);
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

// A handoff starts only for a deploy that got the prepared reply: the client
// acknowledges it, the listener confirms, and only then exits 67. On
// 2026-11-06 a client timed out during a slow prepare and the listener started
// a handoff no deploy was left to commit.
const transactionModule = fileURLToPath(
	new URL("../ccflare-deployment-transaction.mjs", import.meta.url),
);
let nodeBinary: string | undefined;
function node() {
	nodeBinary ??= resolveNodeExecutable();
	return nodeBinary;
}
async function until(check: () => boolean, ms = 5000) {
	const deadline = performance.now() + ms;
	while (!check()) {
		if (performance.now() > deadline) throw new Error("condition timed out");
		await Bun.sleep(20);
	}
}
function priorIntent(f: ReturnType<typeof fixture>) {
	return {
		version: 1,
		phase: "attached",
		manifest: {
			...f.manifest,
			transactionId: "0f0e0d0c-0b0a-4908-8706-050403020100",
		},
		previous: f.runtime,
		updatedAt: "2026-11-06T00:00:00.000Z",
	};
}
function intentAt(dir: string) {
	const path = join(dir, "intent.json");
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}
function runClient(handoff: string, command: string) {
	return new Promise<{ code: number | null; stdout: string; stderr: string }>(
		(resolve) => {
			const child = spawn(node(), [
				transactionModule,
				"client",
				handoff,
				command,
			]);
			let stdout = "",
				stderr = "";
			child.stdout.on("data", (c) => {
				stdout += c;
			});
			child.stderr.on("data", (c) => {
				stderr += c;
			});
			child.on("close", (code) => resolve({ code, stdout, stderr }));
		},
	);
}
async function startListener(prior?: object) {
	const f = fixture();
	const control = mkdtempSync(join(tmpdir(), "ccflare-control-"));
	const handoff = join(f.dir, "handoff");
	mkdirSync(handoff, { mode: 0o700 });
	if (prior) durableWrite(join(handoff, "intent.json"), prior);
	const input = join(f.dir, "runtime-input.json");
	writeFileSync(input, JSON.stringify({ ...f.runtime, controlDir: control }));
	const child = spawn(node(), [transactionModule, "serve", handoff, input], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (c) => {
		stderr += c;
	});
	const exited = new Promise<number | null>((resolve) =>
		child.on("exit", (code) => resolve(code)),
	);
	await until(
		() =>
			existsSync(join(control, "deploy.sock")) &&
			existsSync(join(handoff, "runtime.json")),
	);
	const command = join(f.dir, "command.json");
	writeFileSync(
		command,
		JSON.stringify({ command: "prepare", manifest: f.manifest }),
	);
	const commandLine = () =>
		JSON.stringify({
			command: "prepare",
			manifest: f.manifest,
			secret: readFileSync(join(control, "deploy-credential"), "utf8"),
		}) + "\n";
	return {
		f,
		control,
		handoff,
		child,
		exited,
		command,
		commandLine,
		stderr: () => stderr,
		cleanup() {
			child.kill("SIGKILL");
			rmSync(f.dir, { recursive: true, force: true });
			rmSync(control, { recursive: true, force: true });
		},
	};
}
function connect(control: string) {
	const socket = net.createConnection(join(control, "deploy.sock"));
	const lines: string[] = [];
	let buffer = "",
		closed = false;
	socket.on("data", (c) => {
		buffer += c;
		for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
			lines.push(buffer.slice(0, end));
			buffer = buffer.slice(end + 1);
		}
	});
	socket.on("error", () => {});
	socket.on("close", () => {
		closed = true;
	});
	const connected = new Promise<void>((resolve) =>
		socket.on("connect", () => resolve()),
	);
	return {
		socket,
		connected,
		isClosed: () => closed,
		async nextLine(ms = 5000) {
			await until(() => lines.length > 0 || closed, ms);
			return lines.shift();
		},
	};
}
async function exitWithin(exited: Promise<number | null>, ms: number) {
	return await Promise.race([
		exited,
		Bun.sleep(ms).then(() => "running" as const),
	]);
}

test("an unacknowledged prepare rewinds to the intent it replaced", () => {
	const f = fixture();
	try {
		const prior = priorIntent(f);
		durableWrite(join(f.dir, "intent.json"), prior);
		prepareTransaction(f.dir, f.manifest, f.runtime);
		abandonPreparedTransaction(f.dir, f.manifest.transactionId, prior);
		expect(intentAt(f.dir)).toEqual(prior);
		expect(prepareTransaction(f.dir, f.manifest, f.runtime).phase).toBe(
			"prepared",
		);
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test("an unacknowledged first prepare leaves no intent behind", () => {
	const f = fixture();
	try {
		prepareTransaction(f.dir, f.manifest, f.runtime);
		abandonPreparedTransaction(f.dir, f.manifest.transactionId, null);
		expect(existsSync(join(f.dir, "intent.json"))).toBe(false);
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test("a rewind refuses an intent that is no longer this prepared transaction", () => {
	const f = fixture();
	try {
		prepareTransaction(f.dir, f.manifest, f.runtime);
		expect(() =>
			abandonPreparedTransaction(
				f.dir,
				"11111111-1111-4111-8111-111111111111",
				null,
			),
		).toThrow("prepared transaction changed");
		expect(intentAt(f.dir).phase).toBe("prepared");
		advanceTransaction(f.dir, "prepared", "draining");
		expect(() =>
			abandonPreparedTransaction(f.dir, f.manifest.transactionId, null),
		).toThrow("prepared transaction changed");
		expect(intentAt(f.dir).phase).toBe("draining");
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test("the listener starts the handoff only after the client acknowledges the prepared reply", async () => {
	const l = await startListener();
	try {
		const client = await runClient(l.handoff, l.command);
		expect(client.code, client.stderr).toBe(0);
		expect(JSON.parse(client.stdout)).toEqual({ ok: true, phase: "handoff" });
		expect(await exitWithin(l.exited, 5000)).toBe(67);
		expect(intentAt(l.handoff)).toMatchObject({
			phase: "prepared",
			manifest: { transactionId: l.f.manifest.transactionId },
		});
	} finally {
		l.cleanup();
	}
}, 20_000);

test("a client that leaves after the prepared reply without acknowledging starts no handoff", async () => {
	const l = await startListener(priorIntent(fixture()));
	try {
		const prior = intentAt(l.handoff);
		const c = connect(l.control);
		await c.connected;
		c.socket.write(l.commandLine());
		expect(JSON.parse(String(await c.nextLine()))).toEqual({
			ok: true,
			phase: "prepared",
		});
		c.socket.destroy();
		await until(
			() => JSON.stringify(intentAt(l.handoff)) === JSON.stringify(prior),
		);
		expect(await exitWithin(l.exited, 500)).toBe("running");
		// The rewound listener takes the next deploy.
		const client = await runClient(l.handoff, l.command);
		expect(client.code, client.stderr + l.stderr()).toBe(0);
		expect(await exitWithin(l.exited, 5000)).toBe(67);
	} finally {
		l.cleanup();
	}
}, 20_000);

test("a client that disconnects before the reply arrives starts no handoff", async () => {
	const l = await startListener();
	try {
		const c = connect(l.control);
		await c.connected;
		c.socket.write(l.commandLine());
		c.socket.destroy();
		expect(await exitWithin(l.exited, 1000)).toBe("running");
		expect(intentAt(l.handoff)).toBeNull();
		const client = await runClient(l.handoff, l.command);
		expect(client.code, client.stderr + l.stderr()).toBe(0);
		expect(await exitWithin(l.exited, 5000)).toBe(67);
	} finally {
		l.cleanup();
	}
}, 20_000);

test("an acknowledgement for another transaction starts no handoff", async () => {
	const l = await startListener();
	try {
		const c = connect(l.control);
		await c.connected;
		c.socket.write(l.commandLine());
		expect(JSON.parse(String(await c.nextLine()))).toMatchObject({ ok: true });
		c.socket.write(
			JSON.stringify({ ack: "11111111-1111-4111-8111-111111111111" }) + "\n",
		);
		expect(await c.nextLine()).toBeUndefined();
		await until(() => intentAt(l.handoff) === null);
		expect(await exitWithin(l.exited, 500)).toBe("running");
	} finally {
		l.cleanup();
	}
}, 20_000);

test("the command timer does not cut off an acknowledgement sent after 2 s", async () => {
	const l = await startListener();
	try {
		const c = connect(l.control);
		await c.connected;
		await Bun.sleep(1500);
		c.socket.write(l.commandLine());
		expect(JSON.parse(String(await c.nextLine()))).toMatchObject({ ok: true });
		await Bun.sleep(1000);
		c.socket.write(JSON.stringify({ ack: l.f.manifest.transactionId }) + "\n");
		expect(JSON.parse(String(await c.nextLine()))).toEqual({
			ok: true,
			phase: "handoff",
		});
		expect(await exitWithin(l.exited, 5000)).toBe(67);
	} finally {
		l.cleanup();
	}
}, 20_000);

test("a rejected prepare exits 1 and leaves the listener waiting", async () => {
	const l = await startListener();
	try {
		writeFileSync(
			l.command,
			JSON.stringify({
				command: "prepare",
				manifest: { ...l.f.manifest, expectedGeneration: 2 },
			}),
		);
		const client = await runClient(l.handoff, l.command);
		expect(client.code, client.stderr).toBe(1);
		expect(JSON.parse(client.stdout)).toMatchObject({ ok: false });
		expect(intentAt(l.handoff)).toBeNull();
		expect(await exitWithin(l.exited, 500)).toBe("running");
	} finally {
		l.cleanup();
	}
}, 20_000);

// The real client against a scripted server, to control timing.
async function fakeListener(
	onCommand: (socket: net.Socket) => void,
	onAck: (socket: net.Socket, ack: unknown) => void,
) {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-client-"));
	const control = join(dir, "control");
	mkdirSync(control);
	writeFileSync(join(dir, "runtime.json"), JSON.stringify({ controlDir: control }));
	writeFileSync(join(control, "deploy-credential"), "fixture-secret");
	const transactionId = "af4c1b62-5a6c-4c2f-8d3a-2f5e7c8d9a01";
	const command = join(dir, "command.json");
	writeFileSync(
		command,
		JSON.stringify({ command: "prepare", manifest: { transactionId } }),
	);
	const server = net.createServer((socket) => {
		let buffer = "",
			seen = 0;
		socket.on("error", () => {});
		socket.on("data", (c) => {
			buffer += c;
			for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				if (seen++ === 0) onCommand(socket);
				else onAck(socket, JSON.parse(line));
			}
		});
	});
	await new Promise<void>((resolve) =>
		server.listen(join(control, "deploy.sock"), resolve),
	);
	return {
		dir,
		command,
		transactionId,
		async close() {
			await new Promise((resolve) => server.close(resolve));
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("the client waits out a prepare slower than the old 3 s timeout", async () => {
	let ack: unknown;
	const fake = await fakeListener(
		(socket) =>
			setTimeout(
				() => socket.write(JSON.stringify({ ok: true, phase: "prepared" }) + "\n"),
				3500,
			),
		(socket, message) => {
			ack = message;
			socket.end(JSON.stringify({ ok: true, phase: "handoff" }) + "\n");
		},
	);
	try {
		const client = await runClient(fake.dir, fake.command);
		expect(client.code, client.stderr).toBe(0);
		expect(ack).toEqual({ ack: fake.transactionId });
	} finally {
		await fake.close();
	}
}, 20_000);

test("the client exits 70 when the listener never confirms the handoff", async () => {
	const fake = await fakeListener(
		(socket) =>
			socket.write(JSON.stringify({ ok: true, phase: "prepared" }) + "\n"),
		(socket) => socket.end(),
	);
	try {
		const client = await runClient(fake.dir, fake.command);
		expect(client.code, client.stderr).toBe(70);
		expect(client.stderr).toContain("handoff not confirmed");
	} finally {
		await fake.close();
	}
}, 20_000);
