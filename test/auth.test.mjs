import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { expandHome, maskToken, redact, resolveToken } from '../src/auth.mjs';

function fakeReader(files) {
  return async (file) => {
    if (Object.prototype.hasOwnProperty.call(files, file)) return files[file];
    const error = new Error(`ENOENT: ${file}`);
    error.code = 'ENOENT';
    throw error;
  };
}

test('environment beats files', async () => {
  const resolved = await resolveToken({
    env: { GITHUB_TOKEN: 'from-env' },
    home: '/home/tester',
    readFileImpl: fakeReader({ '/home/tester/.dsh/secrets/github-token': 'from-file' }),
  });
  assert.deepEqual(resolved, { token: 'from-env', source: 'env:GITHUB_TOKEN' });
});

test('GHL_TOKEN wins over GITHUB_TOKEN and GH_TOKEN', async () => {
  const resolved = await resolveToken({
    env: { GHL_TOKEN: 'first', GITHUB_TOKEN: 'second', GH_TOKEN: 'third' },
    readFileImpl: fakeReader({}),
  });
  assert.equal(resolved.source, 'env:GHL_TOKEN');
  assert.equal(resolved.token, 'first');
});

test('blank environment values are ignored', async () => {
  const home = '/home/tester';
  const tokenFile = path.join(home, '.dsh', 'secrets', 'github-token');
  const resolved = await resolveToken({
    env: { GITHUB_TOKEN: '   ' },
    home,
    readFileImpl: fakeReader({ [tokenFile]: 'file-token\n' }),
  });
  assert.deepEqual(resolved, { token: 'file-token', source: tokenFile });
});

test('no token anywhere resolves to null', async () => {
  const resolved = await resolveToken({ env: {}, home: '/home/tester', readFileImpl: fakeReader({}) });
  assert.equal(resolved, null);
});

test('an explicit --token-file is mandatory, not a fallback', async () => {
  await assert.rejects(
    resolveToken({ env: { GITHUB_TOKEN: 'x' }, home: '/h', readFileImpl: fakeReader({}), explicitPath: '/h/missing' }),
    /no token found/,
  );
  const resolved = await resolveToken({
    env: {},
    home: '/h',
    readFileImpl: fakeReader({ '/h/tok': 'abc' }),
    explicitPath: '/h/tok',
  });
  assert.deepEqual(resolved, { token: 'abc', source: '/h/tok' });
});

test('expandHome only rewrites a leading tilde', () => {
  assert.equal(expandHome('~/x', '/home/t'), path.join('/home/t', 'x'));
  assert.equal(expandHome('/a/~/x', '/home/t'), '/a/~/x');
  assert.equal(expandHome('~', '/home/t'), '/home/t');
});

test('maskToken never reveals the middle', () => {
  assert.equal(maskToken(''), '<none>');
  assert.equal(maskToken('short'), '****');
  const masked = maskToken('ghp_1234567890abcdefghij');
  assert.match(masked, /^ghp_…ghij \(\d+ chars\)$/);
});

test('redact scrubs tokens and secret-looking key/value pairs', () => {
  const text = redact('Authorization: Bearer ghp_abcdefghijklmnopqrstuvwx and token=deadbeef');
  assert.equal(text.includes('ghp_abcdefghijklmnopqrstuvwx'), false);
  assert.equal(text.includes('deadbeef'), false);
});
