import { describe, expect, it } from "bun:test";
import {
	attachGenerationStartReader,
	generationStartFromReads,
	readGenerationStart,
} from "./stream-evidence";

function emptyStream(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.close();
		},
	});
}

describe("generation-start sidecar (#643)", () => {
	it("returns null for a stream nothing measured", () => {
		expect(readGenerationStart(emptyStream())).toBeNull();
		expect(readGenerationStart(null)).toBeNull();
		expect(readGenerationStart(undefined)).toBeNull();
	});

	it("reads the producer's value lazily, at read time", () => {
		const body = emptyStream();
		let startedAt: number | null = null;
		attachGenerationStartReader(body, () =>
			startedAt === null ? null : { startedAt },
		);
		expect(readGenerationStart(body)).toBeNull();
		startedAt = 1_700_000_001_000;
		expect(readGenerationStart(body)).toEqual({ startedAt: 1_700_000_001_000 });
	});

	it("keeps the stream identity through a Response wrap", () => {
		const body = emptyStream();
		attachGenerationStartReader(body, () => ({ burst: true }));
		expect(readGenerationStart(new Response(body).body)).toEqual({
			burst: true,
		});
	});

	it("never lets a failing or malformed producer reach the caller", () => {
		const throwing = emptyStream();
		attachGenerationStartReader(throwing, () => {
			throw new Error("producer failed");
		});
		expect(readGenerationStart(throwing)).toBeNull();

		for (const startedAt of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
			const body = emptyStream();
			attachGenerationStartReader(body, () => ({ startedAt }));
			expect(readGenerationStart(body)).toBeNull();
		}
	});

	it("reports a burst when no read followed the read that carried the first output", () => {
		expect(generationStartFromReads(null, 0, 4)).toBeNull();
		expect(generationStartFromReads(1_000, 3, 3)).toEqual({ burst: true });
		expect(generationStartFromReads(1_000, 3, 4)).toEqual({ startedAt: 1_000 });
	});
});
