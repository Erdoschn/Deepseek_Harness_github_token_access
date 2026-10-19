#!/usr/bin/env node
/**
 * ghl — a latch for your GitHub token.
 *
 * The CLI is a thin shell: parse arguments, resolve the token and policy, call a
 * command, audit the outcome. Every decision about *whether* something may run
 * lives in policy.mjs.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolveToken, maskToken, redact } from './auth.mjs';
import { createClient, GithubError } from './github.mjs';
import {
  PolicyDeniedError,
  collectFiles,
  commitFiles,
  createBranch,
  createIssue,
  createPullRequest,
  createRepo,
  gate,
  listEntriesAtRef,
  listIssues,
  listPullRequests,
  listRepos,
  rawOperationFor,
  rawRequest,
  readFileAtRef,
  viewPullRequest,
  viewRepo,
  whoami,
} from './commands.mjs';
import {
  OPERATIONS,
  authorize,
  describePolicy,
  findPolicyFile,
  loadPolicyFile,
  normalizeRepo,
} from './policy.mjs';
import { appendAudit, defaultAuditPath, resolveAuditPath } from './audit.mjs';

const VERSION = '0.1.0';

/** Short flags that always take a value, mapped to their long form. */
const SHORT_VALUE_FLAGS = { '-m': '--message', '-o': '--org' };

const BOOLEAN_FLAGS = new Set([
  '--json',
  '--dry-run',
  '--no-audit',
  '--verbose',
  '--private',
  '--public',
  '--draft',
  '--force',
  '--write',
  '--help',
]);

export const EXIT = { OK: 0, ERROR: 1, DENIED: 2, USAGE: 64 };

/** Command groups the CLI understands; anything else is a usage error. */
const KNOWN_GROUPS = new Set([
  'whoami',
  'repo',
  'file',
  'branch',
  'commit',
  'pr',
  'issue',
  'api',
  'policy',
  'init',
  'audit',
  'help',
  'version',
]);

/** Parse `argv` into `{ positionals, flags }` without a dependency. */
export function parseArgs(argv) {
  const positionals = [];
  const flags = { _repeat: {} };
  for (let index = 0; index < argv.length; index += 1) {
    let token = argv[index];
    if (SHORT_VALUE_FLAGS[token] !== undefined) {
      const next = argv[index + 1];
      if (next === undefined) throw new UsageError(`${token} needs a value`);
      index += 1;
      flags[SHORT_VALUE_FLAGS[token]] = next;
      continue;
    }
    if (token.startsWith('--')) {
      let name = token;
      let inlineValue;
      const equals = token.indexOf('=');
      if (equals !== -1) {
        name = token.slice(0, equals);
        inlineValue = token.slice(equals + 1);
      }
      const repeated = ['--file', '--label', '--repo'].includes(name);
      if (repeated) {
        flags._repeat[name] ??= [];
      }
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
      } else if (inlineValue !== undefined) {
        if (repeated) flags._repeat[name].push(inlineValue);
        else flags[name] = inlineValue;
      } else {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--')) {
          throw new UsageError(`${name} needs a value`);
        }
        index += 1;
        if (repeated) flags._repeat[name].push(next);
        else flags[name] = next;
      }
      continue;
    }
    positionals.push(token);
  }
  return { positionals, flags };
}

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

const HELP = `ghl ${VERSION} — a latch for your GitHub token

Usage: ghl <command> [arguments] [flags]

Identity
  whoami                                  who the token belongs to, and its scopes

Repositories
  repo list [--limit N]                   repositories the token can reach
  repo view <owner/repo>                  one repository
  repo create <name> [--org O] [--private] [--description D]

Files
  file read <owner/repo> <path> [--ref R]  read a file as text
  file ls <owner/repo> [dir] [--ref R]     list a directory

Changes
  branch create <owner/repo> <branch> --from <ref>
  commit <owner/repo> --branch B -m MSG --file local=remote [--file ...]
                     [--create-branch-from REF]
  pr list <owner/repo> [--state open|closed|all] [--limit N]
  pr view <owner/repo> <number>
  pr create <owner/repo> --head H --base B --title T [--body TEXT] [--draft]
  issue list <owner/repo> [--state open|closed|all] [--limit N]
  issue create <owner/repo> --title T [--body TEXT] [--label NAME]...

Policy
  policy show                             what the active policy allows
  policy check <operation> [owner/repo]   ask before acting
  init [--repo owner/repo]... [--write]   write a starter ghl.config.json
  audit [--limit N]                       recent audit entries from this machine

Escape hatch (needs rawApi in the policy)
  api <METHOD> <path> [--body-file F]

Global flags
  --policy <file>       use this policy instead of searching for ghl.config.json
  --token-file <file>   read the token from this file
  --dry-run             resolve and print the plan, change nothing
  --json                machine-readable output
  --no-audit            do not append to the audit log
  --verbose             print the token source (never the token itself)

Exit codes: 0 ok, 1 error, 2 denied by policy, 64 usage.
`;

