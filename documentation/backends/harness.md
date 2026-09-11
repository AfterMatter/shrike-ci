# Agent harness

How the review engine talks to an agent, and how to replace OpenCode with any other harness or a custom one.

## The contract

`bot/src/backends/types.ts` is the whole interface:

- `Backend` has a `name`, a `defaultModel`, and `open(options)`.
- `open` receives `cwd` (the checked out PR), an optional `model` string, an optional `timeoutMs`, and a `log` callback. It returns an `AgentSession`.
- `AgentSession.prompt(text)` sends one message and resolves with the final assistant text plus `usage.tokens` and `usage.cost`.
- `AgentSession.close()` releases everything the session holds.

The runner opens one session per skill, sends the skill prompt once, sends one retry prompt in the same session if the reply is not a valid report, and closes the session in a `finally`. Nothing else in the repo imports from `backends/` except `getBackend` in `backends/index.ts`.

## What every backend must guarantee

- Tools are read only. The agent can read, list and search the checkout. It cannot edit, run shell commands, fetch the web, or leave `cwd`.
- No GitHub secrets reach the agent. Strip `GITHUB_TOKEN`, `INPUT_GITHUB_TOKEN`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` from any child environment.
- The requested model is the model used. Fail at `open` if the runtime silently fell back to another one.
- A hung agent is killed after `timeoutMs` and `prompt` rejects.
- `usage` is filled from the runtime's own accounting, zero if it has none.

`bot/test/acp.test.ts` checks the first two guarantees live. A new backend copies that test with its own gate variable.

## Adding a backend

1. Create `bot/src/backends/<name>.ts` exporting a `Backend`. Keep every runtime specific import in this file.
2. Register it in the `backends` map in `bot/src/backends/index.ts`.
3. Add `bot/test/<name>.test.ts` with the three live assertions: reads a file, cannot overwrite it, does not echo a planted token. Gate it on an env variable so unit runs stay offline.
4. Select it with the `backend` Action input or `SHRIKE_BACKEND` for the server. No other code changes.
5. Add a short page next to this one with the runtime's install step and credentials.

## Candidates

| Harness | Shape | Credentials | Notes |
| --- | --- | --- | --- |
| OpenCode over ACP (current) | subprocess, JSON-RPC on stdio | none for the free Zen models | Free tier only works inside the OpenCode binary. Permissions set through `OPENCODE_CONFIG_CONTENT`. |
| pi (`@earendil-works/pi-coding-agent`) | in-process TypeScript SDK | provider API key | `createAgentSession` with `tools: ["read", "grep", "find", "ls"]`, `SessionManager.inMemory()`, a resource loader with `noExtensions`, `noSkills` and `noContextFiles`. Usage and cost come with each assistant message. |
| Custom | own loop on a provider SDK | provider API key | Implement the four read only tools and the loop. The prompt and report contract in `bot/src/prompt.ts` and `bot/src/report.ts` stay unchanged, so skills do not change. |

## Phase: backend swap

Happens when the hosted bot starts running and a paid model is available. Kept small on purpose.

1. Add the new backend with steps 1 to 5 above. One pull request.
2. Run the self review on this repo with both backends against the same pull request and compare the JSON reports for finding count, line accuracy and cost.
3. Flip `defaultModel` and the `backend` default in `action/action.yml` and `bot/src/config.ts`.
4. Remove OpenCode: delete `bot/src/backends/acp.ts` and `bot/test/acp.test.ts`, drop `@agentclientprotocol/sdk` from `bot/package.json`, remove the `opencode_version` input and install step from `action/action.yml`, remove the `bun add -g opencode-ai` step from `.github/workflows/ci.yml`, remove `.opencode/` from `.gitignore`, and update the README.

Steps 3 and 4 are one pull request each so either can be reverted alone.
