# Shrike CI

Shrike is to PRs as Linear is to Issues. This repository is the open source runner: the review engine and the GitHub Action that runs it inside your own CI. Which reviews run, their instructions, the model, the session mode and whether Shriken writes the summary are configured on the Shrike website and fetched at run time, so the workflow file carries no settings.

## Add Shrike to a repository

1. Sign in on the Shrike website with GitHub and open the repository. The page shows the API URL and lets you pick the reviews.
2. Add a repository variable `SHRIKE_API_URL` with that URL.
3. Create `.github/workflows/shrike.yml`:

```yaml
name: Shrike
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  repository_dispatch:
    types: [shrike]
concurrency:
  group: shrike-${{ github.event.pull_request.number || github.event.issue.number || github.event.client_payload.pr }}
  cancel-in-progress: false
jobs:
  review:
    if: github.event_name != 'issue_comment' || (github.event.issue.pull_request && contains(github.event.comment.body, '@shrike'))
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      checks: write
      issues: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: AfterMatter/shrike-ci/action@main
        with:
          api_url: ${{ vars.SHRIKE_API_URL }}
```

`id-token: write` lets the job mint a GitHub OpenID Connect token. The Action sends it to the API, which verifies it against GitHub's public keys and answers with the settings and review instructions of exactly that repository. No secret is stored in the repository. To use a paid provider add its key to the job environment, for example `ANTHROPIC_API_KEY`, and pick the model on the website.

### What happens on a pull request

1. The Action asks the API for the repository's settings and the instructions of the reviews to run.
2. A sticky `Shrike` comment lists every review and its status, updated after each one.
3. Each review gets the repository checked out at the PR head, the full diff and its instructions, in a fresh agent session or in the shared session when that mode is on.
4. Each review posts one pull request review with inline comments on changed lines, findings outside the diff in the review body, and one check run named `shrike/<review>`.
5. When at least one review produced a report and the `shriken` setting is on (the default), Shriken runs once more with the reviews' numbered findings, the commits, the discussion, the linked issues and pull requests and the images of the description. It writes two or three short paragraphs for the human reviewer, with at most three blocks between them (a diff excerpt, a suggestion taken from a finding or an image from the description), each claim carrying an inline reference token such as `[finding:code-review#2]`, `[commit:abc1234]` or `[file:src/a.ts:12]`. The summary goes to the Shrike website only, where the tokens become links; on GitHub it leaves just a `shrike/shriken` check run and its row in the status comment. `shriken` is a reserved name and cannot be requested as a review.
6. When the `autofix` setting is `ci` or `all`, or the run was asked for with `@shrike autofix` (or `@shrike autofix ci`), or the head commit is an earlier autofix commit, Shrike waits for the other checks of the head commit (up to 30 minutes), then opens a session that may edit files and run commands. In `ci` mode it acts only when every Shrike review passed and fixes the failing checks from their job logs; in `all` mode it also resolves the findings of the reviews. It commits the working tree as the Shrike GitHub App with a `Shrike-Autofix: <mode>` trailer and pushes to the pull request branch with a token minted by the API, so the checks and Shrike run again on the new commit and the loop continues until everything is green, the agent changes nothing, or `autofixLimit` autofix commits sit in a row at the head (a human commit resets the count). Changes under `.github/workflows` are discarded, forks are refused, and the attempt is reported as the reserved `autofix` run with a `shrike/autofix` check. The Shrike GitHub App needs contents write and actions read on the repository.
7. Every finished review, the Shriken run and the autofix run are reported back to the API so the website shows history and cost. One JSON report per run is also written to the `reports` output directory.

### Triggers

| Event | Behaviour |
| --- | --- |
| PR opened, reopened, synchronize, ready for review | runs the configured reviews in order |
| Comment `@shrike` on a PR | runs the configured reviews |
| Comment `@shrike security-review cleanup` | runs only those reviews, in that order |
| Comment `@shrike autofix` or `@shrike autofix ci` | runs the configured reviews, then one autofix attempt in `all` or `ci` mode that keeps going on the next pushes until green or the limit |
| `repository_dispatch` type `shrike` | runs the job sent by the Shrike GitHub App |

Draft pull requests are skipped until marked ready for review. Pull requests from forks get a read only token, so results cannot be posted for them with the default token.

### Action inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `api_url` | required | Shrike API base URL from the website |
| `github_token` | `${{ github.token }}` | token used to read the PR and post results |
| `opencode_version` | pinned | OpenCode CLI version for the `acp` backend |

## Layout

```
core/       review engine: job model, prompt, report contract, diff, checkout, GitHub client, runner, settings client, backends/acp
action/     composite GitHub Action around the engine
```

The hosted API, the website, the review instructions and the GitHub App webhook live in the private `shrike` repository, which consumes `core/` from here.

## Develop

```bash
bun install
bun run typecheck
bun test
```

The `acp` backend needs the OpenCode CLI on `PATH` (`bun add -g opencode-ai`).
