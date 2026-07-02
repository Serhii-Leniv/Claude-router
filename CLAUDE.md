# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # TypeScript → dist/ (chmod via node — Windows-safe)
npm test               # Build + run all tests (node:test, quoted glob — cmd.exe-safe)
npm run dev            # tsc --watch
node --test dist/__tests__/classifier.test.js  # Run single test file (build first)
```

## Architecture

**claude-router** is a drop-in wrapper around `@anthropic-ai/sdk` that auto-routes Claude API calls to Haiku/Sonnet/Opus by prompt complexity.

```
ClaudeRouter.send(params)
  → Classifier (heuristic | ai | hybrid) → picks tier
  → Anthropic SDK messages.create() with resolved model
  → On RateLimitError: fallback to next tier up
  → CostTracker records meta (cost, savings vs baseline)
  → Returns RoutedMessage (Anthropic.Message + RouteMeta)
```

### Key files

- `src/types.ts` — All interfaces (Tier, RouterConfig, RoutingTuning, RouteMeta, RoutedMessage, RouterStats, ClassifyInput/Result)
- `src/models.ts` — Pricing constants, `computeCostCents()`, tier→model mapping
- `src/classifier.ts` — Heuristic scoring (0–100 → haiku/sonnet/opus), AI classification via Haiku, hybrid mode, unified `classify()` entry point with LRU cache
- `src/cache.ts` — Generic bounded `LruCache` (classification results, per-credential SDK clients)
- `src/tracker.ts` — CostTracker keeps running aggregates (O(1) memory; no per-call array)
- `src/params.ts` — `normalizeParamsForTier()`: strips/adapts model-specific params to the routed tier (see Parameter normalization)
- `src/index.ts` — ClaudeRouter class, `createRouter()` factory, re-exports

### Pricing (`src/models.ts`)

Pricing is **family-based**, not per-ID. `priceForModel()` resolves an exact ID match first (so user overrides win), then falls back to the model's family (`familyForModel()` matches on `haiku`/`sonnet`/`opus` substrings). This keeps `savedCents` correct for dated snapshots and Bedrock/Vertex `us.anthropic.*` IDs without a code change. Default tiers (`DEFAULT_MODELS`): haiku→`claude-haiku-4-5`, sonnet→`claude-sonnet-5`, opus→`claude-opus-4-8`. Current generation (`FAMILY_PRICING`, $/1M in/out): Haiku 4.5 $1/$5, Sonnet 5 $3/$15 (standard; intro $2/$10 through 2026-08-31), Opus 4.6–4.8 $5/$25. **Opus is NOT the old $15/$75 — drift here silently corrupts every savings figure.**

### Classifier

Heuristic score 0–100: Haiku (<30), Sonnet (30–70), Opus (>70). All weights live in the exported `HEURISTIC_WEIGHTS` block. Signals: cognitive-verb keywords (word-boundary regex with `s?` plural suffix — NOT substring; "listen" must not match "list"), token estimate (includes tool_result volume via `extraChars`, which deliberately does NOT feed keyword matching), code blocks, math/science keywords+notation, tool_use/tool_result blocks, request-level `tools` count, image blocks, system-prompt length/expert keywords, message count.

Hybrid mode confirms with AI when score is in the band (default 40–60) **or** when `keywordHits === 0 && estimatedTokens >= 20` (signal-poor, e.g. non-English). Both call sites use the unified `classify()` entry (`src/classifier.ts`) — do not reintroduce per-caller switch statements.

**AI classifier never throws**: 1.5s `AbortSignal.timeout` + try/catch fall back to `classifyHeuristic()`. Only genuine `method: 'ai'` results are cached (sha1 key over normalized snippet/system/message count/tool count); heuristic fallbacks are recomputed so a transient Haiku outage isn't cached. Tuning knobs (`RouterConfig.routing` / `FileConfig.routing`): `haikuMax`, `opusMin`, `hybridBand`, `aiTimeoutMs`, `classifyCacheSize` — all optional, defaults preserve behavior.

### Retry / escalation

`src/retry.ts` — `shouldRetry()` checks two conditions on a completed response:
- **Truncation**: `stop_reason === 'max_tokens'` with >20 output tokens → escalate tier
- **Refusal**: output <200 chars whose first 80 chars match `REFUSAL_PATTERNS` → escalate tier (anchored to the opening so quoted refusal phrases mid-answer don't false-positive)

`nextTier()` walks `TIER_ORDER` (haiku→sonnet→opus). Opus never retries — no higher tier.

### Parameter normalization

`src/params.ts` — `normalizeParamsForTier(params, tier)` is applied immediately before **every** routed `messages.create`/`stream` in both the library (`src/index.ts`) and the proxy (`src/proxy/handler.ts`), including escalated-retry calls. The router picks the model, so it must also strip/adapt model-coupled params or the request 400s on the routed model:
- **haiku** (Haiku 4.5): delete `thinking` (no adaptive support) and `output_config.effort` (unsupported). Sampling params kept.
- **sonnet/opus** (Sonnet 5 / Opus 4.8): delete `temperature`/`top_p`/`top_k`; rewrite `thinking:{type:'enabled',budget_tokens}` → `{type:'adaptive'}`.

Never touches `messages`/`system`/`tools`/`max_tokens`. This is what makes `--force-route` work with Claude Code (which sends adaptive thinking + effort, which Haiku rejects). The AI classifier builds its own clean request and is not normalized.

### Proxy server (`src/proxy/`)

HTTP proxy that sits in front of the Anthropic API — zero code changes needed on the client side.

```
src/proxy/
  server.ts     — Hono app, routes: GET /health, GET /dashboard, POST /v1/messages
  handler.ts    — classify → call API → retry if needed → set x-router-* headers
  dashboard.ts  — HTML dashboard rendering routeHistory
  cli.ts        — CLI dispatcher + commands; bin name `claude-router` (package.json `bin`)
  cli-config.ts — paths (routerPaths), FileConfig loading, parseServeArgs (throws CliUsageError), getVersion, suggestCommand
  daemon.ts     — detached-spawn daemon, ~/.claude-router/daemon.json state, health polling, stopDaemon
  platform.ts   — per-OS autostart/env-var/statusline (pure builders + execFileSync executors)
  term.ts       — zero-dep ANSI styling (Claude Code aesthetic), tier colors, box(), NO_COLOR/TTY detection
