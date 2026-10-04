import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { CATEGORY_LABELS } from '../types.js';
import { DEFAULT_FOLDER } from '../config.js';
const TAG = { 'feature-update': 'feature', 'bug-fix': 'bug-fix', 'code-change': 'code-change' };
const BADGE = { 'feature-update': '✨ Feature', 'bug-fix': '🐛 Fix', 'code-change': '🔧 Change' };
// Text from commits/AI must not be able to create headings, frontmatter fences, HTML or entry markers in the note.
const safeText = (s) => s.replace(/^(\s*)(#|---|<|>|\|)/gm, '$1\\$2');
const oneLine = (s) => s.replace(/\s*[\r\n]+\s*/g, ' ');
const MARKER = /^<!-- changelog:([0-9a-f]{7,64}) (\S+) -->$/;
/** One changelog entry, rendered as a section of its category's single note. */
export function renderEntry(entry) {
    const c = entry.commit;
    const scope = c.message.match(/^\w+\(([^)]+)\)!?:/)?.[1] ?? entry.areas[0];
    const list = (items) => items.map((s) => `- ${oneLine(s)}`).join('\n');
    const files = entry.files.slice(0, 200).map((f) => `- \`${f.replace(/`/g, "'")}\``);
    if (entry.files.length > 200)
        files.push(`- …and ${entry.files.length - 200} more`);
    const s = c.stats;
    const message = c.message.replace(/```/g, "'''").replace(/<!--/g, '&lt;!--');
    return [
        `<!-- changelog:${c.hash} ${c.date} -->`,
        `### ${[c.date.slice(0, 10), BADGE[entry.category], scope && oneLine(scope)].filter(Boolean).join(' · ')}`,
        `**${oneLine(entry.title)}**`,
        [
            `- **Author:** ${oneLine(c.author)}`,
            `- **Commit:** \`${c.shortHash}\` on \`${oneLine(c.branch)}\``,
            `- **Impact:** ${s.files} file(s), +${s.insertions}/-${s.deletions}${entry.truncated ? ' (diff truncated for analysis)' : ''}`,
            `- **Analysis:** ${entry.analysis}`,
        ].join('\n'),
        safeText(entry.summary),
        entry.changes.length ? `**Changes**\n\n${list(entry.changes)}` : '',
        entry.technicalDetails.length ? `**Technical details**\n\n${list(entry.technicalDetails)}` : '',
        `<details>\n<summary>Files changed (${entry.files.length})</summary>\n\n${files.join('\n')}\n\n</details>`,
        `<details>\n<summary>Commit message</summary>\n\n\`\`\`text\n${message}\n\`\`\`\n\n</details>`,
    ].filter(Boolean).join('\n\n');
}
/** Reads a category note back into repository sections of entry blocks. */
function parse(text) {
    const sections = [];
    let section;
    let block;
    let fence = false;
    for (const line of text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').split(/\r?\n/)) {
        if (!fence) {
            const h = line.match(/^## (.+)/);
            if (h) {
                section = { heading: h[1].trim(), blocks: [] };
                sections.push(section);
                block = undefined;
                continue;
            }
            const m = line.match(MARKER);
            if (m && section) {
                block = { hash: m[1], time: Date.parse(m[2]), text: '' };
                section.blocks.push(block);
            }
        }
        if (/^\s*```/.test(line))
            fence = !fence;
        if (block)
            block.text += `${line}\n`;
    }
    return sections;
}
function renderFile(category, sections) {
    const frontmatter = { type: category, tags: ['changelog', TAG[category]] };
    // Newest first within each repository.
    const body = sections.map((s) => `## ${s.heading}\n\n${[...s.blocks].sort((a, b) => (b.time || 0) - (a.time || 0)).map((b) => b.text.trim()).join('\n\n')}`);
    return `---\n${YAML.stringify(frontmatter)}---\n\n# ${CATEGORY_LABELS[category]}\n\n${body.join('\n\n')}\n`;
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
    get folder() {
        return path.join(this.vault, this.config.changelogFolder || DEFAULT_FOLDER);
    }
    /** One note per category, e.g. `<changelogFolder>/Bug Fixes.md`. */
    file(category) {
        return path.join(this.folder, `${CATEGORY_LABELS[category]}.md`);
    }
    read(category) {
        try {
            return parse(fs.readFileSync(this.file(category), 'utf8'));
        }
        catch {
            return [];
        }
    }
    async initialize() {
        if (!fs.existsSync(this.vault) || !fs.statSync(this.vault).isDirectory()) {
            throw new Error(`Obsidian vault not found at ${this.vault}`);
        }
        fs.mkdirSync(this.folder, { recursive: true });
    }
    async exists(commitHash, category) {
        return this.read(category).some((s) => s.blocks.some((b) => b.hash === commitHash));
    }
    upsert(entry, overwrite) {
        const sections = this.read(entry.category);
        const heading = `${oneLine(entry.commit.repository)} ${CATEGORY_LABELS[entry.category].toLowerCase()}`;
        const block = { hash: entry.commit.hash, time: Date.parse(entry.commit.date), text: renderEntry(entry) };
        const existing = sections.flatMap((s) => s.blocks).find((b) => b.hash === block.hash);
        if (existing) {
            if (overwrite)
                Object.assign(existing, block);
        }
        else {
            let section = sections.find((s) => s.heading === heading);
            if (!section)
                sections.push((section = { heading, blocks: [] }));
            section.blocks.push(block);
        }
        fs.mkdirSync(this.folder, { recursive: true });
        fs.writeFileSync(this.file(entry.category), renderFile(entry.category, sections));
    }
    async createEntry(entry) {
        this.upsert(entry, false);
    }
    async updateEntry(entry) {
        this.upsert(entry, true);
    }
    async testConnection() {
        try {
            await this.initialize();
            fs.accessSync(this.folder, fs.constants.W_OK);
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
