# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/) (pre-1.0: minor = features, patch = fixes).

## [Unreleased]

### Added
- **German refusal detection** — `REFUSAL_PATTERNS` now includes German refusal phrases ("Ich kann dabei nicht helfen", "Als KI kann ich nicht", …), so auto-escalation fires for German responses too. Patterns follow the same modal + object/verb anchoring as the English set to avoid over-matching benign sentences ("Ich kann keine Fehler finden"). First step for #3.

### Fixed
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
