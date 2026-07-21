# Literature review: routing vs cascading, heuristic vs semantic

**Date:** 2026-07-21
**Method:** 6 search angles, 23 sources fetched, 115 claims extracted, 25 put through
3-vote adversarial verification. 14 confirmed, **11 refuted**.

The refuted list matters as much as the confirmed one — it contains the arguments
that would most easily have justified the current design.

## Confirmed findings

### 1. Learned routers beat random, but the margin is entirely traffic-dependent

RouteLLM (Ong et al., ICLR 2025) — CPT(50%) strong-model call fractions against a
~50% random baseline:

| Benchmark | Best router | Random |
|---|---:|---:|
| MT Bench | 13.4% | ~49% |
| MMLU | 35.4% | ~50% |
| GSM8K | 33.6% | ~50% |

Cite the raw call fractions, not the paper's prose — it mixes relative and
percentage-point units. The MT Bench and MMLU winners are *different architectures*
(matrix factorisation vs causal-LLM classifier).

**Transfer caveat that governs everything below:** RouteLLM routes GPT-4 vs
Mixtral-8x7B — ~50x cost gap, cross-vendor, cross-capability-class. claude-router's
main path is sonnet-5 vs opus-4.8: ~5x, same vendor, same generation. Router headroom
scales with the capability gap. **Do not quote 75% / 85% / 3.66x as expected savings
here.**

