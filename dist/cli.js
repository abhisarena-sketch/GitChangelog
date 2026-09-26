#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CATEGORY_NAMES } from './types.js';
import { CONFIG_FILE, ConfigError, DEFAULT_FOLDER, configExists, configPath, defaults, loadConfig, loadSecrets, notionToken, saveConfig, saveSecrets, stateDir, } from './config.js';
import { findRepoRoot, repositoryName } from './git.js';
import { hookStatus, installHook, uninstallHook, detectHooks } from './hooks.js';
import { processCommit, syncQueue } from './engine.js';
import { createDestination, describeDestination } from './destinations/index.js';
import { NotionDestination, parseNotionId } from './destinations/notion.js';
import { detectVaults, looksLikeVault } from './destinations/obsidian.js';
import { excludeStateDir, isStateDirExcluded, listQueue, readState } from './store.js';
import { redactSecrets } from './redact.js';
import { ask, bold, confirm, dim, fail, interactive, ok, select, warn } from './prompt.js';
const CLI_PATH = fileURLToPath(import.meta.url);
const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(CLI_PATH), '..', 'package.json'), 'utf8')).version;
const HELP = `${bold('Git ChangeLog')} ${VERSION} - classify every commit into Code Changes, Bug Fixes and Feature Updates
and publish them to Notion or Obsidian.

Usage: git-changelog <command> [options]

Commands:
  init                         Configure this repository and install the post-commit hook
      --destination <notion|obsidian>   --vault <path>   --folder <path>
      --notion-token <token>   --notion-parent <page>   --notion-code-db/--notion-bug-db/--notion-feature-db <id>
      --ai <anthropic|openai|none>   --no-ai   --model <id>   --no-hook   --yes
  status                       Show hook, destination, AI provider and queue status
  analyze [--commit <ref>]     Analyze and publish a commit (default HEAD)
      --dry-run                Print the entries without publishing
      --force                  Re-analyze a commit that was already processed (never duplicates)
  sync                         Retry entries in the local retry queue
  destination [notion|obsidian]  Show or switch the destination (history is not copied)
  config [notion|obsidian|ai]  Show configuration, or reconfigure one part
  doctor                       Diagnose setup problems
  uninstall [--purge]          Remove the hook (--purge also removes ${CONFIG_FILE} and .changelog/)

Environment: CHANGELOG_AI_PROVIDER, ANTHROPIC_API_KEY, OPENAI_API_KEY, NOTION_TOKEN, GIT_CHANGELOG_SKIP=1`;
class UserError extends Error {
}
function requireRoot() {
    const root = findRepoRoot(process.cwd());
    if (!root)
        throw new UserError('Not a Git repository. Run this inside a repository (or `git init` first).');
    return root;
}
function tryLoadConfig(root) {
    try {
        return loadConfig(root);
    }
    catch {
        return undefined;
    }
}
const DEST_OPTIONS = {
    vault: { type: 'string' },
    folder: { type: 'string' },
    'notion-token': { type: 'string' },
    'notion-parent': { type: 'string' },
    'notion-code-db': { type: 'string' },
    'notion-bug-db': { type: 'string' },
    'notion-feature-db': { type: 'string' },
    yes: { type: 'boolean', short: 'y' },
};
const AI_OPTIONS = {
    ai: { type: 'string' },
    'no-ai': { type: 'boolean' },
    model: { type: 'string' },
    yes: { type: 'boolean', short: 'y' },
};
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
// ---------- configuration steps ----------
async function configureObsidian(flags, existing) {
    const validate = (v) => {
        if (!v)
            return 'A vault path is required.';
        const p = path.resolve(v);
        if (!fs.existsSync(p))
            return `Path does not exist: ${p}`;
        if (!fs.statSync(p).isDirectory())
            return `Not a directory: ${p}`;
        return null;
    };
    let vault = str(flags.vault);
    if (!vault) {
        const detected = detectVaults();
        if (interactive() && detected.length) {
            vault = await select('Which Obsidian vault?', [
                ...detected.map((v) => ({ value: v.path, label: v.name, hint: v.path })),
                { value: '', label: 'Enter a path manually' },
            ]);
        }
        if (!vault)
            vault = await ask('Obsidian vault path:', { initial: existing?.vaultPath, validate });
    }
    const error = validate(vault);
    if (error)
        throw new UserError(error);
    vault = path.resolve(vault);
    if (!looksLikeVault(vault))
        console.log(warn(`${vault} has no .obsidian folder - is it a vault? Continuing anyway.`));
    else
        console.log(ok(`Obsidian vault: ${vault}`));
    const folderCheck = (f) => {
        const target = path.resolve(vault, f);
        return target === vault || !target.startsWith(vault + path.sep) ? 'The folder must be inside the vault.' : null;
    };
    let folder = str(flags.folder) ?? (interactive() && !flags.yes
        ? await ask('Changelog folder inside the vault:', { initial: existing?.changelogFolder ?? DEFAULT_FOLDER, validate: folderCheck })
        : existing?.changelogFolder ?? DEFAULT_FOLDER);
    folder = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const folderError = folderCheck(folder);
    if (folderError)
        throw new UserError(folderError);
    return { vaultPath: vault, changelogFolder: folder };
}
async function configureNotion(root, flags, existing) {
    let token = str(flags['notion-token']) ?? loadSecrets(root).notionToken;
    if (str(flags['notion-token']))
        saveSecrets(root, { notionToken: token });
    if (!token) {
        console.log(dim('\nCreate an internal integration at https://www.notion.so/profile/integrations and copy its secret.'));
        token = await ask('Notion integration token:', { secret: true, validate: (v) => (v ? null : 'A token is required.') });
        saveSecrets(root, { notionToken: token });
    }
    else if (process.env.NOTION_TOKEN) {
        console.log(ok('Using NOTION_TOKEN from the environment'));
    }
    const probe = new NotionDestination({ databases: { codeChanges: '', bugFixes: '', featureUpdates: '' } }, token);
    if (await probe.testConnection())
        console.log(ok('Notion token works'));
    else
        console.log(warn('Could not verify the Notion token (offline or invalid). Continuing.'));
    const fromFlags = ['notion-code-db', 'notion-bug-db', 'notion-feature-db'].map((k) => str(flags[k]));
    if (fromFlags.every(Boolean)) {
        const [codeChanges, bugFixes, featureUpdates] = fromFlags.map((v) => parseNotionId(v));
        return { databases: { codeChanges, bugFixes, featureUpdates } };
    }
    const hasExisting = !!(existing?.databases.codeChanges && existing.databases.bugFixes && existing.databases.featureUpdates);
    let mode = str(flags['notion-parent']) ? 'create' : hasExisting ? 'keep' : 'create';
    if (interactive() && !flags.yes && !str(flags['notion-parent'])) {
        mode = await select('Notion databases', [
            ...(hasExisting ? [{ value: 'keep', label: 'Keep the current databases' }] : []),
            { value: 'create', label: 'Create three new databases in a Notion page' },
            { value: 'existing', label: 'Use existing database IDs' },
        ]);
    }
    if (mode === 'keep')
        return { databases: existing.databases };
    if (mode === 'create') {
        const parent = str(flags['notion-parent']) ??
            (await ask('Parent page URL or ID (share the page with your integration first):', { validate: (v) => (v ? null : 'Required.') }));
        const databases = await NotionDestination.createDatabases(parent, token);
        console.log(ok('Created Notion databases: Code Changes, Bug Fixes, Feature Updates'));
        return { databases };
    }
    const id = async (label, initial) => parseNotionId(await ask(`${label} database ID or URL:`, { initial, validate: (v) => (v ? null : 'Required.') }));
    return {
        databases: {
            codeChanges: await id('Code Changes', existing?.databases.codeChanges),
            bugFixes: await id('Bug Fixes', existing?.databases.bugFixes),
            featureUpdates: await id('Feature Updates', existing?.databases.featureUpdates),
        },
    };
}
const KEY_ENV = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };
async function configureAi(root, flags, existing) {
    let choice = flags['no-ai'] ? 'none' : str(flags.ai)?.toLowerCase();
    if (!choice) {
        const current = existing?.enabled ? existing.provider : 'none';
        choice = interactive() && !flags.yes
            ? await select('How should commits be analyzed?', [
                { value: 'anthropic', label: 'Anthropic', hint: 'Claude reads the diff (secrets redacted)' },
                { value: 'openai', label: 'OpenAI', hint: 'GPT reads the diff (secrets redacted)' },
                { value: 'none', label: 'Local / No AI', hint: 'nothing leaves your machine' },
            ], ['anthropic', 'openai', 'none'].indexOf(current))
            : current;
    }
    if (!['anthropic', 'openai', 'none', 'local'].includes(choice))
        throw new UserError(`--ai must be anthropic, openai or none (got "${choice}")`);
    if (choice === 'none' || choice === 'local')
        return { enabled: false, provider: existing?.provider ?? 'anthropic' };
    const secrets = loadSecrets(root);
    const key = choice === 'anthropic' ? secrets.anthropicApiKey : secrets.openaiApiKey;
    if (!key && interactive() && !flags.yes) {
        const entered = await ask(`${KEY_ENV[choice]} (saved to .changelog/secrets.yml; leave empty to use the environment variable):`, { secret: true });
        if (entered)
            saveSecrets(root, choice === 'anthropic' ? { anthropicApiKey: entered } : { openaiApiKey: entered });
    }
    else if (!key) {
        console.log(warn(`${KEY_ENV[choice]} is not set - local analysis will be used until it is.`));
    }
    console.log(dim(`\nPrivacy: commit diffs (with secrets redacted) will be sent to ${choice === 'anthropic' ? 'Anthropic' : 'OpenAI'} for analysis.`));
    return { enabled: true, provider: choice, ...(str(flags.model) ?? existing?.model ? { model: str(flags.model) ?? existing?.model } : {}) };
}
async function configureDestination(root, type, flags, existing) {
    if (type === 'obsidian')
        return { type, obsidian: await configureObsidian(flags, existing?.destination.obsidian) };
    return { type, notion: await configureNotion(root, flags, existing?.destination.notion) };
}
async function verifyDestination(root, config) {
    try {
        await createDestination(config, loadSecrets(root)).initialize();
        console.log(ok(`Destination ready: ${describeDestination(config)}`));
    }
    catch (err) {
        console.log(warn(`Destination not reachable yet: ${err.message}. Entries will queue until it is (git-changelog sync).`));
    }
}
// ---------- commands ----------
async function cmdInit(args) {
    const { values } = parseArgs({
        args,
        options: { destination: { type: 'string' }, 'no-hook': { type: 'boolean' }, ...DEST_OPTIONS, ...AI_OPTIONS },
    });
    const root = requireRoot();
    console.log(`${bold('Git ChangeLog Setup')}\n`);
    console.log(ok(`Git repository detected (${repositoryName(root)})`));
    const existing = tryLoadConfig(root);
    if (existing)
        console.log(dim(`Updating existing ${CONFIG_FILE}`));
    let type = str(values.destination);
    if (!type) {
        type = interactive() && !values.yes
            ? await select('Where should changelogs be stored?', [
                { value: 'notion', label: 'Notion' },
                { value: 'obsidian', label: 'Obsidian' },
            ], existing?.destination.type === 'obsidian' ? 1 : 0)
            : existing?.destination.type;
    }
    if (type !== 'notion' && type !== 'obsidian')
        throw new UserError('Choose a destination: --destination notion|obsidian');
    const destination = await configureDestination(root, type, values, existing);
    const ai = await configureAi(root, values, existing?.ai);
    const hook = values['no-hook'] ? false : interactive() && !values.yes ? await confirm('Install post-commit hook?') : true;
    const config = { ...defaults(), ...(existing ?? {}), destination, ai };
    saveConfig(root, config);
    excludeStateDir(root);
    console.log(`\n${ok(`Saved ${CONFIG_FILE}`)}`);
    if (hook) {
        const result = installHook(root, CLI_PATH);
        console.log(ok(`post-commit hook installed (${path.relative(root, result.file) || result.file})`));
        for (const note of result.notes)
            console.log(dim(`  ${note}`));
    }
    await verifyDestination(root, config);
    console.log(`\n${bold('Done.')} Every commit is now logged to ${type === 'notion' ? 'Notion' : 'Obsidian'}.`);
    console.log(dim(`Try it on the last commit: git-changelog analyze --dry-run`));
}
function printResult(result, header = true) {
    if (header)
        console.log(`\n${bold('Git ChangeLog')}`);
    for (const w of result.warnings)
        console.log(warn(w));
    if (result.status === 'duplicate')
        return console.log(dim(`Commit already processed - nothing to do (use --force to re-check).`));
    if (result.status === 'empty')
        return console.log(dim('No changes to log in this commit.'));
    for (const e of result.published)
        console.log(ok(`${CATEGORY_NAMES[e.category]} → ${result.destination}: ${e.title}`));
    for (const e of result.duplicates)
        console.log(dim(`• ${CATEGORY_NAMES[e.category]} already exists in ${result.destination}, skipped`));
    if (result.queued.length) {
        console.log(warn(`Unable to publish changelog: ${result.error}`));
        console.log(dim(`  ${result.queued.length} entr${result.queued.length === 1 ? 'y' : 'ies'} saved to the retry queue. Run: git-changelog sync`));
    }
}
/** Called by the post-commit hook. Never throws and always exits 0: the commit already succeeded. */
async function cmdHook() {
    console.log(`\n${ok('Commit completed')}`);
    try {
        const root = requireRoot();
        if (!configExists(root)) {
            console.log(`\n${bold('Git ChangeLog')}\n${warn(`Not configured for this repository. Run: git-changelog init`)}`);
            return;
        }
        printResult(await processCommit(root, 'HEAD'));
    }
    catch (err) {
        console.log(`\n${bold('Git ChangeLog')}\n${warn(`Unable to publish changelog: ${err.message}`)}`);
    }
}
async function cmdAnalyze(args) {
    const { values } = parseArgs({
        args,
        options: { commit: { type: 'string', short: 'c' }, 'dry-run': { type: 'boolean' }, force: { type: 'boolean' }, json: { type: 'boolean' } },
    });
    const root = requireRoot();
    const result = await processCommit(root, str(values.commit) ?? 'HEAD', {}, { dryRun: values['dry-run'], force: values.force });
    if (values.json) {
        console.log(JSON.stringify({ status: result.status, analysis: result.analysis, entries: result.entries, warnings: result.warnings }, null, 2));
        return;
    }
    if (result.status === 'dry-run') {
        console.log(`${bold('Git ChangeLog')} ${dim('(dry run - nothing published)')}\n`);
        for (const w of result.warnings)
            console.log(warn(w));
        console.log(`Commit ${result.commit.shortHash}: ${result.commit.subject}`);
        console.log(`Analysis: ${result.analysis}${result.commit.truncated ? ' (diff truncated)' : ''}${result.commit.redactions ? `, ${result.commit.redactions} secret(s) redacted` : ''}\n`);
        for (const e of result.entries)
            printEntry(e);
        return;
    }
    printResult(result, true);
    if (result.queued.length)
        process.exitCode = 1;
}
function printEntry(e) {
    console.log(`${bold(CATEGORY_NAMES[e.category])}: ${e.title}`);
    console.log(`  ${e.summary}`);
    for (const c of e.changes.slice(0, 10))
        console.log(dim(`  - ${c}`));
    if (e.areas.length)
        console.log(dim(`  areas: ${e.areas.join(', ')}`));
    console.log();
}
async function cmdSync() {
    const root = requireRoot();
    loadConfig(root);
    const pending = listQueue(root).length;
    if (!pending)
        return console.log(ok('Retry queue is empty'));
    const result = await syncQueue(root);
    for (const e of result.published)
        console.log(ok(`${CATEGORY_NAMES[e.category]} ${e.commit.shortHash}: ${e.title}`));
    for (const e of result.duplicates)
        console.log(dim(`• ${CATEGORY_NAMES[e.category]} ${e.commit.shortHash} already existed, removed from queue`));
    for (const f of result.failed)
        console.log(warn(`${CATEGORY_NAMES[f.entry.category]} ${f.entry.commit.shortHash}: ${f.error}`));
    console.log(`\n${result.failed.length ? warn(`${result.failed.length} still queued`) : ok('Queue cleared')}`);
    if (result.failed.length)
        process.exitCode = 1;
}
async function cmdDestination(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: DEST_OPTIONS });
    const root = requireRoot();
    const config = loadConfig(root);
    const target = positionals[0];
    if (!target) {
        console.log(`Destination: ${bold(describeDestination(config))}`);
        console.log(dim('Switch with: git-changelog destination notion | git-changelog destination obsidian'));
        return;
    }
    if (target !== 'notion' && target !== 'obsidian')
        throw new UserError('Destination must be "notion" or "obsidian".');
    const previous = config.destination.type;
    if (previous === target)
        console.log(dim(`Already using ${target}; updating its settings.`));
    config.destination = await configureDestination(root, target, values, config);
    saveConfig(root, config);
    console.log(ok(`Destination: ${describeDestination(config)}`));
    if (previous !== target) {
        console.log(dim(`Existing ${previous} entries were not copied. New commits and queued entries will go to ${target}.`));
    }
    await verifyDestination(root, config);
}
async function cmdConfig(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { ...DEST_OPTIONS, ...AI_OPTIONS } });
    const root = requireRoot();
    const part = positionals[0];
    if (!part) {
        if (!configExists(root))
            throw new ConfigError('No configuration yet. Run: git-changelog init');
        console.log(dim(`# ${configPath(root)}`));
        console.log(fs.readFileSync(configPath(root), 'utf8').replace(/(token:\s*)\S+/g, '$1••••'));
        const s = loadSecrets(root);
        const state = (v, env) => (!v ? 'not set' : env && process.env[env] ? 'set (environment)' : 'set (.changelog/secrets.yml)');
        console.log(dim('# credentials'));
        console.log(`NOTION_TOKEN: ${state(s.notionToken, 'NOTION_TOKEN')}\nANTHROPIC_API_KEY: ${state(s.anthropicApiKey, 'ANTHROPIC_API_KEY')}\nOPENAI_API_KEY: ${state(s.openaiApiKey, 'OPENAI_API_KEY')}`);
        return;
    }
    const config = loadConfig(root);
    if (part === 'ai') {
        config.ai = await configureAi(root, values, config.ai);
    }
    else if (part === 'notion' || part === 'obsidian') {
        if (config.destination.type !== part) {
            throw new UserError(`The active destination is ${config.destination.type}. Switch with: git-changelog destination ${part}`);
        }
        config.destination = await configureDestination(root, part, values, config);
    }
    else {
        throw new UserError('Usage: git-changelog config [notion|obsidian|ai]');
    }
    saveConfig(root, config);
    console.log(ok(`Saved ${CONFIG_FILE}`));
    if (part !== 'ai')
        await verifyDestination(root, config);
}
function cmdStatus() {
    const root = requireRoot();
    console.log(`${bold('Git ChangeLog')}\n`);
    console.log(`Repository: ${repositoryName(root)}`);
    const hook = hookStatus(root);
    console.log(`Hook: ${hook.installed ? ok(`Installed${hook.method !== 'git' ? ` (${hook.method})` : ''}`) : fail('Not installed')}`);
    const config = tryLoadConfig(root);
    if (!config) {
        console.log(`\n${warn(configExists(root) ? `${CONFIG_FILE} is invalid - run git-changelog doctor` : 'Not configured - run git-changelog init')}`);
        return;
    }
    const state = readState(root);
    console.log(`\nDestination:\n  ${describeDestination(config)}`);
    const aiLabel = config.ai.enabled ? `${config.ai.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} (${config.ai.model || (config.ai.provider === 'anthropic' ? 'claude-opus-5' : 'gpt-5-mini')})` : 'Local (no AI)';
    console.log(`\nAI:\n  ${aiLabel}`);
    console.log(`\nLast processed commit:\n  ${state.lastCommit ? `${state.lastCommit.slice(0, 7)} ${dim(state.lastRunAt ?? '')}` : 'none yet'}`);
    console.log(`\nPending:\n  ${listQueue(root).length}`);
}
async function cmdDoctor() {
    let problems = 0;
    const check = (pass, label, fix) => {
        if (pass === true)
            console.log(ok(label));
        else if (pass === 'warn')
            console.log(warn(`${label}${fix ? dim(` - ${fix}`) : ''}`));
        else {
            problems++;
            console.log(fail(`${label}${fix ? dim(` - ${fix}`) : ''}`));
        }
    };
    console.log(`${bold('Git ChangeLog doctor')}\n`);
    const root = findRepoRoot(process.cwd());
    check(!!root, 'Git repository', 'run inside a Git repository');
    if (!root)
        return void (process.exitCode = 1);
    const hook = hookStatus(root);
    const hooks = detectHooks(root);
    check(hook.installed, hook.installed ? `Git hook (${hook.method}: ${path.relative(root, hook.file) || hook.file})` : 'Git hook', 'run: git-changelog init');
    if (hook.installed && hook.method === 'git' && process.platform !== 'win32') {
        check(!!(fs.statSync(hook.file).mode & 0o111), 'Hook is executable', `chmod +x ${hook.file}`);
    }
    if (hook.method === 'lefthook')
        check('warn', 'Lefthook manages hooks', 'make sure `lefthook install` has been run');
    if (hooks.husky && hook.method !== 'husky')
        check('warn', 'Husky detected but hook is not in .husky/', 'rerun: git-changelog init');
    let config;
    try {
        config = loadConfig(root);
        check(true, `Configuration (${CONFIG_FILE})`);
    }
    catch (err) {
        check(false, 'Configuration', err.message);
    }
    if (config) {
        const secrets = loadSecrets(root);
        check(true, `Destination: ${describeDestination(config)}`);
        const dest = createDestination(config, secrets);
        if (config.destination.type === 'notion') {
            const token = notionToken(config, secrets);
            check(!!token, 'Notion credentials', 'set NOTION_TOKEN or run: git-changelog config notion');
            if (config.destination.notion?.token)
                check('warn', 'Notion token is stored in .changelogrc.yml', 'move it to NOTION_TOKEN or `git-changelog config notion` so it is never committed');
            if (token) {
                const reachable = await dest.testConnection();
                check(reachable, 'Notion connection', 'check the token and your network');
                if (reachable) {
                    try {
                        await dest.initialize();
                        check(true, 'Notion databases accessible');
                    }
                    catch (err) {
                        check(false, 'Notion databases', `${err.message} - share each database with your integration`);
                    }
                }
            }
        }
        else {
            const vault = config.destination.obsidian.vaultPath;
            const exists = fs.existsSync(vault);
            check(exists, `Obsidian vault (${vault})`, 'the path does not exist - run: git-changelog config obsidian');
            if (exists) {
                if (!looksLikeVault(vault))
                    check('warn', 'Vault has no .obsidian folder', 'is this the right folder?');
                check(await dest.testConnection(), 'Changelog folder is writable', 'check permissions on the vault folder');
            }
        }
        if (config.ai.enabled) {
            const key = config.ai.provider === 'anthropic' ? secrets.anthropicApiKey : secrets.openaiApiKey;
            check(true, `AI provider: ${config.ai.provider}`);
            check(key ? true : 'warn', 'AI credentials', `set ${KEY_ENV[config.ai.provider]} - local analysis is used until then`);
        }
        else {
            check(true, 'AI provider: local analysis (nothing leaves your machine)');
        }
        const probe = redactSecrets('api_key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123"').text;
        check(config.privacy.redactSecrets ? !probe.includes('abcdefghij') : 'warn', 'Secret redaction', 'privacy.redactSecrets is off');
    }
    try {
        fs.mkdirSync(stateDir(root), { recursive: true });
        fs.accessSync(stateDir(root), fs.constants.W_OK);
        check(true, 'File permissions (.changelog/)');
    }
    catch {
        check(false, 'File permissions', `cannot write ${stateDir(root)}`);
    }
    check(isStateDirExcluded(root) ? true : 'warn', '.changelog/ is excluded from Git', 'run: git-changelog init');
    const pending = listQueue(root).length;
    check(pending ? 'warn' : true, `Retry queue: ${pending} pending`, 'run: git-changelog sync');
    console.log(problems ? `\n${fail(`${problems} problem(s) found`)}` : `\n${ok('All checks passed')}`);
    if (problems)
        process.exitCode = 1;
}
async function cmdUninstall(args) {
    const { values } = parseArgs({ args, options: { purge: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' } } });
    const root = requireRoot();
    const removed = uninstallHook(root);
    console.log(removed.length ? ok(`Removed Git ChangeLog from ${removed.map((f) => path.relative(root, f) || f).join(', ')}`) : dim('No Git ChangeLog hook found.'));
    const pending = listQueue(root).length;
    if (values.purge) {
        if (pending && interactive() && !values.yes && !(await confirm(`${pending} queued entr${pending === 1 ? 'y' : 'ies'} will be deleted. Continue?`, false)))
            return;
        fs.rmSync(configPath(root), { force: true });
        fs.rmSync(stateDir(root), { recursive: true, force: true });
        console.log(ok(`Removed ${CONFIG_FILE} and .changelog/`));
    }
    else {
        console.log(dim(`Kept ${CONFIG_FILE}${pending ? ` and ${pending} queued entries` : ''}. Use --purge to remove ${pending ? 'them' : 'it'}.`));
    }
}
export async function main(argv = process.argv.slice(2)) {
    const [command, ...args] = argv;
    if (command === 'hook')
        return cmdHook();
    try {
        switch (command) {
            case 'init': return await cmdInit(args);
            case 'status': return cmdStatus();
            case 'analyze': return await cmdAnalyze(args);
            case 'sync': return await cmdSync();
            case 'destination': return await cmdDestination(args);
            case 'config': return await cmdConfig(args);
            case 'doctor': return await cmdDoctor();
            case 'uninstall': return await cmdUninstall(args);
            case '-v':
            case '--version':
            case 'version': return console.log(VERSION);
            case undefined:
            case '-h':
            case '--help':
            case 'help': return console.log(HELP);
            default: throw new UserError(`Unknown command "${command}". Run: git-changelog --help`);
        }
    }
    catch (err) {
        const known = err instanceof UserError || err instanceof ConfigError || err.code?.startsWith('ERR_PARSE_ARGS');
        console.error(fail(known ? err.message : `Unexpected error: ${err.stack ?? err}`));
        process.exitCode = 1;
    }
}
// Allow `import { main }` in tests without running the CLI.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(CLI_PATH)) {
    void main();
}
