# Research

Measurements and literature review behind the routing design. Everything here is
dated and reproducible — the point is that future routing decisions cite evidence
rather than intuition.

**This directory is not published.** `docs/` is deployed to GitHub Pages in full;
this is deliberately outside it.

## Index

- [`2026-07-25-live-session.md`](2026-07-25-live-session.md) — one live Claude Code session: $3.34 vs $4.23 all-Opus (21%). n=1, figures only.

| Document | Date | What it establishes |
|---|---|---|
| [routing-architecture.md](2026-07-21-routing-architecture.md) | 2026-07-21 | Literature review: what measured comparisons say about heuristic vs semantic vs learned routers, and about routing vs cascading. 23 sources, adversarially verified. |
| [detector-measurement.md](2026-07-21-detector-measurement.md) | 2026-07-21 | The shipped refusal/truncation detectors fire **zero times** on 35,314 real Claude Code responses. |
| [tier-ceiling.md](2026-07-21-tier-ceiling.md) | 2026-07-21 | Head-to-head: can haiku/sonnet replace opus on real turns? Blind-judged matched pairs. **Agentic traffic only.** |
| [end-to-end-savings.md](2026-07-21-end-to-end-savings.md) | 2026-07-21 | **First measurement of the router operating.** Published 0.2.2 replayed over 200 real turns: 35.4% projected saving, upper bound. |
| [single-turn-failed.md](2026-07-21-single-turn-failed.md) | 2026-07-21 | ❌ Failed attempt to measure the same boundary on single-turn requests. Pairwise judging cannot measure adequacy on open-ended tasks. Read before designing another run. |

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

### Wire capture

Transcripts are **not** a substitute for what Claude Code sends. They store what
the user typed; the harness injects CLAUDE.md, skill and agent rosters at API-call
time. Of 444 transcript files for this repo, 6 contain `<system-reminder>` and 2
contain the CLAUDE.md injection — which is why the 200-turn replay below showed
197 sonnet / 3 opus and never surfaced #34, where injected text was deciding the
tier on every request. Two rounds of that bug (#18, #34) shipped for this reason.

```bash
node research/scripts/record-wire.mjs            # forwards to the real API, records requests
export ANTHROPIC_BASE_URL=http://127.0.0.1:4200  # then work normally
node research/scripts/analyze-wire.mjs           # replay the corpus through routeByEvidence
```

`record-wire.mjs` does **not** route — it records and forwards, so collecting a
corpus cannot change which model serves real work. The corpus contains full
prompts, source code and tool output; it is written to `~/.claude-router/wire`,
outside the repository, and should be deleted after the measurement.

`analyze-wire.mjs` reports **leaks first** — harness text that reached scored task
text, by channel — because that is the failure mode that has shipped twice, and a
healthy-looking tier distribution is exactly what it produces.

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
