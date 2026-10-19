# gh-latch

**A latch for your GitHub token.**

`gh-latch` is a small command-line tool that sits between a credential and the GitHub API. You give it a token, you write down â€?in a file â€?*which repositories* it may touch and *whether* it may write, and then every action goes through that latch before it reaches GitHub.

It exists because handing a token to a script, a CI job, or an AI agent currently means handing over everything that token can do. `gh-latch` makes the grant explicit, inspectable, and narrow.

```console
$ ghl policy show
permissions: read, write
repos.allow: acme/*
repos.deny:  acme/secret

$ ghl commit acme/api --branch docs/readme -m "docs: add readme" --file README.md
ghl: policy denied "commit.create":
  - repository "acme/secret" is not covered by repos.allow (or is listed in repos.deny)
```

No dependencies. Node 20+. About 1,000 lines you can read in one sitting.

---

## Why

A GitHub token is all-or-nothing. Fine-grained tokens narrow the blast radius, but they cannot express *"this agent may open pull requests against `acme/api`, and nothing else, and not at 3am on a Sunday"* â€?that logic has to live somewhere. Usually it lives in a prompt, a shell alias, or nowhere.

`gh-latch` puts it in `ghl.config.json`, next to the code, under version control, reviewable in a pull request.

## Install

```console
git clone https://github.com/Erdoschn/gh-latch.git
cd gh-latch
node src/cli.mjs help          # run straight from the checkout
npm link                       # or install the `ghl` command globally
```

## Quickstart

1. **Give it a token.** Any of these work; the first one found wins.

   | Source | |
   | --- | --- |
   | `GHL_TOKEN` | environment variable |
   | `GITHUB_TOKEN` | environment variable |
   | `GH_TOKEN` | environment variable |
   | `~/.dsh/secrets/github-token` | file, one line, nothing else |
   | `~/.config/ghl/token` | file |
   | `~/.gh-latch/token` | file |

   The token is never printed, never written to the audit log, and never cached.

2. **Write a policy.**

   ```console
   ghl init --repo acme/api --write
   ```

   ```json
   {
     "version": 1,
     "repos": { "allow": ["acme/api"], "deny": [] },
     "permissions": ["read", "write"],
     "allowRepoCreate": false,
     "rawApi": false,
     "denyOperations": [],
     "auditLog": null
   }
   ```

3. **Check your own work.**

   ```console
   ghl whoami
   ghl policy show
   ghl repo view acme/api
   ```

4. **Do something.**

   ```console
   ghl commit acme/api --branch docs/readme --create-branch-from main \
     -m "docs: add a readme" --file README.md --file docs/usage.md
   ghl pr create acme/api --head docs/readme --base main --title "docs: add a readme"
   ```

## The policy model

Three ideas, and that is the whole design:

- **`permissions`** â€?what *kind* of action is allowed. `read`, `write`. There is no `admin`: `gh-latch` refuses to perform administrative operations at all, so the level is rejected at parse time rather than left available.
- **`repos.allow` / `repos.deny`** â€?which repositories. Patterns are `owner/name`, `owner/*`, `*/name`, `*/*`. `deny` always wins.
- **`denyOperations`** â€?a veto list for individual operations, or `"*"` for a dry-run-only setup.

Two doors are shut by default and need an explicit opt-in:

- `allowRepoCreate` â€?creating a brand-new repository is a write, but a *louder* one.
- `rawApi` â€?the `ghl api` escape hatch, off until you turn it on.

Full reference, including recipes for CI and for agents: [`docs/policy.md`](docs/policy.md).

## Commands

| Command | Operation | Level |
| --- | --- | --- |
| `ghl whoami` | â€?| none |
| `ghl repo list` | `repo.list` | read |
| `ghl repo view <repo>` | `repo.view` | read |
| `ghl repo create <name>` | `repo.create` | write + `allowRepoCreate` |
| `ghl file read <repo> <path>` | `file.read` | read |
| `ghl file ls <repo> [dir]` | `file.read` | read |
| `ghl branch create <repo> <branch> --from <ref>` | `branch.create` | write |
| `ghl commit <repo> --branch B -m MSG --file local=remote` | `commit.create` | write |
| `ghl pr list / view` | `pr.list`, `pr.view` | read |
| `ghl pr create <repo> --head H --base B --title T` | `pr.create` | write |
| `ghl issue list / create` | `issue.list`, `issue.create` | read / write |
| `ghl api <METHOD> <path>` | `raw.read`, `raw.write` | read / write + `rawApi` |
| `ghl policy show` / `check` | â€?| none |
| `ghl audit` | â€?| none |

Exit codes are meant to be used by scripts: `0` ok, `1` error, `2` denied by policy, `64` usage error.

## Safety properties

- Deny by default: with no `ghl.config.json`, every GitHub operation is refused.
- The token never appears in output, in the audit log, or in an error message.
- `--dry-run` resolves everything, prints the plan, and performs reads only.
- Every attempt â€?including refused ones â€?can be appended to `~/.gh-latch/audit.jsonl`.
- Commits are written through the Git Data API, so a multi-file change lands atomically and `force` is never set on a ref update.

## Development

```console
npm test        # node --test test/
npm run check   # syntax check of every source file
```

No dependencies, no build step, and no transpiler: what you clone is what runs. Contribution guide: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT â€?see [`LICENSE`](LICENSE).

[ç®€ä½“ä¸­æ–‡è¯´æ˜Ž](README.zh-CN.md)
