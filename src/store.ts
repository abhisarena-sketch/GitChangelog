// Local, git-excluded state in <repo>/.changelog: processed-commit ledger and retry queue.
import fs from 'node:fs';
import path from 'node:path';
import type { ChangelogEntry } from './types.js';
import { STATE_DIR, stateDir } from './config.js';
import { git, tryGit } from './git.js';

interface State {
  lastCommit?: string;
  lastRunAt?: string;
  processed: string[];
}

export interface QueuedEntry {
  file: string;
  entry: ChangelogEntry;
  error: string;
  attempts: number;
  queuedAt: string;
}

const statePath = (root: string) => path.join(stateDir(root), 'state.json');
const queueDir = (root: string) => path.join(stateDir(root), 'queue');

export function readState(root: string): State {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(root), 'utf8'));
    return { processed: Array.isArray(s.processed) ? s.processed : [], lastCommit: s.lastCommit, lastRunAt: s.lastRunAt };
  } catch {
    return { processed: [] };
  }
}

export function markProcessed(root: string, hash: string): void {
  const state = readState(root);
  state.processed = [hash, ...state.processed.filter((h) => h !== hash)].slice(0, 500);
  state.lastCommit = hash;
  state.lastRunAt = new Date().toISOString();
  fs.mkdirSync(stateDir(root), { recursive: true });
  fs.writeFileSync(statePath(root), JSON.stringify(state, null, 2));
}

export const wasProcessed = (root: string, hash: string) => readState(root).processed.includes(hash);

export function enqueue(root: string, entry: ChangelogEntry, error: string, attempts = 0): string {
  const dir = queueDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${entry.commit.hash.slice(0, 7)}-${entry.category}.json`);
  fs.writeFileSync(file, JSON.stringify({ entry, error, attempts, queuedAt: new Date().toISOString() }, null, 2));
  return file;
}

export function listQueue(root: string): QueuedEntry[] {
  const dir = queueDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .flatMap((n) => {
      try {
        return [{ file: path.join(dir, n), ...JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) }];
      } catch {
        return []; // unreadable queue file: leave it for the user to inspect
      }
    });
}

export const dequeue = (file: string) => fs.rmSync(file, { force: true });

/** Keeps .changelog/ (state, queue, local secrets) out of git without touching the project's .gitignore. */
export function excludeStateDir(root: string): void {
  const exclude = path.resolve(root, git(root, ['rev-parse', '--git-path', 'info/exclude']).trim());
  const line = `/${STATE_DIR}/`;
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (current.split(/\r?\n/).includes(line)) return;
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}# Git ChangeLog local state\n${line}\n`);
}

export const isStateDirExcluded = (root: string) => tryGit(root, ['check-ignore', '-q', '--no-index', `${STATE_DIR}/state.json`]) !== null;
