# Agent harness

How the review engine talks to an agent, and how to replace OpenCode with any other harness or a custom one.

## The contract

`core/src/backends/types.ts` is the whole interface. A `Backend` opens an `AgentSession` for a checkout and a model name. A session answers one prompt with the final text plus token and cost usage, and can be closed.

The runner opens one session per review, sends the prompt once, sends one retry prompt in the same session if the reply is not a valid report, and closes the session in a `finally`. No code outside `backends/` refers to a concrete backend: the rest of the repo goes through `getBackend` in `backends/index.ts` and the `Backend` and `AgentSession` types in `backends/types.ts`. Tests import a backend directly.

## What every backend must guarantee

- Tools cannot change files or run commands. Edit, write, shell, web access and directories outside `cwd` are denied. Read, list, search, language server lookups and the agent's own task list are allowed.
- No GitHub secrets reach the agent. Strip `GITHUB_TOKEN`, `INPUT_GITHUB_TOKEN`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` from any child environment.
- The requested model is the model used. Fail at `open` if the runtime silently fell back to another one.
- A hung agent is killed after `timeoutMs` and `prompt` rejects.
- `usage` is filled from the runtime's own accounting, zero if it has none.

`core/test/acp.test.ts` checks read only tools, no leaked secrets and non-zero usage live. A new backend copies that test with its own gate variable.

## Adding a backend

1. Create `core/src/backends/<name>.ts` exporting a `Backend`. Keep every runtime specific import in this file.
2. Register it in the `backends` map in `core/src/backends/index.ts`.
3. Add `core/test/<name>.test.ts` with the four live assertions: reads a file, reports non-zero usage, cannot overwrite the file, does not echo a planted token. Gate it on an env variable so unit runs stay offline.
4. Select it with the `backend` Action input or `SHRIKE_BACKEND` for the server. No other code changes.
5. Add a short page next to this one with the runtime's install step and credentials.

## Candidates

| Harness | Shape | Credentials | Notes |
| --- | --- | --- | --- |
| OpenCode over ACP (current) | subprocess, JSON-RPC on stdio | none for the free Zen models | Free tier only works inside the OpenCode binary. Permissions set through `OPENCODE_CONFIG_CONTENT`. |
| pi (`@earendil-works/pi-coding-agent`) | in-process TypeScript SDK | provider API key | `createAgentSession` with `tools: ["read", "grep", "find", "ls"]`, `SessionManager.inMemory()`, a resource loader with `noExtensions`, `noSkills` and `noContextFiles`. Usage and cost come with each assistant message. |
| Custom | own loop on a provider SDK | provider API key | Implement the four read only tools and the loop. The prompt and report contract in `core/src/prompt.ts` and `core/src/report.ts` stay unchanged, so reviews do not change. |

## Phase: backend swap

Happens when the hosted bot starts running and a paid model is available. Kept small on purpose.

1. Add the new backend with steps 1 to 5 above. One pull request.
2. Run the self review on this repo with both backends against the same pull request and compare the JSON reports for finding count, line accuracy and cost.
3. Flip `defaultModel` in the backend and the `backend` default in `core/src/settings.ts`.
4. Remove OpenCode: delete `core/src/backends/acp.ts` and `core/test/acp.test.ts`, drop `@agentclientprotocol/sdk` from `core/package.json`, remove the `opencode_version` input and install step from `action/action.yml`, remove the `bun add -g opencode-ai` step from `.github/workflows/ci.yml`, remove `.opencode/` from `.gitignore`, and update the README.

Steps 3 and 4 are one pull request each so either can be reverted alone.
