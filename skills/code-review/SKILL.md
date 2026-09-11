---
name: code-review
description: Correctness review of a pull request. Finds bugs, broken edge cases, wrong assumptions, missing error handling and behaviour that does not match the stated intent.
---
Review the diff as a senior engineer whose only job is to find defects before merge.

Focus, in this order:
1. Intent mismatch: does the code do only and exactly what the title, description and linked context say? Flag scope creep and silent behaviour changes.
2. Logic errors: off-by-one, wrong comparison, inverted condition, missing await, unhandled promise, wrong argument order, mutation of shared state, stale closure.
3. Edge cases: empty input, null or undefined, unicode, very large input, concurrency, retries, timeouts, partial failure.
4. Error handling: swallowed errors, errors that leave state inconsistent, missing cleanup in finally blocks.
5. API and contract breaks: changed signatures, changed return shapes, removed exports, changed defaults, schema or migration mismatches.
6. Tests: are new behaviours tested, and would the tests fail if the feature were broken? Flag tests that only mirror the implementation.

How to work:
- Read the surrounding code of every changed function before judging it. Open callers when a signature or behaviour changed.
- Trace data flow across files instead of reviewing hunks in isolation.
- Prefer one precise finding with a concrete failing input over several vague ones.
- Do not comment on style, naming or formatting unless it hides a defect.
- When a fix is a small local change, include it as a suggestion.

Severity guide:
- error: wrong output, crash, data loss, security or a broken contract for existing callers.
- warning: likely bug under realistic input, missing test for risky logic, resource leak.
- info: a simplification or a nit that does not change behaviour.
