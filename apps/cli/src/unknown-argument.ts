import { levenshteinDistance } from "@better-ccflare/core";

/**
 * The largest edit distance at which a near miss is still suggested.
 */
export const SUGGESTION_MAX_DISTANCE = 2;

/**
 * Every flag `parseArgs` in main.ts accepts, plus `--smol`, which the systemd
 * unit in docs/systemd.md passes and the CLI ignores. Only used to suggest a
 * near miss for an argument it does not know: the `switch` is what accepts a
 * flag, and a test reads main.ts to fail if the two lists ever disagree.
 */
export const KNOWN_FLAGS = [
	"--version",
	"-v",
	"--help",
	"-h",
	"--serve",
	"--smol",
	"--port",
	"--ssl-key",
	"--ssl-cert",
	"--stats",
	"--add-account",
	"--mode",
	"--priority",
	"--profile",
	"--cross-region-mode",
	"--list",
	"--remove",
	"--pause",
	"--resume",
	"--set-priority",
	"--scan-external-codex",
	"--analyze",
	"--repair-db",
	"--doctor",
	"--doctor-full",
	"--doctor-recover",
	"--resolve-family-policy-aliases",
	"--convert-family-policy-aliases",
	"--all",
	"--family",
	"--include-pins",
	"--yes",
	"--cache-flight-recorder-report",
	"--cache-flight-recorder-health",
	"--json",
	"--api-url",
	"--reset-stats",
	"--clear-history",
	"--rebuild-windows",
	"--since",
	"--dry-run",
	"--compact",
	"--get-model",
	"--set-model",
	"--generate-api-key",
	"--admin",
	"--list-api-keys",
	"--disable-api-key",
	"--enable-api-key",
	"--delete-api-key",
	"--reauthenticate",
	"--force-reset-rate-limit",
	"--show-config",
] as const;

/**
 * The nearest long flag to `arg`, or null when none is within
 * SUGGESTION_MAX_DISTANCE. Compared case-insensitively, so `--LIST` suggests
 * `--list`. The one-letter short flags are left out: every unknown one-letter
 * flag is within distance 1 of `-v` and `-h`, so suggesting them would name a
 * flag for every typo and mean nothing.
 */
export function nearestKnownArgument(arg: string): string | null {
	const input = arg.toLowerCase();
	let best: string | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const candidate of KNOWN_FLAGS) {
		if (!candidate.startsWith("--")) continue;
		const distance = levenshteinDistance(input, candidate);
		if (distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
		}
	}
	return bestDistance <= SUGGESTION_MAX_DISTANCE ? best : null;
}

/**
 * The lines to print to stderr for an argument `parseArgs` does not
 * recognise, before exiting 1. Before this existed an unknown argument was
 * skipped and the no-argument path started the server, so a typo such as
 * `--lsit` booted a proxy on the default port.
 */
export function unknownArgumentLines(arg: string): string[] {
	const shown = arg === "" ? '""' : arg;
	const lines = [`❌ unknown argument: ${shown}`];

	const equals = arg.indexOf("=");
	const name = equals > 0 ? arg.slice(0, equals) : null;
	if (name && (KNOWN_FLAGS as readonly string[]).includes(name)) {
		lines.push(
			`${name} takes its value as the next argument: ${name} ${arg.slice(equals + 1)}`,
		);
	} else {
		const suggestion = nearestKnownArgument(arg);
		if (suggestion) lines.push(`Did you mean: ${suggestion}?`);
	}

	lines.push("Run hov-router --help to see every option.");
	return lines;
}
