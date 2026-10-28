import type { EventEmitter } from "node:events";
import { startSseKeepalive } from "./sse-keepalive";

/**
 * An SSE response subscribed to one event-bus channel.
 *
 * Both dashboard streams that speak the `event: connected` greeting
 * (requests, alerts) share this body. The logs stream does not: it greets
 * with a `data:` frame, answers an already-aborted request before building a
 * stream, and registers its abort listener before `start`, so it keeps its
 * own handler.
 */
export function createEventStreamHandler<T>(
	bus: EventEmitter,
	eventName: string,
): (req: Request) => Response {
	return (req: Request): Response => {
		let writeHandler: ((data: T) => void) | null = null;
		let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
		let stopKeepalive: (() => void) | null = null;
		let isClosed = false;
		const handleAbort = () => cleanup();
		const cleanup = () => {
			if (isClosed) return;
			isClosed = true;
			stopKeepalive?.();
			stopKeepalive = null;
			if (writeHandler) {
				bus.off(eventName, writeHandler);
				writeHandler = null;
			}
			req.signal.removeEventListener("abort", handleAbort);
			try {
				controller?.close();
			} catch {
				// The consumer may already have cancelled the stream.
			}
		};

		const stream = new ReadableStream<Uint8Array>({
			start(streamController) {
				controller = streamController;
				if (req.signal.aborted) {
					cleanup();
					return;
				}
				req.signal.addEventListener("abort", handleAbort);
				const encoder = new TextEncoder();
				writeHandler = (data: T) => {
					if (isClosed) return;
					try {
						streamController.enqueue(
							encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
						);
					} catch {
						cleanup();
					}
				};
				try {
					streamController.enqueue(
						encoder.encode("event: connected\ndata: ok\n\n"),
					);
				} catch {
					cleanup();
					return;
				}
				bus.on(eventName, writeHandler);
				stopKeepalive = startSseKeepalive(streamController, cleanup);
			},
			cancel: cleanup,
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				Connection: "keep-alive",
				"Cache-Control": "no-cache",
			},
		});
	};
}
