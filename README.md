<p align="center">
  <img src="assets/claude-router.svg" alt="claude-router" width="640">
</p>

<p align="center">
  <strong>Auto-route every Claude request to the cheapest model that can handle it.</strong>
</p>

<p align="center">
  <a href="https://github.com/Serhii-Leniv/claude-router/actions/workflows/test.yml"><img src="https://github.com/Serhii-Leniv/claude-router/actions/workflows/test.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@sheruq/claude-router"><img src="https://img.shields.io/npm/v/@sheruq/claude-router?color=D97757&label=npm" alt="npm version"></a>
  <img src="https://img.shields.io/npm/dm/@sheruq/claude-router?color=D97757" alt="npm downloads">
  <img src="https://img.shields.io/node/v/@sheruq/claude-router?color=D97757" alt="node version">
  <img src="https://img.shields.io/npm/l/@sheruq/claude-router?color=D97757" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-strict-D97757" alt="TypeScript">
  <a href="https://send.monobank.ua/jar/3zo8nv9iuF"><img src="https://img.shields.io/badge/support-monobank_jar-D97757" alt="support: monobank jar"></a>
</p>

---

**Cut your Anthropic API bill by routing every request to the cheapest Claude model that can handle it — Haiku, Sonnet, or Opus.** `claude-router` is a self-hosted, drop-in proxy: point any Anthropic-compatible app (Claude Code, Cursor, Cline, or your own SDK code) at it with one environment variable and get automatic, complexity-aware model routing — **zero code changes, no SaaS in your request path, no per-token markup**. Every response reports exactly what you saved.

```text
[claude-router] → haiku  (heuristic, 0ms) | cost: $0.0010 | saved: $0.0030 vs claude-sonnet-5
[claude-router] → opus   (hybrid, 48ms)   | cost: $0.0890 | extra: $0.0740 vs claude-sonnet-5
```

## Is this for you?

**If you pay per token** (Anthropic API, Amazon Bedrock, or Google Vertex) **and your traffic is a mix of easy and hard requests.** The router skims the easy majority down to Haiku/Sonnet and reserves Opus for what actually needs it.

