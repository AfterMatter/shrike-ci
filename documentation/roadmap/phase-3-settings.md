# Phase 3: settings in the backend

## Goal

The workflow file stops carrying configuration. A user's workflow becomes checkout plus `uses: AfterMatter/shrike-ci/action@main` and nothing else. Which reviews run, which model, and the session mode are set on the website, and both the Action path and the App path read them from the backend.

## Pieces

- Database: Supabase. Postgres for data, Supabase Auth with GitHub login for the website.
- API: the existing Hono server in `bot/` grows two routes. There is no second server.
- Website: the `dashboard/` from the spec. Reads through Supabase with row level security, writes settings through the API.

## How CI authenticates without a secret

GitHub Actions can mint an OpenID Connect token for any job that declares `id-token: write`. The token is a signed JWT whose claims include `repository`, `repository_id` and `repository_owner`, and it can only be minted from inside that repository's workflow.

1. The Action requests the token from GitHub with audience `shrike`.
2. It sends the token to `GET /v1/settings`.
3. The API verifies the signature against GitHub's public keys at `https://token.actions.githubusercontent.com/.well-known/jwks`, checks the audience, and reads `repository_id`.
4. Settings for that repository come back, or defaults when the repository has never been set up. The Action keeps working for repositories that never visit the website.

The App path already knows the repository from the installation webhook and looks up the same row by `repository_id`. Both paths call one function in `bot/src/settings.ts`, so they cannot drift.

The same token authenticates `POST /v1/runs`, which stores each review's report and usage so the website can show history and cost.

## Tables

| Table | Columns |
| --- | --- |
| `repositories` | `github_id` primary key, `owner`, `name`, `installation_id` nullable, `settings` jsonb, `created_at` |
| `runs` | `id`, `repository_github_id`, `pr`, `sha`, `trigger`, `review`, `status`, `verdict`, `tokens`, `cost`, `report` jsonb, `created_at` |
| `memberships` | `user_id`, `repository_github_id`, filled at login from the repositories the GitHub user can administer |

`settings` holds `reviews` (ordered names), `model`, `backend` and `session`. Unknown keys are rejected by the same zod schema the runner uses.

## Pull requests, in order

1. Supabase project, schema migration, row level security policies, seed for this repository.
2. API routes with OIDC verification and tests using a locally signed token and a fake JWKS.
3. `bot/src/settings.ts` used by `runJob`, run reporting after each review, Action requests the token. Behaviour with no backend URL configured stays exactly as today.
4. Website: GitHub login, repository list, settings form, run history.
5. Remove the `skills` input default from `action/action.yml` and rename it to `reviews`.

## Human setup

- A Supabase project and its URL, anon key and service key.
- A GitHub OAuth app for website login.
- A public URL for the API, which is the same process as the webhook server.
- The GitHub App from phase 2 for the App path.
