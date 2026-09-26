import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
export const CONFIG_FILE = '.changelogrc.yml';
export const STATE_DIR = '.changelog';
export const DEFAULT_IGNORE = [
    'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', 'target', 'vendor', '.git',
    '.gradle', '.venv', 'venv', '__pycache__', 'Pods', 'DerivedData', 'bin/Debug', 'bin/Release', 'obj',
];
export const DEFAULT_FOLDER = 'Development/Changelog';
export const defaults = () => ({
    version: 1,
    ai: { enabled: false, provider: 'anthropic' },
    git: { maxDiffSize: 50000 },
    ignore: { paths: DEFAULT_IGNORE },
    privacy: { redactSecrets: true },
});
export const configPath = (root) => path.join(root, CONFIG_FILE);
export const stateDir = (root) => path.join(root, STATE_DIR);
const secretsPath = (root) => path.join(stateDir(root), 'secrets.yml');
export class ConfigError extends Error {
}
export function configExists(root) {
    return fs.existsSync(configPath(root));
}
/** Loads .changelogrc.yml, fills defaults and validates. Throws ConfigError with an actionable message. */
export function loadConfig(root, env = process.env) {
    if (!configExists(root))
        throw new ConfigError(`No ${CONFIG_FILE} found. Run: git-changelog init`);
    let raw;
    try {
        raw = YAML.parse(fs.readFileSync(configPath(root), 'utf8')) ?? {};
    }
    catch (err) {
        throw new ConfigError(`${CONFIG_FILE} is not valid YAML: ${err.message}`);
    }
    const base = defaults();
    const config = {
        version: 1,
        destination: raw.destination ?? {},
        ai: { ...base.ai, ...(raw.ai ?? {}) },
        git: { ...base.git, ...(raw.git ?? {}) },
        ignore: { paths: Array.isArray(raw.ignore?.paths) ? raw.ignore.paths.map(String) : base.ignore.paths },
        privacy: { ...base.privacy, ...(raw.privacy ?? {}) },
    };
    const provider = env.CHANGELOG_AI_PROVIDER?.trim().toLowerCase();
    if (provider === 'none' || provider === 'local')
        config.ai.enabled = false;
    else if (provider === 'anthropic' || provider === 'openai')
        config.ai = { ...config.ai, enabled: true, provider };
    validateConfig(config);
    return config;
}
export function validateConfig(config) {
    const { destination } = config;
    if (destination.type !== 'notion' && destination.type !== 'obsidian') {
        throw new ConfigError(`destination.type must be "notion" or "obsidian" (got ${JSON.stringify(destination.type)})`);
    }
    if (destination.type === 'obsidian' && !destination.obsidian?.vaultPath) {
        throw new ConfigError('destination.obsidian.vaultPath is missing. Run: git-changelog config obsidian');
    }
    if (destination.type === 'notion') {
        const db = destination.notion?.databases;
        if (!db?.codeChanges || !db.bugFixes || !db.featureUpdates) {
            throw new ConfigError('Notion database IDs are missing. Run: git-changelog config notion');
        }
    }
    if (!['anthropic', 'openai'].includes(config.ai.provider)) {
        throw new ConfigError(`ai.provider must be "anthropic" or "openai" (got ${JSON.stringify(config.ai.provider)})`);
    }
    if (!(Number(config.git.maxDiffSize) > 0))
        config.git.maxDiffSize = 50000;
}
/** Writes a minimal config: only destination, ai and non-default settings. */
export function saveConfig(root, config) {
    const base = defaults();
    const out = { version: 1, destination: pruneDestination(config.destination) };
    out.ai = { enabled: config.ai.enabled, provider: config.ai.provider, ...(config.ai.model ? { model: config.ai.model } : {}) };
    if (config.git.maxDiffSize !== base.git.maxDiffSize)
        out.git = config.git;
    if (JSON.stringify(config.ignore.paths) !== JSON.stringify(base.ignore.paths))
        out.ignore = config.ignore;
    if (config.privacy.redactSecrets !== base.privacy.redactSecrets)
        out.privacy = config.privacy;
    fs.writeFileSync(configPath(root), YAML.stringify(out));
}
// Exactly one destination: drop the block of whichever destination is not active.
function pruneDestination(d) {
    if (d.type === 'obsidian')
        return { type: 'obsidian', obsidian: d.obsidian };
    const notion = d.notion ? { ...d.notion } : undefined;
    if (notion && !notion.token)
        delete notion.token;
    return { type: 'notion', notion };
}
export function loadSecrets(root, env = process.env) {
    let stored = {};
    try {
        stored = YAML.parse(fs.readFileSync(secretsPath(root), 'utf8')) ?? {};
    }
    catch {
        // no secrets file is fine
    }
    return {
        notionToken: env.NOTION_TOKEN || stored.notionToken,
        anthropicApiKey: env.ANTHROPIC_API_KEY || stored.anthropicApiKey,
        openaiApiKey: env.OPENAI_API_KEY || stored.openaiApiKey,
    };
}
/** Secrets live in .changelog/secrets.yml, which is git-excluded and never committed. */
export function saveSecrets(root, update) {
    const file = secretsPath(root);
    let current = {};
    try {
        current = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
    }
    catch {
        // start fresh
    }
    const merged = Object.fromEntries(Object.entries({ ...current, ...update }).filter(([, v]) => v));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, YAML.stringify(merged), { mode: 0o600 });
}
export function notionToken(config, secrets) {
    return secrets.notionToken || config.destination.notion?.token || undefined;
}
export function aiKey(config, secrets) {
    return config.ai.provider === 'anthropic' ? secrets.anthropicApiKey : secrets.openaiApiKey;
}
