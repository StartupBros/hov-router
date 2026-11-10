# Re-authenticating an account

A re-login replaces an account's OAuth tokens in place. Its name, priority, routing settings, usage statistics and request history stay as they are. Do not remove and re-add an account to fix an expired login: the new account starts with no history.

## When an account needs a re-login

HoV Router refreshes an OAuth access token when a request needs one. A token that has expired, or is about to, is refreshed before the request is sent, and a `401` on an Anthropic OAuth, Codex or xAI account triggers one refresh and retry. Nothing refreshes an idle account in the background (see [Auto-refresh removed](hov-router-migration.md#auto-refresh-removed)).

A re-login is needed when the provider refuses that refresh, because the login itself is gone. The router recognizes a refusal when:

- **Anthropic, Codex or xAI** answer with an OAuth error meaning the refresh token is no longer valid, such as `invalid_grant`, `invalid_refresh_token`, `refresh_token_expired`, `refresh_token_reused` or `refresh_token_invalidated`.
- **Codex** answers a refresh with HTTP `401`, with or without a code. OpenAI's own Codex CLI treats every refused refresh this way. Two exceptions are not treated as a dead login: a `401` that names the client (`invalid_client`, `unauthorized_client`), and a response whose body could not be read in full.

When a refresh is refused, the router:

1. Pauses the account with the reason `oauth_invalid_grant`, so requests stop going to it.
2. Marks it as needing a re-login. Its row on the dashboard's Accounts page shows a **Re-authenticate** button.
3. Raises a critical "Account authentication failed" alert, `Account <name> (<provider>) requires re-authentication: <reason>`. The alert appears in the dashboard and goes to the alert webhook if one is set ([Alerts](configuration.md#alerts)).
4. Logs the refusal with the HTTP status and, when the provider sent one, its error code. The rest of the provider's response is never logged.

Other failures, such as a network error, a `5xx` or a rate limit, are not treated as a dead login. The request fails, and the next request that needs a token tries the refresh again.

## How to re-authenticate

On the dashboard, open the Accounts page. An account that needs a re-login shows a **Re-authenticate** button on its row. To re-authenticate any other time, open the row's **More actions** menu (⋯) and choose **Re-authenticate…**.

| Provider | Dashboard | CLI |
|---|---|---|
| Anthropic (Claude login) | Open the link the dialog shows, sign in, and paste the authorization code back into the dialog. | `hov-router --reauthenticate <name>` opens the same sign-in page and asks for the code. |
| Anthropic (Console login, no refresh token) | Not available. | `hov-router --reauthenticate <name>` |
| Codex | OpenAI device sign-in: open the link the dialog shows and enter its code. It works from any device, so the router can run on another machine. | Not available. The CLI points you at the dashboard. |
| Qwen | Device sign-in, as for Codex. | `hov-router --reauthenticate <name>` |
| xAI | Not available. | Sign in with `grok --oauth`, then run `hov-router --reauthenticate <name>`. It imports the new login from `~/.grok/auth.json`. |
| Other providers | Not available. | Remove the account and add it again. |

Quote a name that contains spaces, for example `hov-router --reauthenticate 'team account'`. The `better-ccflare` command takes the same flags.

## What a re-login changes

- The access token, refresh token and expiry are replaced. A Qwen re-login also updates the account's endpoint.
- The re-login flag is cleared and the `oauth_invalid_grant` pause is lifted, so the account returns to rotation. Any other pause stays: one you set by hand, an overage pause, or a pause after repeated failures. Resume those from the dashboard or with `POST /api/accounts/<id>/resume`.
- A dashboard re-login clears the server's cached token, so the next request uses the new one. An Anthropic or Qwen re-login from the CLI asks a server running on the same machine to reload the account (`POST /api/accounts/<id>/reload`). An xAI re-login from the CLI does not; call that endpoint yourself if the server keeps using the old login.

## Troubleshooting

**No Re-authenticate button on the row.** The button appears only while the account is paused for a re-login. Use **More actions** (⋯) → **Re-authenticate…** instead.

**The CLI says the account "cannot be re-authenticated from the CLI".** The provider has no CLI sign-in. The message names the path that works, which for Codex is the dashboard.

**The re-login worked but the account is still paused.** It was paused for another reason. Resume it from the dashboard.

**A Codex account was paused after a refresh logged `HTTP 401` with no code.** OpenAI refused the refresh without saying why. If the refusal was temporary, the cost is one re-login you did not strictly need.
