# Security policy

## The model in one paragraph

`gh-latch` is a *policy enforcement point*, not a security boundary. It narrows what a
token can do inside the process that runs `ghl`; it cannot stop someone who already has
the token from using `curl` instead. The threat it addresses is an honest-but-overbroad
agent, script, or CI job — not an attacker with local code execution.

Practical consequences:

- The policy file is trusted input. If an attacker can edit `ghl.config.json`, the policy is gone.
- The token is read from the environment or a file you control. Protect that file the way you protect any credential.
- Denied attempts are only visible if the audit log is enabled (`auditLog`), and the audit log lives on the local filesystem.

## What `gh-latch` will never do

- Perform administrative operations (settings, webhooks, org membership, deletions). The `admin` level is rejected at parse time and there is no code path for it.
- Force-push a ref. Ref updates are sent with `force: false`.
- Print, log, or cache a token. Output is passed through `redact()` before it reaches a terminal.

## Reporting a vulnerability

Please **do not** open a public issue for anything that could weaken the latch:

- a way to make an operation run without passing `authorize()`,
- a repository pattern that matches more than it reads as matching,
- a path where the token or another secret is printed or written to the audit log,
- a way for `--dry-run` to perform a write.

Report it through GitHub's private vulnerability reporting on this repository
("Security" → "Report a vulnerability"), or by email to the maintainers listed in
`package.json`. Include the smallest reproduction you can.

Expect an acknowledgement within 72 hours and a fix or a reasoned response within
14 days. Credit is given in the release notes unless you prefer otherwise.

## Supported versions

The project is pre-1.0: fixes land on `main` and in the next patch release. Pin a tag
if you need stability.