```

Providers: `anthropic` (per-credential client from `x-api-key` or `Authorization: Bearer`, cached in an LRU of 100 via `getAnthropicClient()` to preserve keep-alive), `bedrock` (singleton `@anthropic-ai/bedrock-sdk`), `vertex` (singleton `@anthropic-ai/vertex-sdk`).

Passthrough: if `model` field is set and not `"auto"`, request bypasses routing and forwards directly to `api.anthropic.com` — **unless `--force-route` is set** (Claude Code always pins a model, so it needs `--force-route`). Passthrough only applies to the `anthropic` provider. The body is read **once as text** and forwarded verbatim; forwarded responses pipe `response.body` and must strip `content-encoding`/`content-length` (undici already decompressed).

`routeHistory` is an in-memory capped array (max 1000 events) used by `/dashboard`.

Streaming responses only set `x-router-tier/model/classifier/confidence` headers (cost/saved aren't known until the stream finishes); non-streaming sets the full `x-router-*` set including cost and savings.

### CLI (`src/proxy/cli.ts`)

Subcommands: `start` (foreground; `-d`/`--daemon` for background), `stop`, `restart`, `status`, `logs [-f] [-n N]`, `install`/`uninstall` (**cross-platform**: detached daemon + per-OS autostart — Windows HKCU Run key, macOS LaunchAgent, Linux systemd user unit — plus env var via setx/rc-block and a node-based Claude Code statusline), `init` (scaffold config), `doctor` (diagnostics, exit code = failure count), `help`, `-V`/`--version`. Unknown subcommands error with a Levenshtein suggestion (no more silent fallthrough to `start`); bare flags still run `start` behind a deprecation warning. Install steps report honestly — ✓ only after the daemon's `/health` actually passes.

The proxy binds `127.0.0.1` by default (`--host` / `FileConfig.host` to override). This is a security boundary, not a convenience: with `bedrock`/`vertex` the proxy uses the operator's cloud credentials and does not authenticate incoming requests — do not change the default bind.

Config file: `~/.claude-router/config.json` (`FileConfig`) supplies defaults for every flag plus `tiers` (per-tier model ID overrides), `pricing` (per-ID `$/1M` overrides), and `routing` (classifier tuning). **CLI flags always override the file.** Precedence for tier→model: provider defaults (`DEFAULT_MODELS`/`BEDROCK_MODELS`/`VERTEX_MODELS`) ← spread ← config `tiers`.

### Testing

Tests use `node:test` (no external test framework). Router tests mock `_client` property directly — no network calls. All tests are pure unit tests.

### Module system

ES2022 target, Node16 module resolution. All internal imports use `.js` extension suffix.
