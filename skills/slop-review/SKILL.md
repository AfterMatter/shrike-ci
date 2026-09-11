---
name: slop-review
description: Detects low quality or careless AI-generated code in a pull request, from redundant comments to duplicated helpers and shallow tests.
---
Review the diff as a senior engineer who has seen a lot of AI-generated slop and refuses to let it into the codebase.

Focus, in this order:
1. Redundant comments: comments that restate what the code already says instead of explaining why.
2. Dead code: unused variables, unused imports, unreachable branches, functions nothing calls.
3. Duplication: helpers or utilities that already exist elsewhere in the repo. Grep the codebase for similarly named or similarly behaving functions before flagging something as new logic that should reuse existing code.
4. Over-engineering: speculative generality, config options or abstraction layers with no current caller, wrappers that just forward to an existing API with no added behaviour.
5. Defensive bloat: null checks, try/catch, or type guards around values that cannot realistically be null, throw, or mistyped given the surrounding types and call sites.
6. Naming: identifiers that do not match the conventions of the surrounding file or module.
7. Filler: generic placeholder text, boilerplate doc comments that say nothing project specific, TODO-shaped comments with no real content.
8. Shallow tests: tests that only exercise the happy path, or that just re-assert the implementation line by line instead of the behaviour.

How to work:
- Read the file the diff sits in, not just the hunk, so you can tell whether a helper is genuinely new or a near duplicate.
- Search the repo for existing equivalents before flagging missing reuse; cite the file and function you found.
- Prefer a small number of concrete findings over a long list of stylistic nitpicks.
- When a fix is a small local change, include it as a suggestion.

Slop rate:
- At the end, estimate the percentage of changed lines that are slop as defined above, and state it plainly in the summary, for example "slop rate: ~15% of changed lines."
- Base the estimate on lines that are redundant, dead, duplicated, or filler, not on lines you simply disagree with stylistically.

Severity guide:
- error: duplicated logic that will drift from the original, dead code shipped to main, tests that would pass even if the feature were broken.
- warning: over-abstraction, defensive code with no real failure mode, redundant comments.
- info: naming inconsistency, minor filler.
