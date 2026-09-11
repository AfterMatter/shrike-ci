# Layout

Shrike is two repositories. `shrike-ci` is public and holds what runs in users' CI. `shrike` is private and holds the hosted service: API, database, website, review instructions and the GitHub App webhook. `shrike` consumes `core/` from this repository as a git submodule workspace.

## Folders in shrike-ci

| Path | Role | Depends on |
| --- | --- | --- |
| `core/src/backends/` | Agent runtime adapters. Only place allowed to know about OpenCode. | nothing in the repo |
| `core/src/` (rest) | Review engine: job model, prompt, report contract, diff, checkout, GitHub client, runner, settings client. | `backends/` |
| `action/` | Composite GitHub Action. Reads the Actions environment, fetches settings and reviews from the API, calls the runner. | `core` |
| `.github/workflows/` | `ci.yml` runs typecheck and tests. `shrike.yml` runs Shrike on this repo's own pull requests. | `action/` |
| `documentation/` | This folder. | nothing |

## Folders in shrike

| Path | Role |
| --- | --- |
| `server/` | Hono API and webhook server: OIDC and Supabase JWT verification, settings and run storage, review loader, local or Actions dispatch. |
| `reviews/` | Review instructions, one `SKILL.md` per directory, served to runners by the API. |
| `supabase/` | Migrations and row level security policies. |
| `dashboard/` | Website: GitHub login, repository list, settings form, run history. |

## Entry points

- `action/src/run.ts` for the Action path. Runs inside the user's Actions job with the workflow token, authenticates to the API with the job's OpenID Connect token.
- `server/src/index.ts` in `shrike` for the App path. Serves the API, verifies GitHub App signatures, and either forwards the job to the repo's workflow (`SHRIKE_RUNNER=actions`) or runs it on the host (`SHRIKE_RUNNER=local`).

Both build the same `Job` with `jobFromEvent`, resolve settings with `resolveSettings`, and run it with `runJob` from `core/`, so any change to what a review does lands in one place. Any behaviour added to one path must go through `runJob` or a module it calls, never into the entry point alone.

## What the runner receives

`runJob` takes the settings and the list of loaded reviews (`name`, `description`, `body`). It never reads review files itself. The Action gets both from `GET /v1/settings`; the server loads them from `reviews/` and the database. Names that were requested but not returned are reported as `unknown review` in the status comment.
