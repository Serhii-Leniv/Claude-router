<p align="center">
  <img src="assets/claude-router.svg" alt="claude-router" width="640">
</p>

<p align="center">
  <strong>Auto-route every Claude request to the cheapest model that can handle it.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@sheruq/claude-router"><img src="https://img.shields.io/npm/v/@sheruq/claude-router?color=D97757&label=npm" alt="npm version"></a>
  <img src="https://img.shields.io/npm/dm/@sheruq/claude-router?color=D97757" alt="npm downloads">
  <img src="https://img.shields.io/node/v/@sheruq/claude-router?color=D97757" alt="node version">
  <img src="https://img.shields.io/npm/l/@sheruq/claude-router?color=D97757" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-strict-D97757" alt="TypeScript">
</p>

---

**Cut your Claude bill by auto-routing each request to the cheapest model that can handle it — Haiku, Sonnet, or Opus.** Run it as a drop-in proxy and any Anthropic-compatible app (Claude Code, Cursor, Cline, your own SDK code) gets cost-optimized routing with **zero code changes**. Every response reports exactly how much you saved.

```
[claude-router] → haiku  (heuristic, 0ms) | cost: $0.0010 | saved: $0.0030 vs claude-sonnet-4-6
[claude-router] → opus   (hybrid, 48ms)   | cost: $0.0890 | extra: $0.0740 vs claude-sonnet-4-6
```

- **Zero code changes** — point any app at the proxy via `ANTHROPIC_BASE_URL`. Or `import` it as a library.
- **Measurable** — every call reports exact cents saved vs your baseline model, with a live dashboard.
- **Self-classifying** — heuristic routing at 0ms, or let Haiku confirm ambiguous prompts (~$0.00004/call).
- **Always-correct pricing** — savings are computed against current Claude pricing, resilient to new model snapshots.
- **Auto-fallback & auto-retry** — rate-limited or truncated/refused responses escalate one tier automatically.
- **Claude-only, done right** — tuned specifically for the Haiku/Sonnet/Opus cost & capability tiers.

---

## Quick start — make Claude Code cheaper

Run the proxy and point Claude Code at it. Simple turns go to Haiku, hard ones to Opus — automatically.

```bash
# Start the proxy (no install needed)
npx @sheruq/claude-router start --port 4000 --force-route --verbose

# In another shell, point Claude Code (or any Anthropic app) at it
export ANTHROPIC_BASE_URL=http://localhost:4000
claude
```

That's it. Watch the routing decisions and savings stream by in the proxy log, or open the dashboard:

```
http://localhost:4000/dashboard
```

> `--force-route` makes the proxy route **every** request by complexity, overriding the model the client asked for. This is what Claude Code needs (it always pins a model). Drop it if you want explicit model requests to pass through untouched.

### macOS one-time install (auto-start)

On macOS you can install the proxy as a background service that starts on login and wires up `ANTHROPIC_BASE_URL` and a Claude Code statusline for you:

```bash
npx @sheruq/claude-router install --force-route
# restart your terminal, then use `claude` normally — all calls auto-routed
```

Manage it with `claude-router status`, `claude-router stop`, `claude-router uninstall`.

---

## Config file (optional)

Set defaults once in `~/.claude-router/config.json` instead of passing flags every time. **CLI flags always override the file.**

```json
{
  "port": 4000,
  "classifier": "hybrid",
  "forceRoute": true,
  "verbose": false,
  "tiers": {
    "haiku": "claude-haiku-4-5",
    "sonnet": "claude-sonnet-4-6",
    "opus": "claude-opus-4-8"
  },
  "pricing": {
    "claude-opus-4-8": { "input": 5.0, "output": 25.0 }
  }
}
```

- `tiers` — override which model ID each tier maps to.
- `pricing` — override `$/1M` token pricing used for savings math (handy for enterprise/negotiated rates).

---

## CLI reference

```
claude-router start [options]      Start the proxy in the foreground
claude-router install [options]    macOS: install as a login service (+ env + statusline)
claude-router uninstall            macOS: remove all installed components
claude-router stop                 Stop the background proxy
claude-router status               Show proxy health

Options (start / install):
  --port, -p <number>      Port (default: 4000)
  --force-route            Route every request, ignoring the client's model (needed for Claude Code)
  --verbose, -v            Log routing decisions
  --classifier <mode>      heuristic | ai | hybrid (default: hybrid)
  --provider <mode>        anthropic | bedrock | vertex (default: anthropic)
  --region <string>        AWS/GCP region
```

### Authentication

The proxy forwards whatever credentials your app already sends — no extra config:

| Method | Header | Use case |
|--------|--------|----------|
| API key | `x-api-key: sk-ant-...` | Anthropic API subscribers |
| Bearer token | `Authorization: Bearer <token>` | Claude Pro/Max subscription, Claude Code |
| Env vars | — | AWS Bedrock, Google Vertex AI |

---

## How routing works

