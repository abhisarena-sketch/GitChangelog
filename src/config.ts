import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const CONFIG_FILE = '.changelogrc.yml';
export const STATE_DIR = '.changelog';

export type DestinationType = 'notion' | 'obsidian';
export type AiProvider = 'anthropic' | 'openai';

export interface ObsidianConfig {
  vaultPath: string;
  changelogFolder: string;
}

export interface NotionConfig {
  /** Prefer NOTION_TOKEN or `git-changelog config notion` (stored outside the repo's tracked files). */
  token?: string;
  pages: { codeChanges: string; bugFixes: string; featureUpdates: string };
}

export interface Config {
  version: 1;
  destination: { type: DestinationType; obsidian?: ObsidianConfig; notion?: NotionConfig };
  ai: { enabled: boolean; provider: AiProvider; model?: string };
  git: { maxDiffSize: number };
  ignore: { paths: string[] };
  privacy: { redactSecrets: boolean };
}

export interface Secrets {
  notionToken?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
}

export const DEFAULT_IGNORE = [
  'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', 'target', 'vendor', '.git',
  '.gradle', '.venv', 'venv', '__pycache__', 'Pods', 'DerivedData', 'bin/Debug', 'bin/Release', 'obj',
];

export const DEFAULT_FOLDER = 'Development/Changelog';

export const defaults = (): Omit<Config, 'destination'> => ({
  version: 1,
  ai: { enabled: false, provider: 'anthropic' },
  git: { maxDiffSize: 50000 },
  ignore: { paths: DEFAULT_IGNORE },
  privacy: { redactSecrets: true },
});

export const configPath = (root: string) => path.join(root, CONFIG_FILE);
export const stateDir = (root: string) => path.join(root, STATE_DIR);
const secretsPath = (root: string) => path.join(stateDir(root), 'secrets.yml');

export class ConfigError extends Error {}

export function configExists(root: string): boolean {
  return fs.existsSync(configPath(root));
}

/** Loads .changelogrc.yml, fills defaults and validates. Throws ConfigError with an actionable message. */
export function loadConfig(root: string, env: NodeJS.ProcessEnv = process.env): Config {
  if (!configExists(root)) throw new ConfigError(`No ${CONFIG_FILE} found. Run: git-changelog init`);
  let raw: any;
  try {
    raw = YAML.parse(fs.readFileSync(configPath(root), 'utf8')) ?? {};
  } catch (err) {
    throw new ConfigError(`${CONFIG_FILE} is not valid YAML: ${(err as Error).message}`);
  }
  const base = defaults();
  const config: Config = {
    version: 1,
    destination: raw.destination ?? {},
    ai: { ...base.ai, ...(raw.ai ?? {}) },
    git: { ...base.git, ...(raw.git ?? {}) },
    ignore: { paths: Array.isArray(raw.ignore?.paths) ? raw.ignore.paths.map(String) : base.ignore.paths },
    privacy: { ...base.privacy, ...(raw.privacy ?? {}) },
  };

  const provider = env.CHANGELOG_AI_PROVIDER?.trim().toLowerCase();
  if (provider === 'none' || provider === 'local') config.ai.enabled = false;
  else if (provider === 'anthropic' || provider === 'openai') config.ai = { ...config.ai, enabled: true, provider };

  validateConfig(config);
  return config;
}

export function validateConfig(config: Config): void {
  const { destination } = config;
  if (destination.type !== 'notion' && destination.type !== 'obsidian') {
    throw new ConfigError(`destination.type must be "notion" or "obsidian" (got ${JSON.stringify(destination.type)})`);
  }
  if (destination.type === 'obsidian' && !destination.obsidian?.vaultPath) {
    throw new ConfigError('destination.obsidian.vaultPath is missing. Run: git-changelog config obsidian');
  }
  if (destination.type === 'notion') {
    const db = destination.notion?.pages;
    if (!db?.codeChanges || !db.bugFixes || !db.featureUpdates) {
      throw new ConfigError('Notion page IDs are missing. Run: git-changelog config notion');
    }
  }
  if (!['anthropic', 'openai'].includes(config.ai.provider)) {
    throw new ConfigError(`ai.provider must be "anthropic" or "openai" (got ${JSON.stringify(config.ai.provider)})`);
  }
  if (!(Number(config.git.maxDiffSize) > 0)) config.git.maxDiffSize = 50000;
}

/** Writes a minimal config: only destination, ai and non-default settings. */
export function saveConfig(root: string, config: Config): void {
  const base = defaults();
  const out: Record<string, unknown> = { version: 1, destination: pruneDestination(config.destination) };
  out.ai = { enabled: config.ai.enabled, provider: config.ai.provider, ...(config.ai.model ? { model: config.ai.model } : {}) };
  if (config.git.maxDiffSize !== base.git.maxDiffSize) out.git = config.git;
  if (JSON.stringify(config.ignore.paths) !== JSON.stringify(base.ignore.paths)) out.ignore = config.ignore;
  if (config.privacy.redactSecrets !== base.privacy.redactSecrets) out.privacy = config.privacy;
  fs.writeFileSync(configPath(root), YAML.stringify(out));
}

// Exactly one destination: drop the block of whichever destination is not active.
function pruneDestination(d: Config['destination']): Config['destination'] {
  if (d.type === 'obsidian') return { type: 'obsidian', obsidian: d.obsidian };
  const notion = d.notion ? { ...d.notion } : undefined;
  if (notion && !notion.token) delete notion.token;
  return { type: 'notion', notion };
}

export function loadSecrets(root: string, env: NodeJS.ProcessEnv = process.env): Secrets {
  let stored: Secrets = {};
  try {
    stored = YAML.parse(fs.readFileSync(secretsPath(root), 'utf8')) ?? {};
  } catch {
    // no secrets file is fine
  }
  return {
    notionToken: env.NOTION_TOKEN || stored.notionToken,
    anthropicApiKey: env.ANTHROPIC_API_KEY || stored.anthropicApiKey,
    openaiApiKey: env.OPENAI_API_KEY || stored.openaiApiKey,
  };
}

/** Secrets live in .changelog/secrets.yml, which is git-excluded and never committed. */
export function saveSecrets(root: string, update: Secrets): void {
  const file = secretsPath(root);
  let current: Secrets = {};
  try {
    current = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
  } catch {
    // start fresh
  }
  const merged = Object.fromEntries(Object.entries({ ...current, ...update }).filter(([, v]) => v));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify(merged), { mode: 0o600 });
}

export function notionToken(config: Config, secrets: Secrets): string | undefined {
  return secrets.notionToken || config.destination.notion?.token || undefined;
}

export function aiKey(config: Config, secrets: Secrets): string | undefined {
  return config.ai.provider === 'anthropic' ? secrets.anthropicApiKey : secrets.openaiApiKey;
}
