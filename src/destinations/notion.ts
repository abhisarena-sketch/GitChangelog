import { CATEGORY_LABELS } from '../types.js';
import type { Category, ChangelogDestination, ChangelogEntry, FetchLike } from '../types.js';
import type { NotionConfig } from '../config.js';

const API = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';

const PAGE_KEY: Record<Category, keyof NotionConfig['pages']> = {
  'feature-update': 'featureUpdates',
  'bug-fix': 'bugFixes',
  'code-change': 'codeChanges',
};
const BADGE: Record<Category, string> = { 'feature-update': '✨ Feature', 'bug-fix': '🐛 Fix', 'code-change': '🔧 Change' };

const rich = (content: string, bold = false) => {
  const chunks = [];
  for (let i = 0; i < Math.min(content.length, 6000); i += 2000) {
    chunks.push({ type: 'text', text: { content: content.slice(i, i + 2000) }, ...(bold ? { annotations: { bold: true } } : {}) });
  }
  return chunks.length ? chunks : [{ type: 'text', text: { content: '' } }];
};
const block = (type: string, content: string, extra: object = {}, bold = false) => ({ object: 'block', type, [type]: { rich_text: rich(content, bold), ...extra } });
const plain = (b: any): string => (b?.[b?.type]?.rich_text ?? []).map((t: any) => t.plain_text ?? t.text?.content ?? '').join('');
const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ');
const intro = () => block('paragraph', 'Newest changes first. Every entry lists its author and commit.');

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

  /** One page per category; every commit is appended to it as a group of blocks. */
  private page(category: Category): string {
    const id = this.config.pages[PAGE_KEY[category]];
    if (!id) throw new Error(`No Notion page configured for ${CATEGORY_LABELS[category]}`);
    return parseNotionId(id);
  }

  /** Checks that each changelog page is shared with the integration. */
  async initialize(): Promise<void> {
    for (const category of Object.keys(PAGE_KEY) as Category[]) await this.request('GET', `/pages/${this.page(category)}`);
  }

  async exists(commitHash: string, category: Category): Promise<boolean> {
    const page = this.page(category);
    let cursor: string | undefined;
    do {
      const data = await this.request('GET', `/blocks/${page}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
      if ((data.results ?? []).some((b: any) => plain(b) === `Commit: ${commitHash}`)) return true;
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);
    return false;
  }

  private children(entry: ChangelogEntry) {
    const c = entry.commit;
    const scope = c.message.match(/^\w+\(([^)]+)\)!?:/)?.[1] ?? entry.areas[0];
    const bullets = (items: string[], max: number) => {
      const out = items.slice(0, max).map((s) => block('bulleted_list_item', oneLine(s)));
      if (items.length > max) out.push(block('bulleted_list_item', `…and ${items.length - max} more`));
      return out;
    };
    const blocks: object[] = [
      block('heading_3', [c.date.slice(0, 10), BADGE[entry.category], scope && oneLine(scope)].filter(Boolean).join(' · ')),
      block('paragraph', entry.title, {}, true),
      block('bulleted_list_item', `Author: ${oneLine(c.author)}`),
      block('bulleted_list_item', `Commit: ${c.hash}`),
      block('bulleted_list_item', `Repository: ${oneLine(c.repository)} (${oneLine(c.branch)})`),
      block('bulleted_list_item', `Impact: ${c.stats.files} file(s), +${c.stats.insertions}/-${c.stats.deletions}`),
      block('bulleted_list_item', `Analysis: ${entry.analysis}${entry.truncated ? ' (diff truncated)' : ''}`),
      block('paragraph', entry.summary),
    ];
    if (entry.changes.length) blocks.push(block('paragraph', 'Changes', {}, true), ...bullets(entry.changes, 25));
    if (entry.technicalDetails.length) blocks.push(block('paragraph', 'Technical details', {}, true), ...bullets(entry.technicalDetails, 15));
    blocks.push(
      block('toggle', `Files changed (${entry.files.length})`, { children: bullets(entry.files, 90) }),
      block('toggle', 'Commit message', { children: [block('code', c.message, { language: 'plain text' })] }),
      { object: 'block', type: 'divider', divider: {} },
    );
    return blocks;
  }

  async createEntry(entry: ChangelogEntry): Promise<void> {
    const page = this.page(entry.category);
    const append = (children: object[], after?: string) => this.request('PATCH', `/blocks/${page}/children`, { children, ...(after ? { after } : {}) });
    // Insert right after the page's first block (the intro line) so the newest entry is on top.
    let anchor: string | undefined = (await this.request('GET', `/blocks/${page}/children?page_size=1`)).results?.[0]?.id;
    if (!anchor) anchor = (await append([intro()])).results?.[0]?.id;
    await append(this.children(entry), anchor);
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.request('GET', '/users/me');
      return true;
    } catch {
      return false;
    }
  }

  /** Creates the three changelog pages under a Notion page the integration can access. */
  static async createPages(parentPageId: string, token: string, fetchImpl: FetchLike = fetch): Promise<NotionConfig['pages']> {
    const dest = new NotionDestination({ pages: { codeChanges: '', bugFixes: '', featureUpdates: '' } }, token, fetchImpl);
    const ids = {} as NotionConfig['pages'];
    for (const category of Object.keys(PAGE_KEY) as Category[]) {
      const page = await dest.request('POST', '/pages', {
        parent: { page_id: parseNotionId(parentPageId) },
        properties: { title: { title: rich(CATEGORY_LABELS[category]) } },
        children: [intro()],
      });
      ids[PAGE_KEY[category]] = page.id;
    }
    return ids;
  }
}
