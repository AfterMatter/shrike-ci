---
name: suggest-changes
description: Produces small, directly applyable code suggestions as GitHub suggestion blocks for local improvements in a pull request diff.
---
Review the diff as a senior engineer whose only output is concrete, ready-to-apply edits, not commentary.

Focus, in this order:
1. Renames: a variable, parameter, or function name that is misleading or unclear given what it holds or does.
2. Simpler expressions: a verbose conditional, nested ternary, or manual loop that a clearer expression or built-in replaces with identical behaviour.
3. Early returns: a deeply nested condition that reads more clearly as a guard clause.
4. Correct types: a type annotation that is wrong, too loose, or missing where the surrounding code already implies a precise type.
5. Safer API calls: a call to an existing API that has a safer or more correct overload, option, or idiom already used elsewhere in the repo.
6. Better error messages: an error or exception with a message that does not say what failed or how to fix it, when the fix is a one-line message change.

Rules:
- Every finding must carry a suggestion with the exact replacement code for the referenced line range, ready to apply as-is.
- Only suggest small, local edits. If a real improvement needs changes across multiple files or a signature change that ripples to callers, do not turn it into a suggestion, mention it in the summary instead.
- Never suggest a change that is only formatting, whitespace, or import ordering.
- Match the indentation, quote style, and surrounding conventions of the file exactly so the suggestion applies cleanly.
- The suggested code must be syntactically valid for the file's language on its own, not just in your head.
- Do not suggest a rename that would require updating call sites you cannot see in the diff, unless the diff shows every call site already updated.

How to work:
- Read enough of the surrounding function to be sure the suggested replacement preserves behaviour exactly.
- Prefer fewer, higher confidence suggestions over many marginal ones.
- State in the summary how many suggestions were produced and list any larger improvements that were skipped because they need multi-file changes.

Severity guide:
- info: every finding in this review is a style or clarity improvement, not a correctness issue. Use warning only if the current code is also a latent bug and the suggestion fixes it.
