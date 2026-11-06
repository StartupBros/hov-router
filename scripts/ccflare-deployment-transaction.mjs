#!/usr/bin/env node
// One cold backend transaction. Ingress stays in its original process.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	closeSync,
	chownSync,
	fchownSync,
	chmodSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	readSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export function fileHash(path) {
	const h = createHash("sha256"),
		fd = openSync(path, "r"),
		buffer = Buffer.allocUnsafe(64 * 1024);
	try {
		for (;;) {
			const n = readSync(fd, buffer, 0, buffer.length, null);
			if (!n) break;
			h.update(buffer.subarray(0, n));
		}
		return h.digest("hex");
	} finally {
		closeSync(fd);
	}
}
// Only ENOENT proves absence. Permission, malformed or I/O failures are
// ownership ambiguity and must never authorize a second database owner.
export function processExists(pid, start, read = readFileSync) {
	try {
		const text = read(`/proc/${pid}/stat`, "utf8");
		const marker = text.lastIndexOf(") ");
		const actual = text.slice(marker + 2).split(" ")[19];
		if (marker < 0 || !/^\d+$/.test(actual))
			throw new Error("ambiguous process identity");
		return actual === String(start);
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}
export function durableWrite(path, value) {
	const staged = `${path}.new-${process.pid}-${randomBytes(8).toString("hex")}`;
	const fd = openSync(staged, "wx", 0o600);
	try {
		writeFileSync(fd, JSON.stringify(value));
		if (process.geteuid?.() === 0) {
			const owner = statSync(dirname(path));
			fchownSync(fd, owner.uid, owner.gid);
		}
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(staged, path);
	const dir = openSync(dirname(path), "r");
	try {
		fsyncSync(dir);
	} finally {
		closeSync(dir);
	}
}
// A listener on any local address blocks a same-port bind, so the port is
// free only when neither table has a LISTEN entry for it.
export function portListening(port, read = readFileSync) {
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
		throw new Error("invalid backend port");
	const portHex = port.toString(16).toUpperCase().padStart(4, "0");
	for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
		let text;
		try {
			text = read(table, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") continue;
			throw error;
		}
		for (const line of text.split("\n").slice(1)) {
			const fields = line.trim().split(/\s+/);
			if (fields[3] === "0A" && fields[1]?.endsWith(`:${portHex}`)) return true;
		}
	}
	return false;
}
// The backend a previous overlap handoff left draining. Absent is null;
// anything malformed is ambiguity, never absence.
function retiringIdentity(r) {
	if (r.retiring === undefined) return null;
	const x = r.retiring;
	if (
		!x ||
		typeof x !== "object" ||
		!Number.isSafeInteger(x.pid) ||
		x.pid < 1 ||
		typeof x.startTime !== "string" ||
		!/^(0|[1-9]\d{0,19})$/.test(x.startTime)
	)
		throw new Error("ambiguous retiring backend identity");
	return x;
}
function readIntent(dir) {
	return JSON.parse(readFileSync(join(dir, "intent.json"), "utf8"));
}
function validManifest(m, r) {
	const digest = (x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
	return (
		m &&
		/^[0-9a-f-]{36}$/.test(m.transactionId) &&
		/^[0-9a-f]{40}$/.test(m.candidateSourceSha) &&
		/^[0-9a-f]{32}$/.test(m.candidateNonce) &&
		digest(m.candidateHash) &&
		digest(m.candidatePinHash) &&
		m.expectedGeneration === r.generation &&
		m.oldPid === r.oldPid &&
		String(m.oldStartTime) === String(r.oldStartTime) &&
		m.previousPinHash === r.pinHash &&
		m.schemaDigest === r.schemaDigest &&
		digest(m.schemaDigest) &&
		JSON.stringify(m.ingress) === JSON.stringify(r.ingress) &&
		fileHash(r.pinPath) === r.pinHash &&
		typeof m.candidateBinary === "string" &&
		realpathSync(m.candidateBinary) === m.candidateBinary &&
		statSync(m.candidateBinary).isFile() &&
		(statSync(m.candidateBinary).mode & 0o222) === 0 &&
		fileHash(m.candidateBinary) === m.candidateHash &&
		(retiringIdentity(r), true)
	);
}
export function prepareTransaction(dir, m, r) {
	if (!validManifest(m, r))
		throw new Error("candidate manifest incompatible or identity mismatch");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	if (existsSync(join(dir, "intent.json"))) {
		const old = readIntent(dir);
		if (!["attached", "rolled_back"].includes(old.phase))
			throw new Error("existing transaction requires recovery");
	}
	const intent = {
		version: 1,
		phase: "prepared",
		manifest: m,
		previous: r,
		updatedAt: new Date().toISOString(),
	};
	durableWrite(join(dir, "intent.json"), intent);
	return intent;
}
// A prepared transaction no deploy acknowledged goes back to the intent it
// replaced (none, attached or rolled_back), so the runner never hands off
// with no deploy to commit. Refuses unless intent.json still holds exactly
// that prepared transaction.
export function abandonPreparedTransaction(dir, transactionId, replaced) {
	const current = readIntent(dir);
	if (
		current.phase !== "prepared" ||
		current.manifest?.transactionId !== transactionId
	)
		throw new Error("prepared transaction changed; not rewinding");
	const path = join(dir, "intent.json");
	if (replaced) {
		durableWrite(path, replaced);
		return;
	}
	unlinkSync(path);
	const fd = openSync(dir, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
// Legacy handoff: draining -> old_reaped. Overlap handoff: quiescing ->
// old_quiesced, where the old backend keeps finishing its streams after it
// releases the port; quiescing -> old_reaped is its fallback.
const next = {
	prepared: ["draining", "quiescing", "held"],
	draining: ["old_reaped", "held"],
	quiescing: ["old_quiesced", "old_reaped", "held"],
	old_quiesced: ["candidate_started", "held"],
	old_reaped: ["candidate_started", "held"],
	candidate_started: ["candidate_verified", "rolled_back", "held"],
	candidate_verified: ["committed", "rolled_back", "held"],
	committed: ["attached", "held"],
};
export function advanceTransaction(
	dir,
	expected,
	phase,
	evidence = {},
	exists = processExists,
	listening = portListening,
) {
	const transaction = readIntent(dir);
	if (transaction.phase !== expected || !next[expected]?.includes(phase))
		throw new Error("stale transaction phase");
	const retiring = retiringIdentity(transaction.previous);
	if (
		["draining", "quiescing"].includes(phase) &&
		retiring &&
		exists(retiring.pid, retiring.startTime)
	)
		throw new Error("previous handoff is still retiring");
	if (phase === "old_quiesced") {
		if (
			!Number.isSafeInteger(evidence.backendPort) ||
			evidence.backendPort < 1 ||
			evidence.backendPort > 65535
		)
			throw new Error("backend port evidence missing");
		if (listening(evidence.backendPort))
			throw new Error("previous backend still listens");
	}
	if (
		phase === "old_reaped" &&
		exists(transaction.previous.oldPid, transaction.previous.oldStartTime)
	)
		throw new Error("previous backend is not reaped");
	if (
		phase === "candidate_started" &&
		(!Number.isSafeInteger(evidence.candidatePid) ||
			evidence.candidatePid < 1 ||
			!/^\d+$/.test(String(evidence.candidateStartTime)))
	)
		throw new Error("candidate process evidence missing");
	if (
		phase === "candidate_verified" &&
		(!transaction.candidatePid ||
			!exists(transaction.candidatePid, transaction.candidateStartTime))
	)
		throw new Error("candidate identity unavailable");
	if (
		phase === "committed" &&
		fileHash(transaction.previous.pinPath) !==
			transaction.manifest.candidatePinHash
	)
		throw new Error("candidate pin not durably committed");
	if (
		phase === "rolled_back" &&
		(!transaction.candidatePid ||
			exists(transaction.candidatePid, transaction.candidateStartTime) ||
			fileHash(transaction.previous.pinPath) !==
				transaction.manifest.previousPinHash)
	)
		throw new Error("unsafe rollback");
	const out = {
		...transaction,
		...evidence,
		phase,
		updatedAt: new Date().toISOString(),
	};
	durableWrite(join(dir, "intent.json"), out);
	return out;
}
function matchesStartup(configured, binary, hash, source, schema) {
	if (!configured) return true;
	return (
		configured.binary === binary &&
		configured.sourceSha === source &&
		configured.schemaDigest === schema &&
		fileHash(binary) === hash
	);
}
export function prepareBootstrap(dir, receipt) {
	if (
		!/^[0-9a-f]{64}$/.test(receipt.pinHash) ||
		!/^[0-9a-f]{64}$/.test(receipt.binaryHash) ||
		!/^[0-9a-f]{40}$/.test(receipt.sourceSha) ||
		!/^[0-9a-f]{64}$/.test(receipt.schemaDigest) ||
		fileHash(receipt.binary) !== receipt.binaryHash
	)
		throw new Error("invalid bootstrap artifact");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	if (process.geteuid?.() === 0) {
		const owner = statSync(receipt.binary);
		chownSync(dir, owner.uid, owner.gid);
	}
	if (
		existsSync(join(dir, "intent.json")) &&
		!["attached", "rolled_back"].includes(readIntent(dir).phase)
	)
		throw new Error("unfinished transaction cannot bootstrap");
	durableWrite(join(dir, "bootstrap.json"), { version: 1, ...receipt });
}
export function recordBackendOwner(dir, phase, pid, start) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (
		phase !== "spawning" &&
		(phase !== "running" ||
			!Number.isSafeInteger(pid) ||
			pid < 1 ||
			!/^\d+$/.test(String(start)))
	)
		throw new Error("invalid backend ownership receipt");
	durableWrite(join(dir, "owner.json"), { phase, pid, start });
}
export function recoverTransaction(dir, exists = processExists, configured) {
	try {
		if (existsSync(join(dir, "owner.json"))) {
			const owner = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8"));
			if (
				owner?.phase !== "running" ||
				!Number.isSafeInteger(owner.pid) ||
				owner.pid < 1 ||
				typeof owner.start !== "string" ||
				!/^(0|[1-9]\d{0,19})$/.test(owner.start) ||
				BigInt(owner.start) > 18446744073709551615n ||
				exists(owner.pid, owner.start)
			)
				return { action: "hold", reason: "unreaped_or_ambiguous_owner" };
		}
		const bootstrapPath = join(dir, "bootstrap.json");
		const intentPath = join(dir, "intent.json");
		const transaction = existsSync(intentPath) ? readIntent(dir) : null;
		const retiring = transaction && retiringIdentity(transaction.previous);
		if (
			transaction &&
			((retiring && exists(retiring.pid, retiring.startTime)) ||
				exists(transaction.previous.oldPid, transaction.previous.oldStartTime) ||
				(transaction.candidatePid &&
					exists(transaction.candidatePid, transaction.candidateStartTime)))
		)
			return { action: "hold", reason: "unreaped_backend" };
		if (configured && existsSync(bootstrapPath)) {
			const receipt = JSON.parse(readFileSync(bootstrapPath, "utf8"));
			if (
				(!transaction ||
					["attached", "rolled_back"].includes(transaction.phase)) &&
				fileHash(configured.pinPath) === receipt.pinHash &&
				matchesStartup(
					configured,
					receipt.binary,
					receipt.binaryHash,
					receipt.sourceSha,
					receipt.schemaDigest,
				)
			)
				return { action: "start_bootstrap" };
		}
		if (!transaction) return { action: "start" };
		const hash = fileHash(transaction.previous.pinPath);
		if (
			["prepared", "rolled_back"].includes(transaction.phase) &&
			hash === transaction.manifest.previousPinHash &&
			matchesStartup(
				configured,
				transaction.previous.binary,
				transaction.previous.binaryHash,
				transaction.previous.backendSourceSha,
				transaction.previous.schemaDigest,
			)
		)
			return { action: "start_previous" };
		if (
			["committed", "attached"].includes(transaction.phase) &&
			hash === transaction.manifest.candidatePinHash &&
			matchesStartup(
				configured,
				transaction.manifest.candidateBinary,
				transaction.manifest.candidateHash,
				transaction.manifest.candidateSourceSha,
				transaction.manifest.schemaDigest,
			)
		)
			return { action: "start_candidate" };
		return { action: "hold", reason: "transaction_ambiguous" };
	} catch {
		return { action: "hold", reason: "identity_unavailable" };
	}
}
// Deploy control is three newline-delimited messages: the prepare command,
// the listener's prepared reply, and the client's acknowledgement, which the
// listener answers with a handoff confirmation before it exits 67. Preparing
// hashes the whole candidate and fsyncs the intent, which took longer than
// the client's old 3 s timeout on a loaded host on 2026-11-06.
const CLIENT_IDLE_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 2_000;
const ACK_TIMEOUT_MS = 30_000;
// Resolves with the listener's refusal or its handoff confirmation. Anything
// else rejects: the deploy then cannot tell whether a handoff started.
async function client(dir, command) {
	const runtime = JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8"));
	const control = runtime.controlDir;
	const secret = readFileSync(join(control, "deploy-credential"), "utf8");
	return await new Promise((resolve, reject) => {
		const socket = net.createConnection(join(control, "deploy.sock"));
		let input = "",
			reply = null,
			settled = false;
		const finish = (error, value) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			if (error) reject(error);
			else resolve(value);
		};
		socket.setTimeout(CLIENT_IDLE_TIMEOUT_MS, () =>
			finish(new Error("transaction command timeout")),
		);
		socket.on("error", (error) => finish(error));
		socket.on("close", () =>
			finish(
				new Error(reply ? "handoff not confirmed" : "transaction reply missing"),
			),
		);
		socket.on("connect", () =>
			socket.write(JSON.stringify({ ...command, secret }) + "\n"),
		);
		socket.on("data", (c) => {
			input += c;
			if (input.length > 4096) return finish(new Error("response too large"));
			for (let end = input.indexOf("\n"); end >= 0; end = input.indexOf("\n")) {
				let message;
				try {
					message = JSON.parse(input.slice(0, end));
				} catch (error) {
					return finish(error);
				}
				input = input.slice(end + 1);
				if (reply)
					return message.ok && message.phase === "handoff"
						? finish(null, message)
						: finish(new Error("handoff not confirmed"));
				reply = message;
				if (!message.ok) return finish(null, message);
				socket.write(
					JSON.stringify({ ack: command.manifest?.transactionId }) + "\n",
				);
			}
		});
	});
}
async function serve(dir, runtime) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const credential = randomBytes(32).toString("base64url");
	writeFileSync(join(runtime.controlDir, "deploy-credential"), credential, {
		mode: 0o600,
	});
	durableWrite(join(dir, "runtime.json"), {
		...runtime,
		deploymentPid: process.pid,
	});
	const socketPath = join(runtime.controlDir, "deploy.sock");
	try {
		unlinkSync(socketPath);
	} catch {}
	// The prepared transaction awaiting its acknowledgement or handed off.
	let pending = null;
	const sockets = new Set();
	const server = net.createServer((socket) => {
		if (sockets.size >= 4) {
			socket.destroy();
			return;
		}
		sockets.add(socket);
		let input = "",
			stage = "command",
			ours = null,
			timer;
		const bound = (ms) => {
			clearTimeout(timer);
			timer = setTimeout(() => socket.destroy(), ms);
		};
		bound(COMMAND_TIMEOUT_MS);
		socket.on("error", () => {});
		socket.on("close", () => {
			clearTimeout(timer);
			sockets.delete(socket);
			if (stage === "committed") {
				server.close(() => process.exit(67));
				for (const other of sockets) other.destroy();
			} else if (stage === "awaiting_ack") {
				try {
					abandonPreparedTransaction(
						dir,
						ours.manifest.transactionId,
						ours.replaced,
					);
					pending = null;
				} catch (error) {
					// Something else wrote intent.json: keep refusing prepares.
					console.error(`backend transaction held: ${error.message}`);
				}
			}
		});
		socket.on("data", (chunk) => {
			if (stage !== "command" && stage !== "awaiting_ack") return;
			input += chunk;
			if (input.length > 8192) {
				socket.destroy();
				return;
			}
			const end = input.indexOf("\n");
			if (end < 0) return;
			const line = input.slice(0, end);
			input = input.slice(end + 1);
			if (stage === "awaiting_ack") {
				let ack;
				try {
					ack = JSON.parse(line).ack;
				} catch {}
				if (ack !== ours.manifest.transactionId) {
					socket.destroy();
					return;
				}
				stage = "committed";
				socket.end(JSON.stringify({ ok: true, phase: "handoff" }) + "\n");
				bound(COMMAND_TIMEOUT_MS);
				return;
			}
			let result;
			try {
				const command = JSON.parse(line);
				const a = Buffer.from(String(command.secret || "")),
					b = Buffer.from(credential);
				if (a.length !== b.length || !timingSafeEqual(a, b))
					throw new Error("unauthorized");
				if (command.command !== "prepare" || pending)
					throw new Error("invalid control phase");
				const replaced = existsSync(join(dir, "intent.json"))
					? readIntent(dir)
					: null;
				prepareTransaction(dir, command.manifest, runtime);
				ours = pending = { manifest: command.manifest, replaced };
				stage = "awaiting_ack";
				result = { ok: true, phase: "prepared" };
			} catch {
				stage = "rejected";
				result = { ok: false, reason: "manifest_or_control_rejected" };
			}
			if (stage === "awaiting_ack") {
				socket.write(JSON.stringify(result) + "\n");
				bound(ACK_TIMEOUT_MS);
			} else {
				socket.end(JSON.stringify(result) + "\n");
				bound(COMMAND_TIMEOUT_MS);
			}
		});
	});
	server.listen(socketPath, () => chmodSync(socketPath, 0o600));
	// A signal leaves an unacknowledged prepare on disk on purpose: the RSS
	// recycle path retires this listener and adopts a prepared intent whose
	// reply was lost, and boot recovery restarts the previous build.
	for (const sig of ["SIGTERM", "SIGINT"])
		process.on(sig, () => {
			server.close();
			for (const s of sockets) s.destroy();
			process.exit(0);
		});
}
if (
	process.argv[1] &&
	process.argv[1] !== "-" &&
	existsSync(process.argv[1]) &&
	realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const [command, dir, ...args] = process.argv.slice(2);
	try {
		if (command === "serve")
			await serve(dir, JSON.parse(readFileSync(args[0], "utf8")));
		else if (command === "client") {
			const result = await client(
				dir,
				JSON.parse(readFileSync(args[0], "utf8")),
			);
			console.log(JSON.stringify(result));
			if (!result.ok) process.exitCode = 1;
		} else if (command === "owner-spawning")
			recordBackendOwner(dir, "spawning");
		else if (command === "owner-started")
			recordBackendOwner(dir, "running", Number(args[0]), args[1]);
		else if (command === "advance")
			console.log(
				JSON.stringify(
					advanceTransaction(
						dir,
						args[0],
						args[1],
						args[2] ? JSON.parse(args[2]) : {},
					),
				),
			);
		else if (command === "recover") {
			const result = recoverTransaction(dir, processExists, {
				binary: process.env.CCFLARE_BIN,
				sourceSha: process.env.CCFLARE_SOURCE_SHA,
				schemaDigest: process.env.CCFLARE_SCHEMA_DIGEST,
				pinPath: process.env.CCFLARE_PIN_PATH,
			});
			console.log(JSON.stringify(result));
			if (result.action === "hold") process.exitCode = 70;
		} else throw new Error("unknown transaction command");
	} catch (error) {
		console.error(`backend transaction held: ${error.message}`);
		process.exitCode = 70;
	}
}
