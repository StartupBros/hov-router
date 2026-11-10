# Systemd Deployment Guide

Production deployment of HoV Router as a systemd service on Linux.

## Reference Unit File

```ini
[Unit]
Description=better-ccflare proxy
After=network-online.target
Wants=network-online.target

# --- Restart limits are [Unit] directives ---
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=better-ccflare
Group=better-ccflare

# --- Environment ---
Environment=PORT=8889
Environment=BUN_JSC_forceRAMSize=2147483648

# --- Preflight: strip invalid BUN_JSC_* vars before Bun starts ---
ExecStartPre=/opt/better-ccflare/scripts/preflight-env.sh

# --- Main process ---
# --smol enables aggressive GC (the correct way to reduce memory usage)
ExecStart=/usr/bin/better-ccflare --smol --serve --port 8889

# --- Optional resource-limit hardening example ---
# Uncomment only after measuring this deployment under its expected load, and
# set both memory values above its measured peak (see Resource Limits).
# MemoryMax=<peak plus headroom>
# MemoryHigh=<above the peak>
# CPUQuota=200%

# --- Restart policy ---
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=143

# --- Security hardening ---
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/better-ccflare
PrivateTmp=true

# --- Logging ---
StandardOutput=journal
StandardError=journal
SyslogIdentifier=better-ccflare

[Install]
WantedBy=multi-user.target
```

## Managed Request-Body Policies

The production `ccflare-stack.service` deployment renders its build pin at `/etc/systemd/system/ccflare-stack.service.d/50-pinned-build.conf`. It pins the Node front guard and Bun proxy separately:

```ini
Environment=GUARD_MAX_REQUEST_BODY_BYTES=33554432
Environment=GUARD_MAX_BUFFERED_REQUEST_BODY_BYTES=268435456
Environment=CCFLARE_MAX_BUFFERED_REQUEST_BODY_BYTES=1073741824
Environment=CCFLARE_MAX_BODY_ADMISSION_QUEUE=500
```

`GUARD_MAX_REQUEST_BODY_BYTES` is the 32 MiB request wire limit. `GUARD_MAX_BUFFERED_REQUEST_BODY_BYTES` is the Node guard's 256 MiB **encoded-buffer** reservation budget; it must be no greater than 256 MiB and at least twice the wire limit. At the defaults it admits four worst-case 32 MiB bodies because each reserves 64 MiB. The managed pin intentionally does **not** set `GUARD_MAX_BODY_READERS`: reader cardinality is independent of weighted byte reservations, so an operator override/default remains effective.

A valid guard `Content-Length` reserves twice its declared number of bytes before buffering. Missing, chunked, invalid, or misleading length reserves twice the full 32 MiB limit. Guard reader admission is FIFO, and the independent `GUARD_MAX_BODY_READERS` limit caps active readers.

`CCFLARE_MAX_BUFFERED_REQUEST_BODY_BYTES` is a separate **Bun-process weighted-work** admission budget, valid from 256 MiB through 1 GiB; the managed pin sets it to **1 GiB** (`1073741824`). `CCFLARE_MAX_BODY_ADMISSION_QUEUE` controls its FIFO queue, valid from 0 through 5000. Bun reserves 8× a canonical unencoded/`identity` `Content-Length` (zero reserves zero), up to the 32 MiB request limit. Missing, chunked, malformed, over-limit, compressed, and unknown-encoding metadata — and any handler that must hold the full worst case, such as the OpenAI Responses routes during translation — instead reserve the worst case, `8 × 32 MiB = 256 MiB`, capped at the configured budget rather than the budget's entirety. At the managed 1 GiB pin that combination admits four concurrent worst-case requests before a fifth queues, and roughly 5.3 MiB bodies at 24-way concurrency. This 8× value is conservative admission weighting bounding weighted admitted work, not an exact heap or RSS measurement; downstream readers remain the exact size authority. The Node guard and Bun controller are independent process budgets—there is no bypass header or circular lock.

