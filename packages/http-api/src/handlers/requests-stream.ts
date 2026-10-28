import { type RequestEvt, requestEvents } from "@better-ccflare/core";
import { createEventStreamHandler } from "./event-stream";

export function createRequestsStreamHandler() {
	return createEventStreamHandler<RequestEvt>(requestEvents, "event");
}
