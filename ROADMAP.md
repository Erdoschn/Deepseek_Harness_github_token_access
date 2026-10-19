# Roadmap

This is a list of things the maintainers think are worth doing, ordered by how much
they would help someone today. Anything here is fair game for a pull request — open an
issue first if it is larger than a screen of code, so we can agree on the shape.

## Next

- [ ] **`ghl pr review`** — submit a review with `--approve`, `--request-changes`, or
      `--comment`. Same latch, one more write operation.
- [ ] **`ghl pr merge`** — currently impossible by design. If it ever lands, it needs a
      merge-method restriction and its own policy flag, not a reuse of `write`.
- [ ] **`ghl file write`** — single-file convenience over `commit`, for the common
      "update one line in one file" case.
- [ ] **`ghl release`** — read-only listing of tags and releases; creation stays out until
      the model for it is clear.

## Policy model

- [ ] **`repos.deny` glob by label or topic** — "never touch anything labelled `secrets`".
- [ ] **`maxCommitsPerRun`** — a coarse rate limit, so a looping agent trips a latch
      instead of filling a branch with noise.
- [ ] **`requireCleanBranch`** — refuse to push when the branch has an open pull request.

## Developer experience

- [ ] **`--output ndjson`** — for piping long `repo list` output into other tools.
- [ ] **Shell completion** — bash and zsh first, generated from the command table.
- [ ] **`ghl doctor`** — one command that answers "is my token, policy, and audit path
      set up correctly?".
- [ ] **More translations** — `README.zh-CN.md` exists; Japanese, Spanish, and German
      would widen the audience.

## Explicitly out of scope

Saying no is part of the roadmap:

- Administrative operations (settings, webhooks, org membership, deletions). The `admin`
  level does not exist and is not planned.
- Force-pushing. Ref updates are always `force: false`.
- Storing tokens, refreshing them, or managing OAuth flows. Use your platform's secret
  store; `gh-latch` only reads.
- A TUI. The point is a small surface that scripts and agents can call.

## Good first issues

If you want to make a first contribution, these are shaped to be small and finishable:

1. Add a policy recipe to `docs/policy.md` for a case you actually have.
2. Improve one error message so it names the file and the fix.
3. Add a test for an edge case in `repoMatches` (unicode names, trailing slashes).
4. Translate `README.zh-CN.md` into another language.
5. Add a `ghl audit --json` test that asserts denied entries are recorded.