Sources: [arXiv:2406.18665](https://arxiv.org/pdf/2406.18665),
[ICLR camera-ready](https://proceedings.iclr.cc/paper_files/paper/2025/file/5503a7c69d48a2f86fc00b3dc09de686-Paper-Conference.pdf)

### 2. Every measured winner is a learned model — keyword heuristics appear nowhere

RouteLLM's design space: similarity-weighted ranking, matrix factorisation, BERT
classifier, causal-LLM classifier. No lexical-feature router is evaluated anywhere in
the surveyed literature. Our heuristic is not at the bottom of a ranking; it is
outside the ranking.

### 3. Learned routers collapse off-distribution — this is the decisive constraint

On MMLU, **all** RouteLLM routers performed at random-router level when trained on
Arena data alone: *"all routers perform poorly at the level of the random router...
which we attribute to most MMLU questions being out-of-distribution"*. Adding ~1,500
in-domain labelled samples (<2% of training data) moved every router to ~20% better
than random.

The failure is along the **query-distribution** axis, not the model-pair axis — the
same routers generalise across model pairs without retraining.

**Consequence:** building a learned/semantic up-front router for claude-router now
would reproduce the exact configuration that measured at random — no labels, and
traffic further off-distribution from chat preference data than MMLU is.

### 4. "Routing beats cascading" is weaker than it is usually cited

RouteLLM never evaluated a cascade baseline. Its preference is a stated design
assertion about latency: *"These methods rely on multiple LLM queries, which can
increase latency. In contrast, our approach routes each query to a single LLM."*
Anyone citing RouteLLM as measured evidence against cascades is over-reading it.

The one paper that *does* find pre-generation routing beats cascading
([arXiv:2605.06350](https://arxiv.org/abs/2605.06350), May 2026, single-author
preprint) carries three qualifications that invert it for our case:

1. its winning router is self-described as *"a diagnostic baseline, not a
   state-of-the-art learned-routing claim"*;
2. its cost accounting **excludes the embedding model** (*"Monetary cost is not
   incurred by the open-source sentence-transformer embedding"*) — our classifier
   call is free in neither cost nor latency;
3. it explicitly states cascading stays competitive **when pre-generation features
   are uninformative**, with TriviaQA (embedding AUROC ~0.49) as its own counterexample.

### 5. Cascade viability is a property of the verifier, not of the architecture

RouterBench ([arXiv:2403.12031](https://arxiv.org/pdf/2403.12031)) formalises the
escalation judge as *"a scoring function g:text→[0,1] paired with a threshold t"* and
labels its own positive cascade result an oracle: *"the router possesses perfect
knowledge of the final score"*. Cascade gains hold at judge error ~0.1 and
**deteriorate rapidly above ~0.2**.

`shouldRetry()` **is** g paired with t. The 0.2 error rate is therefore a concrete
design target, not an analogy.

### 6. Even a trained verifier misfires about half the time

"Cluster, Route, Escalate" (Moslem et al., June 2026): a ModernBERT-base classifier
trained on **45,000 task-correctness labels** escalated ~202 of 590 queries with ~104
false positives vs ~98 true positives — a **51% false discovery rate**. The cascade
was still net-positive (68.9% → 74.0% on the cheap cluster).

Both halves must travel together: the FDR is bad *and* the cascade still won.

### 7. Self-verification carries signal only when its own noise is modelled

AutoMix (NeurIPS 2024): >50% cost reduction at comparable performance — but via a
POMDP meta-verifier that explicitly models verifier noise. The surveyed 2026 routing
survey states both halves: *"previous work finds self-verification unreliable"* yet
*"AutoMix demonstrates that few-shot self-verification provides a valuable signal."*

### 8. No calibrated-confidence signal is available to us

Cascade-optimality theory requires a continuous confidence score; the papers use
log-probabilities. **The Anthropic Messages API exposes no logprobs.** Any
calibrated-threshold design must first invent that signal (self-verification score,
sampled-answer consistency, a judge call) — and its cost counts against escalation
savings, a cost the cited papers excluded from their accounting.

## Refuted claims (0-3 votes unless noted)

These did **not** survive verification. Listed because each is an argument someone
would reasonably reach for:

| Refuted claim | Why it matters |
|---|---|
| RouteLLM's headline "85% / 45% / 35% fewer GPT-4 calls" | Baseline conflation — measured against GPT-4-only, not against random |
| "A small quality gap implies a favourable routing regime, so sonnet-vs-opus is favourable" | This is the most tempting justification for the whole project. It is unsupported. |
| Soft/probabilistic labels beat hard binary labels for routers | Would have justified emitting a calibrated probability |
| Hybrid-LLM DeBERTa: 40% fewer large-model calls at no quality drop | Would have justified a learned pre-execution router |
| Matrix factorisation is *intrinsically* the best router architecture | Its edge is attributed partly to data scarcity |
| Cascading is specifically advantageous under widely-varying query difficulty | Would have been the structural argument for cascades |
| Two-stage route-then-cascade retains 97-99% of strongest-model accuracy | Would have justified the hybrid directly |
| Learned binary strong/weak routing cuts cost >2x while preserving quality | Would have justified the binary framing |
| Routing gains collapse on homogeneous technical traffic | Would have argued *against* agentic routing |
| RouterBench judge-error cliff (1-2 vote) | Survives in restated form as finding 5 above |
| No routing algorithm beats the Zero-router baseline (1-2 vote) | Would have argued the whole category is low-value |

## Source-quality caveat

Only RouteLLM (ICLR 2025) and AutoMix (NeurIPS 2024) are peer-reviewed. The two most
decision-relevant papers for routing-vs-cascading are unreviewed preprints one to two
months old. RouterBench is also a preprint.

**Nothing in the evidence base measures agentic traffic.** Not one source evaluates
multi-turn tool-use sessions, harness-dominated prompts, or coding agents.
LiveCodeBench is the closest and is single-shot code generation. Every statement
about Claude Code traffic derived from this review is mechanism-based extrapolation.

## Open questions this review could not close

1. What is the actual false-positive rate of `shouldRetry()` on real traffic?
   (Partly answered by [detector-measurement.md](2026-07-21-detector-measurement.md):
   the fire rate itself is zero on the available corpus.)
2. Does per-turn complexity classification work at all inside an agentic loop, where
   difficulty lives in accumulated context the classifier never sees? No source
   evaluates session-level vs turn-level vs sticky-within-session routing.
3. Can a usable continuous confidence signal be built without logprobs?
4. Does escalating actually resolve refusals, and does the answer differ by refusal
   class? Escalation is only rational for capability limits; a safety-policy refusal
   will likely reproduce at the higher tier at 5x cost.
5. Is the achievable savings envelope on a ~5x same-generation gap large enough to
   justify any routing machinery? (Addressed by
   [tier-ceiling.md](2026-07-21-tier-ceiling.md).)
