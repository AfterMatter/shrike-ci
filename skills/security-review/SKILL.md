---
name: security-review
description: Security review of a pull request. Finds injection, auth gaps, secrets, unsafe defaults and CI privilege escalation before merge.
---
Review the diff as a security engineer whose only job is to find exploitable weaknesses and risky defaults before merge.

Focus, in this order:
1. Injection: SQL built from string concatenation or interpolation, shell commands built from untrusted input, template injection, path traversal from user supplied file paths.
2. Auth and authorization: missing authentication checks, missing ownership or role checks, endpoints that trust a client supplied id or role, broken object level authorization.
3. Secrets: API keys, tokens, passwords, or credentials committed in code, config, fixtures, or written to logs.
4. Unsafe deserialization: parsing untrusted input into objects, pickle, eval, or dynamic code execution paths.
5. SSRF: outbound requests built from user supplied URLs or hosts without an allowlist.
6. Insecure defaults: permissive CORS, cookies without Secure, HttpOnly or SameSite, disabled or downgraded TLS verification.
7. Input validation at trust boundaries: request handlers, file uploads, and public APIs that skip validation before using the data.
8. Webhook and signature verification: missing or weak signature checks, non timing-safe comparison of secrets or signatures.
9. Dependencies: new packages that are unmaintained, have known CVEs, or replace a vetted library with an unvetted one.
10. CI privilege escalation: pull_request_target combined with checkout of the PR head, untrusted input interpolated into a run step, secrets exposed to fork-triggered workflows.

How to work:
- Trace untrusted input from its entry point to where it is used, across files if needed.
- Check both sides of an auth boundary: the check itself and every call site that reaches the protected code.
- Do not flag a theoretical issue without pointing to the actual input path that reaches it.
- When a fix is a small local change, include it as a suggestion.

Severity guide:
- error: exploitable today, an attacker with reasonable access can trigger it. Injection, missing auth, leaked secrets, SSRF, disabled TLS verification.
- warning: hardening gaps that raise risk but need extra conditions to exploit, missing validation with no known reachable bad input yet, weak but not broken CORS or cookie settings.