Bun rejects queue-full body requests locally with `503` and `Retry-After: 1` before proxy/provider work. It removes aborted queued requests, and a restart clears active leases and queue state. Its response lifetime can outlast handler return, so a reservation releases only when the response body closes, errors, or cancels (or shutdown aborts it).

`deploy-ccflare.sh` validates the rendered pin and, after `systemctl daemon-reload`, validates the **effective merged** `Environment` from systemd. A later operator drop-in can override the values, but missing, partial, non-integer, out-of-range, or incompatible effective values restore the prior managed pin and prevent the service restart. Legacy rollback accepts an older pin only when both Bun admission variables are absent.

After a restart, inspect `GET /_guard/health` and `GET /health` on naturally arriving authorized traffic; do not generate synthetic traffic against Anthropic-backed accounts. Guard root and `runtime.limits` must both report `maxRequestBodyBytes` and `maxBufferedRequestBodyBytes`. Root `bodyReaders.reservationLimitBytes`, `reservedBytes`, and `reservedBytesPeak` show the guard aggregate budget, current reservation, and high-water mark. Bun's `runtime.bodyAdmission` reports aggregate configuration, current/peak reservations, active/queued counts, and counters only; it never includes body data, paths, accounts, sessions, or request IDs. The OpenAI Responses endpoint also applies the 32 MiB limit separately to encoded and decoded `gzip`, `deflate`, and `zstd` request bodies.

## Codex Client Identity Drop-In

By default the Codex provider advertises its compiled client version. To have it follow a managed Codex CLI updater, set `CCFLARE_CODEX_VERIFIED_VERSION_FILE` to the updater's verified-version record. Put it in its own operator drop-in that sorts after the deploy-owned pin:

```ini
# /etc/systemd/system/ccflare-stack.service.d/80-codex-verified-version.conf
[Service]
Environment=CCFLARE_CODEX_VERIFIED_VERSION_FILE=/home/<user>/.local/state/codex-update/verified-version.json
```

`deploy-ccflare.sh` replaces only `50-pinned-build.conf`, so this drop-in survives deploys. The service user must be able to read the record.

- **Apply:** run `systemctl daemon-reload` and restart once. Later record updates take effect without a restart.
- **Confirm:** `GET /api/config/provider-model-defaults` reports `codexClientIdentity.source` as `verified`.
- **Revert:** removing the drop-in, reloading and restarting returns the service to the compiled version.

The record format and fallback rules are in [configuration](configuration.md) under `CCFLARE_CODEX_VERIFIED_VERSION_FILE`.

## Memory Management

### The `--smol` flag (recommended)

The `--smol` CLI flag is Bun's **supported** mechanism for reducing memory usage. It enables aggressive garbage collection and is safe for production use:

```ini
ExecStart=/usr/bin/better-ccflare --smol --serve --port 8889
```

This is equivalent to JavaScriptCore's "small heap" mode but exposed through Bun's stable CLI interface.

### `BUN_JSC_*` environment variables (dangerous)

Bun exposes `BUN_JSC_*` environment variables that map to internal JavaScriptCore options. These are **unstable, undocumented, and change between Bun versions**.

The critical problem: Bun validates these variables in C++ runtime **before any JavaScript executes**. If an invalid variable is set, Bun exits with code 1 immediately. No user code can catch or prevent this crash.

**Known-valid variables** (use with caution, may break in future Bun versions):

| Variable | Purpose | Example |
| -------------------------- | --------------------------- | ------------------- |
| `BUN_JSC_forceRAMSize` | Cap JSC heap size in bytes | `2147483648` (2 GB) |
| `BUN_JSC_useJIT` | Disable JIT compilation | `0` |
| `BUN_JSC_forceGCSlowPaths` | Force slow GC paths (debug) | `1` |

**Invalid variables that will crash Bun:**

| Variable | Why it fails |
| ---------------------- | -------------------------------------- |
| `BUN_JSC_smallHeap` | Not a real JSC option despite the name |
| `BUN_JSC_aggressiveGC` | Not a real JSC option |
| Any typo or guess | JSC option validation is strict |

