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
jobs:
  review:
    if: ${{ !github.event.comment || (github.event.comment.user.type != 'Bot' && startsWith(github.event.comment.body, 'shrike')) }}
    concurrency: shrike-${{ github.event.pull_request.number || github.event.issue.number || github.event.client_payload.pr || github.event.client_payload.chat.id }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: AfterMatter/shrike-ci/action@main
        with:
          api_url: ${{ vars.SHRIKE_API_URL }}
```

`id-token: write` lets the job mint a GitHub OpenID Connect token. The Action sends it to the API, which verifies it against GitHub's public keys and answers with the settings and review instructions of exactly that repository. No secret is stored in the repository. The API then mints an installation token of the Shrike GitHub App for that repository, refreshed before it expires, and everything the run posts, the reviews, the checks, the comments and the media branch, carries the App's name. Without the App installed on the repository the Action falls back to the job token, which then needs `pull-requests: write`, `checks: write` and `issues: write` in the workflow and posts as `github-actions`. Free runs use OpenCode with its free `opencode/big-pickle` model. On a Shrike plan the repository picks a plan model on the website; the Action then leases a Vercel AI Gateway key from the API for that one job, capped at the account's credits, masks it in the log and hands it only to the pi agent, and releases it when the job ends. No model key is ever stored in the repository. Out of credits, the job falls back to the free model.

### What happens on a pull request

1. The Action asks the API for the repository's settings and the instructions of the reviews to run.
2. One sticky `Shrike` card is created or updated in place. While the reviews run it shows their progress; at the end it shows the verdict, one decision paragraph, the table of reviews with Shriken's score and links, the open problems with a `new` mark, the problems resolved since the last push, what each review wrote folded under its name (a comment question answered outside a thread shows open), the nits and the captures folded away, and a link to the pull request on the Shrike website. The card keeps the patch id of the reviewed diff: a later push whose diff has the same patch id, such as an update from main, gets a one line note on the card and Shrike's checks copied to the new commit, and no review runs.
3. Each review gets the repository checked out at the PR head, the full diff, its instructions and the open threads Shrike posted on earlier pushes, in a fresh agent session or in the shared session when that mode is on. Fresh sessions run three at a time. A review whose `paths` globs match no changed file is skipped with a green check. After a report with findings a second turn in the same session asks the agent to re-read each finding, confirm it from the code, and drop or downgrade what it cannot justify.
4. The verdict of a review is derived from its findings: an error fails the check, a warning marks it neutral, an info note is a nit and never blocks. The check `shrike/<review>` carries the top finding in its title and offers the Fix, Re-run and Ask actions in the merge box; the Shrike GitHub App turns them into the autofix of that review, the review or the ask job.
5. The findings of every review are merged by fingerprint, the path and the normalized text of the flagged line, so the same line flagged by two reviews becomes one thread naming both and a finding survives a line shift. Warnings and errors that match no open thread become one pull request review with one thread each; info findings go to the card's nits. A push with nothing new creates no review. Findings outside the diff appear on the card only. A finding that needs changes in several places carries them as related places: its thread sits at its own line with its suggestion and links every other place at the head commit, each with the change it needs.
6. Every open thread is judged by the agent as fixed, still open or wrong. Fixed and wrong threads get a reply naming the commit and are resolved, or minimized when the token cannot resolve. A thread a human replied to is only answered, never resolved. A thread a maintainer resolved without a Shrike reply counts as won't fix and its fingerprint is never raised again on that pull request.
7. When at least one review produced a report and the `shriken` setting is on (the default), Shriken runs once more with the reviews' numbered findings, the commits, the discussion, the linked issues and pull requests and the images of the description. It writes two or three short paragraphs for the human reviewer, with at most three blocks between them (a diff excerpt, a suggestion taken from a finding or an image from the description), each claim carrying an inline reference token such as `[finding:code-review#2]`, `[commit:abc1234]` or `[file:src/a.ts:12]`. The summary goes to the Shrike website only, where the tokens become links; on GitHub it leaves just a `shrike/shriken` check run and its row in the status comment. `shriken` is a reserved name and cannot be requested as a review.
8. When the `autofix` setting is `ci` or `all`, or the run was asked for with `shrike autofix` (or `shrike autofix ci`), or the head commit is an earlier autofix commit, Shrike waits for the other checks of the head commit (up to 30 minutes), then opens a session that may edit files and run commands. In `ci` mode it acts only when every Shrike review passed and fixes the failing checks from their job logs; in `all` mode it also resolves the findings of the reviews listed in `autofixReviews` (every review when the setting is unset) and acts only when the reviews it does not fix passed. `shrike autofix <review>...` and the Fix action of a review's check fix only the named reviews. It commits the working tree as the Shrike GitHub App with a `Shrike-Autofix: <mode>[ <review>...]` trailer, the reviews named when the run was asked for them, and pushes to the pull request branch with a token minted by the API, so the checks and Shrike run again on the new commit and the loop continues until everything is green, the agent changes nothing, or `autofixLimit` autofix commits sit in a row at the head (a human commit resets the count). Changes under `.github/workflows` are discarded, forks are refused, and the attempt is reported as the reserved `autofix` run with a `shrike/autofix` check. The Shrike GitHub App needs contents write and actions read on the repository.
9. When the `capture` setting is on, Shrike reads the diff and plans up to six pages whose rendering changes, with the steps to reach them. It then runs the `captureCommand` of the settings in a checkout of the base commit, waits for `captureUrl` to answer, and lets the agent drive a headless Chrome through the Playwright MCP server: a video of the pass and one screenshot per page, named `before-<page>.png`. It stops the app, does the same at the pull request head for the `after-` files, and commits everything to the `shrike-media` branch of the repository under `pr-<number>/<sha7>/`, as the Shrike GitHub App when it is installed, otherwise with the job token, which then needs `contents: write` in the workflow (a push with the job token starts no workflow, which is right for media). The card shows the pairs side by side in a folded section (as links on private repositories, where GitHub cannot render the files inline) and the reserved `capture` run carries the urls, so the website shows the pairs and Shriken may put one in its summary. The command must install what it needs and serve the app, for example `bun install && bun run dev`; the runner needs Chrome, which GitHub's Ubuntu images ship.
10. Every review, the capture, the Shriken run and the autofix run are reported to the API when they start, while they run, and when they finish, so the website follows them live and shows history and cost. One JSON report per run is also written to the `reports` output directory.

### Triggers

| Event | Behaviour |
| --- | --- |
| PR opened, reopened, synchronize, ready for review | runs the configured reviews in order |
| Comment `shrike` on a PR | runs the configured reviews |
| Comment `shrike security-review cleanup` | runs only those reviews, in that order |
| Comment `shrike autofix` or `shrike autofix ci` | runs the configured reviews, then one autofix attempt in `all` or `ci` mode that keeps going on the next pushes until green or the limit |
| Comment `shrike autofix code-review` (or `shrike autofix ci code-review`) | runs the configured reviews, then fixes only code-review's findings and the CI, whatever `autofixReviews` lists, like the Fix action of its check |
| Comment `shrike <anything else>` on a PR | runs the agent on the pull request: it answers in a comment and, when the ask needs code, commits to the pull request branch (a new pull request for forks) |
| Reply `shrike <question>` inside a review thread | runs the agent with the pull request and answers in that thread |
| Comment `shrike <task>` on an issue | runs the agent on the default branch; changes land on a new `shrike/...` branch with a pull request that closes the issue |
| Fix, Re-run or Ask on a `shrike/<review>` check | the Shrike GitHub App dispatches the autofix of that review, that review, or an agent answer that explains its findings |
| `repository_dispatch` type `shrike` | runs the job sent by the Shrike GitHub App, including chats started on the website |

`shriken`, `capture`, `autofix` and `agent` are reserved names and cannot be requested as reviews.

### The agent

A chat on the website, a free form comment and the Ask action all run the same agent. It sees the pull request or issue it was asked on, every open pull request (fetched as `pull/<n>`), the repository settings on Shrike and the earlier turns of a chat, and it may edit files and run commands. Its answer uses the Shriken reference tokens plus `[pull:<n>]` and `[settings:<key>]`, which the website turns into links; on GitHub they become plain references. It can offer buttons: a settings change the maintainer applies on the website with their own session, or a follow up ask. Shrike commits what it changed as the App without an autofix trailer, discards changes under `.github/workflows`, and reports the run as `agent`.

Draft pull requests are skipped until marked ready for review. Pull requests from forks get a read only job token, so without the App installed results cannot be posted for them.

### Action inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `api_url` | required | Shrike API base URL from the website |
| `github_token` | `${{ github.token }}` | job token, used only when the Shrike GitHub App is not installed |
| `opencode_version` | pinned | OpenCode CLI version for the `acp` backend |

## Layout

```
core/       review engine: job model, prompt, report contract, diff, checkout, GitHub client, threads, card, runner, capture, autofix, agent, settings client, backends (acp loop, opencode, pi), plans
action/     composite GitHub Action around the engine
```

The hosted API, the website, the review instructions and the GitHub App webhook live in the private `shrike` repository, which consumes `core/` from here.

## Develop

```bash
bun install
bun run typecheck
bun test
```

The `acp` backend needs the OpenCode CLI on `PATH` (`bun add -g opencode-ai`); the `pi` backend installs `pi-acp` and `@earendil-works/pi-coding-agent` on first use when they are missing.
