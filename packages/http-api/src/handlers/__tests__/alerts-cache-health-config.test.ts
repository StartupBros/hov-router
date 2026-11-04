import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@better-ccflare/config";
import {
	getAlertsConfig,
	getMemberNoticeDestination,
	memberNoticeStartupWarning,
	setAlertsConfig,
} from "../../services/alerts";
import type { APIContext } from "../../types";
import {
	createAlertsConfigGetHandler,
	createAlertsConfigSetHandler,
} from "../alerts";

describe("cache health alert config API", () => {
	let directory: string;
	let config: Config;
	let context: APIContext;
	let environment: Record<string, string | undefined>;
	beforeEach(() => {
		environment = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => key.startsWith("ALERT_")),
		);
		for (const key of Object.keys(environment)) delete process.env[key];
		directory = mkdtempSync(join(tmpdir(), "cache-health-handler-"));
		config = new Config(join(directory, "config.json"));
		context = { config } as APIContext;
	});
	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
		for (const key of Object.keys(process.env))
			if (key.startsWith("ALERT_")) delete process.env[key];
		Object.assign(process.env, environment);
	});
	const update = (body: unknown) =>
		createAlertsConfigSetHandler(context)(
			new Request("http://fixture/api/insights/alerts/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		);

	it("roundtrips optional cache fields, preserving omissions, destination and allowlist", async () => {
		config.setAlertWebhookUrl("https://example.com/existing");
		config.setAlertWebhookTypes("auth_failure,model_routing_drift");
		const response = await update({
			cacheHealthEnabled: false,
			cacheHealthThresholdPercent: 88,
			cacheHealthDurationMinutes: 60,
			cacheHealthMinRequests: 12,
			cacheHealthMinInputTokens: 120_000,
			cacheHealthReminderMinutes: 720,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			cacheHealthEnabled: false,
			cacheHealthThresholdPercent: 88,
			cacheHealthDurationMinutes: 60,
			cacheHealthMinRequests: 12,
			cacheHealthMinInputTokens: 120_000,
			cacheHealthReminderMinutes: 720,
		});
		await update({ dailySpendUsd: 25 });
		expect(await createAlertsConfigGetHandler(context)().json()).toMatchObject({
			dailySpendUsd: 25,
			cacheHealthEnabled: false,
			cacheHealthThresholdPercent: 88,
			cacheHealthDurationMinutes: 60,
			cacheHealthMinRequests: 12,
			cacheHealthMinInputTokens: 120_000,
			cacheHealthReminderMinutes: 720,
			webhookUrl: "https://example.com/existing",
		});
		expect(config.get("alert_webhook_types")).toBe(
			"auth_failure,model_routing_drift",
		);
	});

	it("does not rewrite omitted file values with env overrides", async () => {
		config.setAlertCacheHealthThresholdPercent(80);
		process.env.ALERT_CACHE_HEALTH_THRESHOLD_PERCENT = "95";
		expect(await (await update({ dailySpendUsd: 12 })).json()).toMatchObject({
			cacheHealthThresholdPercent: 95,
		});
		delete process.env.ALERT_CACHE_HEALTH_THRESHOLD_PERCENT;
		expect(config.getAlertCacheHealthThresholdPercent()).toBe(80);
	});

	it("keeps direct callers with old payloads compatible", () => {
		config.setAlertCacheHealthDurationMinutes(80);
		const payload = getAlertsConfig(config);
		delete payload.cacheHealthEnabled;
		delete payload.cacheHealthThresholdPercent;
		delete payload.cacheHealthDurationMinutes;
		delete payload.cacheHealthMinRequests;
		delete payload.cacheHealthMinInputTokens;
		delete payload.cacheHealthReminderMinutes;
		setAlertsConfig(config, payload);
		expect(config.getAlertCacheHealthDurationMinutes()).toBe(80);
	});

	it("normalizes numeric API inputs without poisoning policy with NaN", async () => {
		expect(
			await (
				await update({
					cacheHealthEnabled: "false",
					cacheHealthThresholdPercent: "Infinity",
					cacheHealthDurationMinutes: 31,
					cacheHealthMinRequests: 0,
					cacheHealthMinInputTokens: "bad",
					cacheHealthReminderMinutes: -1,
				})
			).json(),
		).toMatchObject({
			cacheHealthEnabled: false,
			cacheHealthThresholdPercent: 90,
			cacheHealthDurationMinutes: 40,
			cacheHealthMinRequests: 1,
			cacheHealthMinInputTokens: 100_000,
			cacheHealthReminderMinutes: 1,
		});
	});
});

