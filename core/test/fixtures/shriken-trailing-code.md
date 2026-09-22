Review answers now come in three shapes, chosen by each review's instructions with no new API or migration: written answers fold under what that review said on the Shrike card, and a finding that touches several places reports them as `related`, posting one thread at its own line that links every other place at the head commit as one fingerprint [file:core/src/threads.ts]. Shared spot parsing drops an inverted or equal `startLine` on every place before it reaches a thread, so no `#L9-L3` or `6-6` anchors survive [file:core/src/report.ts], and the card folds each note with fences always balanced, so a stray fence cannot swallow the rest of it [file:core/src/card.ts] [commit:3fd74e4].

```diff
const ranged = <T extends Spot>(spot: T): T => (spot.startLine === undefined || spot.startLine < spot.line ? spot : { ...spot, startLine: undefined });
```

code-review, house-style and cleanup pass after re-verifying the diff [review:code-review] [review:house-style] [review:cleanup]. The one warning is real but narrow: slop-review shows `suggested` in the prompts and `fence` in thread rendering are two copies of the same wrap-in-a-fence job that already disagree, since an empty related suggestion posts as `Delete these lines.` but reaches the autofix agent as an empty fence, masking the deletion signal [finding:slop-review#1]. Its second note and cleanup's two are pure readability: the conditional spread for `related` equals a plain optional read [finding:slop-review#2], and dropping the `ASK` import [finding:cleanup#1] plus hoisting the blob URL out of a map [finding:cleanup#2] change no behaviour.

```suggestion
const suggested = (spot: Spot): string => (spot.suggestion === undefined ? "" : `\n${suggestionBlock(spot.suggestion)}`);

const findingLines = (finding: Finding, n: number): string =>
  `${n + 1}. ${spotAt(finding)} [${finding.severity}] ${finding.title}\n${finding.body}${suggested(finding)}${(finding.related ?? []).map((spot) => `\nAlso at ${spotAt(spot)}${suggested(spot)}`).join("")}`;
