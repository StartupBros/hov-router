import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@better-ccflare/config";
import { normalizeProviderUsageWindows } from "@better-ccflare/core";
import { DatabaseOperations } from "@better-ccflare/database";
import { OffThreadReader } from "../../../../database/src/off-thread-reader";
import { ExternalUsageRepository } from "../../../../database/src/repositories/external-usage.repository";
import { AlertService } from "../../services/alerts";
import type { APIContext } from "../../types";
import { createAnalyticsHandler } from "../analytics";
import { createStatsHandler } from "../stats";

const DAY = 86400000;
const NOW = 1_800_000_000_000;
let dir: string;
let db: DatabaseOperations;
let reader: OffThreadReader;
const others: DatabaseOperations[] = [];

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "ccflare-off-thread-equivalence-"));
	db = new DatabaseOperations(join(dir, "test.db"), { synchronous: "OFF" });
	db.getAdapter().setOffThreadReader(undefined);
	reader = new OffThreadReader({
		dbPath: join(dir, "test.db"),
		busyTimeoutMs: 100,
		embeddedCode: "",
		sourceUrl: new URL(
			"../../../../database/src/reader-worker.ts",
			import.meta.url,
		).href,
	});
	spyOn(Date, "now").mockImplementation(() => NOW);
	const adapter = db.getAdapter();
	for (let group = 1; group <= 3; group++) {
		await adapter.run(
			"INSERT INTO accounts (id,name,provider,created_at) VALUES (?,?, 'codex',0)",
			[`a${group}`, `Account ${group}`],
		);
		for (let day = 0; day < 35; day++) {
			for (let j = 0; j < [1, 3, 7][group - 1]; j++) {
				const id = `${day}-${group}-${j}`;
				await adapter.run(
					`INSERT INTO requests (id,timestamp,method,path,success,response_time_ms,failover_attempts,model,account_used,api_key_id,api_key_name,billing_type,input_tokens,cache_read_input_tokens,cache_creation_input_tokens,output_tokens,total_tokens,cost_usd,output_tokens_per_second,error_message,status_code) VALUES (?,?,'POST','/v1/messages',?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
					[
						id,
						NOW - day * DAY - (group * 100 + j) * 1000,
						j % 4 !== 0,
						day * 100 + group * 10 + j,
						`model-${group}`,
						`a${group}`,
						`k${group}`,
						`Key ${group}`,
						group === 3 ? "api" : "plan",
						100 + j,
						20,
						10,
						30 + j,
						160 + 2 * j,
						group / 8,
						group * 10 + j,
						j % 4 === 0 ? `error-${group}` : null,
						j % 4 === 0 ? 429 : 200,
					],
				);
			}
		}
	}
	await adapter.run(
		"UPDATE requests SET advisor_usage = ? WHERE id = '0-1-0'",
		[
			JSON.stringify([
				{
					model: "advisor",
					inputTokens: 10,
					outputTokens: 5,
					cacheReadInputTokens: 2,
					cacheCreationInputTokens: 1,
				},
			]),
		],
	);
	for (let i = 0; i < 4; i++)
		await adapter.run(
			`INSERT INTO external_usage_events (id,account_id,source_kind,event_ts,timestamp,model,input_tokens,cache_read_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,is_fallback_model,session_id,ingested_at) VALUES (?,?,'cloud',?,?,?,100,20,30,5,150,0,'session',?)`,
			[
				`external-${i}`,
				i === 3 ? null : "a1",
				NOW - (i + 1) * 1000,
				`event-${i}`,
				`external-model-${i % 2}`,
				NOW,
			],
		);
});
afterEach(async () => {
	await reader?.close();
	for (const other of others.splice(0)) await other.close();
	await db?.close();
	mock.restore();
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("heavy read result equivalence", () => {
	it("returns deterministic byte-identical analytics for all 20 range/mode/breakdown combinations", async () => {
		const handler = createAnalyticsHandler({ dbOps: db } as APIContext);
		const params = new URLSearchParams({ range: "30d" });
		const first = await handler(params);
		expect(first.status).toBe(200);
		expect(await first.text()).toBe(await (await handler(params)).text());
		for (const range of ["1h", "6h", "24h", "7d", "30d"])
			for (const mode of ["normal", "cumulative"])
				for (const modelBreakdown of ["false", "true"]) {
					const query = new URLSearchParams({ range, mode, modelBreakdown });
					db.getAdapter().setOffThreadReader(undefined);
					const main = await handler(query);
					expect(main.status).toBe(200);
					db.getAdapter().setOffThreadReader(reader);
					const before = reader.readsServed;
					const worker = await handler(query);
					expect(worker.status).toBe(200);
					expect(await worker.text()).toBe(await main.text());
					expect(reader.readsServed - before).toBeGreaterThanOrEqual(5);
				}
	});
	it("returns identical stats through separate database caches and exercises all four reads", async () => {
		const detached = new DatabaseOperations(join(dir, "test.db"));
		others.push(detached);
		detached.getAdapter().setOffThreadReader(undefined);
		db.getAdapter().setOffThreadReader(reader);
		const url = new URL(
			"http://localhost/api/stats?since=30&errorsSinceHours=8760",
		);
		const main = await createStatsHandler(detached)(url);
		const before = reader.readsServed;
		const worker = await createStatsHandler(db)(url);
		expect(worker.status).toBe(200);
		expect(await worker.text()).toBe(await main.text());
		expect(reader.readsServed - before).toBe(4);
	});
	it("returns identical accounts-page session stats through the reader", async () => {
		const sessions = [
			{ id: "a1", session_start: NOW - 3 * DAY },
			{ id: "a2", session_start: NOW - 20 * DAY },
			{ id: "a3", session_start: null },
		];
		const stats = db.getStatsRepository();
		const main = [...(await stats.getSessionStats(sessions)).entries()];
		expect(main.map(([id]) => id).sort()).toEqual(["a1", "a2"]);
		db.getAdapter().setOffThreadReader(reader);
		const before = reader.readsServed;
		const worker = [...(await stats.getSessionStats(sessions)).entries()];
		expect(JSON.stringify(worker)).toBe(JSON.stringify(main));
		expect(reader.readsServed - before).toBe(1);
	});
	it("preserves token aggregates including advisor/external usage and the external report", async () => {
		const external = new ExternalUsageRepository(db.getAdapter());
		const main = await db.aggregateTokensByModel("a1", NOW - 35 * DAY, NOW);
		const report = await external.report();
		expect(main.length).toBeGreaterThan(1);
		expect(main.find((row) => row.model === "advisor")).toMatchObject({
			requestCount: 0,
			inputTokens: 10,
			outputTokens: 5,
			cacheReadInputTokens: 2,
			cacheCreationInputTokens: 1,
		});
		expect(report).toHaveLength(3);
		db.getAdapter().setOffThreadReader(reader);
		const before = reader.readsServed;
		expect(
			JSON.stringify(
				await db.aggregateTokensByModel("a1", NOW - 35 * DAY, NOW),
			),
		).toBe(JSON.stringify(main));
		expect(JSON.stringify(await external.report())).toBe(
			JSON.stringify(report),
		);
		expect(reader.readsServed - before).toBe(3);
	});
	it("preserves the alerts exhaustion projection after a synchronously committed snapshot", async () => {
		const adapter = db.getAdapter();
		const resetsAt = NOW + 60 * 60_000;
		for (let i = 0; i < 7; i++)
			await adapter.run(
				"INSERT INTO usage_snapshots (account_id,timestamp,window_key,utilization,resets_at) VALUES ('a1',?,'five_hour',?,?)",
				[NOW - (60 - i * 10) * 60_000, 50 + i * 5, resetsAt],
			);
		const store = new Map<string, unknown>();
		const config = Object.assign(new EventEmitter(), {
			getAlertDailySpendUsd: () => 0,
			getAlertTokensPerHour: () => 0,
			getAlertRequestTokens: () => 0,
			getAlertUsageWindowThresholdPercent: () => 90,
			getAlertAnomalyEnabled: () => false,
			getAlertAnomalyIntervalMinutes: () => 15,
			getAlertAnomalyBaselineWindowMinutes: () => 60,
			getAlertAnomalyLoopMinRequests: () => 25,
			getAlertCooldownMinutes: () => 60,
			getAlertWebhookUrl: () => "",
			get: (key: string, fallback?: unknown) =>
				store.has(key) ? store.get(key) : fallback,
			set: (key: string, value: unknown) => {
				store.set(key, value);
			},
		}) as unknown as Config;
		const windows = normalizeProviderUsageWindows(
			{
				five_hour: {
					utilization: 80,
					resets_at: new Date(resetsAt).toISOString(),
				},
			},
			"anthropic",
		);
		async function evaluate() {
			const service = new AlertService(adapter, config);
			try {
				const write = db.recordUsageSnapshot("a1", windows, NOW);
				await service.evaluateUsageSnapshot("a1", "Account 1", windows, NOW);
				await write;
				return await service.listAlerts();
			} finally {
				service.stop();
			}
		}
		const main = await evaluate();
		expect(
			main.filter(
				(alert) => alert.type === "usage_window_exhaustion_projected",
			),
		).toHaveLength(1);
		await adapter.run("DELETE FROM alerts");
		adapter.setOffThreadReader(reader);
		const before = reader.readsServed;
		expect(JSON.stringify(await evaluate())).toBe(JSON.stringify(main));
		expect(reader.readsServed - before).toBe(1);
	});
	it("wires file-backed databases by default and honors every opt-out spelling", async () => {
		const wired = new DatabaseOperations(join(dir, "test.db"));
		others.push(wired);
		const mainQuery = spyOn(wired.getAdapter(), "query");
		expect(await wired.getAdapter().queryOffThread("SELECT 7 AS n")).toEqual([
			{ n: 7 },
		]);
		expect(mainQuery).not.toHaveBeenCalled();
		const saved = process.env.BETTER_CCFLARE_DB_READER_WORKER;
		try {
			for (const value of ["0", "false", "off"]) {
				process.env.BETTER_CCFLARE_DB_READER_WORKER = value;
				const disabled = new DatabaseOperations(join(dir, "test.db"));
				others.push(disabled);
				const query = spyOn(disabled.getAdapter(), "query");
				expect(
					await disabled.getAdapter().queryOffThread("SELECT 8 AS n"),
				).toEqual([{ n: 8 }]);
				expect(query).toHaveBeenCalledTimes(1);
			}
		} finally {
			if (saved === undefined)
				delete process.env.BETTER_CCFLARE_DB_READER_WORKER;
			else process.env.BETTER_CCFLARE_DB_READER_WORKER = saved;
		}
	});
});
