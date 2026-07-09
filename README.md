<p align="center">
  <img src="assets/claude-router.svg" alt="claude-router" width="640">
</p>

<p align="center">
  <strong>Auto-route every Claude request to the cheapest model that can handle it.</strong>
</p>

<p align="center">
  <a href="https://github.com/Serhii-Leniv/Claude-router/actions/workflows/test.yml"><img src="https://github.com/Serhii-Leniv/Claude-router/actions/workflows/test.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@sheruq/claude-router"><img src="https://img.shields.io/npm/v/@sheruq/claude-router?color=D97757&label=npm" alt="npm version"></a>
  <img src="https://img.shields.io/npm/dm/@sheruq/claude-router?color=D97757" alt="npm downloads">
  <img src="https://img.shields.io/node/v/@sheruq/claude-router?color=D97757" alt="node version">
  <img src="https://img.shields.io/npm/l/@sheruq/claude-router?color=D97757" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-strict-D97757" alt="TypeScript">
</p>

---

**Cut your Claude bill by auto-routing each request to the cheapest model that can handle it — Haiku, Sonnet, or Opus.** Run it as a drop-in proxy and any Anthropic-compatible app (Claude Code, Cursor, Cline, your own SDK code) gets cost-optimized routing with **zero code changes**. Every response reports exactly how much you saved.

```
[claude-router] → haiku  (heuristic, 0ms) | cost: $0.0010 | saved: $0.0030 vs claude-sonnet-5
[claude-router] → opus   (hybrid, 48ms)   | cost: $0.0890 | extra: $0.0740 vs claude-sonnet-5
```

- **Zero code changes** — point any app at the proxy via `ANTHROPIC_BASE_URL`. Or `import` it as a library.
- **Measurable** — every call reports exact cents saved vs your baseline model, with a live dashboard.
- **Self-classifying** — heuristic routing at 0ms, or let Haiku confirm ambiguous prompts (~$0.00004/call).
- **Always-correct pricing** — savings are computed against current Claude pricing, resilient to new model snapshots.
- **Auto-fallback & auto-retry** — rate-limited or truncated/refused responses escalate one tier automatically.
- **Claude-only, done right** — tuned specifically for the Haiku/Sonnet/Opus cost & capability tiers.

---

## Quick start — make Claude Code cheaper

Two commands on **Windows, macOS, or Linux**:

```bash
npm install -g @sheruq/claude-router
claude-router install --force-route
# open a new terminal, then use `claude` normally — all calls auto-routed
```

> Install globally (not via `npx`) if you use `install`: the login autostart points at the installed CLI, and the `claude-router` command stays on your PATH for `status`/`stop`/`doctor`.

