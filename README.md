# Shrike CI

Shrike is to PRs as Linear is to Issues. This repository is the open source runner: the review engine and the GitHub Action that runs it inside your own CI. Which reviews run, their instructions, the model and the session mode are configured on the Shrike website and fetched at run time, so the workflow file carries no settings.

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
5. Every finished review is reported back to the API so the website shows history and cost. One JSON report per review is also written to the `reports` output directory.

### Triggers

| Event | Behaviour |
| --- | --- |
| PR opened, reopened, synchronize, ready for review | runs the configured reviews in order |
| Comment `@shrike` on a PR | runs the configured reviews |
| Comment `@shrike security-review cleanup` | runs only those reviews, in that order |
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
