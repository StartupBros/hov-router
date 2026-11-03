import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { HealthVerdict } from "../../../lib/health-verdict";
import { queryKeys } from "../../../lib/query-keys";
import { SystemStatus } from "../SystemStatus";

function render(health: HealthVerdict | null): string {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	queryClient.setQueryData(queryKeys.health(), health);
	return renderToStaticMarkup(
		<QueryClientProvider client={queryClient}>
			<SystemStatus />
		</QueryClientProvider>,
	);
}

// The banner used to be hard-coded to these, whatever the router said (#694).
const STATIC_CLAIMS = /all systems operational|healthy/i;

describe("SystemStatus", () => {
	test("shows the degraded verdict instead of a static all-clear", () => {
		const html = render({
			status: "degraded",
			pool: {
				configured: 2,
				routable: 0,
				paused: 0,
				rate_limited: 2,
				usage_exhausted: 0,
				next_available_at: "2026-11-02T15:45:00.000Z",
			},
		});
		expect(html).toContain("No account can route right now");
		expect(html).toContain('role="status"');
		expect(html).not.toMatch(STATIC_CLAIMS);
	});

	test("shows an unknown status when /health gave no verdict", () => {
		const html = render(null);
		expect(html).toContain("Status unknown");
		expect(html).not.toMatch(STATIC_CLAIMS);
	});
});
