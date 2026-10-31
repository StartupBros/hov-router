---
title: Survey the whole fork network for ports, then check that each confirmed fix applies to this deployment
date: 2026-10-31
category: workflow-issues
module: upstream-integration
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - Looking for fixes worth porting from forks of tombii/better-ccflare or snipeship/ccflare, rather than from one upstream release
  - A candidate is confirmed real upstream and absent from HoV Router, and the next step would be a port PR
  - Deciding whether to adopt a fork feature such as an upstream-error retry, payload compression or error rewrapping
symptoms:
  - GitHub's compare shows a fork 0 commits ahead while it carries work on side branches
  - A fix confirmed against upstream's code guards a branch HoV Router never reaches
  - A port proposal adds behaviour that production already gets from its clients or its config
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components:
  - proxy
  - providers
  - database
tags:
  - upstream-integration
  - fork-network
  - cherry-pick
  - patch-id
  - port-triage
  - applicability-check
---

# Survey the whole fork network for ports, then check that each confirmed fix applies to this deployment

## Context

The two existing upstream docs cover release syncs: merging one tagged tombii release
([composed-upstream-syncs-need-a-silent-drop-survey.md](composed-upstream-syncs-need-a-silent-drop-survey.md),
[authenticate-upstream-sync-closeout.md](authenticate-upstream-sync-closeout.md)). This
doc covers a different job: finding fixes that live only in *sibling forks* and porting the
useful ones. The 2026-10-31 survey (#677) covered 146 forks (54 of tombii/better-ccflare,
92 of snipeship/ccflare) and ended in three port PRs (#681, #682, #683).

The funnel, from #677:

| Stage | Count |
|---|---|
| Commits not in HoV, tombii or snipeship by SHA | 3,154 |
| Left after patch-id and subject dedup | 1,212 |
| Commits triaged (adds tombii main's 315 commits since the last sync base, and the 12 from a fork of a fork) | 1,539, in 22 chunks |
| Deduplicated candidates | 83 |
| Checked by an independent verifier | 42: 19 confirmed, 22 downgraded, 1 refuted |

Two stages carried most of the value. Collection had to look past default branches,
and a second check had to run after verification, because "confirmed" turned out not to
mean "worth porting".

## Guidance

### 1. Fetch every branch of every fork into one scratch bare repo

- List forks with `gh api --paginate "repos/<parent>/forks?per_page=100"`. Forks of forks
  are not in that list, so make a second pass over each fork's own forks. One grandchild
  (aRustyDev) carried 12 commits nobody else had.
- Do not filter forks on GitHub's default-branch `compare` ahead count. Fetch all heads of
  any fork that is ahead **or** has more than one branch. `UPSTREAM.md` ("Why this file
  exists") records the 2026-07-24 audit, where comparing only default branches made forks
  look like zero-delta mirrors.
- Borrow objects from the local checkout, so the fetch downloads only fork-only objects:

```bash
git init --bare -q net.git
echo "$CHECKOUT/.git/objects" > net.git/objects/info/alternates
git -C net.git fetch -q "$CHECKOUT" "refs/remotes/origin/main:refs/hov/main"
git -C net.git fetch -q --no-tags https://github.com/tombii/better-ccflare.git "+refs/heads/*:refs/up/tombii/*" "+refs/tags/*:refs/uptags/tombii/*"
git -C net.git fetch -q --no-tags https://github.com/snipeship/ccflare.git "+refs/heads/*:refs/up/snipeship/*"
# per fork, with a timeout; deleted repositories fail here (5 of 146 did)
git -C net.git fetch -q --no-tags "https://github.com/$owner/$repo.git" "+refs/heads/*:refs/fork/$owner/*"
```

### 2. Reduce to commits that are actually new

```bash
EXCL=$(git -C net.git for-each-ref --format='%(refname)' refs/up refs/uptags refs/hov)
git -C net.git rev-list --no-merges $(git -C net.git for-each-ref --format='%(refname)' refs/fork) --not $EXCL > all-unique.txt
```

Then drop every commit whose `git patch-id --stable`, or whose subject (with any trailing
`(#N)` removed), matches a commit reachable from `$EXCL`. Forks cherry-pick and rebase each
other's work, which changes the SHA but not the patch-id. This step cut 3,154 commits to
1,212. Add upstream's own commits since the last sync merge base: they are candidates too.

### 3. Triage in bounded chunks against one pinned snapshot

- Export `git archive refs/hov/main` once, so every triager reads the same tree.
- Use chunks of about 70 commits (1,539 commits went into 22 chunks). Every chunk accounts for every one of its commits:
  port, consider, or skip with a reason.
- About 1,234 commits were skipped by class. The classes were fork CI and release tooling,
  version bumps, the fork's own process docs, test infrastructure, work already in HoV, and
  features built on surfaces HoV lacks.
- Merge duplicate fixes for the same defect, and pick the version that fits HoV's contracts.
  SijanC147 and tombii both stopped Codex from minting a 0% usage window for a window the
  headers did not report. tombii's version omits the keys. SijanC147's reports `null`.
  Omitting them breaks `if ("five_hour" in data && "seven_day" in data)`
  (`packages/proxy/src/handlers/usage-throttling.ts:447`), so #682 took the null form, and
  `packages/providers/src/providers/codex/usage.ts:270-273` now explains why.

### 4. Verify each candidate independently, and expect most to downgrade

22 of 42 verified candidates were downgraded and one was refuted. A triager reading a
commit in isolation overrates it, so do not port from the triage list.

### 5. Before porting a confirmed fix, check that it applies here

"Confirmed" means the bug is real upstream and the fix is absent from HoV. It does not mean
the bug fires in this deployment or that the fix helps. Run four checks before writing the
port. Each one killed a candidate in this survey:

1. **Call path.** Does HoV reach the buggy code at all?
2. **Production config.** Is the feature even switched on in production?
3. **Client behaviour.** Do the clients already do what the port adds?
4. **Kind of harm.** Does the defect change behaviour, or only the text a user sees?

Write each verdict into the issue with a condition for reopening it. Then the decision
stays put without a process artifact to maintain.

## Why This Matters

Four of the items the survey proposed died at step 5, and each would have shipped code that
did nothing in production or made it worse:

- Two would have run code that production never executes.
- One would have added a second retry layer under clients that already retry. On the
  exclusive single-account lane it would also have turned a real upstream 500 into a router
  503 carrying no upstream detail, and on the multi-account Codex pools it would have cost
  cache affinity.
- One would have put a risky wrapper on the response-identity and drain path to fix text
  nobody had reported seeing.

Without step 1, the survey would also have missed side-branch work that default-branch
counts hide.

## When to Apply

- Any search for ports across the fork network, or across several forks at once.
- Before opening a port PR for any confirmed candidate, including one from a single
  upstream release sync.
- When a fork's feature arrives as "upstream has X and we don't". Run step 5 before
  sizing the port.

## Examples

What step 5 found for each candidate it stopped:

| Candidate | Check that stopped it | Evidence |
|---|---|---|
| tombii's streaming-usage idle timeout (Group B in #677) | Call path | `packages/proxy/src/handlers/response-processor.ts:312` reads `} else if (!isStream && ctx.provider.extractUsageInfo) {`, so a stream never reaches the 60 s extraction budget the fix replaces. No PR opened. |
| Stored payload compression, zstd or binary blob (#679) | Production config | The managed runner starts the binary with `STORE_PAYLOADS=false` (`scripts/run-ccflare-stack.sh:900`). Default installs keep payloads for 1 day (`packages/config/src/index.ts:1726-1730`). |
| tombii's in-place 5xx retry, then bench and fail over (#678) | Client behaviour | HoV retries in place only for 529 (`packages/proxy/src/handlers/proxy-operations.ts:7427-7431`), and that is enough. Claude Code, the Anthropic SDK and Codex CLI already retry 5xx: Claude Code per its docs, the SDK and Codex CLI per their source, as checked on 2026-10-31. In production, 149 sessions sent another request within 120 s of a Codex 503, and 141 of them succeeded on the same account. |
| SijanC147's HTML-to-JSON error envelope on `/v1` (#680) | Kind of harm | The Anthropic SDK decides whether to retry from the status before it reads the body. An HTML page changes the error text, not the retry. Deferred until someone sees one. |

#678, #679 and #680 were closed as not planned, each with a comment giving its reopen
condition.

## Related

- #677: survey coverage, the verified and unverified ledgers, and the Group B analysis.
- #681, #682, #683: the ports that survived.
- [composed-upstream-syncs-need-a-silent-drop-survey.md](composed-upstream-syncs-need-a-silent-drop-survey.md)
  covers the release-sync counterpart: what one upstream release changed that nobody
  reviewed.
- [verify-fix-ancestry-before-citing-a-measured-rate.md](verify-fix-ancestry-before-citing-a-measured-rate.md)
  makes the same move from a different side: re-check a claim against this deployment's
  current state before acting on it.
- `UPSTREAM.md`: protected fork contracts and the release synchronization protocol.
