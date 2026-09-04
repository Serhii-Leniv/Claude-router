# Releasing

Every npm version must be reproducible from a tag on `master`. 0.3.2 and 0.3.3 were published by hand from a side branch and could not be; the `publish` workflow now refuses a tag that is not on `master` or does not match `package.json`.

## Checklist

1. `git checkout master && git pull` — release only from an up-to-date master.
2. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [x.y.z] — YYYY-MM-DD` and open a fresh empty `## [Unreleased]` above it. Pre-1.0: minor = features, patch = fixes.
3. `npm version x.y.z --no-git-tag-version` (updates `package.json` and the lockfile).
4. `npm test`, then `npm pack --dry-run` and compare the file list with the previous release (`npm view @sheruq/claude-router@latest dist.fileCount`).
5. Open a PR titled `chore(release): x.y.z` with those two changes; squash-merge it.
6. Tag the merge commit and push the tag:
   ```sh
   git checkout master && git pull
   git tag -a vx.y.z -m "x.y.z"
   git push origin vx.y.z
   ```
7. The `publish` workflow tests, verifies tag ⇔ version ⇔ master, publishes with provenance, and creates the GitHub release from the CHANGELOG section.
8. Confirm: `npm view @sheruq/claude-router gitHead` equals the tag's commit.

## Prerequisites (one-time)

- npm **trusted publishing** for `@sheruq/claude-router` pointing at `serhiileniv/claude-router` / `publish.yml`. Without it the publish step fails with an auth error and nothing is released.
- The `maintenance` label exists (the weekly `pricing-check` workflow applies it).

## Pricing freshness

`PRICING_LAST_CHECKED` in `src/models.ts` is a dated claim that the table was verified. Bump it whenever you re-verify, even with no changes. The weekly workflow opens an issue past 60 days; `claude-router doctor` warns past 90.
