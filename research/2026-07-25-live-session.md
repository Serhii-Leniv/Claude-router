# 2026-07-25 — one live Claude Code session through the proxy

**Status:** recorded figures, raw ledger not preserved. n = 1.

**Setup:** a sandboxed Claude Code session (v2.1.220) with the published proxy under `--force-route --session-model opus`, classifier `heuristic`, real API spend.

**Result:** the session cost **$3.34**. Priced against the all-Opus counterfactual — the same token counts on the model Claude Code had pinned on every request — it would have cost **$4.23**. A **21%** saving.

**Why this note exists:** the two figures were cited in `CLAUDE.md` and the 0.3.1 changelog as the reason the savings baseline moved from `defaultModel` to the model the client asked for (the old baseline reported this run as a **loss** of $0.80), but they had no dated write-up of their own. This is that write-up. It is honest about what it is: one session, one machine, figures copied from the run's `stats` output, no per-turn data kept.

**What it does not show:** that 21% is typical. The 35% in the [replay](2026-07-21-end-to-end-savings.md) is an upper bound from a different method; the two are not comparable and neither is a distribution.

**Reproduce:** [`sandbox/`](../sandbox/README.md) runs the same shape — Claude Code and the proxy in a container, ledger and wire capture kept — so the next figure can carry its data.
