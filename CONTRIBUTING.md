# Contributing to gh-latch

Thanks for taking the time to contribute. This project is intentionally small, and
that is a feature: every change has to keep it readable in one sitting.

## Ways to help

Not everything is code. All of these are valuable:

- **Report a bug** â€?with the command you ran, the policy file, and what you expected.
- **Write a policy recipe** â€?CI, monorepo bots, agent sandboxes. See `docs/policy.md`.
- **Improve an error message** â€?a denied call should explain itself without a debugger.
- **Port a command** â€?the GitHub API surface is large; we implement it one careful verb at a time.
- **Translate** â€?`README.zh-CN.md` exists; more languages are welcome.

## Ground rules

1. **Zero runtime dependencies.** The tool must run from a clone with nothing installed. If a change needs a library, it needs a very good reason first.
2. **No hidden I/O.** A command either talks to GitHub through `client.request()` or it does not talk at all.
3. **Deny by default.** New operations start closed: add the operation to `OPERATIONS`, give it the narrowest level that works, and document it.
4. **Tests come with the behaviour.** `npm test` must pass; new policy behaviour needs a case in `test/policy.test.mjs`.

## Development setup

```console
git clone https://github.com/Erdoschn/gh-latch.git
cd gh-latch
npm test
npm run check
```

There is no build step. Node 20.11 or newer.

If your machine blocks subprocess spawning (some sandboxes do), run the files directly:

```console
node test/policy.test.mjs && node test/auth.test.mjs && node test/commands.test.mjs && node test/cli.test.mjs
```

## Project layout

| Path | Purpose |
| --- | --- |
| `src/policy.mjs` | the operation table and the authorization engine |
| `src/commands.mjs` | one function per GitHub action, taking an injected client |
| `src/github.mjs` | the REST client: `request()` and `paginate()` |
| `src/auth.mjs` | token resolution, masking, redaction |
| `src/audit.mjs` | append-only JSONL audit log |
| `src/cli.mjs` | argument parsing and dispatch |
| `docs/` | policy reference and architecture notes |

## Adding a command

1. Add the operation to `OPERATIONS` in `src/policy.mjs` with a level and, if needed, a `policyFlag`.
2. Implement it in `src/commands.mjs` as `async function name(client, input)`, returning plain data.
3. Wire it in `src/cli.mjs`: gate first, then call, then audit.
4. Add a test with a fake client. No network in tests, ever.
5. Document the row in the README command table.

## Commit messages

Conventional Commits, roughly: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
A commit should explain *why*; the diff already says *what*.

## Pull requests

Keep them small and focused. The template asks for three things:

- what changed and why,
- how you verified it (`npm test` output is enough),
- whether the change affects the security model â€?if it does, say so explicitly and expect questions.

Maintainers aim to respond within a week. If a PR goes quiet, a friendly ping is welcome;
it is a missed notification, not a rejection.

## Issues

- Search first; duplicates get closed with a link.
- For security problems, **do not open an issue** â€?see [`SECURITY.md`](SECURITY.md).

## Code of conduct

Participation is covered by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## License

By contributing you agree that your contribution is licensed under the MIT license
in [`LICENSE`](LICENSE).
