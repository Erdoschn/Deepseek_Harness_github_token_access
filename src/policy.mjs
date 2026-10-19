/**
 * The policy engine.
 *
 * Everything that reaches GitHub goes through `authorize()` first. The engine is
 * intentionally boring: a repo allow-list, a permission level, and a table of
 * operations that says what each one costs. No plugin hooks, no callbacks.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const READ = 'read';
export const WRITE = 'write';
export const ADMIN = 'admin';

export const PERMISSION_LEVELS = [READ, WRITE];

/**
 * Every command declares exactly one operation. `level` is the permission it
 * costs; `policyFlag` is an extra opt-in switch so that a broad "write" grant
 * does not silently unlock creation of brand-new repositories.
 */
export const OPERATIONS = {
  'repo.list': { level: READ, describes: 'list repositories visible to the token' },
  'repo.view': { level: READ, describes: 'read one repository' },
  'repo.create': { level: WRITE, policyFlag: 'allowRepoCreate', describes: 'create a repository' },
  'file.read': { level: READ, describes: 'read a file at a ref' },
  'branch.create': { level: WRITE, describes: 'create a branch' },
  'commit.create': { level: WRITE, describes: 'write a commit' },
  'pr.list': { level: READ, describes: 'list pull requests' },
  'pr.view': { level: READ, describes: 'read one pull request' },
  'pr.create': { level: WRITE, describes: 'open a pull request' },
  'issue.list': { level: READ, describes: 'list issues' },
  'issue.create': { level: WRITE, describes: 'open an issue' },
  'raw.read': { level: READ, policyFlag: 'rawApi', describes: 'raw GET against the REST API' },
  'raw.write': { level: WRITE, policyFlag: 'rawApi', describes: 'raw non-GET against the REST API' },
};

const POLICY_FILE = 'ghl.config.json';
const KNOWN_KEYS = new Set([
  'version',
  'repos',
  'permissions',
  'denyOperations',
  'allowRepoCreate',
  'rawApi',
  'auditLog',
  '$comment',
]);

export function defaultPolicy() {
  return {
    version: 1,
    repos: { allow: [], deny: [] },
    permissions: [READ],
    denyOperations: [],
    allowRepoCreate: false,
    rawApi: false,
    auditLog: null,
  };
}

class PolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyError';
  }
}

export { PolicyError };

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new PolicyError(`"${field}" must be an array of strings`);
  }
  return value;
}

const REPO_PATTERN = /^(\*|[a-z0-9_.-]+)\/(\*|[a-z0-9_.-]+)$/i;

/** Trim, lower-case and validate a `owner/name` (or `owner/*`) pattern. */
export function normalizeRepo(value) {
  if (typeof value !== 'string') throw new PolicyError('repository must be a string');
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  if (!REPO_PATTERN.test(trimmed)) {
    throw new PolicyError(
      `"${value}" is not a repository pattern; expected "owner/name", "owner/*" or "*/*"`,
    );
  }
  return trimmed.toLowerCase();
}

/** Validate a parsed policy object and fill in defaults. Unknown keys are rejected. */
export function validatePolicy(input) {
  if (!isPlainObject(input)) throw new PolicyError('policy must be a JSON object');
  for (const key of Object.keys(input)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new PolicyError(
        `unknown policy key "${key}" (known keys: ${[...KNOWN_KEYS].join(', ')})`,
      );
    }
  }
  if (input.version !== undefined && input.version !== 1) {
    throw new PolicyError(`unsupported policy version ${input.version}`);
  }

  const policy = defaultPolicy();

  if (input.repos !== undefined) {
    if (!isPlainObject(input.repos)) throw new PolicyError('"repos" must be an object');
    for (const key of Object.keys(input.repos)) {
      if (key !== 'allow' && key !== 'deny') {
        throw new PolicyError(`unknown key "repos.${key}" (known keys: allow, deny)`);
      }
    }
    policy.repos.allow = asStringArray(input.repos.allow, 'repos.allow').map(normalizeRepo);
    policy.repos.deny = asStringArray(input.repos.deny, 'repos.deny').map(normalizeRepo);
  }

  if (input.permissions !== undefined) {
    const permissions = asStringArray(input.permissions, 'permissions');
    if (permissions.includes(ADMIN)) {
      throw new PolicyError(
        `policy level "${ADMIN}" is reserved: gh-latch performs no administrative operations`,
      );
    }
    for (const permission of permissions) {
      if (!PERMISSION_LEVELS.includes(permission)) {
        throw new PolicyError(
          `unknown permission "${permission}" (expected ${PERMISSION_LEVELS.join(' or ')})`,
        );
      }
    }
    policy.permissions = [...new Set(permissions)];
  }

  policy.denyOperations = asStringArray(input.denyOperations, 'denyOperations');
  for (const operation of policy.denyOperations) {
    if (operation !== '*' && OPERATIONS[operation] === undefined) {
      throw new PolicyError(`denyOperations: unknown operation "${operation}"`);
    }
  }

  if (input.allowRepoCreate !== undefined) {
    if (typeof input.allowRepoCreate !== 'boolean') {
      throw new PolicyError('"allowRepoCreate" must be a boolean');
    }
    policy.allowRepoCreate = input.allowRepoCreate;
  }

  if (input.rawApi !== undefined) {
    if (typeof input.rawApi !== 'boolean') throw new PolicyError('"rawApi" must be a boolean');
    policy.rawApi = input.rawApi;
  }

  if (input.auditLog !== undefined) {
    if (input.auditLog !== null && typeof input.auditLog !== 'string') {
      throw new PolicyError('"auditLog" must be a string path or null');
    }
    policy.auditLog = input.auditLog;
  }

  return policy;
}

