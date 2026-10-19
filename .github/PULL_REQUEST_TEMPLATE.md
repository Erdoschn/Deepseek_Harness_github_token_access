## What changed

<!-- One paragraph. Explain why, not just what. -->

## How it was verified

<!-- `npm test` output is enough. Manual runs are fine too — say what you ran. -->

## Does this touch the security model?

<!--
Anything under src/policy.mjs, a new operation in OPERATIONS, or a change to what
`--dry-run` does, counts. If yes: which operation, which level, and why that level.
-->

- [ ] No
- [ ] Yes — described above

## Checklist

- [ ] `npm test` passes
- [ ] `npm run check` passes
- [ ] No runtime dependency was added
- [ ] New behaviour has a test (policy changes need a case in `test/policy.test.mjs`)
- [ ] Documentation updated (README command table, or `docs/policy.md` for a new key)
- [ ] Commit messages follow Conventional Commits
