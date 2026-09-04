# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/) (pre-1.0: minor = features, patch = fixes).

## [Unreleased]

### Added
- **Claude Fable 5.1 and Mythos 5.1** (released 2026-09-01). The `fable` tier now resolves to `claude-fable-5-1`, which supersedes Fable 5 (still priced, now a legacy model). The `fable` substring meant 5.1 family-resolved at the right $10/$50 base the day it shipped — the fallback doing its job — but two things still needed rows: `claude-mythos-5-1` matches no family and would have priced at *zero*, and both 5.1 models bill **cache reads at 2.5% of input**, not the standard 10%.
- **Per-model cache-read rates** (`ModelPricing.cacheRead`, resolved via `cacheReadRate()`). `CACHE_READ_RATE` (10%) is now the default rather than a universal. On a cache-heavy client like Claude Code the cache-read line is most of the input bill, so applying 10% to Fable 5.1 overstated that component roughly 4x. The field is optional, so every existing pricing entry and every user `pricing` override keeps the standard rate — absent means standard, never free.

### Changed
- **Savings can read negative again.** 0.3.2 clamped `savedCents` at zero (`countedSavings()`); that hid the turns routing lands *above* the baseline, which is exactly the signal [#61](https://github.com/Serhii-Leniv/claude-router/issues/61) fixed the baseline to expose. The clamp is gone; a sub-cent loss renders as a neutral `$0.00`, a real one as `extra`.
- **0.3.2 and 0.3.3 were published from a side branch** and are now merged into `master` (tagged `v0.3.2`/`v0.3.3` at their published commits), so every npm version is reproducible from git again.

### Added
- **Orchestration plugin for Claude Code** (`plugin/`, installed by `claude-router install` through the `claude` CLI; `--no-policy` skips it; `claude-router policy install|status|uninstall` manages it alone). Five role agents — `claude-router:recon` (haiku), `builder` and `batch` (sonnet), `gate` and `audit` (opus, fresh-context review before and after risky work) — each opening with the marker the proxy pins on, plus a 2 KB session policy. Hooks are Node scripts, so the plugin works on Windows. On SessionStart it prints one line saying whether the proxy is actually enforcing (`claude-router: enforcing — session pinned to opus, subagent roles routed by the proxy`) or that tiers are advisory because the proxy is down or not routing. A SubagentStart hook reports each subagent's agent type to `POST /api/agents`, which is what lets the `agents` config mapping pin third-party agents by name. `/health` now reports `version`, `sessionModel` and `roleRouting`; `doctor` warns when the plugin is not installed.
- **Subagent role routing** (`src/roles.ts`, on by default under `--force-route`; `--role-routing off` to disable). A Claude Code subagent whose agent definition opens with `<!-- claude-router:role=recon -->` (or `builder`, `batch`, `gate`, `audit`) is pinned to that role's tier — haiku for reconnaissance, sonnet for implementation, opus for fresh-context review — and skips the classifier (and hybrid mode's Haiku call). Config `roles` overrides a role's tier (`{ "builder": "opus" }`); `agents` pins third-party agents by Claude Code agent type. Without a marker, a read-only agent the client already runs on haiku is confirmed at haiku instead of being floored to sonnet; shape never demotes. `x-router-role` names the deciding role; every subagent row in the ledger carries `subagent`, `role` and `roleSource`. Marker detection is a block-prefix test on the system prompt, never a search.
- **`x-router-reason`** — every routed response (streaming too) names the gate that decided the tier: `agentic:mid-loop`, `single-turn:short mechanical transform`, `session:coordinator-pinned`, `ai:level-2`. The same string lands in `history.jsonl` (`reason`), the verbose log, and a new dashboard column. It was computed on every request since 0.2.2 and reached none of them.
- The `fable` tier shows in the startup banner (marked opt-in) and has its own terminal colour.
- **Releases are published by CI, with provenance.** A `v*` tag on `master` whose version matches `package.json` runs the tests, publishes with `npm publish --provenance`, and creates the GitHub release from the CHANGELOG section. A tag on a side branch is refused — the failure mode that produced 0.3.2/0.3.3. `RELEASING.md` has the checklist.
- **The pricing table has a dated claim.** `PRICING_LAST_CHECKED` in `src/models.ts` records when the table was last verified; a weekly workflow opens one issue once it is older than 60 days, and `claude-router doctor` warns past 90. Not a failing test, so it cannot go red on an unrelated PR.
- **`claude-router help` is rendered from the options table.** `--session-model`, `--upstream` and `--restore-delegation` were live flags with no help line because the text was a second hand-written copy; a flag now cannot exist without one, and a test checks every flag appears.

