# Phase 3: everything from the app

## Goal

The workflow file stops carrying configuration and this repository stops carrying review instructions. A user's workflow is checkout plus `uses: AfterMatter/shrike-ci/action@main` with the `api_url` input. Which reviews run, their instructions, the model and the session mode live in the private `shrike` app, and both the Action path and the App path read them from there.

## Pieces

- Database: Supabase. Postgres for data, Supabase Auth with GitHub login for the website. Schema in `shrike/supabase/migrations`.
- API: the Hono server in `shrike/server`. The same process serves the GitHub App webhook. There is no second server.
- Review instructions: `shrike/reviews/<name>/SKILL.md`, served by the API. Built-in reviews are Shrike features, see `internal-reviews.md`.
- Website: `shrike/dashboard`. Reads through Supabase with row level security, writes settings through the API.

## How CI authenticates without a secret

GitHub Actions can mint an OpenID Connect token for any job that declares `id-token: write`. The token is a signed JWT whose claims include `repository`, `repository_id` and `repository_owner`, and it can only be minted from inside that repository's workflow.

1. The Action requests the token from GitHub with audience `shrike` (`actionsIdToken` in `core/src/settings.ts`).
2. It sends the token to `GET /v1/settings?reviews=<requested names>`.
3. The API verifies the signature against GitHub's public keys at `https://token.actions.githubusercontent.com/.well-known/jwks`, checks the audience, checks that the `sub` claim names the same repository, and reads `repository_id`.
4. The answer is `{ settings, reviews }`: the repository's settings, or defaults when it was never set up, and the instructions of the requested reviews, or of the configured ones when nothing was requested.

The App path already knows the repository from the installation webhook and looks up the same row by `repository_id`. Both paths call `resolveSettings` and `runJob` from `core/`, so they cannot drift.

The same token authenticates `POST /v1/runs`, which stores each review's report and usage so the website can show history and cost.

## Tables

| Table | Columns |
| --- | --- |
| `repositories` | `github_id` primary key, `owner`, `name`, `installation_id` nullable, `settings` jsonb, `created_at` |
| `runs` | `id`, `repository_github_id`, `pr`, `sha`, `trigger`, `review`, `status`, `verdict`, `tokens`, `cost`, `report` jsonb, `created_at` |
| `memberships` | `user_id`, `repository_github_id`, filled at login from the repositories the GitHub user can administer |

`settings` holds `reviews` (ordered names), `model`, `backend` and `session`. Unknown keys are rejected by the same zod schema the runner uses.

## Status

- shrike-ci: done. The Action requires `api_url`, has no override inputs, fetches settings and review bodies, reports every run.
- shrike: server, migrations, reviews and dashboard. See its README for the human setup: Supabase project, GitHub OAuth app, public API URL, `SHRIKE_API_URL` repository variable.