`install` starts the proxy in the background (and verifies it's healthy before saying so), registers it to start on login, sets `ANTHROPIC_BASE_URL`, and adds a Claude Code statusline. Per OS:

- **Windows** — background daemon + HKCU Run key for login autostart; env var via `setx` (applies to new terminals).
- **macOS** — background daemon + LaunchAgent; env var block in `~/.zshrc`.
- **Linux** — background daemon + systemd user unit (falls back gracefully if `systemctl` is absent); env var block in `~/.bashrc`/`~/.zshrc`.

Manage it anytime:

```bash
claude-router status    # health, routing stats, install state
claude-router stats     # lifetime savings + per-day breakdown
claude-router logs -f   # follow the daemon log
claude-router doctor    # diagnose setup problems
claude-router stop      # stop the background proxy
claude-router uninstall # remove everything install added
```

Watch routing decisions in the logs, or open the live dashboard: `http://localhost:4000/dashboard`

> `--force-route` makes the proxy route **every** request by complexity, overriding the model the client asked for. This is what Claude Code needs (it always pins a model). Drop it if you want explicit model requests to pass through untouched.
>
> The proxy automatically reconciles model-specific parameters with the tier it routes to (see [How routing works](#how-routing-works)), so force-routing Claude Code to Haiku doesn't break on Claude Code's adaptive-thinking / effort settings.

### Try it without installing

**1. Start the proxy** in one terminal:

```bash
npx @sheruq/claude-router start --port 4000 --force-route --verbose
```

**2. Point Claude Code (or any Anthropic app) at it** in a second terminal:

```powershell
# Windows (PowerShell)
$env:ANTHROPIC_BASE_URL = "http://localhost:4000"
claude
```

```bash
# macOS / Linux (bash/zsh)
export ANTHROPIC_BASE_URL=http://localhost:4000
claude
```

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
    "sonnet": "claude-sonnet-5",
    "opus": "claude-opus-4-8"
  },
  "pricing": {
    "claude-opus-4-8": { "input": 5.0, "output": 25.0 }
  }
}
```

- `tiers` — override which model ID each tier maps to.
- `pricing` — override `$/1M` token pricing used for savings math (handy for enterprise/negotiated rates).
- `routing` *(optional)* — tune the classifier: `{ "haikuMax": 30, "opusMin": 70, "hybridBand": [40, 60], "aiTimeoutMs": 1500, "classifyCacheSize": 500 }`.

Scaffold the file with your current flags: `claude-router init --force-route --port 4000`

---

## CLI reference

```
claude-router install [options]     One-time setup: daemon + login autostart + env var + statusline
claude-router uninstall             Remove everything install added
claude-router start [options]       Run the proxy in the foreground
claude-router start -d              Run it in the background (daemon)
claude-router stop                  Stop the background proxy
claude-router restart [options]     Restart the background proxy
claude-router status                Health, routing stats, install state
claude-router stats [--json]        Lifetime savings and per-day breakdown
claude-router logs [-f] [-n N]      Show (or follow) the daemon log
claude-router init [--force]        Scaffold ~/.claude-router/config.json
claude-router doctor                Diagnose common setup problems
claude-router --version, -V         Print version

Options (install / start / restart / status / doctor):
  --port, -p <number>      Port (default: 4000)
  --host <address>         Bind address (default: 127.0.0.1 — local only)
  --force-route            Route every request, ignoring the client's model (needed for Claude Code)
  --verbose, -v            Log routing decisions
  --classifier <mode>      heuristic | ai | hybrid (default: hybrid)
  --provider <mode>        anthropic | bedrock | vertex (default: anthropic)
  --region <string>        AWS/GCP region

Install-only options:
  --no-autostart           Skip login autostart registration
  --no-env                 Skip setting ANTHROPIC_BASE_URL
  --no-statusline          Skip the Claude Code statusline
```

### Troubleshooting

Something not routing? Run the built-in diagnostics:

```bash
claude-router doctor
```

It checks the Node version, config file validity, proxy health on your configured port, `ANTHROPIC_BASE_URL`, API-key presence, stale daemon state, autostart registration, and the statusline — with a fix hint for anything that fails.

### Authentication

The proxy forwards whatever credentials your app already sends — no extra config:

| Method | Header | Use case |
|--------|--------|----------|
| API key | `x-api-key: sk-ant-...` | Anthropic API subscribers |
| Bearer token | `Authorization: Bearer <token>` | Claude Pro/Max subscription, Claude Code |
| Env vars | — | AWS Bedrock, Google Vertex AI |

> **Security:** the proxy binds to `127.0.0.1` by default — only your own machine can reach it. If you pass `--host 0.0.0.0` to share it on a network, be aware that with the `bedrock`/`vertex` providers the proxy calls out with **your** cloud credentials and does not authenticate incoming requests.

---

## How routing works

- `model: "auto"` or model omitted → classify and route to the optimal tier.
- Explicit model (e.g. `claude-sonnet-5`) → passed through unchanged — **unless** `--force-route` is set.
- **Auto-retry**: a truncated or refused response escalates one tier and retries.
- **Auto-fallback**: a rate-limited (429) tier falls back to the next tier up.
- **Parameter normalization**: the router owns the model, so it also adapts model-specific params to the chosen tier — otherwise a request built for one model would 400 on another. Routing to **Haiku** strips `thinking` and `output_config.effort` (Haiku 4.5 doesn't support adaptive thinking or the effort parameter). Routing to **Sonnet/Opus** strips `temperature`/`top_p`/`top_k` and converts a fixed `thinking.budget_tokens` into adaptive thinking (Sonnet 5 / Opus 4.8 reject those). Your `messages`, `system`, `tools`, and `max_tokens` are never touched. This is what lets `--force-route` work with Claude Code.
- Every response carries `x-router-*` headers with tier, cost, confidence, and savings.

### Classification modes

| Mode | Overhead | How it decides |
|------|----------|----------------|
| `heuristic` | ~0ms | Rule-based scoring 0–100 (cognitive verbs, length, code blocks, math/science signals, tool use, images, multi-turn depth). |
| `ai` | one Haiku call (~$0.00004) | Asks Haiku to rate task complexity 1–3. |
| `hybrid` *(default)* | 0ms, or one Haiku call | Heuristic first; confirms with Haiku when the score is ambiguous (40–60) or the text produced no scoring signals (e.g. non-English prompts). |

Thresholds: **Haiku** < 30, **Sonnet** 30–70, **Opus** > 70 (tunable via `routing` in the config).

AI classification is resilient by design: results are cached (LRU, 500 entries), calls time out after 1.5s, and any failure falls back to the heuristic — a Haiku outage never blocks your requests.

### How savings are measured

Each response's `savedCents` is `(baseline cost − actual cost)` for the tokens used, where the baseline is your `defaultModel` (Sonnet by default). **Prompt-cache tokens are included** — cache reads bill at 10% of the input rate and cache writes at 125%, so figures stay accurate for Claude Code, which caches heavily.

Every routed request is also appended to `~/.claude-router/history.jsonl`, so savings survive restarts: see them with `claude-router stats` or as the *Lifetime Saved* card on the dashboard. Pricing is the **current Claude generation**, and unknown/dated/Bedrock/Vertex model IDs are priced by family so the math stays correct across model launches:

| Model | ID | Input $/1M | Output $/1M |
|-------|-----|-----------:|------------:|
| Claude Opus 4.8 | `claude-opus-4-8` | $5.00 | $25.00 |
| Claude Sonnet 5 | `claude-sonnet-5` | $3.00 | $15.00 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | $1.00 | $5.00 |

> Sonnet 5 has an introductory rate of **$2.00 / $10.00** per 1M through 2026-08-31. Savings are computed against the **standard** $3.00 / $15.00 so the numbers stay stable when the intro period ends — override via `pricing` if you want the intro rate reflected exactly.

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
  defaultModel: 'claude-sonnet-5', // baseline for savings (default: sonnet tier)
  tiers: {                          // override model IDs per tier
    haiku: 'claude-haiku-4-5',
    sonnet: 'claude-sonnet-5',
    opus: 'claude-opus-4-8',
  },
  pricing: {                        // override $/1M token pricing
    'claude-sonnet-5': { input: 3.0, output: 15.0 },
  },
  fallback: true,                   // auto-fallback to next tier on rate limit (default: true)
  verbose: true,                    // log routing decisions (default: false)
  routing: {                        // optional classifier tuning (defaults shown)
    haikuMax: 30,                   // score below this → haiku
    opusMin: 70,                    // score above this → opus
    hybridBand: [40, 60],           // hybrid confirms with AI inside this band
    aiTimeoutMs: 1500,              // AI classifier timeout → heuristic fallback
    classifyCacheSize: 500,         // LRU size for AI results (0 disables)
  },
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

## Contributing

Contributions are welcome! See **[CONTRIBUTING.md](CONTRIBUTING.md)** to get from clone to merged PR — the short version is `npm install && npm test`, branch, add a test, open a PR. `master` is protected: changes merge by squash after review and green CI. For security reports, see **[SECURITY.md](SECURITY.md)**.

---

## License

MIT
