import { describe, expect, it } from "bun:test";
import { PRODUCT_NAME } from "@better-ccflare/core/product-identity";
import { renderToStaticMarkup } from "react-dom/server";
import { RouterUnreachableView, StartupCheckingView } from "./StartupStatus";

describe("StartupCheckingView", () => {
	it("shows the auth check at first", () => {
		const html = renderToStaticMarkup(<StartupCheckingView slow={false} />);
		expect(html).toContain("Checking authentication...");
		expect(html).not.toContain("restarting");
	});

	it("says the router may be restarting once the check is slow", () => {
		const html = renderToStaticMarkup(<StartupCheckingView slow={true} />);
		expect(html).toContain(`Waiting for ${PRODUCT_NAME}`);
		expect(html).toContain("restarting");
		expect(html).not.toContain("Checking authentication...");
	});
});

describe("RouterUnreachableView", () => {
	it("names the router, the last error, and offers a retry", () => {
		const html = renderToStaticMarkup(
			<RouterUnreachableView
				message="Request timeout"
				retrying={false}
				onRetry={() => {}}
			/>,
		);
		expect(html).toContain(`reach ${PRODUCT_NAME}`);
		expect(html).toContain("restarting");
		expect(html).toContain("Request timeout");
		expect(html).toContain("Retry now");
		expect(html).not.toContain('disabled=""');
	});

	it("disables the button while a retry is in flight", () => {
		const html = renderToStaticMarkup(
			<RouterUnreachableView
				message="Request timeout"
				retrying={true}
				onRetry={() => {}}
			/>,
		);
		expect(html).toContain("Retrying...");
		expect(html).toContain('disabled=""');
	});
});
