---
title: Member Notices via BroBot - Plan
type: feat
date: 2026-11-03
topic: member-notices-via-brobot
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan
amends: docs/plans/2026-11-02-1712-feat-banked-resets-plan.md
execution: code
---

# Member Notices via BroBot - Plan

## Goal Capsule

- **Objective:** House of Vibe members see banked-reset news that the router detects as BroBot cards in 📡│ai-alerts. Each card passes the founder review that every other alert passes. The router stops being a second, parallel Discord publisher.
- **Means:** The router keeps detection, its `member_notices` claim ledger, retries and the scheduler from PR #708. Instead of a Discord message body, it sends a signed event with no account data to a new BroBot intake route. BroBot stores the event in an inbox table, lists it through a new `hov-router` source, and reviews, renders and posts it like any reset card.
- **Product authority:**
  - The operator's 2026-11-03 direction: the router detects, BroBot publishes.
  - Decisions D1-D4 below, once answered.
  - The banked-resets plan's Product Contract still governs what is detected (R16, R18-R22) and that notices carry no account data.
  - This plan replaces only how notices reach members: that plan's KTD13 and KTD14, the Discord body in KTD15, and the Discord body in U13.
- **Stop conditions:** Each of these is the operator's go, so stop before it:
  - creating or rotating a secret;
  - setting a Vercel or router environment value;
  - editing `better-ccflare.json`;
  - restarting the router;
  - sending a request that writes an inbox row.

  Also stop if BroBot's verifier rejects the router's signature on the shared golden vector.
- **Execution profile:** Two PRs, one in pushbot (StartupBros-com/pushbot) and one in the router. The pushbot PR deploys first, while the inbox is still empty. The router PR can merge in either order, because member notices stay off until the router is configured. Tests come first in both.
- **Finishing:** Each implementing session merges its own PR after CI passes. Deploying and configuring follow Rollout and need the operator.
- **Open blockers:** D1-D4. Each has a recommendation, which the implementer uses unless the operator answers otherwise.

## Why the delivery changes

PR #708 (55cbd09e) sends notices straight to a Discord webhook. Read-only Discord GETs on 2026-11-04 around 01:00Z showed that 📡│ai-alerts has no webhooks. BroBot posts there with its bot token, after the founder approves each card in ai-alerts-review.

BroBot's X source already searches OpenAI and Anthropic staff posts for "reset" and "banked" (`x-resets.ts:26-56`). So a webhook into the channel would skip review, and it could post a second card for a reset BroBot already announced.

What changes is the last hop only. Detection, the claim ledger, retries and the scheduler stay. No notice has ever been sent: production sets neither `MEMBER_NOTICE_WEBHOOK_URL` nor `member_notice_webhook_url`.

## Operator decisions

- **D1. Which notices become cards.** Recommend all three.
  - Grants and early resets share BroBot's daily reset key, `reset:<vendor>:<Pacific day>` (`x-resets.ts:182`). A vendor still gets at most one reset card a day, so a router event adds a card only on a day X had none: the unannounced case X cannot see.
  - Reminders get their own key, because X has nothing that matches them.
  - Alternative: drop early resets and forward only grants and reminders. The cost is that unannounced early resets go unreported.
- **D2. The card's link.** BroBot's card always requires a link (`CardParts.link`, `card.ts:62-69`), and members cannot open the router dashboard. Recommend that the operator name one URL per provider. The candidates are the vendor's own usage page, or a House of Vibe guide on redeeming banked resets, if one exists.
- **D3. Whether reminders ping.** BroBot pings the 🔔 AI outages & resets role on every card that is not a model card (`card.ts:219`, `discord-server-operations.md:149`).
  - Recommend no ping for reminders. A reminder repeats a grant members already heard about, and two more pings per wave weaken what the role promises. This needs a reminder exception in the ping rule.
  - Alternative: reminders ping like any reset card, which needs no card change.
