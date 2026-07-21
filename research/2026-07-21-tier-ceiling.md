# Tier ceiling: can haiku or sonnet replace opus?

**Date:** 2026-07-21
**Method:** matched-pair head-to-head on real turns, blind-judged against a fixed opus baseline.
**Scripts:** [`scripts/sample-turns.mjs`](scripts/sample-turns.mjs) for extraction; the run itself was a subagent workflow.

## Design

23 turns that opus-4.8 actually served, drawn from this project's own Claude Code
transcripts, in two strata:

- **A — mid-loop** (`stop_reason: 'tool_use'`): 12 turns. 92% of real response volume.
- **B — final answer** (`stop_reason: 'end_turn'` with text): 11 turns. 8% of volume.

Each turn was given to haiku, sonnet and opus with **byte-identical prompts** — only
the model differed. Both cheap tiers were then judged against the **same opus
baseline**, so the two land on one comparable scale.

Controls:
- Presentation order alternates by sample index (deterministic, balanced), so the
  judge cannot learn "first is always the cheap one".
- The judge is not told which model produced which response and is told not to guess.
- The judge is told `equivalent` is a correct verdict and not to manufacture a preference.
- Judge is opus. Since one arm is also opus, self-preference bias runs **against** the
  cheap tiers — a "cheap tier is adequate" result is therefore conservative.

## Results

"Adequate" = cheap tier won or tied.

| | n | equivalent | opus won | of which clear | **adequate** |
|---|---:|---:|---:|---:|---:|
| **sonnet**, A mid-loop | 12 | 9 | 3 | **0** | **75%** |
| **sonnet**, B final | 11 | 1 | 10 | 3 | **9%** |
| **haiku**, A mid-loop | 12 | 7 | 5 | 2 | **58%** |
| **haiku**, B final | 11 | 1 | 10 | 6 | **9%** |

Neither cheap tier ever *won* outright on any sample.

## The finding that matters

**The axis that separates tiers is position in the loop, not topic difficulty.**

Mid-loop steps — pick the next tool call — are largely tier-insensitive: sonnet ties
opus 75% of the time and never loses clearly. Final synthesis is the opposite: opus
wins 10 of 11 against both cheap tiers.

This maps onto a signal available at request time and costing nothing to compute:

> is the last message in `messages` a `tool_result`?

That is not semantic. It has no verb-without-object failure mode. It does not fire on
the word "matrix". And it separates 92% of volume from 8%.

## Haiku: inconclusive, by pre-registered criteria

Before the run, the interpretation was fixed in advance: ≥60% adequate on stratum A
would mean haiku is viable for mid-loop work; 30-40% would mean it is not; **40-60%
would mean the sample is too small to say**. Haiku landed at **58%** — the middle
band. The honest answer is that this run does not settle it.

What *is* informative is **how** haiku failed. Its stratum-A losses were not reasoning
failures:

| Sample | Failure |
|---|---|
| A5 | Never chose the synthesis action the workflow required — would have stalled the run |
| A10 | Called `Read` on a directory, which errors; `Glob` was the right tool |
| A11 | Tried to read a file that did not exist at that commit — the read would error |
| A3 | Missed that three target files were untracked and invisible to `git diff HEAD` |

These are **invalid or wasted actions**, not weaker thinking. In an agentic loop that
failure mode costs another turn, which is exactly the compounding-cost scenario
`applyAgenticFloor` was written to prevent. So haiku's effective discount is not
"80% cheaper" — it is 80% cheaper minus the turns its mistakes add back.

## Measurement reliability: the judge is 35% unstable

The sonnet-vs-opus comparison was scored twice — same generated responses, only a
methodology clarification added to the judge prompt. **8 of 23 verdicts flipped (35%).**

```
A2:  opus -> equivalent      B4:  sonnet -> opus
A3:  opus -> equivalent      B7:  sonnet -> opus
A10: equivalent -> opus      B9:  equivalent -> opus
A11: equivalent -> opus
A12: opus -> equivalent
```

Treat every point estimate above as directional. What survived both runs is the
**stratum pattern**, which is what the design conclusion rests on:

| | run 1 | run 2 |
|---|---:|---:|
| sonnet adequate, A mid-loop | 67% | 75% |
| sonnet adequate, B final | 36% | 9% |

A ≫ B in both. The magnitude moved; the direction did not.

This instability is itself evidence for the literature finding in
[routing-architecture.md](2026-07-21-routing-architecture.md) §5-6: escalation and
quality judges are noisy instruments, and RouterBench's ~0.2 judge-error cliff is a
real engineering constraint, not a theoretical one.

## Known methodology limitations

1. **n=12 and n=11.** Binomial CI at n=12 is roughly ±26pp. Combined with 35% judge
   instability, these numbers distinguish "most" from "few", nothing finer.
2. **Roleplay confound.** Agents were asked to *describe* the next turn, not to live
   inside the loop with real tools. Run 1 penalised the arm that complied with that
   instruction; run 2 added an explicit judge guard against it, which is part of why
   verdicts moved.
3. **Corpus is one project's transcripts** — deliberately scoped for privacy, but
   narrow. Four projects appear in the sample.
4. **This is the secondary traffic profile.** Claude Code agentic sessions. The primary
   target — direct single-turn API traffic — is not measured here at all, and the
   mid-loop signal barely exists there.

## What follows

- Routing on **loop position** is evidence-backed for agentic traffic and should be
  the first structural signal added to the classifier.
- Routing on **topic complexity** (the current additive keyword score) is measuring an
  axis the data does not support.
- **Sonnet as default** for mid-loop agentic work is supported.
- **Haiku for mid-loop work is unresolved** — needs a larger run, and any cost model
  for it must charge for the extra turns its invalid actions cause.
- **Nothing here licenses a claim about direct API traffic.** That gap is the single
  biggest hole in the evidence base, and it covers the primary user.
