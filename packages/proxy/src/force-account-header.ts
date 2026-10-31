const FORCE_ACCOUNT_HEADER = "x-better-ccflare-account-id";

/**
 * The account id a caller forces with the public exact-account header, or
 * null when it forces none. A present but empty value forces nothing: the
 * selector routes it like a request without the header, so routing gates,
 * conflict checks and diagnostic labels read the header through this reader
 * and agree with that decision.
 *
 * One deliberate exception: the subscription WebSearch helper opt-in checks
 * presence with Headers.has(), so an empty header still disables it (#645,
 * fail-closed). Do not route that check through this reader.
 */
export function readForcedAccountHeader(
	headers: Headers | null | undefined,
): string | null {
	return headers?.get(FORCE_ACCOUNT_HEADER)?.trim() || null;
}
