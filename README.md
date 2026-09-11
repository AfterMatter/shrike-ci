# Shrike

Shrike is to PRs as Linear is to Issues. This repository holds the bot, its skills and the GitHub Action. Every pull request gets reviewed by a sequence of skills, one agent session per skill, in the order you configure.

## Add Shrike to a repository

Create `.github/workflows/shrike.yml`:

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
    steps:
      - uses: actions/checkout@v4
      - uses: AfterMatter/shrike-ci/action@main
        with:
          skills: code-review, slop-review, security-review
```

That is the whole install. With no secrets the `acp` backend runs OpenCode on a free OpenCode Zen model. To use a paid provider set the model and the provider key:

```yaml
      - uses: AfterMatter/shrike-ci/action@main
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          model: anthropic/claude-sonnet-4-5
```

### What happens on a pull request

1. A sticky `Shrike` comment lists every skill and its status, updated after each one.
2. Each skill opens its own agent session with the repository checked out at the PR head, the full diff, and the skill's instructions.
3. Each skill posts one review with inline comments on changed lines, findings outside the diff in the review body, and one check run named `shrike/<skill>`.
4. One JSON report per skill is written to the `reports` output directory.

### Triggers

| Event | Behaviour |
| --- | --- |
| PR opened, reopened, synchronize, ready for review | runs the configured skills in order |
| Comment `@shrike` on a PR | runs the configured skills |
| Comment `@shrike security-review cleanup` | runs only those skills, in that order |
| `repository_dispatch` type `shrike` | runs the job sent by the Shrike GitHub App |

Draft pull requests are skipped until marked ready for review.

### Action inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `skills` | `code-review, slop-review, security-review` | ordered skill names |
| `backend` | `acp` | agent backend |
| `model` | backend default (`opencode/big-pickle`) | `provider/model` id |
| `github_token` | `${{ github.token }}` | token used to read the PR and post results |
| `opencode_version` | pinned | OpenCode CLI version for the `acp` backend |

Pull requests from forks get a read only token, so results cannot be posted for them with the default token.

## Skills

Built in skills live in [`skills/`](skills): `code-review`, `slop-review`, `security-review`, `cleanup`, `react-doctor`, `suggest-changes`. A skill is a directory with a `SKILL.md` following the [Agent Skills](https://agentskills.io/specification) format: `name` and `description` in the frontmatter, review instructions in the body. The runner appends the PR context and the JSON output contract.

A repository can add or override skills in `.shrike/skills/<name>/SKILL.md`. Repository skills take precedence over built in ones with the same name.

## GitHub App webhook (optional)

The App is the central trigger for the dashboard and lets one server fan out to many repositories. Register a GitHub App with:

- Webhook URL: `https://<host>/webhooks`, with a webhook secret
- Repository permissions: Contents read and write, Pull requests read and write, Checks read and write, Issues read and write, Metadata read
- Subscribe to events: Pull request, Issue comment, Pull request review comment

Run the server:

```bash
GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY="$(cat key.pem)" GITHUB_WEBHOOK_SECRET=... bun run bot
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `SHRIKE_RUNNER` | `actions` | `actions` sends a `repository_dispatch` to the repository's workflow, `local` runs skills on this machine |
| `SHRIKE_SKILLS` | built in default | skill order for `local` runs |
| `SHRIKE_BACKEND` | `acp` | backend for `local` runs |
| `SHRIKE_MODEL` | backend default | model for `local` runs |
| `SHRIKE_WORKDIR` | `.shrike/work` | clone directory for `local` runs |
| `PORT` | `3000` | listen port |

## Layout

```
bot/        webhook, runner, skill loader, backends/acp (temporary)
skills/     built in SKILL.md files
action/     GitHub Action wrapper around the runner
documentation/  layout, agent harness contract and swap plan, phase status
```

## Develop

```bash
bun install
bun run typecheck
bun test
```

The `acp` backend needs the OpenCode CLI on `PATH` (`bun add -g opencode-ai`).
