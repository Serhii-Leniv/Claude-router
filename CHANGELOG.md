# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/) (pre-1.0: minor = features, patch = fixes).

## [Unreleased]

### Fixed
- **`files` no longer sweeps all of `assets/` into the published package.** The entry was the bare directory, so `npm pack` picked up anything sitting there — including files not tracked in git, which meant the tarball could differ between machines. A 147kB promo image was caught on its way into 0.2.2 this way. Narrowed to `assets/claude-router.svg`, the only asset the README actually references.

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
