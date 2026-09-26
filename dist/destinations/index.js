import { notionToken } from '../config.js';
import { NotionDestination } from './notion.js';
import { ObsidianDestination } from './obsidian.js';
export function createDestination(config, secrets, fetchImpl = fetch) {
    const d = config.destination;
    switch (d.type) {
        case 'obsidian':
            return new ObsidianDestination(d.obsidian);
        case 'notion':
            return new NotionDestination(d.notion, notionToken(config, secrets), fetchImpl);
        default:
            throw new Error(`Unsupported destination "${d.type}"`);
    }
}
export function describeDestination(config) {
    const d = config.destination;
    if (d.type === 'obsidian')
        return `Obsidian (${d.obsidian?.vaultPath} → ${d.obsidian?.changelogFolder})`;
    return 'Notion';
}
