/**
 * Command implementations.
 *
 * Each command takes an explicit context instead of reaching for globals, which
 * is what makes them testable without a network or a real token.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { authorize, normalizeRepo } from './policy.mjs';
import { GithubError } from './github.mjs';

export class PolicyDeniedError extends Error {
  constructor(operation, reasons) {
    super(`policy denied "${operation}":\n  - ${reasons.join('\n  - ')}`);
    this.name = 'PolicyDeniedError';
    this.operation = operation;
    this.reasons = reasons;
  }
}

/** Run the policy gate for one operation and throw a readable error when it says no. */
export function gate(policy, operation, repo) {
  const verdict = authorize(policy, { operation, repo });
  if (!verdict.allowed) throw new PolicyDeniedError(operation, verdict.reasons);
  return verdict;
}

const enc = {
  repo: (repo) => {
    const [owner, name] = normalizeRepo(repo).split('/');
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  },
  ref: (branch) => `heads/${branch}`,
};

function toBase64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

/* ------------------------------------------------------------------ identity */

export async function whoami(client) {
  const { payload: user, headers } = await client.request('GET', '/user');
  return {
    login: user.login,
    name: user.name ?? null,
    id: user.id,
    type: user.type,
    scopes: (headers.get('x-oauth-scopes') ?? '')
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean),
  };
}

/* --------------------------------------------------------------- repositories */

export async function listRepos(client, { limit = 30 } = {}) {
  const repos = await client.paginate('/user/repos', {
    limit,
    query: { per_page: Math.min(limit, 100), sort: 'pushed', affiliation: 'owner,collaborator,organization_member' },
  });
  return repos.map((repo) => ({
    fullName: repo.full_name,
    private: repo.private,
    defaultBranch: repo.default_branch,
    pushedAt: repo.pushed_at,
    description: repo.description,
  }));
}

export async function viewRepo(client, { repo }) {
  const { payload } = await client.request('GET', enc.repo(repo));
  return {
    fullName: payload.full_name,
    private: payload.private,
    defaultBranch: payload.default_branch,
    description: payload.description,
    stars: payload.stargazers_count,
    openIssues: payload.open_issues_count,
    license: payload.license ? payload.license.spdx_id : null,
    topics: payload.topics ?? [],
    htmlUrl: payload.html_url,
  };
}

export async function createRepo(client, { name, private: isPrivate = false, description = '', org = null, autoInit = false }) {
  const requestPath = org ? `/orgs/${encodeURIComponent(org)}/repos` : '/user/repos';
  const { payload } = await client.request('POST', requestPath, {
    body: { name, private: isPrivate, description, auto_init: autoInit },
  });
  return {
    fullName: payload.full_name,
    private: payload.private,
    defaultBranch: payload.default_branch,
    htmlUrl: payload.html_url,
    cloneUrl: payload.clone_url,
  };
}

/* ---------------------------------------------------------------------- files */

export async function readFileAtRef(client, { repo, filePath, ref }) {
  const query = ref ? { ref } : undefined;
  const { payload } = await client.request(
    'GET',
    `${enc.repo(repo)}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`,
    { query, accept: 'application/vnd.github.raw' },
  );
  return typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
}

export async function listEntriesAtRef(client, { repo, dirPath = '', ref }) {
  const suffix = dirPath === '' ? '' : `/${dirPath.split('/').map(encodeURIComponent).join('/')}`;
  const { payload } = await client.request('GET', `${enc.repo(repo)}/contents${suffix}`, {
    query: ref ? { ref } : undefined,
  });
  if (!Array.isArray(payload)) throw new GithubError('expected a directory listing');
  return payload.map((entry) => ({ name: entry.name, type: entry.type, path: entry.path, sha: entry.sha }));
}

/* -------------------------------------------------------------------- branches */

async function resolveRefSha(client, repo, branch) {
  try {
    const { payload } = await client.request('GET', `${enc.repo(repo)}/git/ref/${enc.ref(branch)}`);
    return payload.object.sha;
  } catch (error) {
    if (error instanceof GithubError && error.status === 404) return null;
    throw error;
  }
}

export async function createBranch(client, { repo, branch, from, dryRun = false }) {
  const existing = await resolveRefSha(client, repo, branch);
  if (existing) return { branch, sha: existing, created: false };
  const baseSha = await resolveRefSha(client, repo, from);
  if (!baseSha) throw new GithubError(`base branch "${from}" not found`, { status: 404, method: 'GET' });
  if (dryRun) return { branch, sha: baseSha, created: false, dryRun: true, from };
  const { payload } = await client.request('POST', `${enc.repo(repo)}/git/refs`, {
    body: { ref: `refs/heads/${branch}`, sha: baseSha },
  });
  return { branch, sha: payload.object.sha, created: true, from };
}

/* --------------------------------------------------------------------- commits */

/**
 * Write one commit containing several files, using the Git Data API so the whole
 * change lands atomically instead of as one commit per file.
 *
 * @param {{repo: string, branch: string, message: string, files: Array<{path: string, content: string}>,
 *          createBranchFrom?: string|null, dryRun?: boolean}} input
 */