- **D4. The one-minute resets cron.** Recommend leaving `hov-router` out of `/api/cron/ai-alerts-resets`, whose `resets` scope reads only the X source (`sweep-input.ts:81-100`).
  - The router claims a grant only after 30 quiet minutes, and reminders come days ahead, so the extra 9 minutes the 10-minute sweep can add do not matter.
  - Adding the source would add one database read every minute.

## Event contract

The router sends one POST per claimed notice to the BroBot intake URL. It builds the body when it claims the notice and stores it in `member_notices.content`, so every retry sends the same bytes.

| Field | Type | Meaning |
|---|---|---|
| `version` | `1` | Contract version. |
| `noticeKey` | string | The router's claim key: `grant:<waveId>`, `remind:<waveId>:<3d\|1d>` or `early:<codex\|claude>:after:<minute\|none>`. |
| `kind` | `grant` \| `reminder` \| `early_reset` | Notice kind. |
| `provider` | `codex` \| `claude` | Grants and reminders are always `codex`: waves come from Codex reset credits only (`member-notices.ts:176-200`). |
| `detectedAt` | ISO 8601 | Claim time. |
| `waveExpiresAt` | ISO 8601 or null | When the wave's credits expire. Set for reminders; may be null for grants; always null for early resets. Today this exists only inside the rendered text, so the body must carry it. `member_notices.expires_at` is the delivery deadline, not this. |
| `lead` | `3d` \| `1d` or null | Reminders only. |

The body carries no account name, id, email, per-account count or fleet total. The router's no-account-data test (AE11) extends to it.

**Signing.** The router uses BroBot's v1 scheme (`packages/shared/src/request-signature.ts`):

- `X-Request-Signature: v1=<hex HMAC-SHA256(secret, method \n pathname \n timestamp \n requestId \n sha256hex(body))>`
- `X-Request-Timestamp`, in milliseconds
- `X-Request-Id`, a UUID
- `X-Key-Version: 1`

The router signs at send time, so each retry carries a fresh timestamp and request id. It never sends the secret itself; it does not copy the bot's legacy `X-Internal-Secret` header (`packages/discord-bot/src/lib/api-client.ts:406`). BroBot compares signatures in constant time (`request-signature.ts:40-51`). It rejects any timestamp more than 5 minutes old, and any from the future (`:146-147`).

**Responses.**

| Status | Meaning |
|---|---|
| 200 | Stored, or a duplicate of a stored notice. |
| 400 | Body fails the schema. |
| 401 | Signature fails. |
| 503 | BroBot has no intake secret set. |

The router's existing classification applies unchanged (`member-notices.ts:340-357`): 2xx counts as delivered, 429 and 5xx retry, and any other status gives up and raises `member_notice_delivery_failed`. The BroBot inbox deduplicates by `noticeKey`, not by request id.

## Key Technical Decisions

- **B1. An inbox table that a source reads back.** BroBot posts an alert only while a source lists its key in the current run (`sweep.ts:283-285`). It also closes an approved card unposted once the card's source stops listing it (`sweep.ts:143`). A row written straight into `ai_alert_events` would therefore never post. The `hov-router` source lists every open inbox row on each sweep, which keeps a reviewed card postable until it posts or BroBot's 24-hour pending expiry ends it (`sweep.ts:21`).
- **B2. Listing window.** A row is listed from `detected_at` until `detected_at + 24h` or, if sooner, the wave's expiry.
- **B3. Keys.**
  - Grants and early resets map to `reset:<vendor>:<Pacific day of detectedAt>`, with vendor `openai` for `codex` and `anthropic` for `claude`, the vendor names in `x-resets.ts:26-33`.
  - Reminders map to `reset:<vendor>:remind:<waveId>:<lead>`.
  - Every key keeps kind `reset`, so the kind and key-prefix check (`20261030235844_ai_alert_reset_kind.sql:30-36`) needs no change, and no destructive migration is needed.
  - `hov-router` goes after `x-resets` in `SOURCE_NAMES`. When both sources list one daily key, the run keeps the X post as that key's candidate, because the first source to list a key wins (`sweep-intake.ts:72`).