### Fixed
- **A 429 on opus no longer walks the request onto Fable.** `executeRoute`'s rate-limit walk-up ran to the end of `TIER_ORDER`, past `ESCALATION_CEILING`, so a library caller on the default `fallback: true` could be moved from a rate-limited opus route onto a $10/$50 model without asking. The walk-up now stops where escalation stops; an explicit fable pin still runs once.
- **`routing.haikuMax` / `opusMin` are now actually ignored.** The startup warning said they did nothing, but the AI classifier still mapped its 1–3 verdict through them, so removing "a no-op" from the config changed routing in `ai` and `hybrid` mode. The verdict maps to a tier directly (1→haiku, 2→sonnet, 3→opus) and carries a `reason` (`ai:level-N`, `ai:unparsed`), so AI decisions are as auditable as gate decisions.
- **`/health.requests` and the statusline `#N` count every request.** They read the length of the bounded in-memory history, so the number stopped at ~1000 and then oscillated as batches were trimmed. A monotonic per-process counter feeds both.
- **`getVersion()` says why when it cannot read `package.json`** instead of silently reporting `unknown` in the banner, `/health` and bug reports.
- **`routing.allowFable` is a typed option.** It only worked by accident of the proxy spreading untyped config; `RoutingTuning` and `ClassifyOptions` now declare it, so library callers can set it and the AI-outage fallback keeps it.
- **Requests outside `/v1` no longer 404** ([#63](https://github.com/Serhii-Leniv/claude-router/issues/63), thanks @smoochy). Passthrough was scoped to `/v1/*`, so every other path fell through to a local 404 instead of reaching the origin — including `HEAD /api/hello`, which Claude Code probes on startup, and `/api/organizations`. Passthrough is now a catch-all registered after the router's own endpoints, so `/health`, `/statusline`, `/api/last-route` and `/dashboard` still answer locally and everything else forwards verbatim, tagged `x-router-tier: passthrough`. Non-`anthropic` providers still return a clear 404 rather than forwarding.
- **Sonnet 5 is priced at its real $2/$10, so savings figures stop overstating what routing saved.** Sonnet 5's $2/$10 launched as introductory pricing through 2026-08-31, and we deliberately priced the announced $3/$15 successor so the numbers would not jump when it expired. It never expired: Anthropic made $2/$10 standard and cancelled the 2026-09-01 increase. The sonnet tier is the savings baseline, so every `savedCents`, every *Lifetime Saved* card and every `x-router-saved-cents` header was computed against a baseline 50% too expensive — and because a saving is a **difference**, the error amplifies rather than passing through: on a representative Claude Code turn (110K cached prefix, 800 in, 1200 out) a haiku route reported $0.0356 where the truth is $0.0178, exactly **2x**. Guessing the direction of a scheduled price change turns out to be the same bug as not tracking prices at all. Existing `history.jsonl` events keep the figures they were written with (they are folded, not recomputed); new events use the corrected rate, so a lifetime total will straddle both until you archive the ledger.
- **Sonnet 4, 4.5 and 4.6 keep $3/$15 instead of following the family rate down.** They were free-riding on the family fallback while it said $3/$15; Sonnet 5's price cut made the whole prior generation divergent in a single move, which would otherwise have understated every legacy-Sonnet call by a third. Same shape as legacy Opus, one generation down.
- **Savings are measured against the model the client asked for, not `defaultModel`.** The baseline was a fixed config constant (Sonnet), so opus-pinned Claude Code traffic was priced against Sonnet and the ledger reported a *loss* on runs that genuinely saved money — a measured sandbox session spent $3.34 against a $4.23 all-opus counterfactual, a 21% saving the dashboard rendered as −$0.80. The proxy now takes the baseline from the request's own `model` field, falling back to `defaultModel` when the client named nothing usable (absent, `"auto"`, or unpriced). A routed-down request books the real saving; a request served on the model it asked for books exactly `$0.00`; routing *up* still books an honest negative. Existing `history.jsonl` records keep their original figures — lifetime totals reflect the new baseline only for events recorded from here on.

## [0.3.3] — 2026-07-26

### Fixed
- **`--restore-delegation` reported "not present" while it was working.** The one-per-process report fired on whichever request came first, and against live Claude Code 2.1.220 that is a tool-less meta-call with a ~1.3K system prompt which legitimately carries no payload — the real coordinator turn (31 tools, ~10.3K prompt, both lines present) arrives second. So the first and only line an operator saw was `the known injected lines were not present`, while the strip was in fact removing both lines from every coordinator turn. The no-match report is now gated on the request carrying tools, the same structural agentic/meta split the session pin already makes; a match is still reported the moment it happens. Verified on real traffic through the proxy, before and after. Behaviour of the strip itself is unchanged — only what gets printed.

## [0.3.2] — 2026-07-26

### Added
- **The `opus` tier resolves to Opus 5** (`claude-opus-5`), which ships at the same $5/$25 as Opus 4.8, so the promotion moves no cost figure. `normalizeParamsForTier` drops `thinking:{type:'disabled'}` when `output_config.effort` is `xhigh`/`max`, a pair Opus 5 rejects.
- **`--restore-delegation` — put subagents back within reach** ([#55](https://github.com/Serhii-Leniv/claude-router/issues/55), thanks @smoochy). Claude Code 2.1.219+ injects a system-prompt section telling the model not to spawn subagents unless explicitly asked. Verified against the shipped 2.1.220 binary, it is gated on a **model capability** rather than user config — `opus_5_prompt_bundle`, which of every `capabilities:[…]` array in that binary exactly one model carries: `claude-opus-5` — with a killswitch that defaults off and no settings key, CLI flag or env var to override it ([anthropics/claude-code#80988](https://github.com/anthropics/claude-code/issues/80988)). That silently breaks `sessionModel`: the pin exists so *subagents* carry the volume on cheaper tiers, and with delegation suppressed the pinned tier does every turn itself, costing more than not pinning. The new flag removes those lines from the system prompt on routed requests. **Off by default** — this is the one place the proxy edits a prompt — and never silent: the banner shows it, and one log line per process reports whether the payload was actually found, so a vendor rewrite surfaces instead of looking like success. The match is whole-line and exact, inside `system` only: a substring or regex rule would strip text out of a user's own documentation that merely quotes the line, which is the failure mode `latestUserText` already documents. Removal is deterministic, so the edited prefix pays one cache write and is warm from the second request on.

### Changed
- **Savings are counted, never subtracted** (`countedSavings()`). `baseline − actual` goes negative whenever routing lands *above* the baseline, and reporting that signed delta made the ledger read as if the router had spent the user's money — one opus call cancelled out dozens of haiku wins and the dashboard's "saved" card went red. A route at or above the baseline now contributes **0**. The clamp is per event, never on a total, and lives at both seams (`computeRouteCost` and `foldOutcome`) so a `history.jsonl` written before the rule folds to the same lifetime figure as a fresh one. Consequence to know: over-routing no longer shows up as negative savings — read the tier distribution and the cost card for that.

### Fixed
- **`sessionModel` no longer pins Claude Code's meta-calls to the top tier.** The pin read "no `x-claude-code-agent-id` header" as "coordinator", but Claude Code's session-title and summary calls arrive without that header too — so `--session-model opus` sent them to Opus, paying the top tier to name a session (these were 29% of requests on the wire corpus). The pin now also requires the request to carry tools, which every real coordinator turn does and the meta-calls never do. Measured against live Claude Code v2.1.220: the title call was `opus (pinned)` before and `sonnet` after, with the coordinator still pinned and subagents still routed by evidence.

## [0.3.1] — 2026-07-25

### Added
- **`sessionModel` — pin the Claude Code coordinator session to a tier** ([#55](https://github.com/Serhii-Leniv/claude-router/issues/55), thanks @smoochy). Set `--session-model opus` (or `"sessionModel": "opus"` in `config.json`) to keep Claude Code's main interactive session on one tier — a large context window with no early compaction — while tasks and subagents still route down by evidence. Coordinator vs subagent is told apart by the gateway protocol's `x-claude-code-agent-id` header, which Claude Code sets only on subagent requests, so it works even when subagents inherit the main model. Only effective under `--force-route` (the startup banner flags when it isn't); a config typo naming an unknown tier degrades to normal routing rather than sending the API `model: undefined`. Verified against live Claude Code v2.1.219.

### Fixed
- Docs no longer imply `defaultModel` is a `config.json` option — it is a library-only field and only sets the savings baseline, never the routed model. Use `sessionModel` to influence routing ([#55](https://github.com/Serhii-Leniv/claude-router/issues/55)).

## [0.3.0] — 2026-07-23

Production-hardening release from a full three-angle audit (core library, proxy/CLI, packaging).

> ⚠️ **Breaking:** `router.stream()` is now async. The old form returned a Proxy that broke `for await` and `.on()` chaining and could crash the host process with an unhandled rejection — no working code can depend on it. Migration is one `await`:
> ```ts
> const { stream, meta } = await router.stream({ ... });
> for await (const event of stream) { /* real SDK MessageStream */ }
> ```

### Changed
- **`stream()` returns `Promise<StreamResult>` (breaking).** Classification is awaited first, then the caller gets the untouched SDK `MessageStream` — `for await`, `.on()` chaining, and `.finalMessage()` all work as in the plain SDK. `meta` still resolves after the stream completes; it is pre-marked handled, so a caller that ignores it can no longer crash the process via `unhandledRejection` when a stream errors. Also drops the deep import of `@anthropic-ai/sdk/lib/MessageStream.js` (internal SDK layout) for a type derived from the client surface.

### Security
- **Removed wildcard CORS (breaking for cross-origin browser reads).** The proxy served `Access-Control-Allow-Origin: *` on every route, letting any webpage in the operator's browser POST `/v1/messages` to localhost and read the response — with `bedrock`/`vertex` that spends the operator's cloud credentials with no authentication. No supported consumer needs CORS (the dashboard is same-origin; CLI/statusline use Node fetch). A test pins the header's absence.
- The non-loopback bind warning now also fires for the `anthropic` provider — an exposed proxy is an open, unauthenticated relay regardless of provider.

### Fixed
- **Streaming failures get honest status codes.** Pre-stream errors (401 auth, 400 validation, connection failures) previously surfaced as `200 OK` carrying an SSE `event: error` frame; the first stream event is now awaited before headers are committed, so they map to their real HTTP status like the non-streaming path. Connection errors map to 502 instead of silently becoming 200 (the SDK's `APIConnectionError` has no `status`).
- **Mid-stream failures no longer vanish from the books.** A stream that dies after headers are sent still emits the SSE error frame, and is now recorded with an `error` field; `stats` shows an `Errors` row and the money totals exclude the placeholder zeros. Legacy history lines are unaffected.
- **`executeRoute` defensive gaps.** An unknown tier now throws a typed error instead of sending the API `model: undefined`; a failed escalation retry (e.g. the escalated tier is rate-limited) serves the truncated-but-real original response instead of discarding it and re-walking the tiers; the exhausted-loop path can no longer `throw undefined`.
- **Port conflicts fail cleanly.** `EADDRINUSE`/`EACCES` on startup print an actionable message and exit 1 instead of an uncaught stack trace.
- **`restart` with no daemon state warns** that the previous flags (e.g. `--force-route`) are not carried over, instead of silently restarting with defaults.
- `claude-router stats` no longer renders a signed zero like `-$0.00` or `extra $0.00` for sub-cent savings; they now show a neutral `$0.00` ([#38](https://github.com/Serhii-Leniv/claude-router/issues/38))
- **`files` no longer sweeps all of `assets/` into the published package.** The entry was the bare directory, so `npm pack` picked up anything sitting there — including files not tracked in git, which meant the tarball could differ between machines. A 147kB promo image was caught on its way into 0.2.2 this way. Narrowed to `assets/claude-router.svg`, the only asset the README actually references.

### Added
- **`RouterConfig.logger`** — inject a warn sink (or `{ warn: () => {} }` to silence) for the library's warnings (unpriced models, dead config keys); embedders no longer get unconditional `console.warn` from library code. Default behavior unchanged.
- **`proxy.log` rotation** — rolls over to `proxy.log.1` at 5 MiB on daemon start ([#49](https://github.com/Serhii-Leniv/claude-router/pull/49), thanks @Nitjsefnie); `logs` reads a bounded tail (256 KB) instead of the whole file into memory, and `logs -f` survives rotation instead of silently going quiet. `history.jsonl` is deliberately never rotated (it is the lifetime-savings ledger; archive it anytime — stats restart from zero, with a one-time nudge past 100 MB).
- **Graceful shutdown** — SIGINT/SIGTERM close the server with a capped drain (POSIX + Ctrl+C everywhere; Windows `TerminateProcess` remains abrupt by design, with nothing to flush).
- **Dashboard restyle** — new dark theme with live tier bars and card layout, building on the sign-correct savings cards: the lifetime card no longer renders a negative total as hardcoded green `$-0.00` ([#46](https://github.com/Serhii-Leniv/claude-router/pull/46)) and the Session Saved card keeps its 4-decimal precision with the same sign/tone rules ([#48](https://github.com/Serhii-Leniv/claude-router/pull/48), both thanks @Nitjsefnie).
- Dedicated tests for `executeRoute`, the CLI server-bind path, log rotation/tail reads, and the streaming failure modes (driven over real sockets).

### Known limitations (deferred, low severity)
- Passthrough forwards client headers verbatim (no allowlist); `~/.claude-router` files are not chmod-0600; a recycled PID on Windows could make `stop` signal an unrelated process; the dashboard "session" figures cap at the last 1000 events; `computeRouteCost`/`TIER_ORDER` and friends are not re-exported from the package entry; no ESLint/Prettier in the repo (typecheck only).

## [0.2.2] — 2026-07-21

> ⚠️ **Contains breaking changes despite being a patch release.** A `^0.2.1` range picks this up automatically. If you `import` the scoring helpers (`heuristicScore`, `heuristicScoreDetailed`, `scoreToTier`, `scoreToConfidence`, `HEURISTIC_WEIGHTS`), **your build will fail** — they no longer exist. Use `routeByEvidence` instead. If you only run the proxy or use `createRouter()`, nothing you call has changed, but routing decisions will differ: Sonnet is now the default and tier selection no longer runs on a keyword score. Pin `0.2.1` if you need the old behaviour while you migrate.

### Changed
- **Routing is evidence-based gates, not a keyword score (breaking).** The additive 0–100 scorer let unrelated weak signals sum into an expensive decision — `matrix` (+25) and `determinant` (+25) reached the Opus threshold on a beginner numpy question, with neither word being evidence of difficulty. Summing was the bug, so no weight tuning could fix it. Replaced by `routeByEvidence()`: **Sonnet is the default** and leaving it requires positive evidence; gates are **conjunctive**, so coincidental matches cannot combine; and the agentic and single-turn profiles are scored separately because they expose different signals. Agentic routing keys on **loop position** — is the last message a `tool_result` — which is the one routing signal with a measurement behind it. Every decision carries a `reason` (e.g. `agentic:mid-loop`), so routing is auditable rather than a number you have to trust. See [`research/`](research/).
- **Hybrid mode's score band is gone.** It now asks Haiku exactly when no gate fired and routing fell through to the default, instead of when a score landed between two thresholds.

### Added
- **Fable 5 as a fourth tier** ($10/$50), with per-tier pricing and parameter normalization — Fable rejects `thinking: {type: 'disabled'}`, so a client that disables thinking would 400 the moment it routed there. Reaching fable is **opt-in** (`routing.allowFable`) and requires depth *and* long-horizon signals together; the retry path never reaches it at all. Nothing measured supports predicting "super hard" from request text, and at 2x Opus a wrong promotion is the most expensive mistake the router can make.
- **Structural refusal detection** — `stop_reason: 'refusal'` (Opus 4.7+, Sonnet 5, Fable 5) is checked before the lexical phrase list. It is language-independent, so it covers every language without a single new pattern; measured coverage is 100% of responses against the lexical path's 0.4%. `REFUSAL_PATTERNS` stays as the fallback for older models and for soft refusals, which arrive as `end_turn`. Includes the German patterns from the earlier step toward #3. Closes #22.
- **`research/`** — the measurements behind the routing design: a literature review (23 sources, 14 confirmed / 11 refuted claims), a detector measurement over 35,314 real responses, a tier head-to-head, and a documented failed experiment. Scripts are reproducible and make no network calls.

### Fixed
- **`shouldRetry` could escalate away from Opus.** It gated "nowhere to escalate" on the end of `TIER_ORDER`, so appending fable silently made Opus retryable. Both it and `nextTier` now gate on `ESCALATION_CEILING`.

### Removed
- **The additive scorer's public surface (breaking).** `heuristicScore`, `heuristicScoreDetailed`, `scoreToTier`, `scoreToConfidence` and `HEURISTIC_WEIGHTS` are no longer exported — there is no score to expose. `routeByEvidence`, `isAgentic` and `isMidLoop` are exported instead. `routing.haikuMax` / `opusMin` / `hybridBand` are still accepted but are **no-ops**, kept so an existing config file loads rather than failing on upgrade.

### Known limitations
- **Fable on Bedrock / Vertex is not wired up.** Its inference-profile ID on those platforms is unverified, so the `fable` tier resolves to **Opus** there rather than risking a 404 — a request routed to fable on Bedrock or Vertex silently runs on Opus. This is inert while `allowFable` is off (the default). Set `tiers.fable` yourself, and verify it against your console, if you enable fable there.
- **The single-turn haiku gate is unmeasured.** Its conditions are a deliberate conservative choice, not a calibrated result — the experiment that would have calibrated them failed, and is documented rather than quietly dropped.

## [0.2.1] — 2026-07-13

### Fixed
- **Claude Code no longer over-routes to Opus (negative savings)** — with `--force-route`, the classifier scored Claude Code's constant harness (huge system prompt + ~15 tool definitions), not the user's task, pushing every request — even `"what is 2+2?"` — over the Opus threshold and costing *more* than the Sonnet baseline. The classifier now scores the **latest user turn** and caps the combined harness contribution, so routing follows the task. The `anthropic-beta` header is also forwarded on the **passthrough** path (routed calls already kept it).
- **count_tokens and other `/v1` endpoints no longer 404** — the proxy only served `POST /v1/messages`, so Claude Code and the VS Code extension 404'd on `/v1/messages/count_tokens` (and model listing). Non-routable `/v1/*` requests now forward verbatim to Anthropic (auth + `anthropic-beta` headers preserved), tagged `x-router-tier: passthrough`. Non-`anthropic` providers return a clear 404 for these.
- **`ANTHROPIC_BASE_URL` now reaches GUI-launched apps on macOS** — `install` also runs `launchctl setenv` (and `uninstall` runs `launchctl unsetenv`), so VS Code / the Claude Code extension started from Dock/Finder inherit the proxy URL without being relaunched from a terminal. The shell-rc export alone never reached them.
- **Proxy no longer 500s on an unexpected response shape** — `shouldRetry` read `response.content.filter(...)`; when the upstream response omitted `content`, the resulting `TypeError` was uncaught in the non-streaming handler and surfaced as a 500 (leaking the connection). Retry inspection now guards missing `content`/`usage` and skips retry instead of throwing.
- **`install` no longer fights the autostart supervisor for the port** — it started a detached daemon *and* registered a KeepAlive LaunchAgent (macOS) / `--now` systemd unit (Linux), so both bound port 4000 and the supervisor's instance looped forever on `EADDRINUSE`, flooding the log. Autostart is now registered first; the daemon is only started if the supervisor didn't already bring the proxy up, and the supervised PID is recorded so `status`/`stop`/`restart` keep working. Windows (login-only Run key) still starts a daemon at install time.
- **Routed non-streaming requests with large `max_tokens` no longer 500** — the SDK refuses a non-streaming `messages.create` whose implied duration exceeds 10 minutes unless an explicit timeout is set, throwing a base `AnthropicError` (no status). Claude Code sends large `max_tokens` on non-streaming requests, so this threw uncaught in `handleNonStreaming` (whose catch only handled `APIError`) and surfaced as a 500 with a leaked connection. The router now passes an explicit timeout to non-streaming creates, and the handler returns a structured error for any non-API `AnthropicError` instead of throwing.
- **Proxy no longer 500s on an unexpected response shape** — the non-streaming handler assumed a well-formed `Anthropic.Message`: `shouldRetry` read `response.content.filter(...)` and `computeCosts` read `response.usage.cache_read_input_tokens`. A response missing `content` or `usage` threw an uncaught `TypeError` (the handler's catch only handles `APIError`), surfacing as a 500 and leaking the connection — which could wedge the proxy. Retry inspection now guards missing `content`/`usage`, and cost math guards a missing/partial `usage`, so the request path can't crash on a malformed response.
- **Proxy no longer calls itself in an infinite loop** — the proxy builds its Anthropic SDK clients from the request credentials, and the SDK inherits `ANTHROPIC_BASE_URL` from the environment. Once that variable points at the proxy (the whole point of the install step, and required for GUI apps via `launchctl setenv`), every upstream call — routed requests *and* the hybrid classifier's Haiku call — went back to the proxy, which forwarded it to itself, endlessly (observed: tens of thousands of zero-token events, port saturation, client hangs). The proxy now pins `baseURL` to `https://api.anthropic.com` when constructing its clients, so it always reaches the real API regardless of the ambient `ANTHROPIC_BASE_URL`.
- **Routed requests keep the client's `anthropic-beta` header** — the routed path rebuilds the request through the SDK, which dropped the incoming `anthropic-beta` header. Bodies that depend on a beta feature (e.g. Claude Code's `context_management`) then 400 with `"Extra inputs are not permitted"`, because the field is present but its enabling beta flag is gone. The header is now relayed to both the non-streaming and streaming `messages.create`/`stream` calls (including escalated retries).

## [0.2.0] — 2026-07-02

### Added
- **Persistent savings history** — every routed request is appended to `~/.claude-router/history.jsonl`; new `claude-router stats [--json]` command shows lifetime savings with a per-day breakdown, and the dashboard gains *Lifetime Saved* / *Lifetime Requests* cards.
- **GitHub Actions CI** — full build + test suite on Ubuntu/Windows/macOS × Node 18/22.
- GitHub Pages landing site (`docs/`).

### Fixed
- **Cost accuracy with prompt caching** — cache reads now bill at 10% and cache writes at 125% of the input rate. Costs and savings were previously understated for clients that cache heavily (Claude Code does). Cache token counts surface in `RouteMeta`/route events.

## [0.1.0] — 2026-07-02

### Added
- **Cross-platform install** — `install`/`uninstall` now work on Windows (HKCU Run key + `setx`), macOS (LaunchAgent), and Linux (systemd user unit) on top of a detached background daemon with health-verified startup.
- New CLI commands: `start -d` (daemon), `restart`, `logs [-f]`, `init`, `doctor`, `--version`; unknown commands error with a suggestion instead of silently starting a server.
- Colored terminal output (zero dependencies), aligned status/start boxes, honest per-step ✓/✗ reporting.
- Classifier signals for tool use, tool results, and images; `routing` config block (`haikuMax`, `opusMin`, `hybridBand`, `aiTimeoutMs`, `classifyCacheSize`); hybrid mode AI-confirms signal-poor (e.g. non-English) prompts.
- AI classification cache (LRU) and per-credential SDK client cache in the proxy.

### Changed
- **Proxy binds to `127.0.0.1` by default** (new `--host` flag to override, with a warning for bedrock/vertex). Previously listened on all interfaces.
- AI classifier no longer throws: 1.5s timeout and any error fall back to the heuristic.
- `CostTracker` keeps running aggregates instead of an unbounded per-call array.
- Statusline uses a `node` one-liner instead of requiring `curl` + `python3`.
- Bare-flag invocation (`claude-router --port ...`) is deprecated in favor of `claude-router start`; it still works with a warning.

### Fixed
- Heuristic scoring: unreachable `>2000 token` branch; substring keyword false-positives ("listen" matched "list").
- `status` hardcoded port 4000; invalid `--classifier` was silently ignored; `uninstall` only cleaned the literal port-4000 zshrc line; install printed success even when `launchctl load` failed.
- Passthrough no longer re-serializes bodies or buffers non-streaming responses, and strips stale `content-encoding`/`content-length` headers.
- `npm run build`/`npm test` work in Windows shells.

## [0.0.5] and earlier

Initial releases: routing proxy with heuristic/AI/hybrid classification, auto-retry and rate-limit fallback, cost tracking and dashboard, macOS install, multi-provider support (Anthropic/Bedrock/Vertex), config file, and the `claude-router` CLI.
