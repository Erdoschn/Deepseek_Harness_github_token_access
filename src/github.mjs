/**
 * A very small GitHub REST client: one `request()` plus pagination.
 *
 * No retries, no caches, no hidden state — if the caller wants something clever
 * it can compose it on top.
 */
export const DEFAULT_BASE_URL = 'https://api.github.com';
export const USER_AGENT = 'gh-latch/0.1 (+https://github.com/gh-latch/gh-latch)';

export class GithubError extends Error {
  constructor(message, { status, method, path: requestPath, documentationUrl, errors } = {}) {
    super(message);
    this.name = 'GithubError';
    this.status = status;
    this.method = method;
    this.path = requestPath;
    this.documentationUrl = documentationUrl;
    this.errors = errors;
  }
}

export function createClient({
  token,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  userAgent = USER_AGENT,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');

  async function request(method, requestPath, { body, query, accept = 'application/vnd.github+json' } = {}) {
    const url = new URL(requestPath.startsWith('http') ? requestPath : `${baseUrl}${requestPath}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    const headers = {
      accept,
      'user-agent': userAgent,
      'x-github-api-version': '2022-11-28',
    };
    if (token) headers.authorization = `Bearer ${token}`;

    const init = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const response = await fetchImpl(url, init);
    const text = await response.text();
    let payload;
    if (text !== '') {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      const message =
        (payload && typeof payload === 'object' && payload.message) ||
        `${response.status} ${response.statusText}`;
      throw new GithubError(`${method} ${url.pathname} failed: ${message}`, {
        status: response.status,
        method,
        path: url.pathname,
        documentationUrl: payload && payload.documentation_url,
        errors: payload && payload.errors,
      });
    }
    return { payload, headers: response.headers, status: response.status };
  }

  /** Follow `Link: rel="next"` until `limit` items were collected or the pages run out. */
  async function paginate(requestPath, { limit = 100, query = {} } = {}) {
    const items = [];
    let next = requestPath;
    let currentQuery = query;
    while (next && items.length < limit) {
      const { payload, headers } = await request('GET', next, { query: currentQuery });
      if (!Array.isArray(payload)) {
        throw new GithubError(`expected an array from ${requestPath}`, { method: 'GET', path: requestPath });
      }
      items.push(...payload);
      const link = headers.get('link');
      const match = link && /<([^>]+)>;\s*rel="next"/.exec(link);
      next = match ? match[1] : null;
      currentQuery = {};
    }
    return items.slice(0, limit);
  }

  return { request, paginate, baseUrl };
}