- **B4. No pre-seeded sentinel.** On a source's first run, BroBot seeds everything the source lists as never-posted. It writes the `source:<name>` sentinel on that run even when the source lists nothing (`sweep-intake.ts:95-120`). Deploying BroBot with an empty inbox and letting one sweep run before the router is configured is enough, so no seed migration is needed.
- **B5. Dedicated signing secret.** BroBot uses `AI_ALERTS_ROUTER_SIGNING_SECRET`, following the `BROBOT_ALERTS_SIGNING_SECRET` precedent (`brobot-internal-auth.ts:19-31`). It does not use `INTERNAL_SERVICE_SECRET`, which about 15 consumers share.
- **B6. Router config keeps the names from #708.**
  - `MEMBER_NOTICE_WEBHOOK_URL` and `member_notice_webhook_url` now hold the intake URL.
  - A new `MEMBER_NOTICE_SIGNING_SECRET`, or `member_notice_signing_secret` in the config file, follows the same rule: the env value wins over the file value. `getAllSettings` removes it.
  - The destination is `on` only with an https URL and a secret. The states become `off`, `missing_secret` and `on`.
- **B7. Discord code leaves the member path.** Three things go:
  - the Discord body branch (`member-notices.ts:322-324`);
  - the check that blocks a member address equal to the alert webhook (KTD14; `webhookIdentity` and `blocked_same_as_alert_webhook`, `alerts.ts:916-961`, with its startup warning);
  - the three text renderers (`member-notices.ts:108-145`).

  The router no longer writes text that members read. A signed JSON body sent to a Discord webhook would get a 4xx, which gives up and raises the operational alert.

  This narrows the `memberNotices.state` values in `GET /api/alerts/config` (`packages/types/src/alerts.ts:192`). No dashboard code reads them, but the PR body must say so. `isDiscordWebhookUrl` stays, because the operator-alert path uses it (`alerts.ts:1247`, `:1291`).
- **B8. BroBot writes the member text.** The card branch starts from the router's current wording (`member-notices.ts:108-145`). Each provider gets its own command: "/usage in the Codex CLI" for Codex, "/usage in Claude Code" for Claude (`USAGE_COMMAND`, `:69-72`). Wave expiry is shown as a date.

## Implementation Units

### Pushbot PR (StartupBros-com/pushbot, `apps/startupbros`)

**P1. Inbox table**
- **Files:** `supabase/migrations/<ts>_ai_alert_router_events.sql` (created with `supabase migration new`, run from the app directory), `supabase/tests/database/ai_alert_router_events.test.sql`, and regenerated database types.
- **Columns:**
  - `notice_key text primary key`
  - `kind text`, checked against `grant`, `reminder`, `early_reset`
  - `provider text`, checked against `codex`, `claude`
  - `detected_at timestamptz not null`
  - `wave_expires_at timestamptz`
  - `lead text`, checked against `3d`, `1d`
  - `received_at timestamptz not null default now()`
  - `body jsonb not null`

  A table check requires that a reminder has both a lead and a wave expiry. This is a new table only, so it takes no lock on an existing one.
- **Access:** follow `ai_alert_events` (`20261030000213_ai_alert_events.sql:65-70`): enable row-level security, revoke from anon, authenticated and service_role, grant select and insert to service_role, and add a deny-all policy for everyone else.
- **Tests (pgTAP):** the checks hold; anon and authenticated can neither read nor write; service_role can insert and select.

**P2. Intake route**
- **Files:**
  - `app/api/internal/ai-alerts/router-events/route.ts`, new, with its test
  - `lib/server/live-events/brobot-internal-auth.ts`, which gains `requireAiAlertsRouterSigningSecret()`
  - an entry in `.env.example`
- **Approach:**
  - Read the raw body once and verify it with `authenticateBrobotInternalRequest(request, bodyText, secret)`.
  - Validate it with a strict zod schema.
  - Insert it, ignoring a duplicate `notice_key`, and answer per the contract.
  - The route header comment carries Consumer, Spend, Gate, Defect and Delete-when.
  - Logs name the notice key, never the body or headers.
