/**
 * Append-only audit log: one JSON object per line, values redacted.
 *
 * The log is written even when the call is denied, because "what was refused"
 * is as interesting as "what ran".
 */
import { appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { redact } from './auth.mjs';

export function defaultAuditPath(home = os.homedir()) {
  return path.join(home, '.gh-latch', 'audit.jsonl');
}

export function resolveAuditPath(policy, { home = os.homedir() } = {}) {
  if (policy && typeof policy.auditLog === 'string' && policy.auditLog.trim() !== '') {
    return policy.auditLog.startsWith('~')
      ? path.join(home, policy.auditLog.slice(1).replace(/^[\\/]/, ''))
      : policy.auditLog;
  }
  return defaultAuditPath(home);
}

export function formatEntry(entry) {
  return JSON.stringify({
    at: new Date().toISOString(),
    ...entry,
    ...(entry.summary ? { summary: redact(entry.summary) } : {}),
  });
}

export async function appendAudit(file, entry, { appendFileImpl = appendFile, mkdirImpl = mkdir } = {}) {
  await mkdirImpl(path.dirname(file), { recursive: true });
  await appendFileImpl(file, `${formatEntry(entry)}\n`, 'utf8');
}