function formatTable(rows, columns) {
  if (rows.length === 0) return '(none)';
  const widths = columns.map((column) =>
    Math.max(column.header.length, ...rows.map((row) => String(row[column.key] ?? '').length)),
  );
  const line = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join('  ');
  return [
    line(columns.map((column) => column.header)),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map((row) => line(columns.map((column) => row[column.key] ?? ''))),
  ].join('\n');
}

function bodyFromFlags(flags) {
  if (flags['--body-file']) return readFile(path.resolve(flags['--body-file']), 'utf8');
  return Promise.resolve(flags['--body'] ?? '');
}

async function requireToken(flags) {
  const resolved = await resolveToken({ explicitPath: flags['--token-file'] });
  if (!resolved) {
    throw new UsageError(
      'no GitHub token found. Set GITHUB_TOKEN, or write one to ~/.dsh/secrets/github-token (see README).',
    );
  }
  if (flags['--verbose']) process.stderr.write(`token source: ${resolved.source} ${maskToken(resolved.token)}\n`);
  return resolved;
}

async function requirePolicy(flags, cwd) {
  const file = await findPolicyFile(cwd, flags['--policy']);
  if (!file) {
    throw new UsageError('no ghl.config.json found here or in a parent directory. Run `ghl init` first.');
  }
  return { file, policy: await loadPolicyFile(file) };
}

function buildContext({ client, policy, flags, auditFile }) {
  return {
    client,
    policy,
    dryRun: Boolean(flags['--dry-run']),
    async record(entry) {
      if (flags['--no-audit']) return;
      await appendAudit(auditFile, entry);
    },
  };
}