- **Tests:**
  - A request signed the way the golden v1 vector is (`packages/shared/src/__fixtures__/request-signature-v1.json`), with this route's pathname, passes.
  - A wrong secret, a missing header, a 6-minute-old timestamp and a future timestamp each get 401 and store nothing.
  - An unknown kind, a reminder without a lead, or an extra field gets 400.
  - The same key sent twice stores one row and gets 200 both times.
  - An unset secret gets 503.
  - Tests use no real Supabase client (`apps/startupbros/AGENTS.md:454`).

**P3. `hov-router` source**
- **Files:** `lib/server/ai-alerts/sources.ts`, `lib/server/ai-alerts/sweep-input.ts`, and a new `lib/server/ai-alerts/router-events.ts` with its test; `sources.test.ts`.
- **Approach:**
  - Add `hov-router` to `SOURCE_NAMES`, after `x-resets`.
  - Readers get no database handle today (`SourceReaderDeps`, `sources.ts:458-467`), so add a `routerEvents.listOpen(now)` dependency, built in `sweep-input.ts` from the run's database client.
  - The reader maps each open row to a `RouterResetCandidate` (kind `reset`, source `hov-router`) with a key from B3.
- **Tests:**
  - The B2 window opens and closes at its exact edges.
  - Both vendors map to the right key, including across the Pacific midnight boundary.
  - A router grant and an X post on one vendor's day yield one key, and the X post is the kept candidate.
  - Confirm, in the sweep harness, which candidate renders when the router's row was inserted first.
  - A database error surfaces as a `hov-router` source error.

**P4. Card**
- **Files:** `lib/server/ai-alerts/card.ts`, `card.test.ts`.
- **Approach:** a `renderParts` branch for `hov-router` candidates:
  - a 🔄 headline per kind and provider;
  - the subtitle `HoV Router · Codex` or `HoV Router · Claude`;
  - the body per B8;
  - the link per D2, and the ping per D3.
- **Tests:** a golden card for each kind and provider pair the router can send; no card text includes a value outside the contract.

**P5. Docs**
- **Files:** `docs/operations/discord-server-operations.md`.
- **Approach:** in the AI alerts section, add the router as a reset source, reminder cards, the intake route and its secret, and the D3 ping rule.

### Router PR (this repository)

**R1. Signed event delivery**
- **Files:**
  - `packages/http-api/src/services/member-notices.ts`
  - `packages/http-api/src/services/alerts.ts`
  - `packages/config/src/index.ts`
  - `packages/types/src/alerts.ts`
  - `apps/server/src/server.ts`
  - `docs/configuration.md`
  - test files that pin the Discord shape today: `member-notices.test.ts`, `member-notices-delivery.test.ts`, `handlers/__tests__/alerts-cache-health-config.test.ts`, `config/src/alerts-config.test.ts`
- **Approach:**
  - Detection builds the contract body instead of text and stores it in `content`.
  - `sendMemberNotice` sends that body with signing headers it computes at send time, using `node:crypto` HMAC, to https URLs only.
  - A config getter returns the secret.
  - Destination states follow B6, and the removals follow B7.
  - The `member_notice_delivery_failed` action text (`alerts.ts:1126`) names both settings.
  - `docs/configuration.md:974-996` is rewritten for the BroBot intake.
  - No schema change: `content` stays text.
- **Tests:**
  - The router's signer reproduces BroBot's golden vector byte for byte. The fixture's values are copied into the test with their source cited:
    - secret `secret`
    - POST `/api/webhooks/discord-brobot`
    - timestamp `1788400000000`
    - request id `golden-req-0001`
    - body `{"ok":true,"n":1}`
    - expected signature `v1=f7a5ff9ad239542531621bd0b6032081ab46a0b46c932cc189e41f27a390b274`
  - The body holds exactly the contract's fields.
  - Two attempts at one notice send identical bodies with different request ids and timestamps.
  - No header carries the secret.
  - An http URL or a missing secret gives a state other than `on`, and no notice is claimed: today's gate already returns before detection (`member-notices.ts:390-439`).
  - `getAllSettings()`, the serialized alerts config and every captured log line contain neither the URL nor the secret.
  - The existing retry, lease and fencing tests pass with the new body.
