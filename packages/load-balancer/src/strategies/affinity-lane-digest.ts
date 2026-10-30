import { createHash } from "node:crypto";

/** Restart-stable identity shared by affinity pins, circuits and request history. */
export function affinityLaneDigest(rawKey: string): string {
	return createHash("sha256")
		.update("hov-router/affinity-lane/v1\n")
		.update(rawKey)
		.digest("hex");
}
