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

**claude-router** is a routing layer that auto-routes Claude API calls across Haiku/Sonnet/Opus/Fable by evidence-based gates. The routing engine (classifier, cost model, tier fallback, retry/escalation) is the project's own; it builds on `@anthropic-ai/sdk` as the transport to Anthropic (and its Bedrock/Vertex siblings) and stays drop-in compatible with it.

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
- `src/models.ts` — Pricing constants, `computeCostCents()`, `computeRouteCost()` (cost + savings for a completed response), tier→model mapping
- `src/classifier.ts` — AI classification via Haiku, hybrid mode, unified `classify()` entry point with LRU cache. Tier selection itself lives in `src/routing.ts`
- `src/cache.ts` — Generic bounded `LruCache` (classification results, per-credential SDK clients)
- `src/route.ts` — `executeRoute()`: the shared routing-execution kernel (normalize → create → rate-limit walk-up → escalation retry), returns a `RouteResult` (see Retry / escalation)
- `src/totals.ts` — Shared route-event aggregation: `RouteTotals`, `emptyTotals()`, pure `foldOutcome(acc, e)` over the minimal `RouteOutcomeLike` shape (see Route aggregation)
- `src/tracker.ts` — CostTracker folds each `RouteMeta` via `foldOutcome` into a `RouteTotals`, maps to `RouterStats` (O(1) memory; no per-call array)
- `src/routing.ts` — `routeByEvidence()`: gate-based tier selection (see Routing)
- `src/params.ts` — `normalizeParamsForTier()`: strips/adapts model-specific params to the routed tier (see Parameter normalization)
- `src/index.ts` — ClaudeRouter class, `createRouter()` factory, re-exports

### Pricing (`src/models.ts`)

`computeCostCents()` accepts optional prompt-cache tokens (5th param): cache reads bill at `CACHE_READ_RATE` (10%) and writes at `CACHE_WRITE_RATE` (125%) of the input rate. Both routed paths pass `usage.cache_read_input_tokens`/`cache_creation_input_tokens` — omitting them understates every Claude Code cost figure.

Pricing is **family-based**, not per-ID. `priceForModel()` resolves an exact ID match first (so user overrides win), then falls back to the model's family (`familyForModel()` matches on `haiku`/`sonnet`/`opus`/`fable` substrings). This keeps `savedCents` correct for dated snapshots and Bedrock/Vertex `us.anthropic.*` IDs without a code change. Default tiers (`DEFAULT_MODELS`): haiku→`claude-haiku-4-5`, sonnet→`claude-sonnet-5`, opus→`claude-opus-4-8`, fable→`claude-fable-5`. Current generation (`FAMILY_PRICING`, $/1M in/out): Haiku 4.5 $1/$5, Sonnet 5 $3/$15 (standard; intro $2/$10 through 2026-08-31), Opus 4.6–4.8 $5/$25, Fable 5 $10/$50. **Opus is NOT the old $15/$75 — drift here silently corrupts every savings figure.**

`DEFAULT_PRICING` is assembled as family-derived entries ← spread ← `DIVERGENT_PRICING`. The latter is the exported table of models the family fallback would misprice: legacy Opus 4.0/4.1 (`$15/$75`, 3x the current family rate) and Mythos 5 (`$10/$50`, no family substring to match). Fable 5 is a tier now, so the family fallback covers it. Adding a divergent model is one row there — `models.test.ts` derives its exclusion set from the same table, in both directions, so a redundant or missing entry fails the build instead of rotting.

**Unpriced models are loud, never free.** A model with no exact entry *and* no family match is not $0 — it's unknown, and the old `if (!p) return 0` collapsed the two (this is what shipped Fable 5 at zero cost). `computeCostCents` stays a pure math function returning 0; `computeRouteCost` — the path every routed call takes — raises the signal: `RouteCost.priced` is false when the routed model, the baseline, or both are unpriced (an unpriced baseline makes `savedCents` just as wrong), plus one `console.warn` per model ID. `priced: false` flows into `RouteMeta`/`RouteEvent` → `foldOutcome` → `RouteTotals.unpricedModels`, which `stats`, the dashboard, and the verbose log render as "unknown" rather than `$0.00`. The field is written **only when false**, so pre-existing `history.jsonl` lines keep counting as measured.

