# Changelog

## [3.8.0](https://github.com/StartupBros/hov-router/compare/v3.7.1...v3.8.0) (2026-10-31)


### Features

* **deploy:** overlap backend handoff so new requests skip the drain ([#612](https://github.com/StartupBros/hov-router/issues/612)) ([6b27a65](https://github.com/StartupBros/hov-router/commit/6b27a655d5be6b075a66cec847ba209fa789a1f3))
* keep session-affinity pins across proxy restarts ([#661](https://github.com/StartupBros/hov-router/issues/661)) ([9193caf](https://github.com/StartupBros/hov-router/commit/9193caf7106683c0b5f8e21124fa2e0ba951f5e7)), refs [#516](https://github.com/StartupBros/hov-router/issues/516)
* **proxy:** accept former route-profile ids as aliases ([#649](https://github.com/StartupBros/hov-router/issues/649)) ([e43c224](https://github.com/StartupBros/hov-router/commit/e43c224e2905f16eac1121f700d5c52ebb319346)), refs [#648](https://github.com/StartupBros/hov-router/issues/648)
* **proxy:** label /model picker rows with the model each route serves ([#617](https://github.com/StartupBros/hov-router/issues/617)) ([447f7dc](https://github.com/StartupBros/hov-router/commit/447f7dc7f864e0593baf6456befb88c793f800bd))
* **proxy:** let a Codex route pool follow a model line, not a catalog slot ([#635](https://github.com/StartupBros/hov-router/issues/635)) ([470b9db](https://github.com/StartupBros/hov-router/commit/470b9db977934d36e287d035568e35212cb47e43))
* **proxy:** let WebSearch helpers use the Anthropic subscription pool ([#646](https://github.com/StartupBros/hov-router/issues/646)) ([f36a730](https://github.com/StartupBros/hov-router/commit/f36a7308e788e884a0a157025579ce18c007b3e5)), refs [#644](https://github.com/StartupBros/hov-router/issues/644)
* **proxy:** opt-in subscription WebSearch helpers for exact route profiles ([#645](https://github.com/StartupBros/hov-router/issues/645)) ([767d5b4](https://github.com/StartupBros/hov-router/commit/767d5b4a597d8ce46f070c953a29507a14454ef4))
* **proxy:** record the serving process start in each routing summary ([#657](https://github.com/StartupBros/hov-router/issues/657)) ([6f2a6eb](https://github.com/StartupBros/hov-router/commit/6f2a6ebfaf9889d73486a9ca3bfbed26e66abc96))


### Bug Fixes

* **cli:** open the database with the server's config under --serve ([#624](https://github.com/StartupBros/hov-router/issues/624)) ([6771aa5](https://github.com/StartupBros/hov-router/commit/6771aa5261987cd39aea4198021d869251c7ad7c))
* **dashboard:** report the later reset when both quota windows are spent ([#656](https://github.com/StartupBros/hov-router/issues/656)) ([a294b57](https://github.com/StartupBros/hov-router/commit/a294b57a158a0598f601e74e9cbd71f170254c08))
* **dashboard:** show a retrying "can't reach" view instead of an empty page ([#599](https://github.com/StartupBros/hov-router/issues/599)) ([56d6259](https://github.com/StartupBros/hov-router/commit/56d625900c4ea4f118cba23542a9d8419969410a)), refs [#598](https://github.com/StartupBros/hov-router/issues/598)
* **dashboard:** stop waiting on full statistics to load any page ([#601](https://github.com/StartupBros/hov-router/issues/601)) ([e7a5079](https://github.com/StartupBros/hov-router/commit/e7a50799f1aaa230e5bf33ba0880d53f705be66f)), refs [#480](https://github.com/StartupBros/hov-router/issues/480)
* **database:** make the maintenance tick refresh planner statistics ([#603](https://github.com/StartupBros/hov-router/issues/603)) ([c4276bd](https://github.com/StartupBros/hov-router/commit/c4276bd2278cb44799d794c2ad911eec9d7f0e17)), refs [#480](https://github.com/StartupBros/hov-router/issues/480)
* **database:** open maintenance-worker connections without creating the database file ([#674](https://github.com/StartupBros/hov-router/issues/674)) ([4fc370d](https://github.com/StartupBros/hov-router/commit/4fc370d718c22c2d9f0816542b9edf4b6f9fa3ce))
* **database:** pace retention sweeps so they stop freezing the event loop ([#619](https://github.com/StartupBros/hov-router/issues/619)) ([e052aa9](https://github.com/StartupBros/hov-router/commit/e052aa9079f4a8c0fc323132ca9becf6d62189a1))
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
* retire the wstack name from new builds and installs ([#610](https://github.com/StartupBros/hov-router/issues/610)) ([6a5fe8d](https://github.com/StartupBros/hov-router/commit/6a5fe8db96015c888fdd60aa8c559fc888b87513)), refs [#578](https://github.com/StartupBros/hov-router/issues/578)


### Performance Improvements

* **analytics:** read only the selected window for model performance ([#602](https://github.com/StartupBros/hov-router/issues/602)) ([6910a8b](https://github.com/StartupBros/hov-router/commit/6910a8b12f3ac5b525165186b2246a93860b6752)), refs [#480](https://github.com/StartupBros/hov-router/issues/480)
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
