import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT, UsageError, parseArgs, run } from '../src/cli.mjs';

function sink() {
  return {
    data: '',
    write(chunk) {
      this.data += chunk;
      return true;
    },
  };
}

async function tempProject(policy) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ghl-cli-'));
  if (policy) {
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(path.join(dir, 'ghl.config.json'), `${JSON.stringify(policy, null, 2)}\n`, 'utf8'),
    );
  }
  return dir;
}

test('parseArgs handles short flags, repeated flags and booleans', () => {
  const { positionals, flags } = parseArgs([
    'commit',
    'acme/api',
    '-m',
    'docs: readme',
    '--file',
    'a.md=docs/a.md',
    '--file',
    'b.md',
    '--dry-run',
    '--branch=main',
  ]);
  assert.deepEqual(positionals, ['commit', 'acme/api']);
  assert.equal(flags['--message'], 'docs: readme');
  assert.deepEqual(flags._repeat['--file'], ['a.md=docs/a.md', 'b.md']);
  assert.equal(flags['--dry-run'], true);
  assert.equal(flags['--branch'], 'main');
});

test('parseArgs refuses a flag with no value', () => {
  assert.throws(() => parseArgs(['commit', 'acme/api', '--branch']), UsageError);
  assert.throws(() => parseArgs(['commit', '-m']), UsageError);
});

test('help exits successfully and mentions the command groups', async () => {
  const stdout = sink();
  const code = await run(['help'], { stdout });
  assert.equal(code, EXIT.OK);
  assert.match(stdout.data, /a latch for your GitHub token/);
  assert.match(stdout.data, /policy show/);
});

test('init writes a starter policy that a read-only check can use', async () => {
  const cwd = await tempProject();
  const stdout = sink();
  assert.equal(await run(['init', '--repo', 'acme/api'], { cwd, stdout }), EXIT.OK);

  const written = JSON.parse(await readFile(path.join(cwd, 'ghl.config.json'), 'utf8'));
  assert.deepEqual(written.repos.allow, ['acme/api']);
  assert.deepEqual(written.permissions, ['read']);

  const check = sink();
  assert.equal(await run(['policy', 'check', 'file.read', 'acme/api'], { cwd, stdout: check }), EXIT.OK);
  assert.match(check.data, /"allowed": true/);
});

test('a read-only policy denies writes with exit code 2', async () => {
  const cwd = await tempProject({ version: 1, repos: { allow: ['acme/*'] }, permissions: ['read'] });
  const code = await run(['policy', 'check', 'commit.create', 'acme/api'], { cwd, stderr: sink(), stdout: sink() });
  assert.equal(code, EXIT.DENIED);
});

test('repositories outside the allow-list are denied', async () => {
  const cwd = await tempProject({ version: 1, repos: { allow: ['acme/*'] }, permissions: ['read', 'write'] });
  const code = await run(['policy', 'check', 'commit.create', 'evil/repo'], {
    cwd,
    stderr: sink(),
    stdout: sink(),
  });
  assert.equal(code, EXIT.DENIED);
});

test('policy show reports the effective rules', async () => {
  const cwd = await tempProject({ version: 1, repos: { allow: ['acme/*'] }, permissions: ['read', 'write'] });
  const stdout = sink();
  assert.equal(await run(['policy', 'show'], { cwd, stdout }), EXIT.OK);
  const described = JSON.parse(stdout.data);
  assert.equal(described.policyFile, path.join(cwd, 'ghl.config.json'));
  assert.equal(described.allowRepoCreate, false);
});

test('a missing policy is a usage error, not a crash', async () => {
  const cwd = await tempProject();
  const stderr = sink();
  const code = await run(['repo', 'list'], { cwd, stderr, stdout: sink() });
  // No token in the environment either, but the token check comes first and is
  // also a usage error, so only the exit code is asserted here.
  assert.equal(code, EXIT.USAGE);
  assert.match(stderr.data, /ghl:/);
});

test('unknown commands are rejected with the usage exit code', async () => {
  const cwd = await tempProject({ version: 1, repos: { allow: ['acme/*'] }, permissions: ['read'] });
  const stderr = sink();
  const code = await run(['frobnicate'], { cwd, stderr });
  assert.equal(code, EXIT.USAGE);
  assert.match(stderr.data, /unknown command/);
});
