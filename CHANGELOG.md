# Changelog

## [5.1.0](https://github.com/StartupBros/hov-router/compare/v5.0.1...v5.1.0) (2026-11-14)


### Features

* **dashboard:** expand account details inline with tabs ([#806](https://github.com/StartupBros/hov-router/issues/806)) ([c0970ca](https://github.com/StartupBros/hov-router/commit/c0970cadd703025bccd9fdf1b379e3cbc04b1307)), refs [#766](https://github.com/StartupBros/hov-router/issues/766)
* **dashboard:** make Accounts scan-first and responsive ([#767](https://github.com/StartupBros/hov-router/issues/767)) ([58ce8fe](https://github.com/StartupBros/hov-router/commit/58ce8fee4adef7e42fab13907a383229cf1ee428)), refs [#766](https://github.com/StartupBros/hov-router/issues/766)
* **dashboard:** simplify account comparison and quota hierarchy ([#805](https://github.com/StartupBros/hov-router/issues/805)) ([02e45b1](https://github.com/StartupBros/hov-router/commit/02e45b1cd6bb308a01197e25569a7cdd49b186bf))
* **dashboard:** stack account quotas and add reset-aware sorting ([#802](https://github.com/StartupBros/hov-router/issues/802)) ([d0d52e2](https://github.com/StartupBros/hov-router/commit/d0d52e23ca52d358d44cfe770937291f3b01be15))


### Bug Fixes

* **dashboard:** align account status, usage and action feedback ([#810](https://github.com/StartupBros/hov-router/issues/810)) ([ab9d505](https://github.com/StartupBros/hov-router/commit/ab9d50591516f584c4ed58a329e64ace3fc45e5a))
* **dashboard:** clarify account usage and control labels ([#807](https://github.com/StartupBros/hov-router/issues/807)) ([32c1a79](https://github.com/StartupBros/hov-router/commit/32c1a79715a4fb6e584cb3ebb19cc9840185e557)), refs [#766](https://github.com/StartupBros/hov-router/issues/766)
* **dashboard:** restore account status colors and icons ([#811](https://github.com/StartupBros/hov-router/issues/811)) ([949e17f](https://github.com/StartupBros/hov-router/commit/949e17fbe92f89c765513448a8aac3e77f89b9e7)), refs [#808](https://github.com/StartupBros/hov-router/issues/808) [#766](https://github.com/StartupBros/hov-router/issues/766)
* **external-usage:** skip Codex sessions that ran through the router ([#804](https://github.com/StartupBros/hov-router/issues/804)) ([f96efb5](https://github.com/StartupBros/hov-router/commit/f96efb5ce66ec661d13016484be63744f4a69507))
* **usage:** keep one writer for a request's token counts ([#803](https://github.com/StartupBros/hov-router/issues/803)) ([900eb55](https://github.com/StartupBros/hov-router/commit/900eb55213093316147b7d7d4fb3e4c4d7ad7f87))

## [5.0.1](https://github.com/StartupBros/hov-router/compare/v5.0.0...v5.0.1) (2026-11-11)


### Bug Fixes

* **codex:** pause an account whose token refresh OpenAI refuses ([#795](https://github.com/StartupBros/hov-router/issues/795)) ([b469b65](https://github.com/StartupBros/hov-router/commit/b469b65533107fa5ab94cde3fbd744af2b1059ea))


### Improvements

* drop the startup warning for retired Codex settings after 5.0.0 ([#792](https://github.com/StartupBros/hov-router/issues/792)) ([0c1d86c](https://github.com/StartupBros/hov-router/commit/0c1d86cfc641dd8e6d8f731d4bbfec24c5839026)), refs [#749](https://github.com/StartupBros/hov-router/issues/749)

## [5.0.0](https://github.com/StartupBros/hov-router/compare/v4.0.0...v5.0.0) (2026-11-10)


### ⚠ BREAKING CHANGES

* `POST /api/accounts/:id/auto-refresh`, `POST /api/accounts/:id/model-fallbacks`, `GET /api/system/info` and `GET /api/workspaces` answer 410 Gone. Account API responses no longer include `autoRefreshEnabled`. Send fallbacks as arrays to `POST /api/accounts/:id/model-mappings`, and read workspaces from `GET /api/agents`.
* remove the Default Agent Model setting ([#743](https://github.com/StartupBros/hov-router/issues/743))

### Features

* alert on model catalogue gaps and fix the Sonnet 5.5 cache-read rate ([#778](https://github.com/StartupBros/hov-router/issues/778)) ([04b2cfb](https://github.com/StartupBros/hov-router/commit/04b2cfbd1af96b9d7a1f9ced5e72c156fefe30c9))
* register Claude Fable 5.2 and route the fable family to it ([#771](https://github.com/StartupBros/hov-router/issues/771)) ([d9bb16c](https://github.com/StartupBros/hov-router/commit/d9bb16c4e684b8668df96e63820fa63e865d36c9))


### Bug Fixes

* answer 410 for the removed cache-diagnosis route and list every ignored 5.0.0 setting ([#790](https://github.com/StartupBros/hov-router/issues/790)) ([2fe372d](https://github.com/StartupBros/hov-router/commit/2fe372dca6e26f0706255f575bc1970284a82649)), refs [#788](https://github.com/StartupBros/hov-router/issues/788)
* **codex:** delete Codex trace files past a retention window ([#750](https://github.com/StartupBros/hov-router/issues/750)) ([6742e36](https://github.com/StartupBros/hov-router/commit/6742e369a451cd4781aa10fdd8f555665e034172))
* correct docs and CLI output that cite commands, flags and routes that do not exist ([#741](https://github.com/StartupBros/hov-router/issues/741)) ([42e471f](https://github.com/StartupBros/hov-router/commit/42e471f9bd02f88f5adcc06be0b687bcf99e7fa7))
* **dashboard:** show session-id attributions as sessions, not agents ([#742](https://github.com/StartupBros/hov-router/issues/742)) ([f274365](https://github.com/StartupBros/hov-router/commit/f274365da3be6312cb737a6a754c33a22ee24b20))
* **deploy:** continue a backend handoff the server accepted without replying ([#744](https://github.com/StartupBros/hov-router/issues/744)) ([e890326](https://github.com/StartupBros/hov-router/commit/e890326f2dfe88b6c88501a8fa208308509a1fda)), refs [#743](https://github.com/StartupBros/hov-router/issues/743)
* **deploy:** start a backend handoff only after the deploy acknowledges the prepared reply ([#746](https://github.com/StartupBros/hov-router/issues/746)) ([16097e5](https://github.com/StartupBros/hov-router/commit/16097e55ae271e7c4042ecb8efbe74f3fc892247)), refs [#745](https://github.com/StartupBros/hov-router/issues/745)
* **docker:** give the container time to finish in-flight responses on stop ([#761](https://github.com/StartupBros/hov-router/issues/761)) ([f9b3b37](https://github.com/StartupBros/hov-router/commit/f9b3b37238e948a9682a2b74a5e47b10cb3c4ea6))
* let Use reset redeem any held banked reset, as the Codex CLI does ([#773](https://github.com/StartupBros/hov-router/issues/773)) ([73bf389](https://github.com/StartupBros/hov-router/commit/73bf3897f6e03a75af90ab8b185cb2e452e24d04)), refs [#772](https://github.com/StartupBros/hov-router/issues/772)
* price GPT-6 usage from the era floor and add gpt-6.1-terra ([#779](https://github.com/StartupBros/hov-router/issues/779)) ([afa76a8](https://github.com/StartupBros/hov-router/commit/afa76a8ff9c25785f1456005eb01b4c1a2e3491a))
* **proxy:** date a thinking turn's tokens per second from its block start ([#758](https://github.com/StartupBros/hov-router/issues/758)) ([a08864a](https://github.com/StartupBros/hov-router/commit/a08864ae8caad8035e150e8d74bce9ffd12d80bd))
* **proxy:** date tokens per second from when generation began ([#755](https://github.com/StartupBros/hov-router/issues/755)) ([cc80516](https://github.com/StartupBros/hov-router/commit/cc80516b09148f780da24d1587d9b505e2b3b533))
* **proxy:** prime cold catalog-role pools for inherited stock-model children ([#770](https://github.com/StartupBros/hov-router/issues/770)) ([7aa8b6d](https://github.com/StartupBros/hov-router/commit/7aa8b6d55f701e4ef36a68834b7b7a9c1d9814f0)), refs [#768](https://github.com/StartupBros/hov-router/issues/768)
* **proxy:** restore route-profile session bindings at startup ([#769](https://github.com/StartupBros/hov-router/issues/769)) ([650a671](https://github.com/StartupBros/hov-router/commit/650a6712812cd2b5559125521dd03d0b85b96a28)), refs [#768](https://github.com/StartupBros/hov-router/issues/768)
* **proxy:** stop flush-length windows and Codex reasoning from inflating tokens per second ([#760](https://github.com/StartupBros/hov-router/issues/760)) ([d992207](https://github.com/StartupBros/hov-router/commit/d99220729f9346a4fe1e955d583ec808dd380ea3)), refs [#643](https://github.com/StartupBros/hov-router/issues/643)
* record why a forwarded upstream request failed, and show its model ([#757](https://github.com/StartupBros/hov-router/issues/757)) ([d9e79a8](https://github.com/StartupBros/hov-router/commit/d9e79a8e47c4e4f4c1f8f51cd9bc4fc0e2c7577e))
* **runner:** reap an owned helper only when the stop signal reached it ([#765](https://github.com/StartupBros/hov-router/issues/765)) ([6eddaab](https://github.com/StartupBros/hov-router/commit/6eddaab2d4212af44123f233fb77a92d606efff7))
* show banked resets as a held count and Use reset, without OpenAI's applicable count ([#775](https://github.com/StartupBros/hov-router/issues/775)) ([7da6a9d](https://github.com/StartupBros/hov-router/commit/7da6a9dfacd8206761f2a8d3c39f84e34232d503)), refs [#772](https://github.com/StartupBros/hov-router/issues/772)
* wait for a just-created release draft before failing the coordinator readback ([#785](https://github.com/StartupBros/hov-router/issues/785)) ([9041a9a](https://github.com/StartupBros/hov-router/commit/9041a9ad519904f6a38da986ff4e10379cdbc78f)), refs [#784](https://github.com/StartupBros/hov-router/issues/784)


### Improvements

* **database:** delete the adapter's no-op transaction() ([#759](https://github.com/StartupBros/hov-router/issues/759)) ([884ecb8](https://github.com/StartupBros/hov-router/commit/884ecb827674626eb6c8ea71fb4dbcd78915d8a0))
* delete the Codex HTTP turn-state replay ([#736](https://github.com/StartupBros/hov-router/issues/736)) ([ae31d54](https://github.com/StartupBros/hov-router/commit/ae31d544829016bd1c87566b6266eda87a961202))
* drop the unused Codex cache parity floor ([#737](https://github.com/StartupBros/hov-router/issues/737)) ([4df7c76](https://github.com/StartupBros/hov-router/commit/4df7c7607139b14d3a5bd3ecb162f90f3bd18278))
* drop unused workspace deps and auto-refresh-named leftovers ([#748](https://github.com/StartupBros/hov-router/issues/748)) ([c4884bc](https://github.com/StartupBros/hov-router/commit/c4884bc84e879324a0292cb113c6a621b4074f8e))
* make Codex cache-key continuity always-on and retire dormant canaries ([#735](https://github.com/StartupBros/hov-router/issues/735)) ([3e4c8f2](https://github.com/StartupBros/hov-router/commit/3e4c8f2705bb7cf6ffa82e141cf2ddd23b4c4f00))
* remove dead code inherited from upstream ([#753](https://github.com/StartupBros/hov-router/issues/753)) ([be43006](https://github.com/StartupBros/hov-router/commit/be43006a34e140ec376ae817238d60501a1a14d2))
* remove dead inherited code with no callers ([#731](https://github.com/StartupBros/hov-router/issues/731)) ([efd3205](https://github.com/StartupBros/hov-router/commit/efd32050800997aedc8f59909bb437cab98c5ac6)), refs [#725](https://github.com/StartupBros/hov-router/issues/725)
* remove exported helpers nothing calls ([#739](https://github.com/StartupBros/hov-router/issues/739)) ([eabd4a5](https://github.com/StartupBros/hov-router/commit/eabd4a535d04afd793a0cb3f61f3399c18944db6))
* remove the Codex WebSocket transport ([#734](https://github.com/StartupBros/hov-router/issues/734)) ([cc4d49b](https://github.com/StartupBros/hov-router/commit/cc4d49bed8bbc4e0a729c9bc533a555901fef9fc)), refs [#730](https://github.com/StartupBros/hov-router/issues/730)
* remove the Default Agent Model setting ([#743](https://github.com/StartupBros/hov-router/issues/743)) ([8ab8636](https://github.com/StartupBros/hov-router/commit/8ab8636f8c37f3b3bc06e7c2c3383bbd1453ec30))
* remove the deprecated API endpoints and the autoRefreshEnabled field ([#789](https://github.com/StartupBros/hov-router/issues/789)) ([1b113ef](https://github.com/StartupBros/hov-router/commit/1b113ef559a74cda68a29bd3e3cfac8036238893)), refs [#788](https://github.com/StartupBros/hov-router/issues/788) [#749](https://github.com/StartupBros/hov-router/issues/749)
* remove the inert probe-backoff tie-break ([#733](https://github.com/StartupBros/hov-router/issues/733)) ([5f55cd5](https://github.com/StartupBros/hov-router/commit/5f55cd561dfcadf76dda762ed1ef56d9130cf2d7)), refs [#725](https://github.com/StartupBros/hov-router/issues/725)
* remove the orphaned Ollama transformer and more test-only helpers ([#740](https://github.com/StartupBros/hov-router/issues/740)) ([4bd34d2](https://github.com/StartupBros/hov-router/commit/4bd34d2679bcfb79cf180327c3626e9468b515ca))
* round-5 teardown cleanup (dead code, fictional docs, replay fold, classifyNoExecution) ([#764](https://github.com/StartupBros/hov-router/issues/764)) ([f7c328e](https://github.com/StartupBros/hov-router/commit/f7c328ee60e7b60821008384ed484850bdaeb1d9))


### Performance Improvements

* **database:** drop four requests indexes no live query uses ([#763](https://github.com/StartupBros/hov-router/issues/763)) ([600c761](https://github.com/StartupBros/hov-router/commit/600c76146568dd481d0fcb311c5e849c779db25f))
* **database:** drop three indexes that wider indexes already cover ([#751](https://github.com/StartupBros/hov-router/issues/751)) ([8c070ee](https://github.com/StartupBros/hov-router/commit/8c070ee7907004a50eb6e71756041964b6d1ad98))

## [4.0.0](https://github.com/StartupBros/hov-router/compare/v3.7.1...v4.0.0) (2026-11-05)


### ⚠ BREAKING CHANGES

* PostgreSQL support is removed. A `DATABASE_URL` starting with `postgres://` or `postgresql://` is refused at startup; v3.7.1 is the last release with PostgreSQL support. See "PostgreSQL support removed" in docs/hov-router-migration.md.

### Features

* **database:** name the database worker threads after their lanes ([#716](https://github.com/StartupBros/hov-router/issues/716)) ([db9da86](https://github.com/StartupBros/hov-router/commit/db9da86dad899bd0da8442ec414dbda070264568)), refs [#709](https://github.com/StartupBros/hov-router/issues/709) [#712](https://github.com/StartupBros/hov-router/issues/712)
* deliver member notices to a receiver as signed events ([#720](https://github.com/StartupBros/hov-router/issues/720)) ([8a0e571](https://github.com/StartupBros/hov-router/commit/8a0e571dd2450fb2400893273ec2466ef124505f)), refs [#691](https://github.com/StartupBros/hov-router/issues/691)
* deploy origin/main from any checkout and report the restart verdict in --check ([#727](https://github.com/StartupBros/hov-router/issues/727)) ([f137b5b](https://github.com/StartupBros/hov-router/commit/f137b5b86fcad8a6cb57c179c23144d22a0fcacd))
* **deploy:** overlap backend handoff so new requests skip the drain ([#612](https://github.com/StartupBros/hov-router/issues/612)) ([6b27a65](https://github.com/StartupBros/hov-router/commit/6b27a655d5be6b075a66cec847ba209fa789a1f3))
* drop PostgreSQL support; SQLite is the only database ([#723](https://github.com/StartupBros/hov-router/issues/723)) ([b6f4c8b](https://github.com/StartupBros/hov-router/commit/b6f4c8b4f0f0ef2bd83c5b0b6599b535cfb44d4b))
* **health:** report per-provider upstream reachability ([#704](https://github.com/StartupBros/hov-router/issues/704)) ([b61f781](https://github.com/StartupBros/hov-router/commit/b61f78104b65e23a2c3d7e479817604592a64a55))
* keep session-affinity pins across proxy restarts ([#661](https://github.com/StartupBros/hov-router/issues/661)) ([9193caf](https://github.com/StartupBros/hov-router/commit/9193caf7106683c0b5f8e21124fa2e0ba951f5e7)), refs [#516](https://github.com/StartupBros/hov-router/issues/516)
* post banked-reset member notices to a separate webhook ([#708](https://github.com/StartupBros/hov-router/issues/708)) ([55cbd09](https://github.com/StartupBros/hov-router/commit/55cbd09eed3481c4ae799abb3fce1f1160b2c75f))
* **proxy:** accept former route-profile ids as aliases ([#649](https://github.com/StartupBros/hov-router/issues/649)) ([e43c224](https://github.com/StartupBros/hov-router/commit/e43c224e2905f16eac1121f700d5c52ebb319346)), refs [#648](https://github.com/StartupBros/hov-router/issues/648)
* **proxy:** label /model picker rows with the model each route serves ([#617](https://github.com/StartupBros/hov-router/issues/617)) ([447f7dc](https://github.com/StartupBros/hov-router/commit/447f7dc7f864e0593baf6456befb88c793f800bd))
* **proxy:** let a Codex route pool follow a model line, not a catalog slot ([#635](https://github.com/StartupBros/hov-router/issues/635)) ([470b9db](https://github.com/StartupBros/hov-router/commit/470b9db977934d36e287d035568e35212cb47e43))
* **proxy:** let WebSearch helpers use the Anthropic subscription pool ([#646](https://github.com/StartupBros/hov-router/issues/646)) ([f36a730](https://github.com/StartupBros/hov-router/commit/f36a7308e788e884a0a157025579ce18c007b3e5)), refs [#644](https://github.com/StartupBros/hov-router/issues/644)
* **proxy:** opt-in subscription WebSearch helpers for exact route profiles ([#645](https://github.com/StartupBros/hov-router/issues/645)) ([767d5b4](https://github.com/StartupBros/hov-router/commit/767d5b4a597d8ce46f070c953a29507a14454ef4))
* **proxy:** record the serving process start in each routing summary ([#657](https://github.com/StartupBros/hov-router/issues/657)) ([6f2a6eb](https://github.com/StartupBros/hov-router/commit/6f2a6ebfaf9889d73486a9ca3bfbed26e66abc96))
* redeem banked resets from the dashboard ([#707](https://github.com/StartupBros/hov-router/issues/707)) ([26a62b8](https://github.com/StartupBros/hov-router/commit/26a62b892e845973c0f1f5a5b8040e2743bcc5d6)), refs [#691](https://github.com/StartupBros/hov-router/issues/691)
* show banked Codex resets on accounts and a fleet summary ([#697](https://github.com/StartupBros/hov-router/issues/697)) ([906ce60](https://github.com/StartupBros/hov-router/commit/906ce6075f383beb48415f73ab74a56b5633cf8e)), refs [#691](https://github.com/StartupBros/hov-router/issues/691) [#688](https://github.com/StartupBros/hov-router/issues/688)


### Bug Fixes

* **agents:** keep name and description when editing a CRLF agent file ([#706](https://github.com/StartupBros/hov-router/issues/706)) ([50e7e26](https://github.com/StartupBros/hov-router/commit/50e7e2649be89cc09b244f4b8bcd8d1217c0e321))
* **agents:** load agent files with CRLF line endings ([#705](https://github.com/StartupBros/hov-router/issues/705)) ([c391be3](https://github.com/StartupBros/hov-router/commit/c391be3c09d2a2b4b9a00906a8fccddc20ba1433))
* **cli:** open the database with the server's config under --serve ([#624](https://github.com/StartupBros/hov-router/issues/624)) ([6771aa5](https://github.com/StartupBros/hov-router/commit/6771aa5261987cd39aea4198021d869251c7ad7c))
* **dashboard:** accessibility, contrast and copy pass across every page ([#690](https://github.com/StartupBros/hov-router/issues/690)) ([cd3fa7b](https://github.com/StartupBros/hov-router/commit/cd3fa7b6e288dadca87a18a406076f111a166138))
* **dashboard:** close the remaining accessibility gaps from the UI pass ([#699](https://github.com/StartupBros/hov-router/issues/699)) ([5d26b67](https://github.com/StartupBros/hov-router/commit/5d26b670ba7e1151a277d3e6945a007b88e329b2))
* **dashboard:** explain banked resets in plain words ([#702](https://github.com/StartupBros/hov-router/issues/702)) ([b866d22](https://github.com/StartupBros/hov-router/commit/b866d22645f28711ccef4da1ca362e45fe3c4d5f)), refs [#691](https://github.com/StartupBros/hov-router/issues/691)
* **dashboard:** keep account names whole on phone-width cards ([#703](https://github.com/StartupBros/hov-router/issues/703)) ([b25c5cd](https://github.com/StartupBros/hov-router/commit/b25c5cd63cb835b698c6ab954173a7836025d5ed))
* **dashboard:** report the later reset when both quota windows are spent ([#656](https://github.com/StartupBros/hov-router/issues/656)) ([a294b57](https://github.com/StartupBros/hov-router/commit/a294b57a158a0598f601e74e9cbd71f170254c08))
* **dashboard:** show a retrying "can't reach" view instead of an empty page ([#599](https://github.com/StartupBros/hov-router/issues/599)) ([56d6259](https://github.com/StartupBros/hov-router/commit/56d625900c4ea4f118cba23542a9d8419969410a)), refs [#598](https://github.com/StartupBros/hov-router/issues/598)
* **dashboard:** show the router's real health in System Status ([#701](https://github.com/StartupBros/hov-router/issues/701)) ([7763a40](https://github.com/StartupBros/hov-router/commit/7763a40138edaea20c55116072c497033ed53f70))
* **dashboard:** stop account rows overflowing the accounts page ([#687](https://github.com/StartupBros/hov-router/issues/687)) ([4c0f4af](https://github.com/StartupBros/hov-router/commit/4c0f4afa17a67f64a6b4a8cd68db5c518b1a0a39))
* **dashboard:** stop waiting on full statistics to load any page ([#601](https://github.com/StartupBros/hov-router/issues/601)) ([e7a5079](https://github.com/StartupBros/hov-router/commit/e7a50799f1aaa230e5bf33ba0880d53f705be66f)), refs [#480](https://github.com/StartupBros/hov-router/issues/480)
* **database:** give the accounts page its own off-thread reader ([#712](https://github.com/StartupBros/hov-router/issues/712)) ([337c80c](https://github.com/StartupBros/hov-router/commit/337c80cd96778962fa9008e34a37a7aa000fd163))
* **database:** make the maintenance tick refresh planner statistics ([#603](https://github.com/StartupBros/hov-router/issues/603)) ([c4276bd](https://github.com/StartupBros/hov-router/commit/c4276bd2278cb44799d794c2ad911eec9d7f0e17)), refs [#480](https://github.com/StartupBros/hov-router/issues/480)
* **database:** open maintenance-worker connections without creating the database file ([#674](https://github.com/StartupBros/hov-router/issues/674)) ([4fc370d](https://github.com/StartupBros/hov-router/commit/4fc370d718c22c2d9f0816542b9edf4b6f9fa3ce))
* **database:** pace retention sweeps so they stop freezing the event loop ([#619](https://github.com/StartupBros/hov-router/issues/619)) ([e052aa9](https://github.com/StartupBros/hov-router/commit/e052aa9079f4a8c0fc323132ca9becf6d62189a1))
* **database:** read window token totals from the account index ([#722](https://github.com/StartupBros/hov-router/issues/722)) ([2249d5a](https://github.com/StartupBros/hov-router/commit/2249d5a13bafb9fefadaa4c8edcab9c75ea7d5a6)), refs [#710](https://github.com/StartupBros/hov-router/issues/710)
* **guard:** answer dashboard reads during a deploy drain ([#605](https://github.com/StartupBros/hov-router/issues/605)) ([6fc0c4e](https://github.com/StartupBros/hov-router/commit/6fc0c4ec841817fbe6d1595c7722a21b78449688)), refs [#604](https://github.com/StartupBros/hov-router/issues/604)
* **guard:** reserve no body-reader budget for bodyless requests ([#615](https://github.com/StartupBros/hov-router/issues/615)) ([51c23ee](https://github.com/StartupBros/hov-router/commit/51c23ee9a357aa50c74d68c2e9c450923de697ba))
* name the installed command in runtime hints ([#632](https://github.com/StartupBros/hov-router/issues/632)) ([86a432d](https://github.com/StartupBros/hov-router/commit/86a432d1ae2ecb652cef646ee77cb036d85ec112)), refs [#584](https://github.com/StartupBros/hov-router/issues/584)
* **openai-formats:** keep translated streams alive during long tool calls ([#636](https://github.com/StartupBros/hov-router/issues/636)) ([da46c93](https://github.com/StartupBros/hov-router/commit/da46c93c1ef13c53654ae7740e7d585ccfb11162))
* port database, config, CLI and dashboard fixes from the fork network ([#683](https://github.com/StartupBros/hov-router/issues/683)) ([930c1fa](https://github.com/StartupBros/hov-router/commit/930c1faf6f264973a6108911276ea898d14275d7))
* port proxy and provider fixes from better-ccflare forks ([#682](https://github.com/StartupBros/hov-router/issues/682)) ([5a66cc6](https://github.com/StartupBros/hov-router/commit/5a66cc65b1fadc46cd0e855fbc8dd1d813fafb7d))
* **proxy:** keep the admitted model when Codex retries without cache_control ([#672](https://github.com/StartupBros/hov-router/issues/672)) ([e0b5a98](https://github.com/StartupBros/hov-router/commit/e0b5a98e126a464b71d77c87cf150e557081fec1)), refs [#670](https://github.com/StartupBros/hov-router/issues/670)
* **proxy:** keep usage state until every live-stream timer has fired ([#641](https://github.com/StartupBros/hov-router/issues/641)) ([a238c5d](https://github.com/StartupBros/hov-router/commit/a238c5d34ace3f7a1d8925fd60bae46b856f2d93)), refs [#634](https://github.com/StartupBros/hov-router/issues/634)
* **proxy:** name the vendor and say what each /model row does in plain words ([#630](https://github.com/StartupBros/hov-router/issues/630)) ([f37eac2](https://github.com/StartupBros/hov-router/commit/f37eac266871dff00d2d80d832ef0ff7ef4a4486))
* **proxy:** stop an empty exact-account header from failing quality routes ([#673](https://github.com/StartupBros/hov-router/issues/673)) ([2354bbf](https://github.com/StartupBros/hov-router/commit/2354bbf420966caf1e0ecb97666d059a809912f4))
* **proxy:** stop translated pings from extending the pre-commit idle deadline ([#639](https://github.com/StartupBros/hov-router/issues/639)) ([0377771](https://github.com/StartupBros/hov-router/commit/03777716b5f4f6640b8c0a0022ae00c870222917))
* **proxy:** tell clients not to retry force-route 503s that cannot clear ([#627](https://github.com/StartupBros/hov-router/issues/627)) ([c08b021](https://github.com/StartupBros/hov-router/commit/c08b0219976058219a87f30b2ca25d0e8b314832))
* **server:** name the SQL behind main-thread event-loop stalls ([#616](https://github.com/StartupBros/hov-router/issues/616)) ([f54b3f7](https://github.com/StartupBros/hov-router/commit/f54b3f702a6cc6f09e3e18a703b956880eeee638))
* **server:** say whether an event-loop stall was CPU, disk or swap ([#621](https://github.com/StartupBros/hov-router/issues/621)) ([39803c3](https://github.com/StartupBros/hov-router/commit/39803c3c404018427eedb28d2d1cb93a50eecbc0))


### Security

* owner-only database and config files, no credential headers in stored payloads ([#681](https://github.com/StartupBros/hov-router/issues/681)) ([f7a3b93](https://github.com/StartupBros/hov-router/commit/f7a3b93db1b9051b6975aacccb81613bfe02cfa6))


### Improvements

* **http-api:** share the event-bus SSE stream handler ([#652](https://github.com/StartupBros/hov-router/issues/652)) ([3cf1222](https://github.com/StartupBros/hov-router/commit/3cf1222c01fe0b7ed078c888775b8b8881214a74)), refs [#651](https://github.com/StartupBros/hov-router/issues/651)
* remove the auto-refresh window-opening probes ([#725](https://github.com/StartupBros/hov-router/issues/725)) ([e784510](https://github.com/StartupBros/hov-router/commit/e784510d88573fb4f069bee206e7b83840b11d4f))
* retire the wstack name from new builds and installs ([#610](https://github.com/StartupBros/hov-router/issues/610)) ([6a5fe8d](https://github.com/StartupBros/hov-router/commit/6a5fe8db96015c888fdd60aa8c559fc888b87513)), refs [#578](https://github.com/StartupBros/hov-router/issues/578)


### Performance Improvements

* **analytics:** read only the selected window for model performance ([#602](https://github.com/StartupBros/hov-router/issues/602)) ([6910a8b](https://github.com/StartupBros/hov-router/commit/6910a8b12f3ac5b525165186b2246a93860b6752)), refs [#480](https://github.com/StartupBros/hov-router/issues/480)
* **database:** commit SQLite writes on a worker thread ([#686](https://github.com/StartupBros/hov-router/issues/686)) ([2573e07](https://github.com/StartupBros/hov-router/commit/2573e07820951bfde10e0dd62f062d890ec8935c))
* **database:** keep the integrity-check schedule across backend restarts ([#628](https://github.com/StartupBros/hov-router/issues/628)) ([f46c460](https://github.com/StartupBros/hov-router/commit/f46c46006be27d39f087b28d4e116d844266c120))
* **database:** run the Codex attribution reads on the reader thread ([#625](https://github.com/StartupBros/hov-router/issues/625)) ([76bffae](https://github.com/StartupBros/hov-router/commit/76bffae2349b7e1077ac5061b12c567a8189b492))
* **database:** run the heavy dashboard and stats reads on a reader thread ([#623](https://github.com/StartupBros/hov-router/issues/623)) ([f43b1f8](https://github.com/StartupBros/hov-router/commit/f43b1f8e92bf8710454762264fa5799ec8b54d4d))
* **database:** run vacuum chunks at the configured synchronous mode ([#669](https://github.com/StartupBros/hov-router/issues/669)) ([9a316ef](https://github.com/StartupBros/hov-router/commit/9a316ef46f6bf216fb63099fe99dde2725001557))
* **http-api:** read stored Codex usage payloads on the reader thread ([#675](https://github.com/StartupBros/hov-router/issues/675)) ([2395c74](https://github.com/StartupBros/hov-router/commit/2395c7439391d60df18c4d4b85dc06968f44a578))

## [3.7.1](https://github.com/StartupBros/hov-router/compare/v3.7.0...v3.7.1) (2026-10-25)


### Bug Fixes

* **auth:** keep the router up when a key-usage write fails, and authenticate each request once ([#596](https://github.com/StartupBros/hov-router/issues/596)) ([eba1d16](https://github.com/StartupBros/hov-router/commit/eba1d16b28de2a45763a282dbc7ed81717fdea80))

## [3.7.0](https://github.com/StartupBros/hov-router/compare/v3.6.2...v3.7.0) (2026-10-25)


### Features

* **dashboard:** give HoV Router its own favicon and sidebar mark ([#592](https://github.com/StartupBros/hov-router/issues/592)) ([6f1b655](https://github.com/StartupBros/hov-router/commit/6f1b655cae18ccf9a540fb3e4e10538918e14a23)), refs [#584](https://github.com/StartupBros/hov-router/issues/584)
* **docker:** build HoV Router images from source ([#591](https://github.com/StartupBros/hov-router/issues/591)) ([6a76fc1](https://github.com/StartupBros/hov-router/commit/6a76fc190fc02e52b073388c4fd04020e993c288)), refs [#584](https://github.com/StartupBros/hov-router/issues/584)


### Bug Fixes

* name HoV Router in remaining runtime and dashboard messages ([#585](https://github.com/StartupBros/hov-router/issues/585)) ([c10f346](https://github.com/StartupBros/hov-router/commit/c10f34642f1ebdc5cc6f335f3e0cdebae60da102))

## [3.6.2](https://github.com/StartupBros/hov-router/compare/v3.6.1...v3.6.2) (2026-10-20)


### Bug Fixes

* **ci:** isolate verifier HOME from release assets ([a895cb3](https://github.com/StartupBros/hov-router/commit/a895cb3bb81bb0a72e9da49082ff857e4a4e3a45)), refs [#559](https://github.com/StartupBros/hov-router/issues/559)

## [3.6.1](https://github.com/StartupBros/hov-router/compare/v3.6.0...v3.6.1) (2026-10-20)


### Bug Fixes

* **ci:** allow validation to see unpublished release drafts ([bc74514](https://github.com/StartupBros/hov-router/commit/bc74514166c53a92e32106517a13f6e91862ad61))

## [3.6.0](https://github.com/StartupBros/hov-router/compare/v3.5.78...v3.6.0) (2026-10-20)


### chore

* prepare the first Router release ([eb5c918](https://github.com/StartupBros/hov-router/commit/eb5c9187e4bff4bff21c0ab35cce06cdc04588c7)), refs [#559](https://github.com/StartupBros/hov-router/issues/559)
