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
import { usageCache } from "@better-ccflare/providers";
import type { AccountResponse } from "@better-ccflare/types";
import { OffThreadReader } from "../../../../database/src/off-thread-reader";
import { CacheHealthRepository } from "../../../../database/src/repositories/cache-health.repository";
import { ExternalUsageRepository } from "../../../../database/src/repositories/external-usage.repository";
import { AlertService } from "../../services/alerts";
import type { APIContext } from "../../types";
import { createAccountsListHandler } from "../accounts";
import { createAnalyticsHandler } from "../analytics";
import { createStatsHandler } from "../stats";

const DAY = 86400000;
const NOW = 1_800_000_000_000;
let dir: string;
let db: DatabaseOperations;
let reader: OffThreadReader;
const others: DatabaseOperations[] = [];

function alertConfig(): Config {
	const store = new Map<string, unknown>();
	return Object.assign(new EventEmitter(), {
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
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "ccflare-off-thread-equivalence-"));
	db = new DatabaseOperations(join(dir, "test.db"), { synchronous: "OFF" });
	db.getAdapter().setOffThreadReader(undefined);
	db.getAdapter().setOffThreadReader(undefined, "interactive");
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
	it("runs the external usage attribution reads on the reader and sees rows the same pass wrote", async () => {
		const adapter = db.getAdapter();
		for (const [account, reset] of [
			["a1", 100],
			["a2", 200],
		] as const)
			await adapter.run(
				"INSERT INTO usage_windows (id,account_id,window_key,started_at,resets_at,grant_type) VALUES (?,?,'seven_day',0,?,'natural')",
				[`${account}-window`, account, reset * 1000],
			);
		const event = (timestamp: string, rateLimitResetsAt: number | null) => ({
			sourceKind: "rollout" as const,
			eventTs: 1000,
			timestamp,
			model: "gpt-6-astra",
			inputTokens: 100,
			cacheReadInputTokens: 20,
			outputTokens: 30,
			reasoningOutputTokens: 10,
			totalTokens: 150,
			isFallbackModel: false,
			rateLimitResetsAt,
			planType: "pro",
			limitId: "codex",
			creditsHasCredits: true,
			creditsBalance: "1",
			primaryUsedPercent: 100,
			sessionId: "rollout-session",
		});
		const external = new ExternalUsageRepository(adapter);
		adapter.setOffThreadReader(reader);
		const mainQuery = spyOn(adapter, "query");
		await external.ingest([event("a-direct", 100), event("vote-1", null)]);
		const before = reader.readsServed;
		// The pending read must see the NULL row this pass inserts, and the evidence
		// read the two a2 rows, or the session vote cannot move to a2.
		await external.ingest([
			event("b-direct-1", 200),
			event("b-direct-2", 200),
			event("vote-2", null),
		]);
		expect(reader.readsServed - before).toBe(2);
		expect(
			mainQuery.mock.calls.filter(([sql]) =>
				/SELECT id,session_id|SELECT session_id,rate_limit_resets_at/.test(
					String(sql),
				),
			),
		).toEqual([]);
		expect(
			await adapter.query(
				"SELECT timestamp,account_id,attribution_basis FROM external_usage_events WHERE source_kind='rollout' ORDER BY timestamp",
			),
		).toEqual([
			{ timestamp: "a-direct", account_id: "a1", attribution_basis: "exact" },
			{ timestamp: "b-direct-1", account_id: "a2", attribution_basis: "exact" },
			{ timestamp: "b-direct-2", account_id: "a2", attribution_basis: "exact" },
			{ timestamp: "vote-1", account_id: "a2", attribution_basis: "vote" },
			{ timestamp: "vote-2", account_id: "a2", attribution_basis: "vote" },
		]);
	});
	it("recovers Codex usage from stored payload headers on the reader", async () => {
		const adapter = db.getAdapter();
		const resetAt = Math.floor(NOW / 1000) + 3600;
		const payload = (headers: Record<string, string>) =>
			JSON.stringify({
				response: { status: 200, headers },
				meta: { timestamp: NOW - 60_000 },
			});
		const codexHeaders = (fiveHour: number, sevenDay: number) => ({
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-used-percent": String(fiveHour),
			"x-codex-primary-reset-at": String(resetAt),
			"x-codex-secondary-window-minutes": "10080",
			"x-codex-secondary-used-percent": String(sevenDay),
			"x-codex-secondary-reset-at": String(resetAt + 3 * 86400),
		});
		// a1's newest request carries the headers. a2's newest has none, so the
		// scan must walk to the next row. a3 has no payloads at all.
		for (const [id, json] of [
			["0-1-0", payload(codexHeaders(12, 34))],
			["0-2-0", payload({})],
			["0-2-1", payload(codexHeaders(5, 56))],
		])
			await adapter.run(
				"INSERT INTO request_payloads (id,json,timestamp) VALUES (?,?,?)",
				[id, json, NOW - 60_000],
			);
		const ids = ["a1", "a2", "a3"];
		const handler = createAccountsListHandler(db, {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
		} as unknown as Config);
		const usage = async () => {
			// After a restart the cache is empty, which is what sends the handler to
			// the stored payloads.
			for (const id of ids) usageCache.delete(id);
			const accounts = (await (await handler()).json()) as AccountResponse[];
			return ids.map(
				(id) => accounts.find((account) => account.id === id)?.usageData,
			);
		};
		try {
			const main = await usage();
			expect(main[0]).toMatchObject({
				five_hour: { utilization: 12 },
				seven_day: { utilization: 34 },
			});
			expect(main[1]).toMatchObject({ seven_day: { utilization: 56 } });
			expect(main[2]).toBeNull();
			adapter.setOffThreadReader(reader);
			const mainQuery = spyOn(adapter, "query");
			const readerAll = spyOn(reader, "all");
			const worker = await usage();
			expect(JSON.stringify(worker)).toBe(JSON.stringify(main));
			const payloadRead = ([sql]: unknown[]) =>
				/FROM request_payloads/.test(String(sql));
			expect(mainQuery.mock.calls.filter(payloadRead)).toEqual([]);
			expect(readerAll.mock.calls.filter(payloadRead)).toHaveLength(3);
		} finally {
			for (const id of ids) usageCache.delete(id);
		}
	});
	it("answers the accounts page while the bulk reader is stuck behind a long scan", async () => {
		const adapter = db.getAdapter();
		await adapter.run("UPDATE accounts SET session_start = ? WHERE id = 'a1'", [
			NOW - 3 * DAY,
		]);
		// One stored payload, so the Codex fallback walks the payloads too.
		await adapter.run(
			"INSERT INTO request_payloads (id,json,timestamp) VALUES ('0-1-0','{}',?)",
			[NOW - 60_000],
		);
		const readerAll = spyOn(reader, "all");
		const stuck = {
			all: mock(<R>() => new Promise<R[]>(() => {})),
			get: mock(<R>() => new Promise<R | null>(() => {})),
		};
		// Interactive first: an adapter that ignored lanes would let the stuck
		// reader replace it.
		adapter.setOffThreadReader(reader, "interactive");
		adapter.setOffThreadReader(stuck);
		const ids = ["a1", "a2", "a3"];
		const handler = createAccountsListHandler(db, {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
		} as unknown as Config);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			// An empty cache sends Codex accounts to the stored-usage fallback too.
			for (const id of ids) usageCache.delete(id);
			const before = reader.readsServed;
			const response = await Promise.race([
				handler(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("accounts page waited on the bulk reader")),
						5000,
					);
				}),
			]);
			expect(response.status).toBe(200);
			const accounts = (await response.json()) as AccountResponse[];
			// a1 made one request a day; three fall inside its 3-day session.
			expect(
				accounts.find((account) => account.id === "a1")?.sessionStats,
			).toMatchObject({ requests: 3 });
			expect(stuck.all).not.toHaveBeenCalled();
			expect(stuck.get).not.toHaveBeenCalled();
			expect(reader.readsServed - before).toBeGreaterThanOrEqual(1);
			const walk = ([sql]: unknown[]) =>
				/JOIN requests r ON rp\.id = r\.id/.test(String(sql));
			expect(readerAll.mock.calls.filter(walk)).toHaveLength(3);
		} finally {
			clearTimeout(timer);
			for (const id of ids) usageCache.delete(id);
		}
	});
	it("keeps the accounts list when the stored-usage reads fail", async () => {
		const adapter = db.getAdapter();
		await adapter.run(
			"INSERT INTO usage_snapshots (account_id,timestamp,window_key,utilization,resets_at,active) VALUES ('a1',?,'seven_day',42,?,1)",
			[NOW - 60_000, NOW + DAY],
		);
		// What a read gets after waiting its whole timeout for a busy reader.
		const busy = new Error(
			"off-thread interactive reader busy: read waited 120000ms: SELECT ?",
		);
		const failing = {
			all: mock(async <R>(): Promise<R[]> => {
				throw busy;
			}),
			get: mock(async <R>(): Promise<R | null> => {
				throw busy;
			}),
		};
		adapter.setOffThreadReader(failing, "interactive");
		const ids = ["a1", "a2", "a3"];
		const handler = createAccountsListHandler(db, {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
		} as unknown as Config);
		try {
			for (const id of ids) usageCache.delete(id);
			const response = await handler();
			expect(response.status).toBe(200);
			const accounts = (await response.json()) as AccountResponse[];
			expect(accounts.map((account) => account.id).sort()).toEqual(ids);
			// a1 falls through to its durable weekly snapshot.
			expect(
				accounts.find((account) => account.id === "a1")?.usageData,
			).toMatchObject({ seven_day: { utilization: 42 } });
			expect(failing.get).toHaveBeenCalled();
		} finally {
			for (const id of ids) usageCache.delete(id);
		}
	});
	it("skips the stored-payload walk when no payloads are stored", async () => {
		const adapter = db.getAdapter();
		adapter.setOffThreadReader(reader);
		const ids = ["a1", "a2", "a3"];
		const handler = createAccountsListHandler(db, {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
		} as unknown as Config);
		const mainQuery = spyOn(adapter, "query");
		const readerAll = spyOn(reader, "all");
		try {
			for (const id of ids) usageCache.delete(id);
			const response = await handler();
			expect(response.status).toBe(200);
			const walk = ([sql]: unknown[]) =>
				/JOIN requests r ON rp\.id = r\.id/.test(String(sql));
			expect(readerAll.mock.calls.filter(walk)).toEqual([]);
			expect(mainQuery.mock.calls.filter(walk)).toEqual([]);
		} finally {
			for (const id of ids) usageCache.delete(id);
		}
	});
	it("preserves the alerts exhaustion projection after a synchronously committed snapshot", async () => {
		const adapter = db.getAdapter();
		const resetsAt = NOW + 60 * 60_000;
		for (let i = 0; i < 7; i++)
			await adapter.run(
				"INSERT INTO usage_snapshots (account_id,timestamp,window_key,utilization,resets_at) VALUES ('a1',?,'five_hour',?,?)",
				[NOW - (60 - i * 10) * 60_000, 50 + i * 5, resetsAt],
			);
		const config = alertConfig();
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
		const readerAll = spyOn(reader, "all");
		expect(JSON.stringify(await evaluate())).toBe(JSON.stringify(main));
		// The projection's snapshot read, then the alert history read.
		expect(
			readerAll.mock.calls.map(([sql]) =>
				/FROM usage_snapshots/.test(String(sql))
					? "snapshots"
					: /FROM alerts ORDER BY timestamp DESC/.test(String(sql))
						? "history"
						: String(sql),
			),
		).toEqual(["snapshots", "history"]);
	});
	it("runs the alert history, scanner source and cache-health bucket reads on the reader", async () => {
		const adapter = db.getAdapter();
		// Fixture requests carry no account generation; fence them to the
		// accounts' generation so the bucket aggregate has rows to compare.
		await adapter.run("UPDATE requests SET account_generation = 0");
		for (let i = 0; i < 3; i++)
			await adapter.run(
				"INSERT INTO alerts (id,timestamp,type,severity,title,message,value,threshold,account,acknowledged) VALUES (?,?,'daily_spend','warning',?,?,?,10,'Account 1',?)",
				[
					`alert-${i}`,
					NOW - i * 60_000,
					`Alert ${i}`,
					`message ${i}`,
					i,
					i % 2,
				],
			);
		const external = new ExternalUsageRepository(adapter);
		for (const path of ["/rollouts/a.jsonl", "/rollouts/b.jsonl"])
			await external.saveSource({
				path,
				size: path.length,
				mtimeNs: "1700000000000000000",
				sessionId: `session-${path}`,
				parentId: null,
				sessionTimestamp: "2027-01-15T08:00:00Z",
				lastScannedAt: NOW,
			});
		const cacheHealth = new CacheHealthRepository(adapter);
		const service = new AlertService(adapter, alertConfig());
		const readAll = async () => ({
			alerts: await service.listAlerts(),
			sources: await external.getSources(),
			buckets: await cacheHealth.fetchBuckets(NOW - 6 * 600_000, NOW),
		});
		try {
			const main = await readAll();
			expect(main.alerts.map((alert) => alert.id)).toEqual([
				"alert-0",
				"alert-1",
				"alert-2",
			]);
			expect(main.sources).toHaveLength(2);
			expect(main.buckets.length).toBeGreaterThan(0);
			adapter.setOffThreadReader(reader);
			const mainQuery = spyOn(adapter, "query");
			const readerAll = spyOn(reader, "all");
			expect(JSON.stringify(await readAll())).toBe(JSON.stringify(main));
			for (const moved of [
				/FROM alerts ORDER BY timestamp DESC/,
				/FROM external_usage_sources/,
				/WITH source AS/,
			]) {
				const matches = ([sql]: unknown[]) => moved.test(String(sql));
				expect(mainQuery.mock.calls.filter(matches)).toEqual([]);
				expect(readerAll.mock.calls.filter(matches)).toHaveLength(1);
			}
		} finally {
			service.stop();
		}
	});
	it("wires file-backed databases by default and honors every opt-out spelling", async () => {
		const wired = new DatabaseOperations(join(dir, "test.db"));
		others.push(wired);
		const mainQuery = spyOn(wired.getAdapter(), "query");
		expect(await wired.getAdapter().queryOffThread("SELECT 7 AS n")).toEqual([
			{ n: 7 },
		]);
		expect(
			await wired
				.getAdapter()
				.queryOffThread("SELECT 7 AS n", [], "interactive"),
		).toEqual([{ n: 7 }]);
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
				expect(
					await disabled
						.getAdapter()
						.queryOffThread("SELECT 9 AS n", [], "interactive"),
				).toEqual([{ n: 9 }]);
				expect(query).toHaveBeenCalledTimes(2);
			}
		} finally {
			if (saved === undefined)
				delete process.env.BETTER_CCFLARE_DB_READER_WORKER;
			else process.env.BETTER_CCFLARE_DB_READER_WORKER = saved;
		}
	});
	it("keeps interactive reads off a busy bulk reader in a wired database", async () => {
		const wired = new DatabaseOperations(join(dir, "test.db"));
		others.push(wired);
		const adapter = wired.getAdapter();
		// Warm both workers so spawn time is not part of the race.
		await adapter.queryOffThread("SELECT 1");
		await adapter.queryOffThread("SELECT 1", [], "interactive");
		const order: string[] = [];
		const scan = adapter
			.queryOffThread(
				"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c",
				[3_000_000],
			)
			.then(() => order.push("bulk"));
		const quick = adapter
			.getOffThread("SELECT 1 AS n", [], "interactive")
			.then(() => order.push("interactive"));
		await Promise.all([scan, quick]);
		expect(order).toEqual(["interactive", "bulk"]);
	});
});