### Rule of thumb

Use `--smol` for memory tuning. Use `BUN_JSC_forceRAMSize` only if you need a specific heap cap. Avoid all other `BUN_JSC_*` variables unless you have verified them against Bun's source code for your exact version.

## Preflight Environment Validator

The `scripts/preflight-env.sh` script strips invalid `BUN_JSC_*` environment variables before Bun starts. It uses an allowlist of known-valid variables and unsets anything else with a warning to stderr.

### Wiring as ExecStartPre

```ini
ExecStartPre=/opt/better-ccflare/scripts/preflight-env.sh
ExecStart=/usr/bin/better-ccflare --smol --serve --port 8889
```

systemd runs `ExecStartPre` before the main process. If a stale or invalid `BUN_JSC_*` variable exists in the environment (from a previous configuration, an inherited environment, or a mistake in the unit file), the preflight script catches it.

### Sourcing interactively

When running HoV Router outside systemd, source the script before starting:

```sh
. /opt/better-ccflare/scripts/preflight-env.sh
exec bun run better-ccflare --smol --serve
```

## Resource Limits

### Memory

Limits and protection do different jobs. A limit (`MemoryMax`, `MemoryHigh`) bounds the router. Protection (`MemoryLow`) keeps the kernel from reclaiming the router's memory while something else on the host fills RAM. The live managed `ccflare-stack.service` deployment sets no limit; since 2026-11-09 it sets protection, as described below.

#### Limits

Measure before you set one. systemd logs a unit's peak when it stops (`journalctl -u better-ccflare | grep 'memory peak'`), and `memory.peak` in the unit's cgroup holds the peak since it started. Both include page cache. The managed deployment's unit peaked between 2.2 and 4.7 GB a run from 2026-11-04 to 2026-11-09, so no fixed number fits every deployment:

```ini
MemoryMax=<peak plus headroom>   # hard limit: the OOM killer ends the process above it
MemoryHigh=<above the peak>      # the kernel reclaims and throttles the process above it
```

A `MemoryHigh` below the peak throttles the router at its busiest, so keep both values above the peak. Combined with `--smol`, this can keep a measured deployment within predictable bounds.

#### Protection on a shared host

The router's own limits do nothing for it when another workload on the host fills memory. The kernel then reclaims the router's pages, and its event loop stalls on the page faults that bring them back. On the managed host, about half of the router's event-loop stalls of 5 seconds or more over eight days in November 2026 were faults of this kind. `MemoryLow` makes the kernel reclaim unprotected memory first. Set it on the service **and** on its slice:

```sh
sudo systemctl set-property system.slice MemoryLow=4G
sudo systemctl set-property better-ccflare.service MemoryLow=3G
```

Both are needed because the kernel caps a cgroup's protection at what its ancestors allow ([cgroup v2, `memory.low`](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files)), and `system.slice` has none by default. On its own, the service's `MemoryLow` protects nothing. Set the service's value to about its working set under normal load. Set the slice's value to at least the sum of the `MemoryLow` values of the services in it. Unless cgroup2 is mounted with `memory_recursiveprot` (check `/proc/mounts`), a service in the slice without its own `MemoryLow` gets none of the slice's protection.

`set-property` applies at once, with no restart, and writes a drop-in under `/etc/systemd/system.control/` that persists across reboots. To confirm it took, read `memory.low` in `/sys/fs/cgroup/system.slice/` and in the service's directory under it. The `low` line in the service's `memory.events` counts reclaims that reached protected memory anyway. A rising count means the protection was overrun, and the value is too small or the host has run out of unprotected memory.

The trade-off is deliberate. Under pressure, the other workloads are swapped or OOM-killed sooner. Protection does not bound them, and it cannot help when the whole host stalls on swap I/O. On a host shared with coding agents, builds or batch jobs, bound those too and run an OOM daemon such as earlyoom or systemd-oomd.

### CPU

```ini
CPUQuota=200%     # Allow up to 2 CPU cores
```

