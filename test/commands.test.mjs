import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  PolicyDeniedError,
  collectFiles,
  commitFiles,
  gate,
  rawOperationFor,
} from '../src/commands.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { GithubError } from '../src/github.mjs';

/** A client that answers the Git Data API with canned payloads and records calls. */
function fakeClient({ mainExists = true, commits = [] } = {}) {
  const calls = [];
  const client = {
    calls,
    async request(method, requestPath, options = {}) {
      calls.push({ method, path: requestPath, body: options.body, query: options.query });
      if (method === 'GET' && requestPath.endsWith('/git/ref/heads/main')) {
        if (!mainExists) throw new GithubError('not found', { status: 404 });
        return { payload: { object: { sha: 'parent-sha' } } };
      }
      if (method === 'GET' && requestPath.endsWith('/git/ref/heads/feature')) {
        throw new GithubError('not found', { status: 404 });
      }
      if (method === 'GET' && requestPath.includes('/git/commits/parent-sha')) {
        return { payload: { tree: { sha: 'base-tree' } } };
      }
      if (method === 'POST' && requestPath.endsWith('/git/refs')) {
        return { payload: { object: { sha: options.body.sha } } };
      }
      if (method === 'POST' && requestPath.endsWith('/git/blobs')) {
        return { payload: { sha: `blob-${calls.length}` } };
      }
      if (method === 'POST' && requestPath.endsWith('/git/trees')) {
        return { payload: { sha: 'new-tree' } };
      }
      if (method === 'POST' && requestPath.endsWith('/git/commits')) {
        commits.push(options.body);
        return { payload: { sha: 'new-commit' } };
      }
      if (method === 'PATCH' && requestPath.includes('/git/refs/heads/')) {
        return { payload: {} };
      }
      throw new Error(`unexpected call ${method} ${requestPath}`);
    },
  };
  return client;
}

const file = (name, content = 'hello\n') => ({ path: name, content });

test('commitFiles writes blobs, a tree, a commit and moves the ref', async () => {
  const commits = [];
  const client = fakeClient({ commits });
  const result = await commitFiles(client, {
    repo: 'acme/api',
    branch: 'main',
    message: 'docs: add readme',
    files: [file('README.md'), file('docs/a.md', 'a\n')],
  });

  assert.equal(result.commit, 'new-commit');
  assert.equal(result.parent, 'parent-sha');
  assert.equal(commits.length, 1);
  assert.equal(commits[0].message, 'docs: add readme');
  assert.deepEqual(commits[0].parents, ['parent-sha']);
  assert.equal(commits[0].tree, 'new-tree');

  const patch = client.calls.at(-1);
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.path, '/repos/acme/api/git/refs/heads/main');
  assert.deepEqual(patch.body, { sha: 'new-commit', force: false });

  const tree = client.calls.find((call) => call.path.endsWith('/git/trees'));
  assert.deepEqual(tree.body.base_tree, 'base-tree');
  assert.equal(tree.body.tree.length, 2);
  assert.equal(tree.body.tree[0].mode, '100644');

  const blob = client.calls.find((call) => call.path.endsWith('/git/blobs'));
  assert.equal(blob.body.encoding, 'base64');
  assert.equal(Buffer.from(blob.body.content, 'base64').toString('utf8'), 'hello\n');
});

test('commitFiles refuses to invent a branch', async () => {
  const client = fakeClient();
  await assert.rejects(
    commitFiles(client, { repo: 'acme/api', branch: 'feature', message: 'x', files: [file('a.md')] }),
    /--create-branch-from/,
  );
});

test('commitFiles reports a missing base branch instead of guessing', async () => {
  const client = fakeClient({ mainExists: false });
  await assert.rejects(
    commitFiles(client, {
      repo: 'acme/api',
      branch: 'feature',
      createBranchFrom: 'main',
      message: 'x',
      files: [file('a.md')],
    }),
    /base branch "main" not found/,
  );
});

test('commitFiles can create the branch it commits to', async () => {
  const client = fakeClient();
  const result = await commitFiles(client, {
    repo: 'acme/api',
    branch: 'feature',
    createBranchFrom: 'main',
    message: 'feat: start',
    files: [file('a.md')],
  });
  assert.equal(result.commit, 'new-commit');
  const refPost = client.calls.find((call) => call.method === 'POST' && call.path.endsWith('/git/refs'));
  assert.deepEqual(refPost.body, { ref: 'refs/heads/feature', sha: 'parent-sha' });
});

test('a dry run performs reads only', async () => {
  const client = fakeClient();
  const result = await commitFiles(client, {
    repo: 'acme/api',
    branch: 'main',
    message: 'noop',
    files: [file('a.md')],
    dryRun: true,
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.wouldCreateCommit, true);
  assert.equal(client.calls.every((call) => call.method === 'GET'), true);
});

test('commitFiles rejects an empty file list', async () => {
  await assert.rejects(commitFiles(fakeClient(), { repo: 'acme/api', branch: 'main', message: 'x', files: [] }), /no files/);
});

test('collectFiles maps local paths to repository paths', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ghl-files-'));
  await writeFile(path.join(dir, 'README.md'), '# hi\n', 'utf8');
  await writeFile(path.join(dir, 'b.txt'), 'b\n', 'utf8');

  const files = await collectFiles(['README.md=docs/README.md', 'b.txt'], { cwd: dir });
  assert.deepEqual(
    files.map((entry) => entry.path),
    ['docs/README.md', 'b.txt'],
  );
  assert.equal(files[0].content, '# hi\n');
});

test('gate throws a policy error that names the operation', () => {
  const policy = validatePolicy({ repos: { allow: ['acme/*'] }, permissions: ['read'] });
  assert.throws(
    () => gate(policy, 'commit.create', 'acme/api'),
    (error) => error instanceof PolicyDeniedError && error.operation === 'commit.create',
  );
});

test('read-only verbs map to raw.read, everything else to raw.write', () => {
  assert.equal(rawOperationFor('get'), 'raw.read');
  assert.equal(rawOperationFor('POST'), 'raw.write');
  assert.equal(rawOperationFor('delete'), 'raw.write');
});
