import type { RoutingStreamEvidence } from "@better-ccflare/types/request";

export type RawStreamEvidence = Pick<
	RoutingStreamEvidence,
	"rawEventCounts" | "rawVisibleEvents" | "providerTerminal"
>;
const readers = new WeakMap<
	ReadableStream<Uint8Array>,
	() => RawStreamEvidence
>();

/** In-process observation only; never grants replay authority or retains raw frames. */
export function attachStreamEvidenceReader(
	body: ReadableStream<Uint8Array>,
	read: () => RawStreamEvidence,
): void {
	readers.set(body, read);
}
export function readStreamEvidence(
	body: ReadableStream<Uint8Array>,
): RawStreamEvidence | null {
	try {
		return readers.get(body)?.() ?? null;
	} catch {
		return null;
	}
}

/**
 * When the model began producing output, measured by the layer that last saw
 * real network reads (#643). The precommit gate holds a block start (tool_use,
 * hidden thinking) until meaningful content arrives and then replays the
 * buffer at once, and the Codex translator emits reasoning and tool arguments
 * only when each item finishes; both make the usage collector's own first-token
 * stamp land long after generation began, which inflates tokens per second.
 *
 * `{ startedAt }` is the wall-clock time of the read that carried the first
 * output. `{ burst: true }` means that read was also the last one, so the
 * response arrived whole and no generation window can be measured.
 */
export type GenerationStart = { startedAt: number } | { burst: true };

const generationStartReaders = new WeakMap<
	ReadableStream<Uint8Array>,
	() => GenerationStart | null
>();

/** Read lazily at stream end, so the producer may keep updating its counters. */
export function attachGenerationStartReader(
	body: ReadableStream<Uint8Array>,
	read: () => GenerationStart | null,
): void {
	generationStartReaders.set(body, read);
}

export function readGenerationStart(
	body: ReadableStream<Uint8Array> | null | undefined,
): GenerationStart | null {
	if (!body) return null;
	try {
		const value = generationStartReaders.get(body)?.() ?? null;
		if (!value) return null;
		if ("burst" in value) return value.burst === true ? { burst: true } : null;
		return Number.isFinite(value.startedAt) && value.startedAt > 0
			? { startedAt: value.startedAt }
			: null;
	} catch {
		return null;
	}
}

/**
 * `startRead` is the read count when the first output arrived; `lastRead` is
 * the count at stream end. Equal counts mean nothing arrived after it.
 */
export function generationStartFromReads(
	startedAt: number | null,
	startRead: number,
	lastRead: number,
): GenerationStart | null {
	if (startedAt === null) return null;
	return lastRead > startRead ? { startedAt } : { burst: true };
}
