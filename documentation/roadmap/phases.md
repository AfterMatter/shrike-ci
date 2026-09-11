# Phases

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Skill runner and OpenCode ACP backend running one skill over a PR diff | done |
| 2 | Composite Action and webhook server running skills in order and posting reviews, checks and a status comment | done, verified on pull request 1 |
| 3 | Hosted App: register the GitHub App, host the webhook server, durable queue, sandbox per job, per repo settings | planned |
| 4 | Dashboard and API | planned |
| Backend swap | Replace OpenCode with a paid or custom harness, see `documentation/backends/harness.md` | planned, starts with phase 3 |
| Later | CI autofix and PR autofix skills, custom skills from a repository URL, self hosted runner for long jobs | not started |

## Open decisions

- Repository split into public `shrike-ci` and private `shrike`, see `documentation/architecture/layout.md`.
- Which paid model becomes the default once the hosted bot exists.

## Known limits today

- Pull requests from forks get a read only token on Actions, so nothing can be posted for them until the App path exists.
- The App path is unit tested with real signatures but has not run against a live GitHub App yet.
