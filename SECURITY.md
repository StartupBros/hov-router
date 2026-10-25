# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub private vulnerability reporting:

<https://github.com/StartupBros/hov-router/security/advisories/new>

Do not open a public issue, pull request or discussion for a suspected vulnerability. Public details can put other people's accounts and credentials at risk before a fix exists.

## What to include

- What the problem is and which component it affects (server, guard, dashboard, CLI or a release artifact).
- The version or commit you tested (the `/health` endpoint reports `git_sha`, and `hov-router --version` reports the release).
- Steps to reproduce, or a minimal request or configuration that triggers it.
- The impact you observed or expect, for example credential exposure, authentication bypass, or request routing to the wrong account.
- Any fix or mitigation you already have in mind.

Please do not include real provider API keys, OAuth tokens or account data in a report. Redact them.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest release (3.x line) | Yes |
| `main` | Yes |
| Older releases | No. Upgrade to the latest release. |

## Scope

In scope:

- The HoV Router server and proxy.
- The guard that fronts the server.
- The dashboard and its API.
- The CLI.
- Release artifacts published from this repository.

Out of scope:

- Builds of upstream [better-ccflare](https://github.com/tombii/better-ccflare) that were not produced from this repository. Report those to [tombii/better-ccflare](https://github.com/tombii/better-ccflare).
- Problems on the provider or account side, such as a provider's own API, rate limits, or an account being restricted. Report those to the provider.
- Findings that need an attacker who already controls the host or the router's configuration directory.

See [docs/security.md](docs/security.md) for the project's threat model and hardening guidance.