Adjust based on your expected request volume. For most single-proxy deployments, 100-200% is sufficient.

## Restart Policy Best Practices

```ini
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=143
StartLimitIntervalSec=300
StartLimitBurst=5
```

This means:

- systemd restarts the process on failures, including crashes and bounded
  circuit-open exits, but does not restart an intentional SIGTERM exit (143)
- It waits 5 seconds between restart attempts
- If the process fails 5 times within 300 seconds, systemd stops trying and marks the unit as failed
- After a `StartLimitBurst` failure, manual intervention is required: `systemctl reset-failed better-ccflare && systemctl start better-ccflare`

The managed stack runner exits with status 75 when its internal restart circuit
opens. That keeps systemd from reporting an active service while the proxy and
guard children are stopped; `Restart=on-failure` and the `StartLimit*` bounds
own the outer recovery budget.

For unexpected child failures, `scripts/run-ccflare-stack.sh` uses a separate
aggregate cleanup budget: `RUNNER_FAILURE_STOP_BUDGET_MS` defaults to 30 seconds
and is bounded to 1--120 seconds. It limits how long a stubborn child can delay
the next restart or circuit decision. This budget applies only to failure
cleanup; an intentional TERM/INT keeps the full `GUARD_SHUTDOWN_GRACE_MS` plus
its cushion (605 seconds with the defaults) so in-flight requests can drain.
The runner logs both budgets at startup and when the guard starts. Operators
may override the failure budget in the service environment, but should keep it
below the systemd `StartLimitIntervalSec` window.

The managed source pin explicitly enables runner-owned Bun RSS containment with
the complete tuple `4294967296` bytes, `60000` ms polling, `1800000` ms minimum
uptime, 5 consecutive high samples, `3600000` ms cooldown, and at most 8
recycles per `86400000` ms window. The recycle budget is sized from the
observed growth rate: at roughly 1 GiB/hour a fresh process reaches the
4 GiB threshold in about four hours, so a 24-hour window needs about six
recycles. **Treat that rate as a superseded upper bound, not a current
property.** It was measured on pin `v3.5.70-0471bb24`, which predates the
`Request.clone().json()` native-buffer fix described in
[troubleshooting.md](troubleshooting.md); that fix accounts for roughly half
the measured rate and is already deployed, so the real current rate is lower
and the cap has more headroom than this paragraph implies. Re-measure on the
running build before retuning the cap down — the practice and the ancestry
check are written up in
[docs/solutions/workflow-issues/verify-fix-ancestry-before-citing-a-measured-rate.md](solutions/workflow-issues/verify-fix-ancestry-before-citing-a-measured-rate.md).
The cap itself is independently justified by production evidence that the
previous cap of 3 was exhausted 38 times across two days, so it does not rest
on the rate figure. The cap stays finite rather than unlimited so a runaway leak
still surfaces as `RSS recycle suppressed; cap exhausted` instead of being
masked by endless restarts. Source defaults remain disabled
(`RUNNER_RSS_THRESHOLD_BYTES=0`). The watchdog reads only the exact supervised
upstream PID and verifies its `/proc/<pid>/stat` start time both before and
after every memory sample; it never scans by process name. The sample is
`VmRSS + VmSwap`, not `VmRSS` alone: under host memory pressure the kernel
evicts a leaking process's pages to swap, which lowers `VmRSS` and would
otherwise blind the watchdog exactly when containment is needed. Hosts without
swap report no `VmSwap` and keep the previous resident-only behavior. A
trigger drains the guard first, then stops Bun, and does not consume the
ordinary child-failure circuit.
All seven values are an all-or-none policy: partial or non-production managed
deployment values fail validation. The rollback compatibility path accepts an
older pin only when the entire tuple is absent.

Without the preflight script, an invalid `BUN_JSC_*` variable would burn through all 5 restart attempts in ~25 seconds, causing total proxy downtime until an operator notices.

## Common Pitfalls

### BUN_JSC_smallHeap crash loop

