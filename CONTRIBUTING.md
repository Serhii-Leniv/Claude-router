# Contributing to claude-router

Thanks for taking the time to contribute! 🎉 This guide gets you from a fresh clone to a merged pull request with as little friction as possible.

`claude-router` is a routing layer for the Claude API: it classifies each request by complexity and routes it to the cheapest model that can handle it (Haiku / Sonnet / Opus), reporting exact cost and savings on every call. The routing engine — classifier, cost model, tier fallback, and retry/escalation — is the project's own; it builds on the official `@anthropic-ai/sdk` purely as the transport to Anthropic (and its Bedrock/Vertex siblings), staying drop-in compatible so any Anthropic-SDK app can adopt it with zero code changes. It ships both as a library and as an HTTP proxy.

## TL;DR

```bash
git clone https://github.com/Serhii-Leniv/Claude-router.git
cd Claude-router
npm install
npm test        # build + run the full suite (no network, no API key needed)
```

Then branch, make your change **with a test**, and open a PR. That's it.

## Prerequisites

- **Node.js 18+** (CI runs on 18 and 22). Node 21+ runs `node --test` globs natively; on older versions the suite is driven by `scripts/run-tests.mjs`, so just use `npm test`.
- **npm** (the repo uses `package-lock.json`; CI runs `npm ci`).
- No Anthropic API key is required to build or test — every test is a pure unit test with mocked clients.

## Development workflow

```bash
npm run build     # TypeScript → dist/  (Windows-safe chmod via node)
npm test          # build, then run all tests (node:test)
npm run dev       # tsc --watch for a tight edit loop
npm run proxy     # run the built proxy CLI locally (build first)

# run a single test file after building:
node --test dist/__tests__/classifier.test.js
```

### Project layout

| Path | What lives there |
|------|------------------|
| `src/index.ts` | `ClaudeRouter` class, `createRouter()` factory, re-exports |
| `src/classifier.ts` | Heuristic / AI / hybrid routing, LRU-cached `classify()` |
| `src/models.ts` | Pricing constants, `computeCostCents()`, tier→model mapping |
| `src/params.ts` | `normalizeParamsForTier()` — strips model-coupled params |
| `src/retry.ts` | `shouldRetry()` truncation/refusal escalation |
| `src/proxy/` | Hono HTTP proxy, CLI, daemon, per-OS install |
| `src/__tests__/` | All tests (`node:test`, no external framework) |

`CLAUDE.md` in the repo root is the deep-dive architecture reference — read it before touching the classifier, pricing, or proxy internals.

## Coding conventions

- **TypeScript, strict.** ES2022 target, Node16 module resolution.
- **Internal imports use the `.js` suffix** (e.g. `import { classify } from './classifier.js'`) even though the source is `.ts` — this is required by Node16 resolution. New files must follow it.
- **Match the surrounding code** — naming, comment density, and idiom. Keep functions small and pure where the existing code is.
- **Pricing is load-bearing.** If you touch `src/models.ts`, double-check the family pricing table against current Claude pricing — a wrong number silently corrupts every savings figure. See the pricing notes in `CLAUDE.md`.
- **The proxy binds `127.0.0.1` by default.** That's a security boundary (with Bedrock/Vertex it uses the operator's cloud credentials and doesn't authenticate callers). Don't change the default bind.

## Tests are required

Every behavior change needs a test. The suite is fast (~1s) and uses only `node:test` + `node:assert` — no Jest, no network.

- Add or extend a file under `src/__tests__/`.
- Router/proxy tests mock the SDK client directly (see existing tests for the pattern) — **no real API calls**.
- Run `npm test` and make sure the whole suite is green before pushing. CI runs the same suite across Linux/macOS/Windows on Node 18 and 22, so prefer cross-platform code (avoid shelling out to Unix-only tools).

If you fix a bug, add a regression test that fails before your fix and passes after.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
fix(proxy): forward anthropic-beta header on routed requests
feat(classifier): add configurable hybrid band
docs: clarify install on Linux
test(retry): cover missing usage field
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`. Scope is optional but helpful (`proxy`, `classifier`, `install`, `models`, …). Keep the subject imperative and under ~72 chars; put the *why* in the body.

## Pull requests

1. **Branch** off `master` (e.g. `fix/count-tokens-404`).
2. Keep the PR **focused** — one logical change. If you're fixing several independent things, prefer separate commits (or separate PRs) so each can be reviewed and reverted on its own. PR #13 is a good template: one commit per numbered problem.
3. Fill out the PR template — link the issue it fixes (`Fixes #NN`), say what you changed and why, and how you verified it.
4. Make sure `npm test` passes locally and CI is green.
5. Update `CHANGELOG.md` under `## [Unreleased]` if your change is user-visible.
6. A maintainer reviews before merge. **`master` is protected** — PRs merge by **squash** after an approving review and green CI. No direct pushes.

> First-time contributors: CI won't run automatically on your first PR until a maintainer approves the workflow run — this is a GitHub default for forks, not a problem with your PR.

## Reporting bugs & requesting features

Open an [issue](https://github.com/Serhii-Leniv/Claude-router/issues) using the templates. For bugs, the most useful thing you can include is a minimal repro and the output of `claude-router doctor`. For security-sensitive reports, please **do not** open a public issue — see `SECURITY.md`.

## Questions

Not sure where something goes, or whether an idea fits? Open a [discussion](https://github.com/Serhii-Leniv/Claude-router/discussions) or a draft PR and ask. We'd rather help early than have you guess.

---

By contributing, you agree that your contributions are licensed under the repository's [MIT License](LICENSE).
