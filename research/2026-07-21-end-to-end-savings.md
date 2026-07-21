# End-to-end run: does the router actually save money?

**Date:** 2026-07-21
**Method:** the **published** `@sheruq/claude-router@0.2.2` from npm, installed in an isolated sandbox, driven with 200 real turns from this project's Claude Code transcripts against a stub upstream.
**Status:** first measurement of the router *operating*. Everything before this measured models or detectors, never the router itself.

## Why this was needed

Nothing had ever been measured about the router in operation. No `history.jsonl` had ever existed — the maintainer does not use it, and it has no production traffic. The README's *"typically 10–40% off"* had no measurement behind it.

The tier-ceiling experiment showed cheaper models are often *adequate*. That is a property of the models. Whether the router *picks* correctly is a different question, and it was open.

## Setup

- `npm install @sheruq/claude-router@0.2.2` into a throwaway directory.
- **One line patched:** `ANTHROPIC_UPSTREAM` pointed at a local stub. It is a hardcoded constant (deliberately — it prevents the 0.2.1 self-recursion bug), so there is no other way to exercise the proxy without live API credentials. Restored afterwards.
- The stub returns the **real `usage`** — input, output, cache read, cache creation — recorded for that turn in the transcript, and echoes back whichever model the router chose.
- 200 turns, one per session file for spread, replayed through `createProxyApp` with `forceRoute: true`, `classifier: 'heuristic'`, history written to the sandbox.

**Real:** every routing decision, the cost and savings math, `history.jsonl`, escalation, parameter normalization — the shipped artifact end to end.
**Faked:** the upstream address and the response text.

## Result

| | |
|---|---|
| Turns replayed | 200 (0 failures) |
| Actual spend (models really used) | **$21.4714** |
| Routed spend (models the router chose) | **$13.8691** |
| Difference | **$7.60 — 35.4%** |

Routing distribution:

```
router picked : sonnet 197, opus 3
actually used : opus 166, fable 3, haiku 16, sonnet 15
```

Direction of each decision:

```
routed cheaper: 166   same: 18   routed MORE EXPENSIVE: 16
```

## Reading it honestly

**35.4% is an upper bound, not an expected value.** The calculation holds token counts constant across models, and they are not. A cheaper model may answer more briefly — or, as the tier-ceiling run showed for haiku, take an invalid step and add an entire extra turn. Both effects are unmodelled, and the second one pushes real savings *down*.

**The saving comes from one rule.** 197 of 200 turns went to sonnet, almost all via `agentic:mid-loop` or `agentic:default`. The 35.4% is essentially the value of *"stop sending mid-loop steps to opus"* — which is exactly the rule with a measurement behind it. None of it comes from the keyword-style complexity judgement the old classifier was built around.

**16 turns were routed UP.** Traffic that really ran on haiku now goes to sonnet, costing ~3x more on those turns. That is the conservative single-turn gate doing what it was designed to do, and it is a real cost the headline number nets out. On traffic with a higher share of genuinely trivial requests, this term grows and the 35.4% shrinks.

**This is the secondary profile.** Claude Code agentic sessions. Direct single-turn API traffic — the primary target — is still unmeasured, and the mid-loop rule that produces nearly all of the saving does not exist there.

## What this changes

- The router **does** do its job on agentic traffic, and the effect is large enough to be worth having.
- The README's *"10–40%"* now has one data point inside it rather than nothing. It should be restated as measured, bounded, and profile-specific.
- The single-turn branch is the next thing to fix: it currently *costs* money on 8% of turns (16/200) with no measured benefit.

## Reproducing

`harness.mjs` in the session scratchpad. It needs the one-line upstream patch; a `--upstream` flag on the proxy (defaulting to `api.anthropic.com`) would make this runnable against the unmodified package, and is worth adding for exactly that reason.
