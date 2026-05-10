# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # TypeScript → dist/
npm test               # Build + run all tests (node:test)
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

- `src/types.ts` — All interfaces (Tier, RouterConfig, RouteMeta, RoutedMessage, RouterStats, ClassifyInput/Result)
- `src/models.ts` — Pricing constants, `computeCostCents()`, tier→model mapping
- `src/classifier.ts` — Heuristic scoring (0–100 → haiku/sonnet/opus), AI classification via Haiku, hybrid mode
- `src/tracker.ts` — CostTracker accumulates per-call cost/savings
- `src/index.ts` — ClaudeRouter class, `createRouter()` factory, re-exports

### Classifier thresholds

Heuristic score 0–100: Haiku (<30), Sonnet (30–70), Opus (>70). Hybrid mode: if score 40–60 (ambiguous), confirms with AI call to Haiku.

### Retry / escalation

`src/retry.ts` — `shouldRetry()` checks two conditions on a completed response:
- **Truncation**: `stop_reason === 'max_tokens'` with >20 output tokens → escalate tier
- **Refusal**: output <200 chars matching `REFUSAL_PATTERNS` → escalate tier

`nextTier()` walks `TIER_ORDER` (haiku→sonnet→opus). Opus never retries — no higher tier.

### Proxy server (`src/proxy/`)

HTTP proxy that sits in front of the Anthropic API — zero code changes needed on the client side.

```
src/proxy/
  server.ts   — Hono app, routes: GET /health, GET /dashboard, POST /v1/messages
  handler.ts  — classify → call API → retry if needed → set x-router-* headers
  dashboard.ts — HTML dashboard rendering routeHistory
  cli.ts      — CLI entrypoint (npx claude-router-proxy)
```

Providers: `anthropic` (per-request client from `x-api-key` or `Authorization: Bearer`), `bedrock` (singleton `@anthropic-ai/bedrock-sdk`), `vertex` (singleton `@anthropic-ai/vertex-sdk`).

Passthrough: if `model` field is set and not `"auto"`, request bypasses routing and forwards directly to `api.anthropic.com`.

`routeHistory` is an in-memory ring buffer (max 1000 events) used by `/dashboard`.

### Testing

Tests use `node:test` (no external test framework). Router tests mock `_client` property directly — no network calls. All tests are pure unit tests.

### Module system

ES2022 target, Node16 module resolution. All internal imports use `.js` extension suffix.