async function run(argv, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  const { positionals, flags } = parseArgs(argv);
  if (positionals.length === 0 || positionals[0] === 'help' || flags['--help']) {
    stdout.write(HELP);
    return EXIT.OK;
  }
  if (positionals[0] === 'version' || positionals[0] === '--version') {
    stdout.write(`${VERSION}\n`);
    return EXIT.OK;
  }

  const [group, ...rest] = positionals;
  const json = Boolean(flags['--json']);
  const print = (value) => {
    if (json) stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    else stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
  };

  try {
    if (!KNOWN_GROUPS.has(group)) {
      throw new UsageError(`unknown command "${positionals.join(' ')}" (try \`ghl help\`)`);
    }

    /* Commands that do not need a token or a policy. */
    if (group === 'policy' && rest[0] === 'show') {
      const { file, policy } = await requirePolicy(flags, cwd);
      print({ policyFile: file, ...describePolicy(policy) });
      return EXIT.OK;
    }
    if (group === 'policy' && rest[0] === 'check') {
      const operation = rest[1];
      const target = rest[2] ? normalizeRepo(rest[2]) : undefined;
      if (!operation) throw new UsageError('policy check needs an operation name');
      const { policy } = await requirePolicy(flags, cwd);
      const verdict = authorize(policy, { operation, repo: target });
      print({ operation, repo: target ?? null, ...verdict });
      return verdict.allowed ? EXIT.OK : EXIT.DENIED;
    }
    if (group === 'init') {
      const starter = {
        version: 1,
        repos: { allow: (flags._repeat['--repo'] ?? []).map(normalizeRepo), deny: [] },
        permissions: flags['--write'] ? ['read', 'write'] : ['read'],
        allowRepoCreate: false,
        rawApi: false,
        denyOperations: [],
        auditLog: null,
      };
      const target = path.resolve(cwd, 'ghl.config.json');
      if (!flags['--force']) {
        try {
          await readFile(target, 'utf8');
          throw new UsageError(`${target} already exists (use --force to overwrite)`);
        } catch (error) {
          if (error instanceof UsageError) throw error;
        }
      }
      await writeFile(target, `${JSON.stringify(starter, null, 2)}\n`, 'utf8');
      print({ wrote: target, ...starter });
      return EXIT.OK;
    }
    if (group === 'audit') {
      const file = defaultAuditPath();
      const limit = Number(flags['--limit'] ?? 20);
      let text = '';
      try {
        text = await readFile(file, 'utf8');
      } catch {
        print([]);
        return EXIT.OK;
      }
      const lines = text.trim().split('\n').filter(Boolean).slice(-limit);
      const entries = lines.map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
      if (json) print(entries);
      else
        stdout.write(
          `${formatTable(
            entries.map((entry) => ({
              at: entry.at,
              operation: entry.operation,
              repo: entry.repo ?? '',
              outcome: entry.outcome,
            })),
            [
              { key: 'at', header: 'when' },
              { key: 'operation', header: 'operation' },
              { key: 'repo', header: 'repo' },
              { key: 'outcome', header: 'outcome' },
            ],
          )}\n`,
        );
      return EXIT.OK;
    }

    /* Everything below talks to GitHub. */
    const { token, source } = await requireToken(flags);
    const client = createClient({ token });

    if (group === 'whoami') {
      const me = await whoami(client);
      print({ ...me, tokenSource: source });
      return EXIT.OK;
    }

    const { policy } = await requirePolicy(flags, cwd);
    const auditFile = resolveAuditPath(policy);
    const ctx = buildContext({ client, policy, flags, auditFile });

    let result;
    let operation;
    let repo;

    if (group === 'repo' && rest[0] === 'list') {
      operation = 'repo.list';
      result = await listRepos(client, { limit: Number(flags['--limit'] ?? 30) });
    } else if (group === 'repo' && rest[0] === 'view') {
      repo = normalizeRepo(rest[1]);
      gate(policy, 'repo.view', repo);
      operation = 'repo.view';
      result = await viewRepo(client, { repo });
    } else if (group === 'repo' && rest[0] === 'create') {
      operation = 'repo.create';
      gate(policy, operation, undefined);
      if (flags['--dry-run']) {
        result = { name: rest[1], org: flags['--org'] ?? null, private: Boolean(flags['--private']), dryRun: true };
      } else {
        result = await createRepo(client, {
          name: rest[1],
          private: Boolean(flags['--private']),
          description: flags['--description'] ?? '',
          org: flags['--org'] ?? null,
        });
        repo = result.fullName;
      }
    } else if (group === 'file' && rest[0] === 'read') {
      repo = normalizeRepo(rest[1]);
      gate(policy, 'file.read', repo);
      operation = 'file.read';
      result = await readFileAtRef(client, { repo, filePath: rest[2], ref: flags['--ref'] });
    } else if (group === 'file' && rest[0] === 'ls') {
      repo = normalizeRepo(rest[1]);
      gate(policy, 'file.read', repo);
      operation = 'file.read';
      result = await listEntriesAtRef(client, { repo, dirPath: rest[2] ?? '', ref: flags['--ref'] });
    } else if (group === 'branch' && rest[0] === 'create') {
      repo = normalizeRepo(rest[1]);
      gate(policy, 'branch.create', repo);
      operation = 'branch.create';
      result = await createBranch(client, {
        repo,
        branch: rest[2],
        from: flags['--from'],
        dryRun: Boolean(flags['--dry-run']),
      });
    } else if (group === 'commit') {
      repo = normalizeRepo(rest[0]);
      gate(policy, 'commit.create', repo);
      operation = 'commit.create';
      const filePairs = flags._repeat['--file'] ?? [];
      if (filePairs.length === 0) throw new UsageError('commit needs at least one --file local=remote');
      const files = await collectFiles(filePairs, { cwd });
      result = await commitFiles(client, {
        repo,
        branch: flags['--branch'],
        message: flags['-m'] ?? flags['--message'],
        files,
        createBranchFrom: flags['--create-branch-from'] ?? null,
        dryRun: Boolean(flags['--dry-run']),
      });
    } else if (group === 'pr' && rest[0] === 'list') {
      repo = normalizeRepo(rest[1]);
      gate(policy, 'pr.list', repo);
      operation = 'pr.list';
      result = await listPullRequests(client, {
        repo,
        state: flags['--state'] ?? 'open',
        limit: Number(flags['--limit'] ?? 30),
      });
    } else if (group === 'pr' && rest[0] === 'view') {
      repo = normalizeRepo(rest[1]);
      gate(policy, 'pr.view', repo);
      operation = 'pr.view';
      result = await viewPullRequest(client, { repo, number: Number(rest[2]) });
    } else if (group === 'pr' && rest[0] === 'create') {
      repo = normalizeRepo(rest[1]);
      gate(policy, 'pr.create', repo);
      operation = 'pr.create';
      result = await createPullRequest(client, {
        repo,
        head: flags['--head'],
        base: flags['--base'],
        title: flags['--title'],
        body: await bodyFromFlags(flags),
        draft: Boolean(flags['--draft']),
        dryRun: Boolean(flags['--dry-run']),
      });
    } else if (group === 'issue' && rest[0] === 'list') {
      repo = normalizeRepo(rest[1]);
      gate(policy, 'issue.list', repo);
      operation = 'issue.list';
      result = await listIssues(client, {
        repo,
        state: flags['--state'] ?? 'open',
        limit: Number(flags['--limit'] ?? 30),
      });
    } else if (group === 'issue' && rest[0] === 'create') {
      repo = normalizeRepo(rest[1]);
      gate(policy, 'issue.create', repo);
      operation = 'issue.create';
      result = await createIssue(client, {
        repo,
        title: flags['--title'],
        body: await bodyFromFlags(flags),
        labels: flags._repeat['--label'] ?? [],
        dryRun: Boolean(flags['--dry-run']),
      });
    } else if (group === 'api') {
      const method = (rest[0] ?? 'GET').toUpperCase();
      operation = rawOperationFor(method);
      gate(policy, operation);
      const body = flags['--body-file'] ? JSON.parse(await readFile(path.resolve(flags['--body-file']), 'utf8')) : undefined;
      result = await rawRequest(client, {
        method,
        requestPath: rest[1],
        body,
        dryRun: Boolean(flags['--dry-run']),
      });
    } else {
      throw new UsageError(`unknown command "${positionals.join(' ')}" (try \`ghl help\`)`);
    }

    await ctx.record({ operation, repo: repo ?? null, outcome: 'ok', dryRun: Boolean(flags['--dry-run']) });

    if (Array.isArray(result)) {
      if (json) print(result);
      else if (result.length > 0 && typeof result[0] === 'object') {
        const columns = Object.keys(result[0]).slice(0, 5).map((key) => ({ key, header: key }));
        stdout.write(`${formatTable(result, columns)}\n`);
      } else print(result);
    } else {
      print(result);
    }
    return EXIT.OK;
  } catch (error) {
    if (error instanceof PolicyDeniedError) {
      stderr.write(`ghl: ${error.message}\n`);
      stderr.write('hint: `ghl policy show` explains what the active policy allows.\n');
      return EXIT.DENIED;
    }
    if (error instanceof UsageError) {
      stderr.write(`ghl: ${error.message}\n`);
      return EXIT.USAGE;
    }
    if (error instanceof GithubError) {
      stderr.write(`ghl: ${redact(error.message)}\n`);
      if (error.status === 401) stderr.write('hint: the token is missing or expired.\n');
      if (error.status === 403) stderr.write('hint: the token may lack the required scope.\n');
      if (error.status === 404) stderr.write('hint: wrong repository name, or the token cannot see it.\n');
      return EXIT.ERROR;
    }
    stderr.write(`ghl: ${redact(error && error.message ? error.message : String(error))}\n`);
    if (flags['--verbose'] && error && error.stack) stderr.write(`${redact(error.stack)}\n`);
    return EXIT.ERROR;
  }
}

function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const code = await run(process.argv.slice(2));
  process.exitCode = code;
}

export { run };
export { OPERATIONS };
