# Architecture

`gh-latch` is deliberately shaped like a funnel. Everything that can reach GitHub passes
through one function, and that function is ten lines long.

```
        argv
          │
     cli.mjs            parse flags, resolve token and policy, dispatch
          │
   ┌──────┴──────┐
   │             │
policy.mjs    commands.mjs      authorize → call → return data
   │             │
   └──────┬──────┘
          │
    github.mjs            request() / paginate()
          │
      api.github.com
```

## Modules

**`src/policy.mjs`** — the operation table (`OPERATIONS`) and `authorize()`. Pure
functions over plain objects: no I/O, no clock, no globals. This is the file to read
first, and the only file whose changes can weaken the latch.

**`src/commands.mjs`** — one exported function per action, each taking an injected
client. Commands return plain data and never print. `gate()` is the only way they reach
the policy engine, and it throws rather than returning a falsy value, so a forgotten
`if` cannot silently allow a call.

**`src/github.mjs`** — a thin REST wrapper: one `request()`, one `paginate()`, and a
`GithubError` that keeps the status code and the API's own message. No retries and no
cache, because both hide behaviour that a policy tool should be honest about.

**`src/auth.mjs`** — token lookup order, `maskToken()`, and `redact()`. Every string that
leaves the process goes through `redact()`.

**`src/audit.mjs`** — JSONL appender. Entries are written for denials as well as
successes; a record of what was *refused* is often the more interesting half.

**`src/cli.mjs`** — argument parsing and dispatch. Order inside a command is fixed:
resolve token → resolve policy → gate → call → audit → print.

## Design choices

**Zero dependencies.** The tool runs from a clone with nothing installed. That keeps the
supply chain to "Node itself", and makes the whole thing reviewable in one sitting.

**Deny by default.** No policy file means no operations. The first-run experience is an
error message that tells you to run `ghl init`.

**No `admin` level.** Administrative operations are not implemented, so the level is a
parse error rather than a permission nobody should grant. A capability that does not
exist cannot be enabled by accident.

**Atomic multi-file commits.** `commitFiles()` writes blobs, a tree, a commit, and then
moves the ref with `force: false`. A crash halfway through leaves the branch untouched
instead of half-updated.

**Dry runs only read.** `--dry-run` short-circuits every mutating call at the command
layer, before the transport is asked to do anything. `test/commands.test.mjs` asserts
that a dry run makes GET calls only.

## Testing strategy

- `policy.test.mjs` — the authorization matrix: levels, flags, patterns, deny precedence.
- `commands.test.mjs` — commands against a fake client that records calls, so payload
  shapes (tree entries, base64 blobs, ref updates) are asserted without a network.
- `auth.test.mjs` — lookup precedence, masking, redaction.
- `cli.test.mjs` — argument parsing and end-to-end dispatch against a temporary policy.

No test touches the network. If a change needs a live API to be verified, that is a
review comment, not a test.

## Extending

A new command costs five small edits, listed in `CONTRIBUTING.md`. The rule that keeps
the design intact: **the operation goes into `OPERATIONS` before the command goes into
`cli.mjs`.** Adding the gate after the code is how latches rot.
