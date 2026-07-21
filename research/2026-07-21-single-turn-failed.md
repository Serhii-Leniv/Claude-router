# Failed experiment: single-turn tier boundary

**Date:** 2026-07-21
**Status:** ❌ Invalid. Recorded so the same 121 agent runs are not spent again.
**Cost:** 121 subagent runs, ~4.1M tokens, 13 minutes.

## What was attempted

Close the evidence gap on the **primary** traffic profile — direct single-turn API
requests — since [tier-ceiling.md](2026-07-21-tier-ceiling.md) only covers agentic
Claude Code traffic.

24 genuine human session openings (median 194 chars, no tool history) were given to
haiku, sonnet and opus, then blind-judged pairwise against opus, with a tagging pass
to report the boundary per task type.

## Result, and why it is not usable

| | n | tie | opus won | of which clear | "adequate" |
|---|---:|---:|---:|---:|---:|
| haiku | 21 | 0 | 21 | 20 | **0%** |
| sonnet | 23 | 0 | 23 | 12 | **0%** |

Zero ties across 44 comparisons. The agentic run scored sonnet at 75% ties on the
same judging harness. Models did not change between the two runs — the instrument did.

### Cause 1: the metric measures preference, not adequacy

In the agentic experiment the task had a discrete answer — *which tool to call next*.
When both arms picked `Read src/proxy/dashboard.ts`, "equivalent" was the natural
verdict, and ties were frequent.

Here the task was "answer this open-ended request". A pairwise judge comparing two
essays will essentially always find something to prefer: more detail, a better
example, one fewer unsupported claim. The judge did its job well — the S1 verdict
correctly identifies that one answer's correctness proof was asserted rather than
derived, and that it closed with a fabricated citation.

But **"opus wrote a better essay" is not "sonnet failed the user."** The metric was
named `adequateRate` while measuring relative preference. For a router, only adequacy
matters. The right question is asked of one response at a time — *is this sufficient
for the request?* — not of a pair.

### Cause 2: the corpus does not contain the task types in question

Tagged distribution of the 21 resolved samples:

```
code_write 9 | conversational 3 | analysis 3 | planning 2
code_debug 2 | explanation 1 | code_review 1
```

Zero extraction, classification, formatting, translation, or summarization — exactly
the task types where haiku would plausibly be adequate. A corpus drawn from developer
coding sessions cannot contain them.

This was predicted before launch and the run was started anyway. The tagging pass
should have been a gate: inspect the distribution, then decide whether generating is
worth it.

## Privacy failure

Four judge calls were blocked by the safety classifier, correctly. Widening the corpus
to all local projects pulled in content that was never work material:

- private LinkedIn correspondence with a named third party
- personal business planning notes

Consent had been obtained for the **source** ("all projects"), described at the time
as work repositories. It was not obtained — and could not have been given by the third
party at all — for sending that content to evaluation calls.

**Rule adopted:** when a corpus sweep crosses project boundaries, inspect what the
sweep actually captured *before* it is sent anywhere, and describe the captured
content rather than the directory it came from. Naming the source is not the same as
naming the data. The extracted file was deleted; the widened extraction script is not
committed to this repository.

## The one signal that survives

Haiku lost **clearly** in 20 of 21 comparisons (95%); sonnet in 12 of 23 (52%). That
gap is too large to be explained by the metric flaw alone, and it is consistent with
the agentic run.

**Ordering holds: haiku ≪ sonnet < opus on open-ended developer requests.** So a
demotion gate to haiku must not fire on open-ended work. It says nothing about the
simple task types, which remain unmeasured.

## How to do it correctly, if revisited

1. **Absolute adequacy judging.** Show one response and the request; ask "does this
   adequately serve the request?" — yes/no, judge blind to model. Ties stop being an
   artifact of pairwise comparison.
2. **Gate on the tagging pass.** Inspect task-type coverage before spending any
   generation budget; abort if the types under investigation are absent.
3. **Corpus must span task types**, which a developer-session corpus cannot do.
   Either construct one (and label it constructed) or use a public prompt corpus.
4. **Inspect content before it leaves the machine** if the sweep crossed into personal
   data.

## Consequence for the design

The single-turn branch of the router is built **conservatively rather than optimally**,
because its boundary is unmeasured: sonnet is the default, and demotion to haiku fires
only on a narrow conjunction of explicit simplicity signals. That is a deliberate
choice recorded here so it is not mistaken for a tuned result.
