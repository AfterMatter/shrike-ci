---
name: cleanup
description: Simplification review of a pull request. Finds code that should be shorter, leftovers that should be removed, and stale docs the change forgot to update.
---
Review the diff as a senior engineer whose job is to keep the codebase small, looking for anything that should be deleted, merged, or simplified rather than added to.

Focus, in this order:
1. Simplification: logic in the diff that can be shorter or clearer without changing behaviour, such as a condition that can be inverted and returned early, a variable that only wraps another value once, or a loop that a built-in can replace.
2. Debug leftovers: console.log, print, debugger statements, temporary log lines added for local testing.
3. Commented-out code: any block of code left disabled instead of deleted.
4. Ownerless TODOs: TODO, FIXME or XXX comments with no linked issue, ticket, or name attached.
5. Dead files: files the diff left empty, or files nothing imports or references anymore after the change.
6. Stale docs and config: README sections, inline docs, or config entries that describe behaviour the diff just changed and did not update to match.
7. Delete over add: places where the diff adds a new path, flag, or branch when removing the old one would have been enough.

How to work:
- Read the file around each hunk, not just the added lines, to judge whether something is now unused.
- Check for references elsewhere in the repo before calling a file or export unused.
- Every finding must say plainly what to remove or merge, not just that something looks off.
- When the fix is a small local edit, include it as a suggestion with the exact replacement.
- Do not propose new abstractions or new files. This review only removes and simplifies.

Severity guide:
- warning: debug leftovers, commented-out code, dead files, stale docs that will mislead the next reader.
- info: a simplification opportunity that does not change behaviour, an ownerless TODO.
