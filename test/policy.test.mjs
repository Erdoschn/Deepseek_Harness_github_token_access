import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ADMIN,
  OPERATIONS,
  PolicyError,
  authorize,
  describePolicy,
  isRepoAllowed,
  normalizeRepo,
  parsePolicyJson,
  repoMatches,
  validatePolicy,
} from '../src/policy.mjs';

const basePolicy = () =>
  validatePolicy({
    repos: { allow: ['acme/*'], deny: ['acme/secret'] },
    permissions: ['read', 'write'],
  });

test('normalizeRepo trims, lower-cases and validates', () => {
  assert.equal(normalizeRepo('  Acme/API  '), 'acme/api');
  assert.equal(normalizeRepo('acme/*'), 'acme/*');
  assert.throws(() => normalizeRepo('acme'), PolicyError);
  assert.throws(() => normalizeRepo('acme/api/extra'), PolicyError);
});

test('repoMatches honours wildcards per segment', () => {
  assert.equal(repoMatches('acme/*', 'acme/api'), true);
  assert.equal(repoMatches('*/api', 'acme/api'), true);
  assert.equal(repoMatches('*/*', 'anything/here'), true);
  assert.equal(repoMatches('acme/api', 'acme/apiv2'), false);
});

test('deny wins over allow', () => {
  const policy = basePolicy();
  assert.equal(isRepoAllowed(policy, 'acme/api'), true);
  assert.equal(isRepoAllowed(policy, 'acme/secret'), false);
  assert.equal(isRepoAllowed(policy, 'other/api'), false);
});

test('the admin level cannot be granted at all', () => {
  assert.throws(() => validatePolicy({ permissions: [ADMIN] }), /reserved/);
});

test('unknown policy keys and unknown permissions are rejected', () => {
  assert.throws(() => validatePolicy({ permisions: ['read'] }), /unknown policy key/);
  assert.throws(() => validatePolicy({ permissions: ['write', 'sudo'] }), /unknown permission/);
});

test('denyOperations must name a real operation', () => {
  assert.throws(() => validatePolicy({ denyOperations: ['rm -rf'] }), /unknown operation/);
  assert.doesNotThrow(() => validatePolicy({ denyOperations: ['*'] }));
});

test('read-only policy refuses writes', () => {
  const policy = validatePolicy({ repos: { allow: ['acme/*'] }, permissions: ['read'] });
  assert.equal(authorize(policy, { operation: 'file.read', repo: 'acme/api' }).allowed, true);
  const verdict = authorize(policy, { operation: 'commit.create', repo: 'acme/api' });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reasons.join(' '), /needs permission "write"/);
});

test('write permission still needs the allow-list', () => {
  const policy = basePolicy();
  assert.equal(authorize(policy, { operation: 'commit.create', repo: 'acme/api' }).allowed, true);
  const verdict = authorize(policy, { operation: 'commit.create', repo: 'evil/repo' });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reasons.join(' '), /not covered by repos\.allow/);
});

test('creating a repository additionally needs allowRepoCreate', () => {
  const policy = basePolicy();
  assert.equal(authorize(policy, { operation: 'repo.create' }).allowed, false);
  const permissive = validatePolicy({
    repos: { allow: ['acme/*'] },
    permissions: ['read', 'write'],
    allowRepoCreate: true,
  });
  assert.equal(authorize(permissive, { operation: 'repo.create' }).allowed, true);
});

test('the raw API is closed unless rawApi is set', () => {
  const policy = basePolicy();
  assert.equal(authorize(policy, { operation: 'raw.read' }).allowed, false);
  const permissive = validatePolicy({ permissions: ['read'], rawApi: true });
  assert.equal(authorize(permissive, { operation: 'raw.read' }).allowed, true);
});

test('denyOperations blocks a single operation and "*" blocks everything', () => {
  const one = validatePolicy({
    repos: { allow: ['acme/*'] },
    permissions: ['read', 'write'],
    denyOperations: ['commit.create'],
  });
  assert.equal(authorize(one, { operation: 'commit.create', repo: 'acme/api' }).allowed, false);
  assert.equal(authorize(one, { operation: 'pr.create', repo: 'acme/api' }).allowed, true);

  const all = validatePolicy({ permissions: ['read', 'write'], denyOperations: ['*'] });
  for (const operation of Object.keys(OPERATIONS)) {
    assert.equal(authorize(all, { operation }).allowed, false, operation);
  }
});

test('every reason is reported at once', () => {
  const policy = validatePolicy({ repos: { allow: [] }, permissions: [] });
  const verdict = authorize(policy, { operation: 'repo.create', repo: 'acme/api' });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reasons.length, 3);
});

test('a bad repository pattern becomes a reason instead of a crash', () => {
  const policy = basePolicy();
  const verdict = authorize(policy, { operation: 'file.read', repo: 'not-a-repo' });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reasons.join(' '), /not a repository pattern/);
});

test('parsePolicyJson explains syntax errors', () => {
  assert.throws(() => parsePolicyJson('{ oops }'), /not valid JSON/);
});

test('a byte-order mark is tolerated', () => {
  const policy = parsePolicyJson('\uFEFF{"version":1,"repos":{"allow":["acme/*"]}}');
  assert.deepEqual(policy.repos.allow, ['acme/*']);
});

test('describePolicy lists every operation with its verdict', () => {
  const described = describePolicy(basePolicy());
  assert.deepEqual(described.permissions, ['read', 'write']);
  assert.equal(described.operations.length, Object.keys(OPERATIONS).length);
  const create = described.operations.find((entry) => entry.operation === 'repo.create');
  assert.equal(create.enabled, false);
  const read = described.operations.find((entry) => entry.operation === 'file.read');
  assert.equal(read.enabled, true);
});
