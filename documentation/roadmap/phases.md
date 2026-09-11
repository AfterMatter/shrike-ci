# Phases

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Skill runner and OpenCode ACP backend running one review over a PR diff | done |
| 2 | Composite Action and webhook server running reviews in order and posting reviews, checks and a status comment | done, verified on pull request 1 |
| 3 | Everything from the app: Supabase, API with GitHub OIDC, review instructions served by the API, website, see `phase-3-settings.md` | done in shrike-ci, shrike assembled, live Supabase and OIDC unverified |
| 3b | Hosted App: register the GitHub App, host the server, durable queue, sandbox per job | planned |
| 4 | Internal reviews: correctness, regressions, tests, before and after media, hardening, see `internal-reviews.md` | planned |
| Backend swap | Replace OpenCode with a paid or custom harness, see `../backends/harness.md` | planned, starts with 3b |
| Later | CI autofix and PR autofix, custom skills from a repository URL, self hosted runner for long jobs | not started |

## Open decisions

- Repository split is done: public `shrike-ci` and private `shrike`, see `../architecture/layout.md`.
- Which paid model becomes the default once the hosted bot exists.
- Fresh or shared agent session across reviews, decided by the evaluation set.

## Known limits today

- Pull requests from forks get a read only token on Actions, so nothing can be posted for them until the App path exists.
- The App path is unit tested with real signatures but has not run against a live GitHub App yet.
