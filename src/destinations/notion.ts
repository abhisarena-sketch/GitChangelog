import { CATEGORY_LABELS, CATEGORY_NAMES as TYPE_NAME } from '../types.js';
import type { Category, ChangelogDestination, ChangelogEntry, FetchLike } from '../types.js';
import type { NotionConfig } from '../config.js';

const API = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';

const DB_KEY: Record<Category, keyof NotionConfig['databases']> = {
  'feature-update': 'featureUpdates',
  'bug-fix': 'bugFixes',
  'code-change': 'codeChanges',
};

/** Properties every changelog database needs (besides its title property). */
const PROPERTIES: Record<string, object> = {
  Type: { select: { options: Object.values(TYPE_NAME).map((name) => ({ name })) } },
  Date: { date: {} },
  Commit: { rich_text: {} },
  Author: { rich_text: {} },
  Repository: { select: {} },
  Branch: { rich_text: {} },
  Summary: { rich_text: {} },
  'Files Changed': { rich_text: {} },
  Areas: { multi_select: {} },
};

const rich = (content: string) => {
  const chunks = [];
  for (let i = 0; i < Math.min(content.length, 6000); i += 2000) chunks.push({ type: 'text', text: { content: content.slice(i, i + 2000) } });
  return chunks.length ? chunks : [{ type: 'text', text: { content: '' } }];
};
const block = (type: string, content: string, extra: object = {}) => ({ object: 'block', type, [type]: { rich_text: rich(content), ...extra } });
const selectName = (s: string) => s.replace(/,/g, ' ').slice(0, 100) || 'unknown';

export const parseNotionId = (value: string) => {
  const hex = value.replace(/-/g, '').match(/[0-9a-f]{32}(?=[^0-9a-f]*$)/i)?.[0];
  return hex ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : value.trim();
};

export class NotionApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class NotionDestination implements ChangelogDestination {
  readonly name = 'Notion';
  private titleProperty = new Map<string, string>();

  constructor(
    private config: NotionConfig,
    private token: string | undefined,
    private fetchImpl: FetchLike = fetch,
    private timeoutMs = 30000,
  ) {}

  private async request(method: string, path: string, body?: object): Promise<any> {
    if (!this.token) throw new Error('Notion token missing. Set NOTION_TOKEN or run: git-changelog config notion');
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { authorization: `Bearer ${this.token}`, 'notion-version': VERSION, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new NotionApiError(res.status, `Notion API ${res.status}: ${data.message ?? res.statusText}`);
    return data;
  }

  private db(category: Category): string {
    const id = this.config.databases[DB_KEY[category]];
    if (!id) throw new Error(`No Notion database configured for ${CATEGORY_LABELS[category]}`);
    return parseNotionId(id);
  }

  /** Makes sure each database has the changelog properties, adding any that are missing. */
  async initialize(): Promise<void> {
    for (const category of Object.keys(DB_KEY) as Category[]) {
      const id = this.db(category);
      const db = await this.request('GET', `/databases/${id}`);
      const props: Record<string, any> = db.properties ?? {};
      const title = Object.entries(props).find(([, p]) => p.type === 'title')?.[0] ?? 'Title';
      this.titleProperty.set(id, title);
      const missing = Object.fromEntries(Object.entries(PROPERTIES).filter(([name]) => !props[name]));
      if (Object.keys(missing).length) await this.request('PATCH', `/databases/${id}`, { properties: missing });
    }
  }

  async exists(commitHash: string, category: Category): Promise<boolean> {
    const data = await this.request('POST', `/databases/${this.db(category)}/query`, {
      filter: { property: 'Commit', rich_text: { equals: commitHash } },
      page_size: 1,
    });
    return (data.results ?? []).length > 0;
  }

  private properties(entry: ChangelogEntry, titleProperty: string) {
    return {
      [titleProperty]: { title: rich(entry.title) },
      Type: { select: { name: TYPE_NAME[entry.category] } },
      Date: { date: { start: entry.commit.date } },
      Commit: { rich_text: rich(entry.commit.hash) },
      Author: { rich_text: rich(entry.commit.author) },
      Repository: { select: { name: selectName(entry.commit.repository) } },
      Branch: { rich_text: rich(entry.commit.branch) },
      Summary: { rich_text: rich(entry.summary) },
      'Files Changed': { rich_text: rich(entry.files.join('\n')) },
      Areas: { multi_select: entry.areas.map((a) => ({ name: selectName(a) })) },
    };
  }

  private children(entry: ChangelogEntry) {
    const c = entry.commit;
    const blocks = [
      block('heading_2', 'Summary'),
      block('paragraph', entry.summary),
      block('heading_2', 'Changes'),
      ...(entry.changes.length ? entry.changes : ['—']).map((s) => block('bulleted_list_item', s)),
    ];
    if (entry.technicalDetails.length) {
      blocks.push(block('heading_2', 'Technical Details'), ...entry.technicalDetails.map((s) => block('bulleted_list_item', s)));
    }
    const files = entry.files.slice(0, 40).map((f) => block('bulleted_list_item', f));
    if (entry.files.length > 40) files.push(block('bulleted_list_item', `…and ${entry.files.length - 40} more`));
    blocks.push(block('heading_2', 'Files Changed'), ...files);
    blocks.push(
      block('heading_2', 'Commit Information'),
      block('bulleted_list_item', `Commit: ${c.hash}`),
      block('bulleted_list_item', `Author: ${c.author}`),
      block('bulleted_list_item', `Date: ${c.date}`),
      block('bulleted_list_item', `Repository: ${c.repository} (${c.branch})`),
      block('bulleted_list_item', `Stats: ${c.stats.files} file(s), +${c.stats.insertions}/-${c.stats.deletions}`),
      block('bulleted_list_item', `Analysis: ${entry.analysis}${entry.truncated ? ' (diff truncated)' : ''}`),
      block('code', c.message, { language: 'plain text' }),
    );
    return blocks.slice(0, 100); // Notion accepts at most 100 children per request
  }

  async createEntry(entry: ChangelogEntry): Promise<void> {
    const id = this.db(entry.category);
    if (!this.titleProperty.has(id)) await this.initialize();
    await this.request('POST', '/pages', {
      parent: { database_id: id },
      properties: this.properties(entry, this.titleProperty.get(id) ?? 'Title'),
      children: this.children(entry),
    });
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.request('GET', '/users/me');
      return true;
    } catch {
      return false;
    }
  }

  /** Creates the three changelog databases under a Notion page the integration can access. */
  static async createDatabases(parentPageId: string, token: string, fetchImpl: FetchLike = fetch): Promise<NotionConfig['databases']> {
    const dest = new NotionDestination({ databases: { codeChanges: '', bugFixes: '', featureUpdates: '' } }, token, fetchImpl);
    const ids = {} as NotionConfig['databases'];
    for (const category of Object.keys(DB_KEY) as Category[]) {
      const db = await dest.request('POST', '/databases', {
        parent: { type: 'page_id', page_id: parseNotionId(parentPageId) },
        title: [{ type: 'text', text: { content: CATEGORY_LABELS[category] } }],
        properties: { Title: { title: {} }, ...PROPERTIES },
      });
      ids[DB_KEY[category]] = db.id;
    }
    return ids;
  }
}
