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

### Testing

Tests use `node:test` (no external test framework). Router tests mock `_client` property directly — no network calls. All tests are pure unit tests.

### Module system

ES2022 target, Node16 module resolution. All internal imports use `.js` extension suffix.