### Routing (`src/routing.ts`)

**There is no score.** The additive 0–100 keyword scorer was removed: it let unrelated weak signals sum into an expensive decision (`matrix` +25 and `determinant` +25 reached the Opus threshold on a beginner numpy question, with neither word being evidence of difficulty). Summing was the bug, so no weight tuning could fix it. `routing.test.ts` pins that regression.

`routeByEvidence(input, opts)` returns `{ tier, reason, confidence }` under three rules:

1. **Sonnet is the default.** Leaving it requires positive evidence — absence of complexity is not evidence of simplicity (`"hi"` routes to sonnet, not haiku).
2. **Gates are conjunctive.** Every condition must hold, so two coincidental matches cannot combine into a verdict.
3. **The two traffic profiles are scored separately**, because they expose different signals.

**Agentic branch** (tools defined, or tool blocks in `messages`). The signal is `isMidLoop()` — is the last message a `tool_result`. This is the only routing signal in the codebase with a measurement behind it (`research/2026-07-21-tier-ceiling.md`: mid-loop tool selection is largely tier-insensitive, sonnet adequate 75% with zero clear losses; final synthesis is not, opus won 10 of 11). It is purely structural: no keywords, no language dependence, no verb-without-object failure mode.

**Single-turn branch.** Demotion to haiku requires **all** of: no tools, single message, short task text, no code fence, short system, no images, no depth markers, and a transform verb present. The boundary here is **unmeasured** — the attempt to measure it failed (`research/2026-07-21-single-turn-failed.md`) — so this branch is deliberately conservative rather than tuned. Do not widen the gate without evidence.

**Fable** is opt-in (`allowFable`) and needs depth **and** long-horizon signals together. Nothing measured supports predicting "super hard" from request text, and at $10/$50 a wrong promotion is the most expensive mistake the router can make.

Hybrid mode defers to the AI classifier exactly when no gate fired and routing fell through to the default (`reason` ends with `:default`). Both call sites use the unified `classify()` entry — do not reintroduce per-caller switch statements.

`ClassifyResult.reason` records which gate decided, so a routing decision is auditable after the fact. `routing.haikuMax` / `opusMin` / `hybridBand` are accepted-but-dead config knobs (marked `@deprecated`); they thresholded a score that no longer exists.

**`latestUserText()` is the one extractor — gates and AI snippet both use it.** It takes the newest user turn and strips `<system-reminder>…</system-reminder>` blocks, walking further back if a turn is nothing but injected context. Two separate bugs came from not doing this:

- Joining the whole message array let prior turns and `tool_result` payloads outvote the request (#18, fixed for the heuristic path in `5557d2c`; `buildAISnippet` was missed until #34).
- Keeping the injected context let the *project's own docs* decide the tier (#34). Claude Code injects CLAUDE.md into the user turn as its own text block. Captured from a real session: the opening request carries a 21,558-character injected block ahead of the user's 65 characters, and this CLAUDE.md contains "end-to-end" — a `DEPTH_MARKERS` hit — so `read package.json then tsconfig.json and tell me the build target` routed to **opus** via `agentic:depth-requested`. Any repo whose CLAUDE.md contains a depth word paid opus rates on every turn.

**The filter is structural, not textual.** An injected block is its own text block that opens and closes with the tag; whole blocks are dropped and nothing is parsed inside them. Do not replace this with a regex over the text. The first attempt did exactly that and failed *on this repo*: the paragraph above documents the tag, CLAUDE.md gets injected, and the literal closing tag ended the non-greedy match 8,039 characters in, leaving 13,519 characters of documentation still carrying the depth marker. Content can always mention the delimiter; block boundaries can't be forged by content. A block that merely mentions the tag mid-sentence is a real question and is kept.

`buildAISnippet` head/tail-truncates the extractor's output, falling back to the joined text only when no user turn carries a request at all (`mode: 'ai'` bypasses the gates, so a pure tool_result history can reach it). Do not reintroduce a second extractor, and do not add a keyword gate that reads raw message content.

**Verified against real traffic** (`isMidLoop` fires correctly on Claude Code — a captured tool loop yields `agentic:mid-loop`; an earlier suspicion that the trailing `role: 'system'` message suppressed it was wrong).

**AI classifier never throws**: 1.5s `AbortSignal.timeout` + try/catch fall back to `classifyHeuristic()`. Only genuine `method: 'ai'` results are cached (sha1 key over normalized snippet/system/message count/tool count); heuristic fallbacks are recomputed so a transient Haiku outage isn't cached. Tuning knobs (`RouterConfig.routing` / `FileConfig.routing`): `aiTimeoutMs`, `classifyCacheSize` — optional. `haikuMax`/`opusMin`/`hybridBand` are accepted-but-dead (see Routing).

### Route aggregation

`src/totals.ts` owns the one fold that turns route events into running figures — "sum cost/saved, count per tier, bucket by day". Three call sites reuse it, each keeping its own execution model: `CostTracker.record` folds one `RouteMeta` at a time (O(1)), `history.foldLine` folds newly-appended JSONL lines behind an offset cache, and `dashboard` reduces the live `routeHistory` array. `foldOutcome(acc, e)` reads only `RouteOutcomeLike` (`tier`, `costCents`, `savedCents`, optional `retried`/`timestamp`/`model`/`priced`), so both `RouteMeta` and `RouteEvent` satisfy it structurally without a unified record. `priced === false` buckets the event into `RouteTotals.unpricedModels` (count per model ID) instead of contributing a fake zero — absent means priced, so legacy records aren't retroactively voided. `RouteTotals.tiers` is string-keyed (holds `passthrough` too) and carries only tiers actually seen; the shared `tierBreakdown(totals, labels)` helper zero-fills a fixed label set (used by both `RouterStats.tierBreakdown` and the dashboard bars — add/rename a tier in one place). Do not reintroduce a second copy of the aggregation — extend `foldOutcome`. Line-parsing/corrupt-line rejection stays in `history` (its file seam), not in the shared fold.

### Retry / escalation

`src/retry.ts` — `shouldRetry()` checks two conditions on a completed response:
- **Truncation**: `stop_reason === 'max_tokens'` with >20 output tokens → escalate tier
- **Refusal (structural)**: `stop_reason === 'refusal'` → escalate tier. Language-independent, checked first. Branch on `stop_reason` **only** — the companion `stop_details` is informational and can be `null` on a genuine refusal. Escalation is uniform, not per-`stop_details.category`: opus has already returned by this point, so the only refusals reaching the check are on haiku/sonnet. `stop_reason` is widened to `string` before comparison because the pinned SDK's union predates the value.
- **Refusal (lexical)**: output <200 chars whose first 80 chars match `REFUSAL_PATTERNS` → escalate tier (anchored to the opening so quoted refusal phrases mid-answer don't false-positive). This is a **fallback**, not dead code: only Opus 4.7+/Sonnet 5/Fable 5 set the structural flag (Haiku 4.5, the default entry tier, never does), and soft refusals — the model declining conversationally rather than the classifier firing — arrive as `end_turn`. New languages need only reach the soft-refusal case.

`nextTier()` walks `TIER_ORDER` (haiku→sonnet→opus→fable) but stops at `ESCALATION_CEILING` (opus): fable is 2x opus and the escalation triggers have never fired on real traffic (`research/2026-07-21-detector-measurement.md`: 0 of 35,314 responses). `shouldRetry` gates on the same ceiling — deriving it from `TIER_ORDER.length` silently made opus retryable when fable was added.

`src/route.ts` `executeRoute(client, apiParams, startTier, models, { fallbackOnRateLimit })` is the one place this loop lives — shared by `ClaudeRouter.send` and the proxy `handleNonStreaming`. It normalizes for the tier's model, calls the API, optionally walks up `TIER_ORDER` on a `RateLimitError`, and escalates **once** on truncation/refusal — but only on the originally-classified tier's first response (`!fallbackUsed`), never after a rate-limit walk-up. The library passes `fallbackOnRateLimit: true` (config `fallback`), the proxy `false` (a 429 surfaces to the client). Both then price via `computeRouteCost` and record through their own sink (CostTracker / RouteEvent). Do not re-inline this loop at a caller — the two copies had already drifted on the escalation condition before this was unified. Streaming paths don't use `executeRoute` (no retry once bytes flow).

### Parameter normalization

`src/params.ts` — `normalizeParamsForTier(params, tier)` is applied immediately before **every** routed `messages.create`/`stream` in both the library (`src/index.ts`) and the proxy (`src/proxy/handler.ts`), including escalated-retry calls. The router picks the model, so it must also strip/adapt model-coupled params or the request 400s on the routed model:
- **haiku** (Haiku 4.5): delete `thinking` (no adaptive support) and `output_config.effort` (unsupported). Sampling params kept.
- **sonnet/opus** (Sonnet 5 / Opus 4.8): delete `temperature`/`top_p`/`top_k`; rewrite `thinking:{type:'enabled',budget_tokens}` → `{type:'adaptive'}`.

Never touches `messages`/`system`/`tools`/`max_tokens`. This is what makes `--force-route` work with Claude Code (which sends adaptive thinking + effort, which Haiku rejects). The AI classifier builds its own clean request and is not normalized.

### Proxy server (`src/proxy/`)

HTTP proxy that sits in front of the Anthropic API — zero code changes needed on the client side.

```
src/proxy/
  server.ts     — Hono app, routes: GET /health (via buildHealth), GET /dashboard, POST /v1/messages
  handler.ts    — classify → call API → retry if needed → set x-router-* headers
  health.ts     — single source of truth for the /health contract: SERVICE_ID, HealthInfo type, buildHealth(). server.ts produces it; daemon.checkHealth and cli status consume it (see Health contract)
  dashboard.ts  — HTML dashboard; aggregates routeHistory via foldOutcome (src/totals.ts)
  cli.ts        — CLI dispatcher + commands; bin name `claude-router` (package.json `bin`)
  cli-config.ts — paths (routerPaths), FileConfig loading; one `OPTIONS` table drives parseServeArgs / serveArgsFrom / configFromOptions (see Serve options); getVersion, suggestCommand
  daemon.ts     — detached-spawn daemon, ~/.claude-router/daemon.json state, health polling, stopDaemon
  platform.ts   — per-OS autostart/env-var behind PlatformIntegration adapters (windows/macos/linux) + platformIntegration() selector; pure builders + cross-platform statusline stay outside the adapters; exported functions are thin delegators (see Platform integration)
  term.ts       — zero-dep ANSI styling (Claude Code aesthetic), tier colors, box(), NO_COLOR/TTY detection
  history.ts    — persistent route history (~/.claude-router/history.jsonl, append-only JSONL) with an incremental-read aggregate cache (folds via src/totals.ts); powers `stats` and the dashboard's lifetime cards. Only active when HandlerConfig.historyFile is set (the CLI sets it; tests/library don't).
```

**Health contract** (`src/proxy/health.ts`): the `/health` shape and the `'claude-router-proxy'` identity string live here once. `server.ts` builds the payload with `buildHealth(config, routeHistory)`; `daemon.checkHealth` imports `HealthInfo`/`SERVICE_ID` to verify the port is actually ours; `cli status` types its display off the same `HealthInfo`. Don't re-declare the shape or re-inline the identity string at a consumer.

**Platform integration** (`src/proxy/platform.ts`): OS-specific autostart + `ANTHROPIC_BASE_URL` env work lives in one `PlatformIntegration` adapter per OS (`windows`/`macos`/`linux`), selected once by `platformIntegration()`. macOS's `onStop` unloads the KeepAlive LaunchAgent (called by `daemon.stopDaemon` via the `unloadLaunchAgent` delegator). The exported `installAutostart`/`setEnvVar`/… functions are thin delegators to the current adapter, so call sites and tests are unchanged. Pure string builders (`buildPlist`/`buildSystemdUnit`/`buildRcBlock`/…) and the cross-platform statusline functions are shared and stay outside the adapters. Add per-OS behaviour to the adapter, not as a new `platformName()` switch.

Providers: `anthropic` (per-credential client from `x-api-key` or `Authorization: Bearer`, cached in an LRU of 100 via `getAnthropicClient()` to preserve keep-alive), `bedrock` (singleton `@anthropic-ai/bedrock-sdk`), `vertex` (singleton `@anthropic-ai/vertex-sdk`).

Passthrough: if `model` field is set and not `"auto"`, request bypasses routing and forwards directly to `api.anthropic.com` — **unless `--force-route` is set** (Claude Code always pins a model, so it needs `--force-route`). Passthrough only applies to the `anthropic` provider. The body is read **once as text** and forwarded verbatim; forwarded responses pipe `response.body` and must strip `content-encoding`/`content-length` (undici already decompressed).

`routeHistory` is an in-memory capped array (max 1000 events) used by `/dashboard`.

Streaming responses only set `x-router-tier/model/classifier/confidence` headers (cost/saved aren't known until the stream finishes); non-streaming sets the full `x-router-*` set including cost and savings.

### CLI (`src/proxy/cli.ts`)

Subcommands: `start` (foreground; `-d`/`--daemon` for background), `stop`, `restart`, `status`, `stats [--json]`, `logs [-f] [-n N]`, `install`/`uninstall` (**cross-platform**: detached daemon + per-OS autostart — Windows HKCU Run key, macOS LaunchAgent, Linux systemd user unit — plus env var via setx/rc-block and a node-based Claude Code statusline), `init` (scaffold config), `doctor` (diagnostics, exit code = failure count), `help`, `-V`/`--version`. Unknown subcommands error with a Levenshtein suggestion (no more silent fallthrough to `start`); bare flags still run `start` behind a deprecation warning. Install steps report honestly — ✓ only after the daemon's `/health` actually passes.

The proxy binds `127.0.0.1` by default (`--host` / `FileConfig.host` to override). This is a security boundary, not a convenience: with `bedrock`/`vertex` the proxy uses the operator's cloud credentials and does not authenticate incoming requests — do not change the default bind.

Config file: `~/.claude-router/config.json` (`FileConfig`) supplies defaults for every flag plus `tiers` (per-tier model ID overrides), `pricing` (per-ID `$/1M` overrides), and `routing` (classifier tuning). **CLI flags always override the file.** Precedence for tier→model: provider defaults (`DEFAULT_MODELS`/`BEDROCK_MODELS`/`VERTEX_MODELS`) ← spread ← config `tiers`.

**Serve options** (`cli-config.ts`): the CLI flag set is one declarative `OPTIONS` table (key, flags, kind, default, emit rules). `parseServeArgs` (file defaults ← flags, throws `CliUsageError` on bad/unknown flags), `serveArgsFrom` (rebuild spawn args), and `configFromOptions` (scaffold `init`'s config.json) all fold over it — a new flag is one row, not five parallel edits. Emit predicates key off each option's `default`, so a value and "when to omit it" can't disagree. `tiers`/`pricing`/`routing` are file-only (no flag) and pass through untouched.

### Testing

Tests use `node:test` (no external test framework). Router tests mock the `_client` property directly — no network calls. Most tests are pure unit tests; a few bind an ephemeral **loopback** TCP port (`serve({ port: 0 })` / `http.createServer().listen(0)`) to exercise the proxy over a real socket — `daemon.test.ts` (health polling) and `integration.test.ts` (full end-to-end against a fake in-process Anthropic upstream). None reach the public internet by default. The two `proxy.test.ts` passthrough cases that *do* call `api.anthropic.com` are skipped unless `RUN_NETWORK_TESTS=1` is set.

### Module system

ES2022 target, Node16 module resolution. All internal imports use `.js` extension suffix.