**Symptom:** Service fails immediately on start, burns through `StartLimitBurst`, then stays in failed state.

**Cause:** `BUN_JSC_smallHeap=1` (or similar invalid variable) set in the unit file or inherited environment. Bun validates this in C++ before JavaScript runs, exits code 1.

**Fix:** Remove the invalid variable from the unit file. Use `--smol` flag on `ExecStart` instead. Add the preflight script as `ExecStartPre` to prevent recurrence.

```sh
# Check journal for the crash
journalctl -u better-ccflare --no-pager -n 20

# Reset the failed state
systemctl reset-failed better-ccflare

# Fix the unit file, then reload and start
systemctl daemon-reload
systemctl start better-ccflare
```

### Forgetting daemon-reload

After editing a unit file, you must run `systemctl daemon-reload` before restarting the service. Otherwise systemd uses the cached version.

### Running as root

The reference unit file uses a dedicated `better-ccflare` user. Create it:

```sh
useradd --system --no-create-home --shell /usr/sbin/nologin better-ccflare
mkdir -p /var/lib/better-ccflare
chown better-ccflare:better-ccflare /var/lib/better-ccflare
```

### Database path permissions

If using the default SQLite database, ensure the service user has write access:

```sh
mkdir -p /var/lib/better-ccflare
chown better-ccflare:better-ccflare /var/lib/better-ccflare
```

Set the database path in the unit file:

```ini
Environment=BETTER_CCFLARE_DB_PATH=/var/lib/better-ccflare/better-ccflare.db
```

## Anthropic Degraded Mode Rollout