export function parsePolicyJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new PolicyError(`policy is not valid JSON: ${error.message}`);
  }
  return validatePolicy(parsed);
}

/**
 * Find the policy file: an explicit path, then `ghl.config.json` in the working
 * directory, then in each parent up to the filesystem root.
 */
export async function findPolicyFile(cwd, explicitPath) {
  if (explicitPath) {
    const resolved = path.resolve(cwd, explicitPath);
    return resolved;
  }
  let current = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(current, POLICY_FILE);
    try {
      await readFile(candidate, 'utf8');
      return candidate;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

export async function loadPolicyFile(file) {
  const text = await readFile(file, 'utf8');
  return parsePolicyJson(text);
}

/** Does `pattern` cover `repo`? Both must already be normalized. */
export function repoMatches(pattern, repo) {
  const [patternOwner, patternName] = pattern.split('/');
  const [owner, name] = repo.split('/');
  const wild = (needle, haystack) => needle === '*' || needle === haystack;
  return wild(patternOwner, owner) && wild(patternName, name);
}

export function isRepoAllowed(policy, repo) {
  const target = normalizeRepo(repo);
  if (policy.repos.deny.some((pattern) => repoMatches(pattern, target))) return false;
  return policy.repos.allow.some((pattern) => repoMatches(pattern, target));
}

/**
 * The single gate. Returns `{ allowed: true, level }` or `{ allowed: false, reasons: [...] }`.
 * Every reason is reported, not just the first, so a user can fix a policy in one pass.
 */
export function authorize(policy, { operation, repo }) {
  const definition = OPERATIONS[operation];
  if (!definition) throw new PolicyError(`unknown operation "${operation}"`);
  const reasons = [];

  if (policy.denyOperations.includes('*') || policy.denyOperations.includes(operation)) {
    reasons.push(`operation "${operation}" is denied by denyOperations`);
  }

  if (!policy.permissions.includes(definition.level)) {
    reasons.push(
      `operation "${operation}" needs permission "${definition.level}" but the policy grants ${policy.permissions.length ? policy.permissions.map((p) => `"${p}"`).join(', ') : 'nothing'}`,
    );
  }

  if (definition.policyFlag && policy[definition.policyFlag] !== true) {
    reasons.push(`operation "${operation}" requires policy flag "${definition.policyFlag}": true`);
  }

  if (repo !== undefined && repo !== null) {
    let target;
    try {
      target = normalizeRepo(repo);
    } catch (error) {
      reasons.push(error.message);
      target = null;
    }
    if (target && !isRepoAllowed(policy, target)) {
      reasons.push(`repository "${target}" is not covered by repos.allow (or is listed in repos.deny)`);
    }
  }

  if (reasons.length > 0) return { allowed: false, reasons, level: definition.level };
  return { allowed: true, level: definition.level };
}

/** Human-readable description of what a policy permits, used by `ghl policy show`. */
export function describePolicy(policy) {
  return {
    permissions: [...policy.permissions],
    repos: { allow: [...policy.repos.allow], deny: [...policy.repos.deny] },
    allowRepoCreate: policy.allowRepoCreate,
    rawApi: policy.rawApi,
    denyOperations: [...policy.denyOperations],
    operations: Object.entries(OPERATIONS)
      .filter(([operation]) => !policy.denyOperations.includes(operation) && !policy.denyOperations.includes('*'))
      .map(([operation, definition]) => {
        const check = authorize(policy, { operation });
        return {
          operation,
          level: definition.level,
          enabled: check.allowed,
          ...(check.allowed ? {} : { reasons: check.reasons }),
        };
      }),
  };
}
