import { loadConfig, loadSecrets } from './config.js';
import { extractCommit, resolveCommit } from './git.js';
import { analyzeCommit } from './analysis/index.js';
import { buildEntries } from './entry.js';
import { createDestination } from './destinations/index.js';
import { dequeue, enqueue, listQueue, markProcessed, wasProcessed } from './store.js';
function context(root, deps) {
    const env = deps.env ?? process.env;
    const config = loadConfig(root, env);
    const secrets = loadSecrets(root, env);
    const fetchImpl = deps.fetch ?? fetch;
    const destination = deps.destination ? deps.destination(config, secrets) : createDestination(config, secrets, fetchImpl);
    return { config, secrets, fetchImpl, destination };
}
/** Publishes entries, skipping ones that already exist. Anything that fails goes to the retry queue. */
export async function publish(root, destination, entries) {
    const result = { published: [], duplicates: [], queued: [] };
    try {
        await destination.initialize();
    }
    catch (err) {
        result.error = err.message;
        for (const entry of entries)
            enqueue(root, entry, result.error);
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
        }
        catch (err) {
            result.error = err.message;
            enqueue(root, entry, result.error);
            result.queued.push(entry);
        }
    }
    return result;
}
export async function processCommit(root, ref, deps = {}, opts = {}) {
    const { config, secrets, fetchImpl, destination } = context(root, deps);
    const hash = resolveCommit(root, ref);
    const base = { published: [], duplicates: [], queued: [], entries: [], warnings: [], destination: destination.name };
    if (!opts.force && !opts.dryRun && wasProcessed(root, hash))
        return { ...base, status: 'duplicate' };
    const commit = extractCommit(root, hash, {
        maxDiffSize: config.git.maxDiffSize,
        ignore: config.ignore.paths,
        redactSecrets: config.privacy.redactSecrets,
    });
    if (!commit.files.length) {
        if (!opts.dryRun)
            markProcessed(root, hash);
        return { ...base, status: 'empty', commit };
    }
    const analysis = await analyzeCommit(commit, config, secrets, fetchImpl);
    const entries = buildEntries(commit, analysis, config.privacy.redactSecrets);
    const common = { ...base, commit, entries, analysis: analysis.source, warnings: analysis.warnings };
    if (opts.dryRun)
        return { ...common, status: 'dry-run' };
    const published = await publish(root, destination, entries);
    markProcessed(root, hash);
    return { ...common, ...published, status: published.queued.length ? 'queued' : 'published' };
}
/** Retries queued entries against the current destination. Existing entries are dropped, never duplicated. */
export async function syncQueue(root, deps = {}) {
    const { destination } = context(root, deps);
    const result = { published: [], duplicates: [], failed: [] };
    const queue = listQueue(root);
    if (!queue.length)
        return result;
    try {
        await destination.initialize();
    }
    catch (err) {
        for (const q of queue) {
            enqueue(root, q.entry, err.message, q.attempts + 1);
            result.failed.push({ entry: q.entry, error: err.message });
        }
        return result;
    }
    for (const q of queue) {
        try {
            if (await destination.exists(q.entry.commit.hash, q.entry.category)) {
                result.duplicates.push(q.entry);
            }
            else {
                await destination.createEntry(q.entry);
                result.published.push(q.entry);
            }
            dequeue(q.file);
        }
        catch (err) {
            enqueue(root, q.entry, err.message, q.attempts + 1);
            result.failed.push({ entry: q.entry, error: err.message });
        }
    }
    return result;
}
