// The only place that maps a destination type to an adapter. Add new destinations here.
import type { ChangelogDestination, FetchLike } from '../types.js';
import type { Config, Secrets } from '../config.js';
import { notionToken } from '../config.js';
import { NotionDestination } from './notion.js';
import { ObsidianDestination } from './obsidian.js';

export function createDestination(config: Config, secrets: Secrets, fetchImpl: FetchLike = fetch): ChangelogDestination {
  const d = config.destination;
  switch (d.type) {
    case 'obsidian':
      return new ObsidianDestination(d.obsidian!);
    case 'notion':
      return new NotionDestination(d.notion!, notionToken(config, secrets), fetchImpl);
    default:
      throw new Error(`Unsupported destination "${(d as { type: string }).type}"`);
  }
}

export function describeDestination(config: Config): string {
  const d = config.destination;
  if (d.type === 'obsidian') return `Obsidian (${d.obsidian?.vaultPath} → ${d.obsidian?.changelogFolder})`;
  return 'Notion';
}