export async function commitFiles(client, { repo, branch, message, files, createBranchFrom = null, dryRun = false }) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('no files to commit');
  const plan = { repo: normalizeRepo(repo), branch, message, files: files.map((file) => file.path) };

  const branchExists = await resolveRefSha(client, repo, branch);
  let parentSha = branchExists;
  if (!branchExists) {
    if (!createBranchFrom) {
      throw new Error(`branch "${branch}" does not exist; pass --create-branch-from <ref>`);
    }
    const baseSha = await resolveRefSha(client, repo, createBranchFrom);
    if (!baseSha) throw new GithubError(`base branch "${createBranchFrom}" not found`, { status: 404 });
    if (dryRun) return { ...plan, dryRun: true, wouldCreateBranchFrom: createBranchFrom, wouldCreateCommit: true };
    await client.request('POST', `${enc.repo(repo)}/git/refs`, {
      body: { ref: `refs/heads/${branch}`, sha: baseSha },
    });
    parentSha = baseSha;
  }

  const { payload: parentCommit } = await client.request('GET', `${enc.repo(repo)}/git/commits/${parentSha}`);
  const baseTree = parentCommit.tree.sha;

  if (dryRun) {
    return { ...plan, dryRun: true, parent: parentSha, baseTree, wouldCreateCommit: true };
  }

  const treeEntries = [];
  for (const file of files) {
    const { payload: blob } = await client.request('POST', `${enc.repo(repo)}/git/blobs`, {
      body: { content: toBase64(file.content), encoding: 'base64' },
    });
    treeEntries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const { payload: tree } = await client.request('POST', `${enc.repo(repo)}/git/trees`, {
    body: { base_tree: baseTree, tree: treeEntries },
  });

  const { payload: commit } = await client.request('POST', `${enc.repo(repo)}/git/commits`, {
    body: { message, tree: tree.sha, parents: [parentSha] },
  });

  await client.request('PATCH', `${enc.repo(repo)}/git/refs/${enc.ref(branch)}`, {
    body: { sha: commit.sha, force: false },
  });

  return {
    ...plan,
    commit: commit.sha,
    tree: tree.sha,
    parent: parentSha,
    htmlUrl: `https://github.com/${normalizeRepo(repo)}/commit/${commit.sha}`,
  };
}

/** Read `--file local=repo` pairs into `{path, content}` objects. */
export async function collectFiles(pairs, { cwd = process.cwd(), readFileImpl = readFile } = {}) {
  const files = [];
  for (const pair of pairs) {
    const separator = pair.indexOf('=');
    const localPath = separator === -1 ? pair : pair.slice(0, separator);
    const repoTarget = separator === -1 ? pair : pair.slice(separator + 1);
    const absolute = path.resolve(cwd, localPath);
    const content = await readFileImpl(absolute, 'utf8');
    files.push({ path: repoTarget.replace(/^\/+/, ''), content, localPath: absolute });
  }
  return files;
}

/* ------------------------------------------------------------------ pull requests */

export async function listPullRequests(client, { repo, state = 'open', limit = 30 }) {
  const pulls = await client.paginate(`${enc.repo(repo)}/pulls`, {
    limit,
    query: { state, per_page: Math.min(limit, 100), sort: 'updated', direction: 'desc' },
  });
  return pulls.map((pull) => ({
    number: pull.number,
    title: pull.title,
    state: pull.state,
    draft: pull.draft,
    head: pull.head.ref,
    base: pull.base.ref,
    user: pull.user && pull.user.login,
  }));
}

export async function viewPullRequest(client, { repo, number }) {
  const { payload } = await client.request('GET', `${enc.repo(repo)}/pulls/${number}`);
  return {
    number: payload.number,
    title: payload.title,
    state: payload.state,
    merged: payload.merged,
    head: payload.head.ref,
    base: payload.base.ref,
    body: payload.body,
    additions: payload.additions,
    deletions: payload.deletions,
    changedFiles: payload.changed_files,
    htmlUrl: payload.html_url,
  };
}

export async function createPullRequest(client, { repo, head, base, title, body = '', draft = false, dryRun = false }) {
  if (dryRun) return { repo: normalizeRepo(repo), head, base, title, draft, dryRun: true };
  const { payload } = await client.request('POST', `${enc.repo(repo)}/pulls`, {
    body: { head, base, title, body, draft },
  });
  return { number: payload.number, htmlUrl: payload.html_url, state: payload.state };
}

/* ------------------------------------------------------------------------- issues */

export async function listIssues(client, { repo, state = 'open', limit = 30 }) {
  const issues = await client.paginate(`${enc.repo(repo)}/issues`, {
    limit,
    query: { state, per_page: Math.min(limit, 100), sort: 'updated', direction: 'desc' },
  });
  return issues
    .filter((issue) => issue.pull_request === undefined)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      labels: (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name)),
      user: issue.user && issue.user.login,
    }));
}

export async function createIssue(client, { repo, title, body = '', labels = [], dryRun = false }) {
  if (dryRun) return { repo: normalizeRepo(repo), title, labels, dryRun: true };
  const { payload } = await client.request('POST', `${enc.repo(repo)}/issues`, {
    body: { title, body, labels },
  });
  return { number: payload.number, htmlUrl: payload.html_url, state: payload.state };
}

/* ---------------------------------------------------------------------------- raw */

export function rawOperationFor(method) {
  return method.toUpperCase() === 'GET' ? 'raw.read' : 'raw.write';
}

export async function rawRequest(client, { method, requestPath, body, dryRun = false }) {
  const upper = method.toUpperCase();
  if (dryRun && upper !== 'GET') return { method: upper, path: requestPath, dryRun: true };
  const { payload, status } = await client.request(upper, requestPath, body === undefined ? {} : { body });
  return { method: upper, path: requestPath, status, payload };
}
