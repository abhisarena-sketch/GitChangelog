// Pipeline: commit extraction → analysis → ChangelogEntry → destination adapter.
// Destination-specific behavior lives entirely behind the ChangelogDestination interface.
import type { ChangelogDestination, ChangelogEntry, CommitInfo, FetchLike } from './types.js';
import { loadConfig, loadSecrets } from './config.js';
import type { Config, Secrets } from './config.js';
import { extractCommit, resolveCommit } from './git.js';
import { analyzeCommit } from './analysis/index.js';
import { buildEntries } from './entry.js';
import { createDestination } from './destinations/index.js';
import { dequeue, enqueue, listQueue, markProcessed, wasProcessed } from './store.js';

export interface Deps {
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  /** Override adapter construction (tests, future plugins). */
  destination?: (config: Config, secrets: Secrets) => ChangelogDestination;
}

export interface PublishResult {
  published: ChangelogEntry[];
  duplicates: ChangelogEntry[];
  queued: ChangelogEntry[];
  error?: string;
}

export interface RunResult extends PublishResult {
  status: 'published' | 'queued' | 'duplicate' | 'empty' | 'dry-run';
  commit?: CommitInfo;
  entries: ChangelogEntry[];
  analysis?: 'anthropic' | 'openai' | 'local';
  warnings: string[];
  destination: string;
}

function context(root: string, deps: Deps) {
  const env = deps.env ?? process.env;
  const config = loadConfig(root, env);
  const secrets = loadSecrets(root, env);
  const fetchImpl = deps.fetch ?? fetch;
  const destination = deps.destination ? deps.destination(config, secrets) : createDestination(config, secrets, fetchImpl);
  return { config, secrets, fetchImpl, destination };
}

/** Publishes entries, skipping ones that already exist. Anything that fails goes to the retry queue. */
export async function publish(root: string, destination: ChangelogDestination, entries: ChangelogEntry[]): Promise<PublishResult> {
  const result: PublishResult = { published: [], duplicates: [], queued: [] };
  try {
    await destination.initialize();
  } catch (err) {
    result.error = (err as Error).message;
    for (const entry of entries) enqueue(root, entry, result.error);
    result.queued.push(...entries);
    return result;
  }
  for (const entry of entries) {
    try {
      if (await destination.exists(entry.commit.hash, entry.category)) {
        result.duplicates.push(entry);
        continue;
      }
      await destination.createEntry(entry);
      result.published.push(entry);
    } catch (err) {
      result.error = (err as Error).message;
      enqueue(root, entry, result.error);
      result.queued.push(entry);
    }
  }
  return result;
}

export async function processCommit(
  root: string,
  ref: string,
  deps: Deps = {},
  opts: { dryRun?: boolean; force?: boolean } = {},
): Promise<RunResult> {
  const { config, secrets, fetchImpl, destination } = context(root, deps);
  const hash = resolveCommit(root, ref);
  const base = { published: [], duplicates: [], queued: [], entries: [], warnings: [], destination: destination.name };

  if (!opts.force && !opts.dryRun && wasProcessed(root, hash)) return { ...base, status: 'duplicate' };

  const commit = extractCommit(root, hash, {
    maxDiffSize: config.git.maxDiffSize,
    ignore: config.ignore.paths,
    redactSecrets: config.privacy.redactSecrets,
  });
  if (!commit.files.length) {
    if (!opts.dryRun) markProcessed(root, hash);
    return { ...base, status: 'empty', commit };
  }

  const analysis = await analyzeCommit(commit, config, secrets, fetchImpl);
  const entries = buildEntries(commit, analysis, config.privacy.redactSecrets);
  const common = { ...base, commit, entries, analysis: analysis.source, warnings: analysis.warnings };
  if (opts.dryRun) return { ...common, status: 'dry-run' };

  const published = await publish(root, destination, entries);
  markProcessed(root, hash);
  return { ...common, ...published, status: published.queued.length ? 'queued' : 'published' };
}

export interface SyncResult {
  published: ChangelogEntry[];
  duplicates: ChangelogEntry[];
  failed: { entry: ChangelogEntry; error: string }[];
}

/** Retries queued entries against the current destination. Existing entries are dropped, never duplicated. */
export async function syncQueue(root: string, deps: Deps = {}): Promise<SyncResult> {
  const { destination } = context(root, deps);
  const result: SyncResult = { published: [], duplicates: [], failed: [] };
  const queue = listQueue(root);
  if (!queue.length) return result;
  try {
    await destination.initialize();
  } catch (err) {
    for (const q of queue) {
      enqueue(root, q.entry, (err as Error).message, q.attempts + 1);
      result.failed.push({ entry: q.entry, error: (err as Error).message });
    }
    return result;
  }
  for (const q of queue) {
    try {
      if (await destination.exists(q.entry.commit.hash, q.entry.category)) {
        result.duplicates.push(q.entry);
      } else {
        await destination.createEntry(q.entry);
        result.published.push(q.entry);
      }
      dequeue(q.file);
    } catch (err) {
      enqueue(root, q.entry, (err as Error).message, q.attempts + 1);
      result.failed.push({ entry: q.entry, error: (err as Error).message });
    }
  }
  return result;
}
