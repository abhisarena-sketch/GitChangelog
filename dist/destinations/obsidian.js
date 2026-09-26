import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { CATEGORY_LABELS } from '../types.js';
import { DEFAULT_FOLDER } from '../config.js';
const TAG = { 'feature-update': 'feature', 'bug-fix': 'bug-fix', 'code-change': 'code-change' };
const slugify = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'change';
// Text from commits/AI must not be able to create headings, frontmatter fences or HTML in the note.
const safeText = (s) => s.replace(/^(\s*)(#|---|<|>|\|)/gm, '$1\\$2');
export function renderNote(entry) {
    const frontmatter = {
        type: entry.category,
        date: entry.commit.date.slice(0, 10),
        commit: entry.commit.shortHash,
        commitHash: entry.commit.hash,
        author: entry.commit.author,
        repository: entry.commit.repository,
        branch: entry.commit.branch,
        ...(entry.areas.length ? { areas: entry.areas } : {}),
        analysis: entry.analysis,
        tags: ['changelog', TAG[entry.category]],
    };
    const list = (items) => items.map((s) => `- ${s}`).join('\n');
    const files = entry.files.slice(0, 200).map((f) => `- \`${f.replace(/`/g, "'")}\``);
    if (entry.files.length > 200)
        files.push(`- …and ${entry.files.length - 200} more`);
    const s = entry.commit.stats;
    const sections = [
        `# ${entry.title.replace(/[\r\n]+/g, ' ')}`,
        `## Summary\n\n${safeText(entry.summary)}`,
        entry.changes.length ? `## Changes\n\n${list(entry.changes)}` : '',
        entry.technicalDetails.length ? `## Technical Details\n\n${list(entry.technicalDetails)}` : '',
        `## Files Changed\n\n${files.join('\n')}`,
        `## Commit\n\n\`${entry.commit.shortHash}\` · ${entry.commit.author} · ${entry.commit.date} · \`${entry.commit.branch}\` · ${s.files} file(s), +${s.insertions}/-${s.deletions}${entry.truncated ? ' · diff truncated for analysis' : ''}\n\n\`\`\`text\n${entry.commit.message.replace(/```/g, "'''")}\n\`\`\``,
    ].filter(Boolean);
    return `---\n${YAML.stringify(frontmatter)}---\n\n${sections.join('\n\n')}\n`;
}
function readFrontmatter(file) {
    try {
        const text = fs.readFileSync(file, 'utf8');
        const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        return m ? YAML.parse(m[1]) : null;
    }
    catch {
        return null;
    }
}
export class ObsidianDestination {
    config;
    name = 'Obsidian';
    constructor(config) {
        this.config = config;
    }
    get vault() {
        return path.resolve(this.config.vaultPath);
    }
    folder(category) {
        return path.join(this.vault, this.config.changelogFolder || DEFAULT_FOLDER, CATEGORY_LABELS[category]);
    }
    async initialize() {
        if (!fs.existsSync(this.vault) || !fs.statSync(this.vault).isDirectory()) {
            throw new Error(`Obsidian vault not found at ${this.vault}`);
        }
        for (const category of Object.keys(CATEGORY_LABELS)) {
            fs.mkdirSync(this.folder(category), { recursive: true });
        }
    }
    find(commitHash, category) {
        const dir = this.folder(category);
        if (!fs.existsSync(dir))
            return null;
        const names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
        // Fast path: our filenames end with the short hash. Fall back to scanning all notes (renamed files).
        const short = commitHash.slice(0, 7);
        const ordered = [...names.filter((n) => n.endsWith(`-${short}.md`)), ...names.filter((n) => !n.endsWith(`-${short}.md`))];
        for (const name of ordered) {
            const file = path.join(dir, name);
            const fm = readFrontmatter(file);
            if (fm && fm.commitHash === commitHash && fm.type === category)
                return file;
        }
        return null;
    }
    async exists(commitHash, category) {
        return this.find(commitHash, category) !== null;
    }
    async createEntry(entry) {
        const dir = this.folder(entry.category);
        fs.mkdirSync(dir, { recursive: true });
        const base = `${entry.commit.date.slice(0, 10)}-${slugify(entry.title)}-${entry.commit.hash.slice(0, 7)}`;
        const file = path.join(dir, `${base}.md`);
        // 'wx' never overwrites a note that is already there.
        fs.writeFileSync(file, renderNote(entry), { flag: 'wx' });
    }
    async updateEntry(entry) {
        const file = this.find(entry.commit.hash, entry.category);
        if (!file)
            return this.createEntry(entry);
        fs.writeFileSync(file, renderNote(entry));
    }
    async testConnection() {
        try {
            await this.initialize();
            fs.accessSync(this.folder('code-change'), fs.constants.W_OK);
            return true;
        }
        catch {
            return false;
        }
    }
}
/** Vaults registered with the Obsidian desktop app on this machine. */
export function detectVaults(env = process.env) {
    const home = os.homedir();
    const candidates = [
        env.APPDATA && path.join(env.APPDATA, 'obsidian', 'obsidian.json'),
        path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json'),
        path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'obsidian', 'obsidian.json'),
        path.join(home, '.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian', 'obsidian.json'),
        path.join(home, 'snap', 'obsidian', 'current', '.config', 'obsidian', 'obsidian.json'),
    ].filter((p) => !!p);
    const vaults = new Map();
    for (const file of candidates) {
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            for (const v of Object.values(data.vaults ?? {})) {
                if (typeof v?.path === 'string' && fs.existsSync(v.path))
                    vaults.set(v.path, { name: path.basename(v.path), path: v.path });
            }
        }
        catch {
            // not installed here
        }
    }
    return [...vaults.values()];
}
export function looksLikeVault(dir) {
    return fs.existsSync(path.join(dir, '.obsidian'));
}
