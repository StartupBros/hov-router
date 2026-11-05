---
title: A backend-only deploy keeps the runner's environment, so a new systemd env file needs a full restart
date: 2026-11-04
category: workflow-issues
module: production-deploy
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - Adding or changing a drop-in, Environment= line, or EnvironmentFile for ccflare-stack.service
  - Switching on an environment-gated feature such as member notices on the production host
  - "`scripts/deploy-ccflare.sh --check` prints `restart: backend-only` after a service environment change"
  - Hand-editing better-ccflare.json on a host whose router is running
root_cause: incorrect_assumption
resolution_type: workflow_improvement
related_components:
  - infrastructure
tags:
  - backend-only
  - retained-ingress
  - systemd
  - environmentfile
  - drop-in
  - deploy
  - member-notices
  - config-file
  - saveconfig
---

# A backend-only deploy keeps the runner's environment, so a new systemd env file needs a full restart

## Context

Member notices (PR #720 here; BroBot's intake in StartupBros-com/pushbot #5531 and #5548) are
switched on in production by two new host files: an EnvironmentFile holding `MEMBER_NOTICE_WEBHOOK_URL` and
`MEMBER_NOTICE_SIGNING_SECRET`, and a drop-in under
`/etc/systemd/system/ccflare-stack.service.d/` that names it. Planning that activation turned up
two ways the feature can come up `off` while every file looks right. Neither is written down in
`docs/deployment.md`, `docs/systemd.md`, or the Member notices section of
`docs/configuration.md`.

The 2026-11-04 deploy that switched it on was a full restart, so it hit neither trap: the
member-notice state read `on` afterwards. Both traps below come from reading the code at that
revision. Neither was observed in production.

## Guidance

### 1. Service environment changes reach the backend only on a full restart

`scripts/deploy-ccflare.sh` takes one of two paths (`:609-623`):

- **Full restart**: `sudo systemctl restart ccflare-stack.service` (`:745`). systemd starts a
  new runner with the current merged environment, so every drop-in and EnvironmentFile takes
  effect.
- **Backend-only handoff**: the running runner (`scripts/run-ccflare-stack.sh`) stays up and
  starts the candidate binary as its own child. `run-ccflare-stack.sh:787` points `CCFLARE_BIN`
  at `manifest.candidateBinary`, and `run-ccflare-stack.sh:896-906` launches
  `"$CCFLARE_BIN" --serve ... &`. The child inherits the runner's environment, which systemd
  fixed when the runner started; the launch overrides only a few fixed variables such as `PORT`
  and `LOG_LEVEL`. The runner sources no env file of its own.

The eligibility check (`backend_handoff_eligible`, `scripts/deploy-ccflare-lib.sh:1625`)
compares three things: the schema digest (`:1657`); the runner, guard, policy, timing and
transaction bytes (`:1658`); and the managed pin `50-pinned-build.conf` (`:1660`). The checks
after that only confirm the running generation is alive. It reads no other drop-in and no
EnvironmentFile. A deploy after you add a drop-in can therefore still be
backend-only, and the new backend then runs without the new variables.

The deploy also runs `systemctl daemon-reload` on both paths
(`reload_validate_or_restore_systemd_policy`, `deploy-ccflare.sh:717`). After a backend-only
deploy, `systemctl show -p EnvironmentFiles ccflare-stack.service` therefore lists the new file
even though the running process never loaded it. That listing describes the next start, not the
running process.

What to do:

1. Run `scripts/deploy-ccflare.sh --check` first (it works from any checkout).
   `restart: full restart: <reason>` means the deploy itself loads the new environment.
   `restart: backend-only (the running guard and runner stay up)` means it will not.
2. If it says backend-only, finish the deploy, then run
   `sudo systemctl daemon-reload && sudo systemctl restart ccflare-stack.service`. A full
   restart is a persistence change on this host, so get the operator's go first.
3. Verify the running backend, not systemd. Count the variable without printing its value:

   ```bash
   PID=$(sudo ss -ltnp 'sport = :8789' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
   sudo tr '\0' '\n' < "/proc/$PID/environ" | grep -c '^MEMBER_NOTICE_WEBHOOK_URL='   # 1 = loaded
   ```

   Then check the router's own verdict. `GET /api/insights/alerts/config` (it needs the prod API
   key) returns `memberNotices.state`: `off` with no address, `invalid_address` when the address
   is not https, `missing_secret` without a signing secret, and `on` otherwise.

### 2. Never stage keys in better-ccflare.json while the router runs

`ConfigManager` reads `better-ccflare.json` once (`packages/config/src/index.ts:1535`) and keeps
it in memory. Every write serializes that whole copy back to disk (`saveConfig`, `:1558-1561`),
and ordinary reads write too: `get(key, default)` calls `set` when the key is absent (`:1594`),
and `set` saves (`:1605`). Nothing watches the file. A key you add by hand while the process
runs is overwritten the next time the process writes any config value, so the file ends up as
if you never edited it.

Member notices read the environment first and the file second (`:2687-2703`). Put them in the
service environment. If a file key is unavoidable, stop the service, edit the file, and start it
again.

### Proposed check (not built)

A check that would catch trap 1 needs a product change, so it is only proposed here: the runner
could record a fingerprint of the unit's environment when it starts (the
`systemctl show -p Environment -p EnvironmentFiles` output plus a hash of each listed file).
`backend_handoff_eligible` would then compare that fingerprint with the current one and force a
full restart when they differ.

## Why This Matters

Both failures are silent. With member notices `off` the router sends nothing, and the first
expected event (a three-day expiry reminder) can be weeks away, so the gap shows up as a missed
member notice. Meanwhile the deploy reports success, `systemctl show` lists the file, and the
file holds the key. Only the running process's environment is authoritative.

## When to Apply

- Any new or changed environment for `ccflare-stack.service`, not just member notices. Every
  setting the router reads from its environment at start behaves this way.
  `docs/configuration.md` already says this for Anthropic degraded mode ("captured at process
  start; changing them requires a full restart"), but not for deploys.
- Any hand edit of `better-ccflare.json` on a host with a running router.

## Examples

Switching on member notices, done safely:

1. Install the EnvironmentFile (mode 600) and the drop-in that names it.
2. Run `scripts/deploy-ccflare.sh --check`. A full restart loads the file during the deploy
   itself, which is what happened on 2026-11-04. If it prints backend-only, follow step 2 under
   trap 1 above.
3. Read the backend's `/proc/<pid>/environ` count and `memberNotices.state` (`on`).

Rolling back is the same in reverse: remove the drop-in, reload, and do a full restart. A
backend-only deploy after removing the drop-in would keep sending notices.

## Related

- `docs/solutions/integration-issues/config-preservation-requires-persisted-oauth-recovery-key.md`:
  the same `saveConfig` path, from the angle of preserving a config file the router cannot
  parse.
- `docs/deployment.md` (backend-only handoff selection) and `docs/systemd.md` (the managed pin
  and operator drop-ins) describe the two deploy paths but not how each treats the environment.