- `model: "auto"` or model omitted → classify and route to the optimal tier.
- Explicit model (e.g. `claude-sonnet-4-6`) → passed through unchanged — **unless** `--force-route` is set.
- **Auto-retry**: a truncated or refused response escalates one tier and retries.
- **Auto-fallback**: a rate-limited (429) tier falls back to the next tier up.
- Every response carries `x-router-*` headers with tier, cost, confidence, and savings.

### Classification modes

| Mode | Overhead | How it decides |
|------|----------|----------------|
| `heuristic` | ~0ms | Rule-based scoring 0–100 (cognitive verbs, length, code blocks, math/science signals, multi-turn depth). |
| `ai` | one Haiku call (~$0.00004) | Asks Haiku to rate task complexity 1–3. |
| `hybrid` *(default)* | 0ms, or one Haiku call | Heuristic first; only confirms with Haiku when the score is ambiguous (40–60). |

Thresholds: **Haiku** < 30, **Sonnet** 30–70, **Opus** > 70.

### How savings are measured

Each response's `savedCents` is `(baseline cost − actual cost)` for the tokens used, where the baseline is your `defaultModel` (Sonnet by default). Pricing is the **current Claude generation**, and unknown/dated/Bedrock/Vertex model IDs are priced by family so the math stays correct across model launches:

| Model | ID | Input $/1M | Output $/1M |
|-------|-----|-----------:|------------:|
| Claude Opus 4.8 | `claude-opus-4-8` | $5.00 | $25.00 |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | $3.00 | $15.00 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | $1.00 | $5.00 |

> Need negotiated or enterprise rates? Override them via `pricing` in the config file (proxy) or `pricing` in `createRouter` (library).

### Response headers

```
x-router-tier: haiku
x-router-model: claude-haiku-4-5
x-router-cost-cents: 0.045
x-router-saved-cents: 1.200
x-router-classifier: heuristic
x-router-classifier-ms: 0.1
x-router-confidence: 0.9
```

---

## Other providers

### AWS Bedrock

```bash
npm install @anthropic-ai/bedrock-sdk

AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=us-east-1 \
  npx @sheruq/claude-router start --provider bedrock --port 4000
# No x-api-key needed — auth comes from AWS env vars
export ANTHROPIC_BASE_URL=http://localhost:4000
```

### Google Vertex AI

```bash
npm install @anthropic-ai/vertex-sdk
gcloud auth application-default login

ANTHROPIC_VERTEX_PROJECT_ID=my-project \
  npx @sheruq/claude-router start --provider vertex --port 4000
```

---

## Advanced: use as a library

Prefer to route inside your own app instead of running a proxy? Import it directly.

```bash
npm install @sheruq/claude-router
```

```typescript
import { createRouter } from '@sheruq/claude-router';

const router = createRouter({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  verbose: true,
});

const response = await router.send({
  messages: [{ role: 'user', content: 'Translate to French: Hello world' }],
  max_tokens: 100,
});

console.log(response.meta.tier);       // 'haiku'
console.log(response.meta.savedCents); // 1.2
```

### Streaming

```typescript
const { stream, meta } = router.stream({
  messages: [{ role: 'user', content: 'Write a detailed essay on quantum computing' }],
  max_tokens: 4096,
});

const routeMeta = await meta; // resolves after the stream completes
console.log(routeMeta.tier);  // 'sonnet'
```

### Force a tier / session stats

```typescript
await router.send({ messages: [...], max_tokens: 50, tier: 'opus' }); // skip the classifier

console.log(router.stats());
// { totalCostCents: 5.3, totalSavedCents: 47.3, callCount: 120,
//   tierBreakdown: { haiku: 72, sonnet: 41, opus: 7 } }
```

### Configuration

```typescript
const router = createRouter({
  apiKey: 'sk-...',
  classifier: 'hybrid',            // 'heuristic' | 'ai' | 'hybrid' (default: 'hybrid')
  defaultModel: 'claude-sonnet-4-6', // baseline for savings (default: sonnet tier)
  tiers: {                          // override model IDs per tier
    haiku: 'claude-haiku-4-5',
    sonnet: 'claude-sonnet-4-6',
    opus: 'claude-opus-4-8',
  },
  pricing: {                        // override $/1M token pricing
    'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  },
  fallback: true,                   // auto-fallback to next tier on rate limit (default: true)
  verbose: true,                    // log routing decisions (default: false)
});
```

### Route metadata

Every `send`/`stream` response includes a `meta` object:

```typescript
interface RouteMeta {
  tier: 'haiku' | 'sonnet' | 'opus';
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;          // actual cost in cents
  savedCents: number;         // vs baseline (negative for opus)
  classifierMethod: 'heuristic' | 'ai';
  classifierMs: number;
  confidence: number;         // 0–1
  fallbackUsed: boolean;      // rate-limited and escalated
  retried: boolean;           // auto-retried on bad output
  retryReason: string | null; // 'truncation' | 'refusal' | null
}
```

---

## License

MIT
