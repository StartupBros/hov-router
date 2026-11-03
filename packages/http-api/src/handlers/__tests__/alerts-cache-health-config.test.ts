import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@better-ccflare/config";
import {
	getAlertsConfig,
	getMemberNoticeDestination,
	MEMBER_NOTICES_BLOCKED_WARNING,
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
	const ID = "1400000000000000001";
	const TOKEN = "member-token-abc";
	const DISCORD = `https://discord.com/api/webhooks/${ID}/${TOKEN}`;
	let directory: string;
	let config: Config;
	let context: APIContext;
	let environment: Record<string, string | undefined>;
	beforeEach(() => {
		environment = Object.fromEntries(
			Object.entries(process.env).filter(
				([key]) =>
					key.startsWith("ALERT_") || key === "MEMBER_NOTICE_WEBHOOK_URL",
			),
		);
		for (const key of Object.keys(environment)) delete process.env[key];
		directory = mkdtempSync(join(tmpdir(), "member-notice-state-"));
		config = new Config(join(directory, "config.json"));
		context = { config } as APIContext;
	});
	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
		for (const key of Object.keys(process.env))
			if (key.startsWith("ALERT_") || key === "MEMBER_NOTICE_WEBHOOK_URL")
				delete process.env[key];
		Object.assign(process.env, environment);
	});
	const state = async () =>
		(
			(await createAlertsConfigGetHandler(context)().json()) as {
				memberNotices?: { state: string };
			}
		).memberNotices?.state;

	it("is off when no member address is set", async () => {
		config.setAlertWebhookUrl(DISCORD);
		expect(await state()).toBe("off");
		expect(getMemberNoticeDestination(config)).toEqual({
			state: "off",
			url: null,
		});
		expect(memberNoticeStartupWarning(config)).toBeNull();
	});

	it("is on for a separate address, and the payload names no part of it", async () => {
		config.setAlertWebhookUrl(
			"https://discord.com/api/webhooks/1399999999999999999/alert-token",
		);
		config.set("member_notice_webhook_url", DISCORD);
		expect(await state()).toBe("on");
		expect(getMemberNoticeDestination(config)).toEqual({
			state: "on",
			url: DISCORD,
		});
		const serialized = JSON.stringify(
			await createAlertsConfigGetHandler(context)().json(),
		);
		expect(serialized).not.toContain(ID);
		expect(serialized).not.toContain(TOKEN);
		expect(serialized).not.toContain("discord.com/api/webhooks/1400");
		expect(memberNoticeStartupWarning(config)).toBeNull();
	});

	it("is on when only the token differs from the alert webhook", async () => {
		config.setAlertWebhookUrl(`https://discord.com/api/webhooks/${ID}/other`);
		process.env.MEMBER_NOTICE_WEBHOOK_URL = DISCORD;
		expect(await state()).toBe("on");
	});

	it("is blocked when the member address is the alert webhook under another Discord host spelling", async () => {
		config.setAlertWebhookUrl(DISCORD);
		for (const spelling of [
			`https://discordapp.com/api/webhooks/${ID}/${TOKEN}`,
			`https://canary.discord.com/api/webhooks/${ID}/${TOKEN}?wait=true`,
			`  https://PTB.Discord.com/api/webhooks/${ID}/${TOKEN}  `,
		]) {
			process.env.MEMBER_NOTICE_WEBHOOK_URL = spelling;
			expect(await state()).toBe("blocked_same_as_alert_webhook");
			expect(getMemberNoticeDestination(config).url).toBeNull();
		}
	});

	it("is blocked for a non-Discord address equal to the alert webhook once trimmed", async () => {
		config.setAlertWebhookUrl("https://example.com/hooks/alerts");
		process.env.MEMBER_NOTICE_WEBHOOK_URL =
			" https://example.com/hooks/alerts\n";
		expect(await state()).toBe("blocked_same_as_alert_webhook");
	});

	it("gives a fixed startup warning that names neither address when blocked", () => {
		config.setAlertWebhookUrl(DISCORD);
		process.env.MEMBER_NOTICE_WEBHOOK_URL = `https://discordapp.com/api/webhooks/${ID}/${TOKEN}`;
		const warning = memberNoticeStartupWarning(config);
		expect(warning).toBe(MEMBER_NOTICES_BLOCKED_WARNING);
		expect(warning).not.toContain(ID);
		expect(warning).not.toContain(TOKEN);
		expect(warning).not.toContain("discord");
	});

	it("cannot be set through the alerts config API", async () => {
		const response = await createAlertsConfigSetHandler(context)(
			new Request("http://fixture/api/insights/alerts/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					memberNotices: { state: "on", url: DISCORD },
					member_notice_webhook_url: DISCORD,
				}),
			}),
		);
		expect(response.status).toBe(200);
		expect(config.getMemberNoticeWebhookUrl()).toBe("");
		expect(await state()).toBe("off");
	});
});