**Measured, not promised.** One live Claude Code session through the proxy spent $3.34 against a $4.23 all-Opus counterfactual — **21%** ([note](research/2026-07-25-live-session.md)). A 200-turn replay of the published 0.2.2 projected **35%** ([method](research/2026-07-21-end-to-end-savings.md)), an upper bound that assumes token counts do not change when the model does and that comes almost entirely from one rule: mid-loop tool steps go to Sonnet. Direct API (single-turn) traffic is **unmeasured**. See [What is measured vs assumed](#what-is-measured-vs-assumed).

## Contents

- [Quick start](#quick-start) · [How it works](#how-it-works) · [Configuration](#configuration) · [CLI reference](#cli-reference)
- [Pricing & savings](#pricing--savings) · [Other providers](#other-providers) · [Use as a library](#use-as-a-library) · [Authentication & security](#authentication--security)

## Features

| | |
|---|---|
| 🔌 **Zero code changes** | Point any Anthropic app at the proxy via `ANTHROPIC_BASE_URL`, or `import` it as a library. |
| 🧠 **Evidence-based routing** | Conjunctive gates on request shape, not a keyword score. Sonnet is the default; leaving it needs positive evidence. See [research/](research/) for the measurements behind it. |
| 🛟 **Quality-safe** | Sonnet floor for tool-using sessions, plus auto-escalation on truncation/refusal and auto-fallback on rate limits. |
| 📊 **Measurable** | Every call reports exact cents saved vs your baseline, with lifetime `stats` and a live dashboard. |
| 💯 **Correct by construction** | Per-tier parameter normalization (so routed requests don't 400) and prompt-cache-aware pricing. |
| 🏠 **Self-hosted & Claude-only** | No third party sees your traffic; tuned specifically for the Haiku/Sonnet/Opus/Fable tiers. |

---

## Quick start

### Claude Code (recommended)

Two commands on **Windows, macOS, or Linux**:

```bash
npm install -g @sheruq/claude-router
claude-router install --force-route
# open a new terminal, then use `claude` normally — every call is auto-routed
```

> Install **globally** (not via `npx`) when using `install`: login autostart points at the installed CLI, and the `claude-router` command must stay on your PATH for `status` / `stop` / `doctor`.

`install` starts the proxy in the background (verifying it's healthy before reporting success), registers it to start on login, sets `ANTHROPIC_BASE_URL`, and adds a Claude Code statusline — per OS:

| OS | Autostart | Env var |
|----|-----------|---------|
| **Windows** | HKCU Run key | `setx` (applies to new terminals) |
| **macOS** | LaunchAgent | block in `~/.zshrc` |
| **Linux** | systemd user unit (graceful fallback) | block in `~/.bashrc` / `~/.zshrc` |

Manage it anytime:

```bash
claude-router status    # health, routing stats, install state
claude-router stats     # lifetime savings + per-day breakdown
claude-router logs -f   # follow the daemon log
claude-router doctor    # diagnose setup problems
claude-router stop      # stop the background proxy
claude-router uninstall # remove everything install added
```

Watch routing live in the logs, or open the dashboard at `http://localhost:4000/dashboard`.

> **Why `--force-route`?** Claude Code always pins a model, so the proxy must override it to route by complexity. The router reconciles model-specific parameters with the tier it picks (see [How it works](#how-it-works)), so force-routing never 400s on Claude Code's adaptive-thinking / effort settings. Drop the flag if you want explicit model requests to pass through untouched.

### Any app, without installing

**1. Start the proxy** in one terminal:

```bash
npx @sheruq/claude-router start --port 4000 --force-route --verbose
```

**2. Point your app at it** in another:

```bash
# macOS / Linux
export ANTHROPIC_BASE_URL=http://localhost:4000
claude
```

```powershell
# Windows (PowerShell)
$env:ANTHROPIC_BASE_URL = "http://localhost:4000"
claude
```

---

## How it works

For each request the proxy classifies the task, routes to the right tier, calls the API, and returns the response plus `x-router-*` headers:

- **Route** — `model: "auto"` (or omitted) is classified and routed. An explicit model passes through unchanged **unless** `--force-route` is set.
- **Coordinator pin** *(optional)* — with `--session-model <tier>`, the Claude Code **main session** is pinned to that tier (e.g. `opus` for a large context window and no early compaction) while subagents still route by evidence. It keys off the gateway protocol's `x-claude-code-agent-id` header, which Claude Code sets only on subagent requests — so a request without it is the coordinator. Needs `--force-route` (otherwise the client's pinned model already passes through). See [Pin the coordinator session](#pin-the-coordinator-session).
- **Sonnet by default** — leaving it needs positive evidence. Gates are *conjunctive*, so coincidental keyword matches can't sum into an expensive verdict.
- **Loop-position aware** — a turn answering a `tool_result` is a mid-loop step, and those are largely tier-insensitive. Agentic turns never reach Haiku unless `routing.allowHaikuInAgentic: true`.
- **Auto-retry** — a truncated or refused response escalates one tier and retries.
- **Auto-fallback** — a rate-limited (429) tier falls back to the next tier up.
- **Parameter normalization** — the router owns the model, so it adapts model-coupled params to the chosen tier (otherwise a request built for one model 400s on another). Haiku: strips `thinking` and `output_config.effort`. Sonnet/Opus/Fable: strips `temperature`/`top_p`/`top_k` and converts a fixed `thinking.budget_tokens` to adaptive thinking; Fable additionally rejects *disabled* thinking, so that is dropped too. Your `messages`, `system`, `tools`, and `max_tokens` are never touched.

### Classification modes

| Mode | Overhead | How it decides |
|------|----------|----------------|
| `heuristic` | ~0ms | Conjunctive gates on request shape: tool use, loop position, message count, length, code fences, explicit depth markers. |
| `ai` | one Haiku call (~$0.00004) | Asks Haiku to rate task complexity 1–3. |
| `hybrid` *(default)* | 0ms, or one Haiku call | Gates first; asks Haiku only when no gate fired and routing fell through to the default. |

Every decision carries a `reason` (e.g. `agentic:mid-loop`), so routing is auditable. **Fable** is opt-in (`routing.allowFable`). AI classification is resilient by design — results are cached (LRU 500), calls time out at 1.5s, and any failure falls back to the heuristic, so a Haiku outage never blocks a request.

### Pin the coordinator session

Claude Code's main interactive session is your coordinator — it holds the growing plan and delegates work to subagents. If it routes to Sonnet, its 200k context window fills fast and compaction kicks in early. `--session-model opus` keeps that one session on Opus (large window, no early compaction) while everything the router does for **subagents** stays intact:

```bash
claude-router start --force-route --session-model opus
# or in ~/.claude-router/config.json:  "sessionModel": "opus"
```

How it tells them apart: Claude Code sets the `x-claude-code-agent-id` header **only** on requests from a subagent it spawned ([gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol)). A request without it is the coordinator, so it gets pinned (classifier skipped, `x-router-classifier: pinned`); a request with it routes by evidence as usual. To route subagents down to cheaper tiers, give them lower models in their `.claude/agents/*.md` frontmatter — the pin never touches them. Only takes effect under `--force-route`; without it, the client's explicit model already passes through untouched.

The pin also requires the request to **carry tools**, which every real coordinator turn does. Claude Code's own meta-calls — generating a session title, summarising a conversation — arrive without the agent-id header too, but with no tools and the conversation quoted in `<session>…</session>`. Those keep routing by evidence, so pinning `opus` doesn't pay Opus rates to name a session.

---

## Orchestration mode (Claude Code)

The proxy already sees every request Claude Code makes, so it can do more than pick a model per turn: it can run the whole session as a coordinator on the top tier with role agents carrying the volume on cheaper tiers — and enforce that, and measure it.

```bash
claude-router install --force-route --session-model opus --restore-delegation
# then restart Claude Code
```

`install` also adds the **orchestration plugin** (skip with `--no-policy`, or manage it alone with `claude-router policy install|status|uninstall`). The plugin ships five role agents and a short session policy:

| Agent | Hand it | Tier |
|---|---|---|
| `claude-router:recon` | read-only lookup: where is X, what calls Y | haiku |
| `claude-router:builder` | one scoped change that needs judgement | sonnet |
| `claude-router:batch` | the same edit across many files, fully specified | sonnet |
| `claude-router:gate` | fresh-context readiness check before risky work (READY / REVISE) | opus |
| `claude-router:audit` | fresh-context attempt to refute finished risky work (CONFIRMED / REFUTED / INCONCLUSIVE) | opus |

What the proxy adds that a prompt-only policy cannot:

- **Enforcement.** Each agent definition opens with a marker (`<!-- claude-router:role=recon -->`); the proxy reads it from the subagent's system prompt and pins the tier, whatever model the client asked for and whatever `CLAUDE_CODE_SUBAGENT_MODEL` says. `--session-model opus` pins the coordinator; `--restore-delegation` removes the injected lines that stop Claude Code from spawning agents at all.
- **A ledger.** Every subagent row in `history.jsonl` carries `role`, and `x-router-role` names the deciding role on the response. `claude-router stats` and the dashboard show what reconnaissance, implementation and review actually cost.
- **Every OS.** The hooks are Node scripts, not shell.

Configure in `~/.claude-router/config.json`:

```jsonc
{
  "sessionModel": "opus",
  "restoreDelegation": true,
  "roleRouting": "on",                          // "off" = classify subagents like any request (A/B baseline)
  "roles": { "builder": "opus" },               // move a role to another tier
  "agents": { "some-plugin:reviewer": "opus" }  // pin third-party agents by Claude Code agent type
}
```

Without a marker, a read-only agent Claude Code already runs on haiku (the built-in Explore) is confirmed at haiku instead of being floored to sonnet; the proxy never demotes an agent from tool shape alone.

**Coming from a prompt-only delegation policy?** Keep it if you like it — the proxy does not care where the instruction to delegate came from. What changes: `--session-model opus` holds the coordinator's tier whatever the client sends, `--restore-delegation` removes the injected lines that stop Claude Code spawning agents at all, and `claude-router stats` tells you the dispatch rate and what each role cost, which a prompt cannot. To pin agents from another plugin by name, map their agent type under `agents`. On SessionStart the plugin prints one line saying whether the proxy is actually enforcing (`claude-router: enforcing — session pinned to opus, subagent roles routed by the proxy`) or, if it is down, that the tiers are advisory. For development: `claude --plugin-dir ./plugin`.

## Configuration

Set defaults once in `~/.claude-router/config.json` instead of passing flags. **CLI flags always override the file.** Scaffold it with `claude-router init --force-route --port 4000`.

```json
{
  "port": 4000,
  "classifier": "hybrid",
  "forceRoute": true,
  "verbose": false,
  "sessionModel": "opus",
  "tiers": {
    "haiku": "claude-haiku-4-5",
    "sonnet": "claude-sonnet-5",
    "opus": "claude-opus-5"
  },
  "pricing": {
    "claude-opus-5": { "input": 5.0, "output": 25.0 }
  },
  "routing": {
    "aiTimeoutMs": 1500,
    "classifyCacheSize": 500,
    "allowHaikuInAgentic": false,
    "allowFable": false
  }
}
```

`haikuMax`, `opusMin` and `hybridBand` are accepted but ignored since 0.2.2 — routing is gate-based and there is no score to threshold; the proxy warns once per key. `allowFable` lets classification reach the fable tier (off by default: it is $10/$50 and no measured signal predicts "super hard" from request text).

- **`sessionModel`** — pin the Claude Code coordinator session to a tier (subagents still route). See [Pin the coordinator session](#pin-the-coordinator-session).
- **`tiers`** — override which model ID each tier maps to.
- **`pricing`** — override `$/1M` token rates used for savings math (handy for enterprise/negotiated rates).
- **`routing`** — tune the classifier. `allowHaikuInAgentic: true` lets clearly-trivial tool-using turns reach Haiku (off by default — see the [agentic floor](#how-it-works)).

---

## CLI reference

```text
claude-router install [options]     One-time setup: daemon + login autostart + env var + statusline
claude-router uninstall             Remove everything install added
claude-router start [options]       Run the proxy in the foreground
claude-router start -d              Run it in the background (daemon)
claude-router stop                  Stop the background proxy
claude-router restart [options]     Restart the background proxy
claude-router status                Health, routing stats, install state
claude-router stats [--json]        Lifetime savings and per-day breakdown
claude-router logs [-f] [-n N]      Show (or follow) the daemon log
claude-router init [--force] [options]  Scaffold ~/.claude-router/config.json from the given options
claude-router doctor                Diagnose common setup problems
claude-router --version, -V         Print version

Options (install / start / restart / status / doctor):
  --port, -p <number>    Port (default: 4000)
  --host <address>       Bind address (default: 127.0.0.1 — local only)
  --force-route          Route every request, ignoring the client's model (needed for Claude Code)
  --session-model <tier> Pin the Claude Code coordinator session to a tier (haiku|sonnet|opus|fable); subagents still route. Needs --force-route
  --verbose, -v          Log routing decisions
  --classifier <mode>    heuristic | ai | hybrid (default: hybrid)
  --provider <mode>      anthropic | bedrock | vertex (default: anthropic)
  --region <string>      AWS/GCP region

Install-only options:
  --no-autostart         Skip login autostart registration
  --no-env               Skip setting ANTHROPIC_BASE_URL
  --no-statusline        Skip the Claude Code statusline
```

**Something not routing?** Run `claude-router doctor` — it checks the Node version, config validity, proxy health on your port, `ANTHROPIC_BASE_URL`, credentials, stale daemon state, autostart, and the statusline, with a fix hint for anything that fails.

---

## Pricing & savings

Each response's `savedCents` is `(baseline cost − actual cost)` for the tokens used, where the baseline is **the model the client asked for** — the counterfactual of "what this request would have cost without the router". Claude Code pins a model on every request (that is what `--force-route` overrides), so an opus-pinned request routed to Sonnet books the real opus→sonnet saving, and one the coordinator pin keeps on Opus books exactly `$0.00`. The proxy falls back to `defaultModel` only when the client named nothing usable: no `model` field, `"auto"`, or a model with no pricing entry. **Prompt-cache tokens are included** — reads bill at 10% of the input rate (2.5% on Fable 5.1 / Mythos 5.1) and writes at 125% — so figures stay accurate for cache-heavy clients like Claude Code. Every routed request is appended to `~/.claude-router/history.jsonl`, so savings survive restarts (`claude-router stats` / the dashboard's *Lifetime Saved* card).

`history.jsonl` is append-only by design and never rotated — it *is* the lifetime-savings ledger (~250 bytes/event; a million routed requests ≈ 250 MB). Archive or delete it anytime to start fresh; stats restart from zero. The daemon log (`~/.claude-router/proxy.log`) *does* rotate: past 5 MiB it rolls over to `proxy.log.1` on the next daemon start.

Pricing tracks the **current Claude generation**; unknown/dated/Bedrock/Vertex IDs are priced by family so the math stays correct across model launches:

| Model | ID | Input $/1M | Output $/1M |
|-------|-----|-----------:|------------:|
| Claude Fable 5.1 | `claude-fable-5-1` | $10.00 | $50.00 |
| Claude Opus 5 | `claude-opus-5` | $5.00 | $25.00 |
| Claude Sonnet 5 | `claude-sonnet-5` | $2.00 | $10.00 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | $1.00 | $5.00 |

> Sonnet 5's **$2.00 / $10.00** is the standard rate. It launched as introductory pricing through 2026-08-31, and this router used to price the announced $3.00 / $15.00 successor so savings would not jump when it expired — but the increase was cancelled and $2/$10 became standard. Since the sonnet tier is the savings baseline, that guess made every reported saving too high, and by more than the 50% rate error: a saving is a difference and only one side of it moved, so on a typical Claude Code turn a haiku route reported roughly **twice** what it actually saved. Override via `pricing` for negotiated or enterprise rates.
>
> **Cache reads are 10% of the input rate on every model except Fable 5.1 / Mythos 5.1, which read at 2.5%** ($0.25/1M). On a cache-heavy client like Claude Code the read line is most of the input bill, so the rate is per-model (`ModelPricing.cacheRead`), not a global constant. Cache writes are 125% everywhere.

Every response also carries the decision as headers:

```text
x-router-tier: haiku
x-router-model: claude-haiku-4-5
x-router-cost-cents: 0.045
x-router-saved-cents: 1.200
x-router-classifier: heuristic
x-router-classifier-ms: 0.1
x-router-confidence: 0.9
x-router-reason: agentic:mid-loop
```

---

## What is measured vs assumed

Every number this project reports is downstream of a few measurements and a few assumptions. Which is which:

| Claim | Status | Evidence |
|---|---|---|
| Mid-loop tool steps are tier-insensitive (Sonnet adequate 75%, zero clear losses); final synthesis is not (Opus won 10 of 11) | **Measured** | [tier ceiling](research/2026-07-21-tier-ceiling.md), 23 real turns, blind-judged |
| Escalation triggers (truncation, refusal) never fire on real traffic | **Measured** | [detector measurement](research/2026-07-21-detector-measurement.md), 0 of 35,314 responses |
| 21% saved on one live Claude Code session | **Measured**, n=1 | [live session](research/2026-07-25-live-session.md) |
| 35% on agentic coding traffic | **Upper bound**, replay on a stub upstream, tokens held constant | [end-to-end savings](research/2026-07-21-end-to-end-savings.md) |
| The single-turn haiku gate (short mechanical transforms) | **Unmeasured**, deliberately conservative | [failed experiment](research/2026-07-21-single-turn-failed.md) |
| Fable promotion signals (depth + long horizon) | **Assumed** — nothing measured predicts "super hard" from text | off by default |
| Bedrock / Vertex inference-profile IDs | **Unverified** against a console | `src/models.ts` |
| Orchestration mode saves money over classifying subagents | **Unmeasured** — that is what `--role-routing off` and `stats` exist to compare | [sandbox](sandbox/README.md) |

The standing caveats are in [research/README.md](research/README.md#standing-caveats).

---

## Other providers

The proxy binds to `127.0.0.1` by default — only your own machine can reach it.

> ⚠️ **Fable on Bedrock / Vertex is not wired up.** Fable 5's inference-profile ID on those platforms is unverified, so the `fable` tier resolves to **Opus** there rather than risking a 404 — a request routed to fable on Bedrock or Vertex silently runs on Opus instead. This is inert while `routing.allowFable` is off (the default). If you enable fable on Bedrock or Vertex, set the real ID yourself via `tiers.fable` in `~/.claude-router/config.json` and verify it against your console first. On the first-party Anthropic API, fable routes to `claude-fable-5` as expected.

### AWS Bedrock

```bash
npm install @anthropic-ai/bedrock-sdk

AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=us-east-1 \
  npx @sheruq/claude-router start --provider bedrock --port 4000
# auth comes from AWS env vars — no x-api-key needed
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

## Use as a library

Prefer to route inside your own app instead of running a proxy? Import it directly.

```bash
npm install @sheruq/claude-router
```

```typescript
import { createRouter } from '@sheruq/claude-router';

const router = createRouter({ apiKey: process.env.ANTHROPIC_API_KEY!, verbose: true });

const response = await router.send({
  messages: [{ role: 'user', content: 'Translate to French: Hello world' }],
  max_tokens: 100,
});

console.log(response.meta.tier);       // 'haiku'
console.log(response.meta.savedCents); // 1.2
```

**Streaming** — `await router.stream(...)` classifies first, then returns the real SDK `MessageStream`; `meta` resolves after the stream completes:

```typescript
const { stream, meta } = await router.stream({
  messages: [{ role: 'user', content: 'Write a detailed essay on quantum computing' }],
  max_tokens: 4096,
});

for await (const event of stream) {
  // standard @anthropic-ai/sdk stream events; .on()/.finalMessage() work too
}

const routeMeta = await meta;
console.log(routeMeta.tier); // 'sonnet'
```

**Force a tier / read session stats:**

```typescript
await router.send({ messages: [/* … */], max_tokens: 50, tier: 'opus' }); // skip the classifier

console.log(router.stats());
// { totalCostCents: 5.3, totalSavedCents: 47.3, callCount: 120,
//   tierBreakdown: { haiku: 72, sonnet: 41, opus: 7 } }
```

<details>
<summary><strong>Full <code>createRouter</code> options and <code>RouteMeta</code> shape</strong></summary>

```typescript
const router = createRouter({
  apiKey: 'sk-...',
  classifier: 'hybrid',            // 'heuristic' | 'ai' | 'hybrid' (default: 'hybrid')
  defaultModel: 'claude-sonnet-5', // baseline for savings (default: sonnet tier)
  tiers: {                         // override model IDs per tier
    haiku: 'claude-haiku-4-5',
    sonnet: 'claude-sonnet-5',
    opus: 'claude-opus-5',
  },
  pricing: {                       // override $/1M token pricing
    'claude-sonnet-5': { input: 2.0, output: 10.0 },
  },
  fallback: true,                  // auto-fallback to next tier on rate limit (default: true)
  verbose: true,                   // log routing decisions (default: false)
  routing: {                       // classifier tuning (defaults shown)
    allowFable: false,             // let classification reach fable (depth AND long-horizon evidence required)
    aiTimeoutMs: 1500,             // AI classifier timeout → heuristic fallback
    classifyCacheSize: 500,        // LRU size for AI results (0 disables)
    allowHaikuInAgentic: false,    // let trivial tool-using turns reach haiku (default: floor at sonnet)
  },
});
```

Every `send` / `stream` response includes a `meta` object:

```typescript
interface RouteMeta {
  tier: 'haiku' | 'sonnet' | 'opus';
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;          // actual cost in cents
  savedCents: number;         // vs baseline (negative when routed to opus)
  classifierMethod: 'heuristic' | 'ai';
  classifierMs: number;
  confidence: number;         // 0–1
  fallbackUsed: boolean;      // rate-limited and escalated
  retried: boolean;           // auto-retried on bad output
  retryReason: string | null; // 'truncation' | 'refusal' | null
}
```

</details>

---

## Authentication & security

The proxy forwards whatever credentials your app already sends — no extra config:

| Method | Header | Use case |
|--------|--------|----------|
| API key | `x-api-key: sk-ant-...` | Anthropic API (pay-per-token) |
| Bearer token | `Authorization: Bearer <token>` | Claude Code / subscription auth |
| Env vars | — | AWS Bedrock, Google Vertex AI |

> **Security.** The proxy binds to `127.0.0.1` by default — only your own machine can reach it. If you pass `--host 0.0.0.0` to share it on a network, note that with the `bedrock`/`vertex` providers it calls out with **your** cloud credentials and does not authenticate incoming requests.

---

## Contributing

Contributions welcome! See **[CONTRIBUTING.md](CONTRIBUTING.md)** to go from clone to merged PR — the short version is `npm install && npm test`, branch, add a test, open a PR. `master` is protected: changes merge by squash after review and green CI. For security reports, see **[SECURITY.md](SECURITY.md)**.

## License

[MIT](LICENSE)