describe("member notice destination state", () => {
	const HOST = "brobot.example.com";
	const ADDRESS = `https://${HOST}/api/internal/ai-alerts/router-events`;
	const SECRET = "router-signing-secret-7f3a";
	let directory: string;
	let config: Config;
	let context: APIContext;
	let environment: Record<string, string | undefined>;
	const isScoped = (key: string) =>
		key.startsWith("ALERT_") || key.startsWith("MEMBER_NOTICE_");
	beforeEach(() => {
		environment = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => isScoped(key)),
		);
		for (const key of Object.keys(environment)) delete process.env[key];
		directory = mkdtempSync(join(tmpdir(), "member-notice-state-"));
		config = new Config(join(directory, "config.json"));
		context = { config } as APIContext;
	});
	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
		for (const key of Object.keys(process.env))
			if (isScoped(key)) delete process.env[key];
		Object.assign(process.env, environment);
	});
	const payload = async () =>
		JSON.stringify(await createAlertsConfigGetHandler(context)().json());
	const state = async () =>
		(
			(await createAlertsConfigGetHandler(context)().json()) as {
				memberNotices?: { state: string };
			}
		).memberNotices?.state;

	it("is off when no member address is set, even with a signing secret", async () => {
		config.set("member_notice_signing_secret", SECRET);
		expect(await state()).toBe("off");
		expect(getMemberNoticeDestination(config)).toEqual({
			state: "off",
			url: null,
			secret: null,
		});
		expect(memberNoticeStartupWarning(config)).toBeNull();
	});

	it("is on with an https address and a secret, and the payload names neither", async () => {
		process.env.MEMBER_NOTICE_WEBHOOK_URL = `  ${ADDRESS}\n`;
		process.env.MEMBER_NOTICE_SIGNING_SECRET = SECRET;
		expect(await state()).toBe("on");
		expect(getMemberNoticeDestination(config)).toEqual({
			state: "on",
			url: ADDRESS,
			secret: SECRET,
		});
		const serialized = await payload();
		expect(serialized).not.toContain(HOST);
		expect(serialized).not.toContain(SECRET);
		expect(memberNoticeStartupWarning(config)).toBeNull();
	});

	it("is invalid_address for an address that is not an https URL, with a fixed warning", async () => {
		process.env.MEMBER_NOTICE_SIGNING_SECRET = SECRET;
		for (const address of [
			`http://${HOST}/api/internal/ai-alerts/router-events`,
			`${HOST}/api/internal/ai-alerts/router-events`,
		]) {
			process.env.MEMBER_NOTICE_WEBHOOK_URL = address;
			expect(await state()).toBe("invalid_address");
			expect(getMemberNoticeDestination(config)).toEqual({
				state: "invalid_address",
				url: null,
				secret: null,
			});
			const warning = memberNoticeStartupWarning(config) ?? "";
			expect(warning).toContain("not an https URL");
			expect(warning).not.toContain(HOST);
			expect(warning).not.toContain(SECRET);
			expect(await payload()).not.toContain(HOST);
		}
	});

	it("is missing_secret for an https address with no secret, with a fixed warning", async () => {
		config.set("member_notice_webhook_url", ADDRESS);
		expect(await state()).toBe("missing_secret");
		// The environment wins over the file, including when it is empty.
		config.set("member_notice_signing_secret", SECRET);
		process.env.MEMBER_NOTICE_SIGNING_SECRET = "";
		expect(await state()).toBe("missing_secret");
		expect(getMemberNoticeDestination(config)).toEqual({
			state: "missing_secret",
			url: null,
			secret: null,
		});
		const warning = memberNoticeStartupWarning(config) ?? "";
		expect(warning).toContain("MEMBER_NOTICE_SIGNING_SECRET");
		expect(warning).not.toContain(HOST);
		expect(warning).not.toContain(SECRET);
		expect(await payload()).not.toContain(SECRET);
	});

	it("cannot be set through the alerts config API", async () => {
		const response = await createAlertsConfigSetHandler(context)(
			new Request("http://fixture/api/insights/alerts/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					memberNotices: { state: "on", url: ADDRESS, secret: SECRET },
					member_notice_webhook_url: ADDRESS,
					member_notice_signing_secret: SECRET,
				}),
			}),
		);
		expect(response.status).toBe(200);
		expect(config.getMemberNoticeWebhookUrl()).toBe("");
		expect(config.getMemberNoticeSigningSecret()).toBe("");
		expect(await state()).toBe("off");
	});
});
