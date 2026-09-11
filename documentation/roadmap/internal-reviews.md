# Internal reviews

## Naming

Code review, slop review and security review are internal Shrike features. Shrike writes, tests and hardens them. Their instructions live in `shrike/reviews/<name>/SKILL.md` and are served to runners by the API, so a fix ships to every repository without a workflow change. A skill is what a repository adds itself, later from a repository URL through the website.

Both will load through the same loader and run through the same runner. Everything user facing says `reviews`; the `SKILL.md` file name stays because it follows the Agent Skills format.

## Shipped

| Review | Default | State |
| --- | --- | --- |
| code-review | yes | proven on pull request 1 |
| slop-review | yes | proven on pull request 1 |
| security-review | yes | proven on pull request 1 |
| cleanup, react-doctor, suggest-changes | no | written, not exercised |

## To add

- correctness review: does the change do what the pull request says, including edge cases and error paths.
- regressions review: what existing behaviour the change can break, checked against callers and tests of the touched code.
- tests review: do the tests constrain the change, would they fail if the feature were broken, what is missing.
- before and after media: a comment with screenshots or recordings of the affected UI before and after the change. Needs the hosted runner from phase 3 because the app has to run somewhere.

## Hardening

- An evaluation set of pull requests with known findings, starting with pull request 1, run against every prompt change and every backend swap.
- Line accuracy: every inline finding must land on a line in the diff, findings outside it are counted and reviewed.
- Duplicate findings across reviews are merged before posting.
- False positive tracking through thumbs down reactions on review comments.
- Cost and token caps per review and per pull request.

## Hot context option

Today every review opens a fresh agent session, so the third review reads the same files the first one read. The alternative keeps one session open and runs the next review in it, so the model already has the diff and the files in context. Cheaper and faster, at the risk of an earlier review biasing the next and of context growing past the model's window.

Plan: a per repository setting `session: fresh | shared`. In `bot/src/runner.ts` the shared mode opens the session before the loop and closes it after, and the retry logic stays as is. The evaluation set decides which mode becomes the default.
