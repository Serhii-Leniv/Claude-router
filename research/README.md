# Research

Measurements and literature review behind the routing design. Everything here is
dated and reproducible — the point is that future routing decisions cite evidence
rather than intuition.

**This directory is not published.** `docs/` is deployed to GitHub Pages in full;
this is deliberately outside it.

## Index

| Document | Date | What it establishes |
|---|---|---|
| [routing-architecture.md](2026-07-21-routing-architecture.md) | 2026-07-21 | Literature review: what measured comparisons say about heuristic vs semantic vs learned routers, and about routing vs cascading. 23 sources, adversarially verified. |
| [detector-measurement.md](2026-07-21-detector-measurement.md) | 2026-07-21 | The shipped refusal/truncation detectors fire **zero times** on 35,314 real Claude Code responses. |
| [tier-ceiling.md](2026-07-21-tier-ceiling.md) | 2026-07-21 | Head-to-head: can haiku/sonnet replace opus on real turns? Blind-judged matched pairs. |

## Reproducing

Scripts live in [`scripts/`](scripts/). They read local Claude Code transcripts
(`~/.claude/projects/**/*.jsonl`) and make no network calls.

```bash
npm run build                                    # detectors are imported from dist/
node research/scripts/measure-detectors.mjs      # aggregate counts only, no content
node research/scripts/sample-turns.mjs           # extract turns for head-to-head runs
```

`measure-detectors.mjs` reads aggregate counts and never emits transcript content.
`sample-turns.mjs` **does** extract conversation content, and is scoped to this
project's own transcripts for that reason — widen `ROOT` deliberately, not by default.

## Standing caveats

These apply to every measurement here and are repeated in each document:

- **Corpus is one developer's machine.** 981 sessions across ~20 projects is a
  reasonable spread, but it is one person's working style.
- **Corpus is direct Claude Code usage, not routed traffic.** Nobody has run
  production traffic through the router, so no measurement here observes the
  router's own decisions in the wild.
- **Corpus is opus-dominated** (83% opus-4.8, 16% fable-5). Findings about how
  cheaper tiers behave are inferred from head-to-head runs, not from observed
  production behaviour of those tiers.
- **Claude Code traffic is the secondary target.** The primary target is direct
  API traffic — single-turn, no large harness, no tool loop. No measurement here
  covers that profile. Treat every finding as evidence about the secondary case
  until that gap is closed.
