# Layout

## Folders

| Path | Role | Depends on |
| --- | --- | --- |
| `bot/src/backends/` | Agent runtime adapters. Only place allowed to know about OpenCode. | nothing in the repo |
| `bot/src/` (rest) | Review engine: job model, skill loader, prompt, report contract, diff, checkout, GitHub client, runner, config, webhook server. | `backends/` |
| `action/` | Composite GitHub Action. Reads the Actions environment and calls the runner. | `bot` |
| `skills/` | Built-in reviews, one `SKILL.md` per directory. | nothing |
| `.github/workflows/` | `ci.yml` runs typecheck and tests. `shrike.yml` runs Shrike on this repo's own pull requests. | `action/` |
| `documentation/` | This folder. | nothing |

## Entry points

- `action/src/run.ts` for the Action path. Runs inside the user's Actions job with the workflow token.
- The `import.meta.main` block of `bot/src/index.ts` for the App path. Starts the webhook server, verifies GitHub App signatures, and either forwards the job to the repo's workflow (`SHRIKE_RUNNER=actions`) or runs it on the host (`SHRIKE_RUNNER=local`).

Both build the same `Job` with `jobFromEvent` and run it with `runJob`, so any change to what a review does lands in one place.

## Planned split

`shrike-ci` stays public and holds what runs in users' CI. `shrike` is the private monorepo for the hosted service.

| Piece | Goes to | Why |
| --- | --- | --- |
| `bot/src/` engine, `backends/`, and the exports in `bot/src/index.ts` | `shrike-ci` | The Action cannot run without it. |
| `action/`, `skills/` | `shrike-ci` | Referenced by users' workflows. |
| `bot/src/webhook.ts` and the server start block of `bot/src/index.ts` | `shrike` | Hosted only. |
| API, dashboard, queue, sandboxing, paid backend | `shrike` | Do not exist yet. |

Order of the move:

1. Split `bot/src/index.ts` into the package exports, which stay, and a `server.ts` entry, which moves with `webhook.ts`.
2. Rename `bot/` to `core/` in `shrike-ci` and publish it as a package.
3. Create `shrike` with `server.ts`, `webhook.ts` and their tests, depending on the `core` package.

Until then nothing moves, and new server code goes next to `bot/src/webhook.ts` so the later move stays a directory move.
