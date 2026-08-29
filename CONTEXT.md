# CONTEXT — domain glossary

The ubiquitous language of **claude-router**. Use these terms exactly in code, comments, commits, and reviews. Architecture vocabulary (module, interface, depth, seam, adapter, leverage, locality) comes from the `/codebase-design` skill; this file names the *domain*.

## Core

- **Tier** — a routing bucket: `haiku` | `sonnet` | `opus` | `fable`, ordered cheap→capable by `TIER_ORDER`. A tier is not a model ID; a tier resolves to a model per provider (`DEFAULT_MODELS`/`BEDROCK_MODELS`/`VERTEX_MODELS`, overridable by config `tiers`).
- **Family** — the pricing/identity class of a model ID (`haiku`/`sonnet`/`opus`/`fable`), matched by substring in `familyForModel`. Pricing is family-based so dated snapshots and `us.anthropic.*` IDs price correctly without a code change.
- **Classifier** — the thing that maps a request to a Tier. Three modes: **heuristic** (conjunctive gates over request shape — `routeByEvidence`; there is no score), **ai** (Haiku returns 1–3), **hybrid** (gates, deferring to AI exactly when no gate fired and routing fell through to the default). Entry point: `classify()`. Never throws — AI failure falls back to heuristic. A request the coordinator-session pin decided carries `method: 'pinned'` and was never classified at all.
- **Route** (verb) — pick a Tier, resolve its model, normalize params, call the API, escalate if the output is bad, account for cost. `executeRoute` (`route.ts`) is the shared execution kernel; `ClaudeRouter.send` and the proxy `handleNonStreaming` both call it (streaming paths don't — no retry once bytes flow).
- **Escalation** / **Retry** — bumping to the next Tier up (`nextTier`) when a completed response is **truncated** (`max_tokens` with real output) or a **refusal** — structural (`stop_reason === 'refusal'`, checked first) or lexical (short output opening with a refusal pattern). Happens once, only on the classified tier's first response. Stops at `ESCALATION_CEILING` (opus), so opus never escalates and fable is never an escalation target.
- **Rate-limit walk-up** — on a `RateLimitError`, retry the same request on the next Tier up. The library opts in (`fallbackOnRateLimit: true`); the proxy does not (a 429 surfaces to the client).
- **Fallback** — switching to the next Tier up on a `RateLimitError` (distinct from escalation, which is quality-driven).

## Accounting

- **Route outcome** — the record of one routed call. Two concrete shapes exist by seam: **`RouteMeta`** (library, returned on `RoutedMessage.meta`) and **`RouteEvent`** (proxy, persisted to history). Both satisfy `RouteOutcomeLike`.
- **`RouteTotals`** — running aggregate of route outcomes (requests, cost, saved, retried, per-tier counts, per-day buckets). Produced by the one shared fold.
- **`foldOutcome`** — the single seam that folds a route outcome into `RouteTotals`. Reused by `CostTracker`, `history`, and the dashboard; each keeps its own execution model. The named seam for "aggregate route events" — do not grow a second copy.
- **Baseline / Savings** — `savedCents` is `cost(baseline) − cost(routedModel)` for the same tokens; can be negative when routing escalates. The baseline is **the model the client asked for**, resolved per request (`resolveBaselineModel`); `config.defaultModel` (sonnet tier) is only the fallback for when the client named nothing usable. Pricing a pinned-model client against a fixed constant reports a loss on runs that saved.
- **Cache tokens** — prompt-cache reads (10% of input rate) and writes (125%). Claude Code uses caching heavily; every cost figure must include them.

## Proxy

- **Passthrough** — a request that pins an explicit model (not `"auto"`) bypasses routing and forwards verbatim to `api.anthropic.com`. Anthropic provider only.
- **Force-route** — override passthrough so pinned-model requests still route. Required for Claude Code, which always pins a model.
- **Parameter normalization** — reconciling model-coupled request params with the routed Tier's model (`normalizeParamsForTier`), so a request built for one model doesn't 400 on another. Applied before every routed call, including escalated retries.
- **Provider** — where the API call goes: `anthropic` (per-credential client), `bedrock`, `vertex`.
- **Health contract** — the `/health` payload shape + the `'claude-router-proxy'` identity string, defined once in `health.ts` (`HealthInfo`, `SERVICE_ID`, `buildHealth`). The seam by which the daemon and CLI recognise a running proxy.
- **Platform integration** — the per-OS work of registering **autostart** on login and setting the **`ANTHROPIC_BASE_URL`** env var. One `PlatformIntegration` adapter per OS (windows/macos/linux) behind `platformIntegration()`. The **statusline** (Claude Code's `~/.claude/settings.json`) is cross-platform and sits outside the adapters.
- **Route history** — append-only JSONL at `~/.claude-router/history.jsonl`, read incrementally behind an offset cache; powers `stats` and the dashboard's lifetime figures.
- **Serve option** — one CLI/config knob for the proxy (`port`, `host`, `classifier`, `provider`, `region`, `force-route`, `verbose`). Declared once in the `OPTIONS` table (`cli-config.ts`); parsing, spawn-arg re-serialization, and `init` scaffolding all derive from it. The seam for "add a flag": one row.
