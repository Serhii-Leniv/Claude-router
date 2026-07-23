# Detector measurement: the escalation path never fires

**Date:** 2026-07-21
**Method:** ran the shipped detectors over local Claude Code transcripts. Zero API calls, nothing left the machine.
**Script:** [`scripts/measure-detectors.mjs`](scripts/measure-detectors.mjs)

## Corpus

981 transcript files, 106,102 records, **35,314 completed assistant responses**
(`stop_reason` present).

| Model | Responses |
|---|---:|
| claude-opus-4-8 | 29,295 (83%) |
| claude-fable-5 | 5,642 (16%) |
| claude-haiku-4-5 | 330 |
| claude-sonnet-5 | 24 |

## Result

| Detector | Fires |
|---|---:|
| Structural refusal (`stop_reason === 'refusal'`) | **0** |
| Lexical refusal (`REFUSAL_PATTERNS`) | **0** |
| Truncation (`stop_reason === 'max_tokens'`, >20 output tokens) | **0** |

`stop_reason` distribution: `tool_use` 32,587 (92.3%), `end_turn` 2,704 (7.7%),
`stop_sequence` 23. No `max_tokens`. No `refusal`.

## Why the lexical path is structurally near-inert

`shouldRetry` only scans responses under 200 characters. Of the 2,704 `end_turn`
responses:

- 1,768 carry text (936 are pure `tool_use`/`thinking` with no text block)
- of those, **141 (8.0%)** are under the 200-char guard

Median final answer is **1,589 chars** (p90 8,989, p99 20,301).

So the lexical scan examines **141 of 35,314 responses — 0.4% of the corpus** — and
found no refusals in them.

The structural check added in #22 sits *before* that guard, so its coverage is 100%
against the lexical path's 0.4% — a 250x difference in reach. That is the strongest
argument for the structural signal, and it is now measured rather than asserted.

## The zero is not a measurement bug

The detector was validated through the same import path used for the corpus run:

| Control input | Result |
|---|---|
| `"I can't help with that."` | `{retry: true, reason: 'refusal'}` |
| `"Ich kann dabei nicht helfen."` | `{retry: true, reason: 'refusal'}` |
| `stop_reason: 'max_tokens'`, 50 output tokens | `{retry: true, reason: 'truncation'}` |
| `"The answer is 42."` | `{retry: false, reason: null}` |

## What this does and does not establish

**Established:** the truncation detector is inert on this traffic regardless of
which tier serves it — `max_tokens` is a client-set ceiling and Claude Code sets it
high. The lexical path's 0.4% coverage is a property of response lengths, not of
model choice.

**Not established:** the refusal rate on haiku/sonnet. This corpus is 83% opus,
which refuses less than cheaper tiers. Zero refusals from opus does not imply zero
from haiku.

## Consequences taken

- The queued per-language refusal-pattern work (es/fr/pt/uk, following #3 and #20)
  is deprioritised — those patterns extend a path with no observed activations.
- [#1](https://github.com/Serhii-Leniv/claude-router/issues/1) (streaming refusal
  escalation) was annotated with this data and left open but deprioritised.
- [#22](https://github.com/Serhii-Leniv/claude-router/issues/22) / PR #25 shipped
  anyway: the structural signal is strictly cheaper and wider than the lexical one,
  and it is the path that would fire first if refusals do appear on cheaper tiers.
