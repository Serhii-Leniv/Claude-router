# claude-router

TypeScript-native Claude model router. Auto-routes API calls to Haiku, Sonnet, or Opus by task complexity. Logs cost savings per call.

## Why

Sending "translate hello" to Opus costs 60x more than Haiku — for identical output. This library classifies prompt complexity and picks the cheapest model that can handle it.

- **Zero infra** — `npm install` and go. Optional proxy server for zero-code-change routing.
- **Self-classifying** — Haiku decides whether to use Haiku (hybrid mode, ~$0.00004/call).
- **Measurable** — every response includes exact cents saved vs your baseline model.
- **Full streaming** — works with `.stream()`, meta available after completion.
- **Auto-fallback** — rate-limited? automatically tries the next tier up.
- **Claude-only, done right** — tuned for Haiku/Sonnet/Opus cost and capability tiers.

## Install

```bash
npm install claude-router
```

## Quick Start

```typescript
import { createRouter } from 'claude-router';

const router = createRouter({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  verbose: true,
});

// Auto-routes based on complexity
const response = await router.send({
  messages: [{ role: 'user', content: 'Translate this to French: Hello world' }],
  max_tokens: 100,
});

console.log(response.meta.tier);       // 'haiku'
console.log(response.meta.savedCents); // 1.2
```

## Streaming

```typescript
const { stream, meta } = router.stream({
  messages: [{ role: 'user', content: 'Write a detailed essay on quantum computing' }],
  max_tokens: 4096,
});

// meta resolves after stream completes
const routeMeta = await meta;
console.log(routeMeta.tier); // 'sonnet'
```

## Force a Tier

```typescript
const response = await router.send({
  messages: [{ role: 'user', content: 'Say hi' }],
  max_tokens: 50,
  tier: 'opus', // skip classifier
});
```

## Session Stats

```typescript
console.log(router.stats());
// {
//   totalCostCents: 5.3,
//   totalSavedCents: 47.3,
//   callCount: 120,
//   tierBreakdown: { haiku: 72, sonnet: 41, opus: 7 }
// }
```

## Configuration

```typescript
const router = createRouter({
  apiKey: 'sk-...',

  // Classification strategy (default: 'hybrid')
  // 'heuristic' — 0ms overhead, rule-based scoring
  // 'ai'        — Haiku classifies complexity (~$0.00004/call)
  // 'hybrid'    — heuristic first, AI confirms ambiguous cases
  classifier: 'hybrid',

  // Baseline model for savings calculation (default: sonnet)
  defaultModel: 'claude-sonnet-4-6',

  // Override model IDs per tier
  tiers: {
    haiku: 'claude-haiku-4-5-20251001',
    sonnet: 'claude-sonnet-4-6',
    opus: 'claude-opus-4-6',
  },

  // Override pricing ($ per 1M tokens)
  pricing: {
    'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  },

  // Auto-fallback to next tier on rate limit (default: true)
  fallback: true,

  // Log routing decisions to console (default: false)
  verbose: true,
});
```

## Proxy Server

Run as a drop-in proxy for `api.anthropic.com`. Any app that lets you set a custom base URL gets auto-routing with zero code changes.

```bash
# Start proxy
npx @sheruq/claude-router --port 4000 --verbose

# Or after install
claude-router --port 4000 --verbose
```

Then point your app at it:

```bash
export ANTHROPIC_BASE_URL=http://localhost:4000
```

Works with **Cursor**, **Continue.dev**, **Cline**, **Claude CLI**, or any Anthropic SDK app:

```typescript
const client = new Anthropic({
  baseURL: 'http://localhost:4000',
});
// All existing code works — requests auto-routed to optimal tier
```

### Proxy options

```
--port, -p <number>      Port (default: 4000)
--verbose, -v             Log routing decisions
--classifier <mode>       heuristic | ai | hybrid (default: hybrid)
--provider <mode>         anthropic | bedrock | vertex (default: anthropic)
--region <string>         AWS/GCP region
```

### Authentication

The proxy accepts any of these — no code changes needed:

| Method | Header | Use case |
|--------|--------|----------|
| API key | `x-api-key: sk-ant-...` | Anthropic API subscribers |
| Bearer token | `Authorization: Bearer <token>` | Claude Pro/Max subscription, Claude Code |
| Env vars | — | AWS Bedrock, Google Vertex AI |

### AWS Bedrock

```bash
npm install @anthropic-ai/bedrock-sdk

AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=us-east-1 \
  claude-router --provider bedrock --port 4000
```

```bash
export ANTHROPIC_BASE_URL=http://localhost:4000
# No x-api-key needed — auth from AWS env vars
```

### Google Vertex AI

```bash
npm install @anthropic-ai/vertex-sdk
gcloud auth application-default login

ANTHROPIC_VERTEX_PROJECT_ID=my-project \
  claude-router --provider vertex --port 4000
```

### Claude Code

Works out of the box — just set the base URL:

```bash
ANTHROPIC_BASE_URL=http://localhost:4000 claude
# or permanently:
export ANTHROPIC_BASE_URL=http://localhost:4000
```

Claude Code with Pro/Max subscription (Bearer auth) is also supported automatically.

### How routing works

- `model: "auto"` or model omitted → classify and route to optimal tier
- Explicit model (e.g. `model: "claude-sonnet-4-6"`) → pass through unchanged (Anthropic provider only)
- Auto-retry: truncated or refused responses escalate one tier automatically
- Response includes `x-router-*` headers with tier, cost, confidence, and savings

### Response headers

```
x-router-tier: haiku
x-router-model: claude-haiku-4-5-20251001
x-router-cost-cents: 0.045
x-router-saved-cents: 1.200
x-router-classifier: heuristic
x-router-classifier-ms: 0.1
x-router-confidence: 0.9
```

## How Classification Works

### Heuristic (0ms)

Scores prompts 0–100 based on:
- **Cognitive verbs** — "translate/summarize" → low, "architect/design/evaluate" → high
- **Structural signals** — token count, sentence complexity, code blocks, non-alpha density
- **System prompt** — length > 500 chars or expert keywords bump score
- **Multi-turn** — 5+ messages bump score, 15+ bump more

Thresholds: Haiku (<30), Sonnet (30–70), Opus (>70)

### AI (~50 tokens, uses Haiku)

Sends a short classification prompt to Haiku: "Task complexity 1-3?" Maps 1→Haiku, 2→Sonnet, 3→Opus.

### Hybrid (default)

Heuristic first. If score is 40–60 (ambiguous), confirms with AI classifier.

## Route Meta

Every response includes a `meta` object:

```typescript
interface RouteMeta {
  tier: 'haiku' | 'sonnet' | 'opus';
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;        // actual cost in cents
  savedCents: number;       // vs baseline (can be negative for opus)
  classifierMethod: 'heuristic' | 'ai';
  classifierMs: number;
  confidence: number;       // 0–1, how certain the classifier was
  fallbackUsed: boolean;    // true if rate-limited and escalated
  retried: boolean;         // true if auto-retried on bad output
  retryReason: string | null; // 'truncation' | 'refusal' | null
}
```

## Verbose Output

```
[claude-router] → haiku (heuristic, 0ms) | cost: $0.0010 | saved: $0.0030 vs claude-sonnet-4-6
[claude-router] → opus (heuristic, 0ms, fallback from sonnet) | cost: $0.0890 | extra: $0.0740 vs claude-sonnet-4-6
```

## License

MIT
