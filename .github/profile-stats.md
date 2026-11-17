# Profile dashboard

The existing README layout, asset URLs, transparent backgrounds and light/dark palette are retained. All activity visuals now come from a single authenticated GitHub contribution snapshot. The snake follows a deterministic route over that snapshot; it does not fetch a separate public calendar.

## Access and private activity

Set the existing Actions secret `PROFILE_STATS_TOKEN` to a user token belonging to `bos-code`. Never put its value in source, an issue, a URL or a workflow input. The repository's built-in `GITHUB_TOKEN` can publish assets but cannot read unrelated private company repositories.

Use only read access approved for the repositories you want included. A classic token normally needs `read:user` for private contribution aggregates and `repo` for private repository language data and detailed PR counts; organization SSO may also require authorization. Fine-grained tokens require the appropriate selected repositories and organization approval, and may not cover every organization. The generator cannot grant access or establish that a token covers every repository. GitHub's profile setting for private contribution visibility also affects anonymous aggregates. Public artifacts contain aggregate numbers, language names and dates, never private repository identifiers or code.

Without the personal token, cards explicitly say `Limited access`. With it, cards say `Token-visible activity`; this is not a claim of complete private coverage. A wrong-owner, invalid or expired token fails the refresh rather than silently publishing public-only replacements. This repository's connector cannot inspect or create Actions secrets, so successful authenticated execution is required to verify deployment coverage.

## Metric definitions

- Contributions, commits, issues and reviews: GitHub's contributions collection over the trailing year. Contribution-calendar rules apply; commits on unmerged feature branches may not appear. Restricted contributions can appear anonymously in the calendar without a typed commit/PR/review breakdown. They are never added again to the calendar total.
- PRs opened: authored PRs created during the same period, across token-visible repositories. PRs merged: authored PRs merged during the period, including those opened earlier. These are different time cohorts; merged need not be less than opened.
- Streak: consecutive contributing days within the returned past-year calendar. An empty unfinished final day allows yesterday's streak to continue. This is not an all-time longest streak.
- Languages: byte totals across accessible, non-fork owned repositories plus repositories with commit/PR contributions in the period. Whole-repository language bytes describe project exposure, not personal lines written. Repositories are deduplicated. Private language data is only counted when GitHub actually returns it. The generator requests up to 100 contribution repositories per category; reaching that limit fails validation instead of claiming complete coverage. Owned repositories are paginated.
- Rank: GitHub Readme Stats' established one-year formula, using commits, PRs opened, issues, reviews, public stars on owned non-fork repositories, and followers. It is an activity score, not GitHub's endorsement or a skill rating. The score uses exponential normalization for commits/PRs/issues/reviews with medians 250/50/25/2 and weights 2/3/1/1; stars/followers use x/(1+x), medians 50/10 and weights 4/1. Grades follow the upstream S, A+, A, A-, B+, B, B-, C+, C thresholds. Partial visibility can lower a grade.

GitHub contribution API: https://docs.github.com/en/graphql/reference/users#contributionscollection

Formula source: https://github.com/anuraghazra/github-readme-stats/blob/master/src/calculateRank.js

## Refresh and validation

Scheduled daily at 03:15 UTC (04:15 WAT), on relevant main-branch pushes and manually through Actions. Tests also run on pull requests without the profile secret. Successful generation replaces the output snapshot in one publishing step. A failed refresh leaves the previous assets intact: their UTC timestamps expose age and the README workflow badge exposes the latest run status. GitHub image caches can delay visible changes.

Run `node --test .github/scripts/profile-stats.test.mjs` locally. Fixtures deliberately include private repositories, duplicate repository membership, restricted aggregate counts and incomplete access. They do not represent live account totals.

## Upstream rank license

MIT License

Copyright (c) 2020 Anurag Hazra

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