- **Verification:** run the changed suites one file at a time, then `bun run lint && bun run typecheck && bun run format`.

## Rollout

1. The operator answers D1-D4 or accepts the recommendations.
2. The pushbot PR merges, and Vercel deploys it.
3. The operator generates the signing secret and sets `AI_ALERTS_ROUTER_SIGNING_SECRET` in Vercel production.
4. One 10-minute sweep runs. Check with a read-only `supabase-api sql` query that `ai_alert_events` holds `source:hov-router` in state `seeded`.
5. An unsigned POST to the intake route gets 401, and the inbox stays empty. This confirms the route is live without writing anything.
6. The router PR merges. The operator approves its deploy through `scripts/deploy-ccflare.sh`.
7. The operator gives the router the intake URL and secret, in the config file or an env drop-in, and approves a full restart. The config file is read once at startup (`packages/config/src/index.ts:1531`). Check that `GET /api/alerts/config` shows `memberNotices.state: on`, and that `timedatectl` reports the clock as synchronized.
8. The first real notice reaches ai-alerts-review. The founder's ✅ posts it. This is the first end-to-end proof.

## Verification Contract

- **Pushbot:** `pnpm --filter startupbros test`, typecheck, lint, `supabase db test`, and green CI (`gh pr checks --watch`).
- **Router:** as in R1.
- **Across the two repositories:** both PRs pin the same golden vector, which is the contract test the sides share. A signed request accepted by production BroBot is not proven before Rollout step 8.

## Risks

| Risk | Handling |
|---|---|
| The router's clock runs ahead of Vercel's, so every request gets 401, gives up and raises the operational alert. | Measured 2026-11-03 21:02 EST: 0 s offset against the `Date` headers of vercel.com and google.com, at 1-second resolution, with NTP synchronized. WSL2 clocks can drift after the host sleeps, so Rollout step 7 checks it again. The operational alert names the failure. |
| The shared daily key (D1) can lose a card: a morning X post about a limit reset would absorb that afternoon's router grant. | Accepted, to keep one reset card per vendor per day. |
| Reminders depend on review. A card nobody answers expires after 24 hours (`sweep.ts:21`). | Inherent while review is on. `AI_ALERTS_SKIP_REVIEW=1` removes the gate for every source. |
| BroBot posts at most 3 cards per run, in the order incident, reset, model. | A burst of router events can delay a model card by one sweep. |

## Not built

- No route on the router side. BroBot never calls the router.
- No dashboard change. The router dashboard does not read member-notice state.
- No change to BroBot's review flow, its X source or any other source.
- No new kind in `ai_alert_events`.

## Sources

- Grounding, read-only and collected 2026-11-03:
  - router origin/main 337c80cd: `member-notices.ts`, `alerts.ts:896-961`, `packages/config/src/index.ts:1531` and `:2683-2768`, `docs/configuration.md:974-996`;
  - pushbot origin/main 57749efbe: `apps/startupbros/lib/server/ai-alerts/*`, `lib/server/live-events/brobot-internal-auth.ts`, `supabase/migrations/20261030000213_ai_alert_events.sql`, `20261030235844_ai_alert_reset_kind.sql`, `docs/operations/discord-server-operations.md:196-262`, `vercel.json:274-275`;
  - pushbot's local `packages/shared/src/request-signature.ts` and its `__fixtures__/request-signature-v1.json`.
- Discord channel layout: read-only `discord-cli api GET` calls on the House of Vibe guild. The router's alert webhook posts to #agent-ops, which only the team can see. ai-alerts and ai-alerts-review have no webhooks.
- Amended plan: `docs/plans/2026-11-02-1712-feat-banked-resets-plan.md` (KTD13, KTD14, KTD15's Discord body, U13).
