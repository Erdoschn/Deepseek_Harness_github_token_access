# Policy reference

The policy is a single JSON file, `ghl.config.json`, found in the working directory
or the nearest parent directory. `--policy <file>` overrides the search.

A missing policy is not "allow everything": it is an error. Every command that touches
GitHub refuses to run until a policy exists.

## Fields

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `version` | `1` | `1` | Schema version. Only `1` is accepted. |
| `repos.allow` | `string[]` | `[]` | Repository patterns that may be touched. Empty means nothing. |
| `repos.deny` | `string[]` | `[]` | Patterns refused even when listed in `allow`. Deny wins. |
| `permissions` | `string[]` | `["read"]` | `read`, `write`. `admin` is rejected at parse time. |
| `denyOperations` | `string[]` | `[]` | Operation names to veto, or `"*"` to veto everything. |
| `allowRepoCreate` | `boolean` | `false` | Required for `repo.create`. |
| `rawApi` | `boolean` | `false` | Required for `ghl api`. |
| `auditLog` | `string \| null` | `null` | Path for the JSONL audit log. `null` means `~/.gh-latch/audit.jsonl`. |

Unknown keys are a hard error, so a typo like `permisions` fails loudly instead of
silently granting nothing — or, worse, everything.

## Repository patterns

| Pattern | Matches |
| --- | --- |
| `acme/api` | exactly `acme/api` |
| `acme/*` | any repository owned by `acme` |
| `*/api` | any repository named `api`, any owner |
| `*/*` | everything the token can see |

Patterns are matched per path segment and case-insensitively, so `acme/*` does **not**
match `acme-labs/api`. That is deliberate: `acme*` style prefix matching is a common
source of surprising grants.

## Operations and their levels

| Operation | Level | Extra flag |
| --- | --- | --- |
| `repo.list` | read | |
| `repo.view` | read | |
| `repo.create` | write | `allowRepoCreate` |
| `file.read` | read | |
| `branch.create` | write | |
| `commit.create` | write | |
| `pr.list` | read | |
| `pr.view` | read | |
| `pr.create` | write | |
| `issue.list` | read | |
| `issue.create` | write | |
| `raw.read` | read | `rawApi` |
| `raw.write` | write | `rawApi` |

There is no merge, no delete, no settings operation. `gh-latch` does not implement them,
so no policy can enable them.

## Recipes

### Read-only exploration

```json
{
  "version": 1,
  "repos": { "allow": ["acme/*"] },
  "permissions": ["read"]
}
```

### A CI job that comments on pull requests in one repository

```json
{
  "version": 1,
  "repos": { "allow": ["acme/api"], "deny": ["acme/api-secrets"] },
  "permissions": ["read", "write"],
  "denyOperations": ["branch.create", "commit.create", "repo.create"]
}
```

### An agent that may propose changes but never publish on its own

```json
{
  "version": 1,
  "repos": { "allow": ["acme/api"] },
  "permissions": ["read", "write"],
  "denyOperations": ["pr.create"],
  "auditLog": "~/.gh-latch/agent.jsonl"
}
```

The agent can push a branch; a human runs `ghl pr create` afterwards.

### A completely frozen configuration

```json
{
  "version": 1,
  "repos": { "allow": ["*/*"] },
  "permissions": ["read", "write"],
  "denyOperations": ["*"]
}
```

Useful for recording what a workflow *would* do: every command still resolves, prints
its plan under `--dry-run`, and exits `2`.

## Asking before acting

```console
$ ghl policy check commit.create acme/api
{
  "operation": "commit.create",
  "repo": "acme/api",
  "allowed": true,
  "level": "write"
}
```

Exit code `0` means allowed, `2` means denied — which makes it usable as a guard:

```console
ghl policy check commit.create acme/api > /dev/null || exit 1
```

## What the policy cannot express

- **Time windows** ("not on Sundays"), **rate limits**, or **approval steps**. Those belong
  in the caller, or in a wrapper that runs `ghl policy check` first.
- **Content rules** ("no edits to `CODEOWNERS`"). Use `repos.deny` plus branch protection.
- **Per-user rules.** The policy describes a token, not a person.

If you need one of these, open an issue describing the case — the answer may be a new
operation, or a "no" with an explanation, which is also useful.
