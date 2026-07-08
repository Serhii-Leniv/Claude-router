# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/) (pre-1.0: minor = features, patch = fixes).

## [Unreleased]

### Fixed
- **count_tokens and other `/v1` endpoints no longer 404** — the proxy only served `POST /v1/messages`, so Claude Code and the VS Code extension 404'd on `/v1/messages/count_tokens` (and model listing). Non-routable `/v1/*` requests now forward verbatim to Anthropic (auth + `anthropic-beta` headers preserved), tagged `x-router-tier: passthrough`. Non-`anthropic` providers return a clear 404 for these.
- **`ANTHROPIC_BASE_URL` now reaches GUI-launched apps on macOS** — `install` also runs `launchctl setenv` (and `uninstall` runs `launchctl unsetenv`), so VS Code / the Claude Code extension started from Dock/Finder inherit the proxy URL without being relaunched from a terminal. The shell-rc export alone never reached them.

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
