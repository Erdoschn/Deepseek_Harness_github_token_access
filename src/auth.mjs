/**
 * Token resolution.
 *
 * The token is read at call time and never cached, logged, or echoed. `ghl whoami`
 * prints only the source it came from.
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Lookup order. The first hit wins.
 * `env` entries read the process environment, `file` entries are read lazily.
 */
export const TOKEN_SOURCES = [
  { kind: 'env', name: 'GHL_TOKEN' },
  { kind: 'env', name: 'GITHUB_TOKEN' },
  { kind: 'env', name: 'GH_TOKEN' },
  { kind: 'file', name: '~/.dsh/secrets/github-token' },
  { kind: 'file', name: '~/.config/ghl/token' },
  { kind: 'file', name: '~/.gh-latch/token' },
];

export function expandHome(file, home = os.homedir()) {
  if (file === '~') return home;
  if (file.startsWith('~/') || file.startsWith('~\\')) return path.join(home, file.slice(2));
  return file;
}

export function maskToken(token) {
  if (!token) return '<none>';
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}…${token.slice(-4)} (${token.length} chars)`;
}

/**
 * @returns {Promise<{token: string, source: string} | null>}
 */
export async function resolveToken({
  env = process.env,
  home = os.homedir(),
  readFileImpl = readFile,
  explicitPath,
} = {}) {
  if (explicitPath) {
    const file = expandHome(explicitPath, home);
    const token = await readTokenFile(file, readFileImpl);
    if (!token) throw new Error(`no token found in ${file}`);
    return { token, source: file };
  }

  for (const source of TOKEN_SOURCES) {
    if (source.kind === 'env') {
      const value = env[source.name];
      if (typeof value === 'string' && value.trim() !== '') {
        return { token: value.trim(), source: `env:${source.name}` };
      }
      continue;
    }
    const file = expandHome(source.name, home);
    const token = await readTokenFile(file, readFileImpl);
    if (token) return { token, source: file };
  }
  return null;
}

async function readTokenFile(file, readFileImpl) {
  let text;
  try {
    text = await readFileImpl(file, 'utf8');
  } catch {
    return null;
  }
  const token = text.trim();
  return token === '' ? null : token;
}

/** Strip anything that looks like a credential out of free-form text before logging. */
export function redact(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,})\b/g, '<redacted-token>')
    .replace(/\b(github_pat_[A-Za-z0-9_]{16,})\b/g, '<redacted-token>')
    .replace(/\b([A-Za-z0-9_-]*(?:token|secret|password)[A-Za-z0-9_-]*=)([^\s&"']+)/gi, '$1<redacted>');
}