Anthropic degraded mode is restart-scoped and `off` by default. Read [Configuration](./configuration.md#anthropic-degraded-mode) and [Account Routing Architecture](./routing-architecture.md#anthropic-degraded-mode) before activation. Do not generate synthetic traffic against a real Anthropic account for this rollout; use deterministic validation before deployment and observe only naturally arriving production traffic.

### Topology gate

`enforce` is supported only when all affected traffic reaches one HoV Router server process and therefore one in-memory coordinator. The standard `ccflare-stack.service` runner starts one guard and one upstream server, which satisfies the process boundary only if no other stack, worker, pod, or replica also receives the traffic.

Before enforcement:

- Inventory every load-balancer target and service instance, not just the local unit.
- Confirm one active upstream server process owns all affected routes.
- Treat the SQLite database as irrelevant to coordination; degraded state is never stored there.
- Do not enable enforcement across replicas. Two independent coordinators may each elect one natural recovery probe.

The local process check is useful but does not replace the fleet inventory:

```sh
systemctl show ccflare-stack.service \
  --property=ActiveState \
  --property=SubState \
  --property=MainPID
```

### Establish an off baseline

Set these values in the existing service environment or configuration file:

```ini
Environment=CCFLARE_ANTHROPIC_DEGRADED_MODE=off
Environment=CCFLARE_ANTHROPIC_DEGRADED_DIAGNOSTICS=false
```

Then restart the complete stack:

```sh
sudo systemctl daemon-reload
sudo systemctl restart ccflare-stack.service

curl -fsS http://127.0.0.1:8788/health |
  jq '{status, git_sha, anthropicDegraded: .runtime.anthropicDegraded}'
curl -fsS http://127.0.0.1:8788/_guard/health |
  jq '{status, runtime, counters}'
```

Record the expected `git_sha` and the opaque `runtime.anthropicDegraded.bootId`. Verify `mode` is `off`, `diagnosticsEnabled` is `false`, both health endpoints respond, and the boot ID changed from the previous full-stack run. Use this boot-scoped window to establish normal client status/error-body shape, account selection, physical-send rate, guard-attempt rate, and session-owner continuity.

### Journal access and retention

Detailed diagnostics are allowed only in the host service journal. Before enabling them, verify that intended operators can read the unit and unrelated users cannot:

```sh
getent group systemd-journal
namei -l /var/log/journal /run/log/journal 2>/dev/null
getfacl -p /var/log/journal /run/log/journal 2>/dev/null
OPERATOR_USER=alice
sudo -u "$OPERATOR_USER" journalctl \
  -u ccflare-stack.service --since -5min --no-pager
```

Review the effective journald policy, not only one source file:

```sh
systemd-analyze cat-config systemd/journald.conf
journalctl --disk-usage
```

Confirm the active storage mode and explicit site-appropriate size and time bounds, including `SystemMaxUse` or `RuntimeMaxUse` and `MaxRetentionSec`. If the policy is changed in `/etc/systemd/journald.conf.d/`, restart `systemd-journald` and repeat both checks. Do not enable detailed diagnostics when reader access is broader than intended or either retention dimension is unbounded.

Inspect detailed records in place instead of creating an unmanaged export:

```sh
journalctl -u ccflare-stack.service --since -15min -o cat |
  jq -Rc 'fromjson? | select(.event == "anthropic_degraded_mode")'
```

These records contain only bounded estimates and boot-scoped opaque identifiers, but they are still operator diagnostic data. If a controlled export is necessary, protect it under the same ACL and deletion deadline as the journal window.

### Observe before enforcing

After the baseline and journal checks, set:

```ini
Environment=CCFLARE_ANTHROPIC_DEGRADED_MODE=observe
Environment=CCFLARE_ANTHROPIC_DEGRADED_DIAGNOSTICS=true
```

Perform another full-stack restart and confirm a new boot ID, `mode: "observe"`, and `diagnosticsEnabled: true`. Observation starts with empty shadow state; no state from the off baseline is reused.

Compare rates over similarly sized natural-traffic windows. Counters reset on every restart, and opaque account/owner identifiers rotate with the boot ID, so compare distributions and behavior rather than attempting cross-boot identifier joins.

| Signal | Source | Observation pass criterion |
| ---------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client status and body | Existing client/application telemetry | Status and Anthropic error type/message shape match the off baseline; do not add raw body logging. |
| Account choice | Existing request/account attribution; boot-local `physical_attempt.accountId` diagnostics | Candidate order and account distribution show no observe-only routing change. |
| Owner continuity | Repeated session/account attribution; boot-local `transition` events with `subject: "owner"` | Existing owners remain authoritative and hypothetical retention does not remap affinity. |
| Proxy sends | Health `attempts.{logical,local,physical}` | Physical-send behavior matches off for comparable traffic; `decisions.suppressedSends` and `decisions.probeSends` remain zero while `wouldSuppressSends`/`wouldProbeSends` may increase. |
| Guard attempts | Health `attempts.guard` plus guard-health `counters.{total,retried,overload529}` | Guard amplification does not increase in observe. |
| Pressure and loss | Health `droppedEvents`, `droppedEvidence`, and `saturation` | `saturation` stays false; any drop is explained before enforcement. |

Detailed events should reconcile each logical request to its physical attempts, guard-attempt ordinal when authenticated, owner/quorum/probe decisions, and terminal outcome without retaining user content. End the diagnostic window if client semantics, routing, owner state, sends, or retry behavior diverge from the off baseline.

### Enforce and rollback

Enable `enforce` only after the topology gate and observation criteria pass. Leave diagnostics off unless a separately approved bounded journal window is still active:

```ini
Environment=CCFLARE_ANTHROPIC_DEGRADED_MODE=enforce
Environment=CCFLARE_ANTHROPIC_DEGRADED_DIAGNOSTICS=false
```

Restart the complete stack and verify the expected SHA, a new boot ID, `mode: "enforce"`, and the intended diagnostic state. The fresh coordinator does not inherit observe evidence. During a real matching overload, monitor cohort state, active probes, send/suppression decisions, terminal outcomes, guard attempts, drops, and saturation. A protected 529 is terminal at the guard and must not produce a guard body replay.

Rollback is configuration-only:

```ini
Environment=CCFLARE_ANTHROPIC_DEGRADED_MODE=off
Environment=CCFLARE_ANTHROPIC_DEGRADED_DIAGNOSTICS=false
```

```sh
sudo systemctl daemon-reload
sudo systemctl restart ccflare-stack.service
```

Verify a new boot ID with `mode: "off"` and `diagnosticsEnabled: false`. The restart clears cohorts, leases, retained/shadow owners, and detailed joins. No database cleanup is required.

### Full-stack guard correlation

Each full-stack runner invocation internally generates one ephemeral guard-correlation credential and gives it directly to both child processes. It is not operator configuration: do not add it to `.env`, a unit drop-in, command-line arguments, or logs. A full-stack restart rotates it.

If one child is replaced independently or the two children otherwise disagree, correlation authentication fails closed to local, unjoined attempt accounting. That mismatch does not grant routing authority and must not change provider selection, response bodies, 529 passthrough, or guard retry policy. Restart the full stack to restore joined guard-attempt diagnostics.

## Codex orchestration safety

Codex routing allows one orchestration-capable conversation per identified Claude Code session. The first conversation that offers `Agent` or `Task` becomes the session root. Other conversation identities in that session keep their normal tools but have current `Agent` and `Task` declarations removed. The election is process-local, expires after five hours of orchestration inactivity, and resets when the service restarts. Concurrent independent orchestration roots in one Claude Code session are intentionally unsupported.

Containment is enabled by default. For emergency rollback only:

```ini
Environment=CCFLARE_CODEX_SINGLE_ORCHESTRATION_ROOT=0
```

This switch disables root election only. Trusted descendant filtering and `CCFLARE_SESSION_MAX_REQUESTS_PER_HOUR` remain active. Remove the override to restore containment.

### Codex prompt cache keys

Prompt cache keys are enabled by default for OpenAI-owned `chatgpt.com` and `api.openai.com` endpoints. Each key is conversation-scoped: it comes from the Claude session, the instructions, and the first input item, so concurrent subagents in one session do not share one OpenAI cache machine. A validated continuation of the session's orchestration root keeps the root's key; see [Codex cache-key continuity](configuration.md#codex-cache-key-continuity).

Configuration precedence is:

1. `CCFLARE_CODEX_PROMPT_CACHE_KEY=0` is the explicit global opt-out. Unset or other values leave prompt cache keys enabled by default.
2. The account selected for the transform must resolve to OpenAI's `chatgpt.com` or `api.openai.com` endpoint. Other endpoints are ineligible and emit no key.
3. Missing or malformed Claude session metadata remains ineligible and emits no key.
4. `CCFLARE_CODEX_CACHE_KEY_MODE=session` is an explicit all-session override: one key per session, shared by all of its subagents, with no continuity.
5. Otherwise requests use conversation keys. Empty transformed input keeps the session-key fallback.

The session-key canary that compared the two modes was removed. `CCFLARE_CODEX_CACHE_KEY_SESSION_PERCENT` is ignored and the router logs a startup warning while it is still set, so delete it from the drop-in.

#### Trace schema and analysis

Since schema 9, Codex traces carry physical-attempt identity so retries and failover do not collapse into one logical request:

| Field | Meaning |
| ----------------- | ------- |
| `conversation_id` | Short digest of the logical conversation identity, independent of the outbound cache key |
| `attempt_id` | Unique physical upstream transport identity for one transport attempt |
| `attempt_ordinal` | One-based physical transport ordinal within the logical `request_id` |
| `attempt_cause` | Why the attempt was opened: `initial`, `model_fallback`, `overload_529`, `thinking_retry`, `reasoning_retry`, `cache_control_retry`, `cache_lane_rescue`, `precommit_sse_retry`, `account_failover`, `continuation_repair_retry`, or `other_retry` |

`prompt_cache_key_set`, `prompt_cache_key_id`, and `cache_key_mode` record the effective key behavior. Traces written while the canary existed also carry `cache_key_assignment`, `cache_key_cohort_id`, and `cache_key_assignment_source`; the analyzer still reads those traces and ignores the three fields.

Join rules for analysis:

1. Prefer unambiguous one-to-one joins on `attempt_id` for schema 9 and later request/response pairs.
2. Accept valid legacy schema 6-8 joins only when both sides lack `attempt_id` and there is exactly one request and one response for that `request_id`.
3. Exclude orphan responses, duplicate request or response identities, and any ambiguous multi-record `request_id` groups from attempt-inclusive cache stats.
4. Count requests without a joined terminal as missing joins rather than client aborts.

Attempt-inclusive cache stats therefore measure every unambiguous physical transport, while final-response denominators still describe one terminal outcome per logical client request.

#### Privacy

These trace fields hold only bounded digests, enum values, and physical-attempt identifiers. They never store raw session IDs, prompt material, or outbound cache keys. Internal routing metadata is stripped before upstream transport. Cache token counts and serialized prefix-boundary byte lengths are different units, so trace analysis must not claim an exact provider token-cache boundary from HMAC boundary telemetry.

Prefix retention and instruction/tool stability require `CCFLARE_CODEX_TRACE_HMAC_KEY`, because summaries written without that key intentionally contain no HMACs. Those comparisons are reported as unavailable rather than changed when HMACs are absent. With a dedicated trace key, traces include bounded cumulative prefix-boundary HMACs and byte lengths, allowing an earlier full input to be compared with the corresponding prefix of a later turn. Old boundaries outside the bounded retention window are also reported as unavailable. The key itself is never written to the trace. Rotate or remove it after the observation window.

Accounts with mature repeated 429 streaks use process-local single-flight recovery probes after cooldown expiry. Journal events are `cooldown_probe_admitted`, `cooldown_probe_suppressed`, `cooldown_probe_recovery_success`, and `cooldown_probe_reapplied`. The upstream reset time remains authoritative; probe gating prevents concurrent re-entry without imposing a longer fixed cooldown.


### Listener-preserving memory recycling

The runner defaults `RUNNER_PERSISTENT_GUARD=1`. An RSS+swap watchdog recycle
keeps the existing guard and SSH tunnel alive. A private per-runner Unix socket
(mode 0600 inside a 0700 directory) authenticates the drain and replacement
commands; generation numbers reject stale transitions. Control and correlation
credentials travel only through child environments/private IPC, never argv or logs.

The guard pauses new dispatches and retains already-dispatched requests through
the existing shutdown grace. Requests accepted during the pause wait in a bounded,
cancellable queue before body reads, using their original guard deadline. Existing
concurrency/body-reader queues and weighted body limits remain in force. The native whole-upload timeout is disabled because every post-header path has
an owned request deadline or bounded discard; the native 60-second header timeout
remains enabled. Queue saturation returns an explicit 503; expired requests retain the existing deadline
error. `/_guard/health` stays available and exposes lifecycle state, generation,
waiting/dispatched counts and recycle counters. `/health` returns a prompt 503
while the upstream is unavailable; it never claims the backend is healthy.

After a natural or bounded forced drain, the runner stops and reaps the old sole
upstream before launching the replacement. The guard verifies process start time,
executable digest, ownership of the upstream listening socket and health build SHA,
then updates runtime PID/artifact identity and rotates the correlation signer before
releasing waiting requests. Already-dispatched requests are never replayed across
this boundary. Failed replacements remain fenced while the existing bounded
restart circuit applies. Terminal TERM/INT still shuts the entire stack down.

Memory recycling always drains the old upstream first. A compatible backend-only
deployment through `scripts/deploy-ccflare.sh` also keeps the guard. When the
running backend supports it, the deployment quiesces the old upstream instead of
draining it: the old process releases its port and finishes its streams while the
replacement serves (see
[Retained-ingress backend transactions](deployment.md#retained-ingress-backend-transactions)).
Lifecycle and schema changes still replace the full service. `RUNNER_PERSISTENT_GUARD=0` retains the legacy full-stack recycling path
for explicit rollback. The memory threshold, swap accounting, recycle cap, response
idle controls and request deadlines are unchanged.
