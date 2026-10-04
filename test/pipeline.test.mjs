// Engine → destination behavior: AI providers, duplicates, Notion/Obsidian adapters, retry queue.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { categoriesOf, cleanEnv, commit, dist, fakeAnthropic, fakeNotion, notes, notionRepo, obsidianRepo, writeConfig } from './helpers.mjs';

const { processCommit, syncQueue } = await dist('engine.js');
const { listQueue } = await dist('store.js');
const { NotionDestination } = await dist('destinations/notion.js');

const aiEnv = cleanEnv({ CHANGELOG_AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'test-key' });
const THREE = {
  summary: 'Improved workforce scenarios',
  categories: [
    { type: 'feature-update', title: 'Added scenario comparison', description: 'Compare scenarios side by side.', changes: ['Added compare()'], technicalDetails: [], files: ['src/scenario.js'] },
    { type: 'bug-fix', title: 'Fixed rounding in totals', description: 'Totals rounded down.', changes: ['Use Math.round'], technicalDetails: ['Root cause: Math.floor'], files: ['src/calc.js'] },
    { type: 'code-change', title: 'Refactored calculation engine', description: 'Split into modules.', changes: ['Extracted helpers'], technicalDetails: [], files: ['src/'] },
  ],
};

describe('AI analysis', () => {
  it('uses structured AI output and writes one note per category', async () => {
    const { dir, vault } = obsidianRepo('ai-mixed');
    const { hash } = commit(dir, { 'src/scenario.js': 'export const s = 1;\n', 'src/calc.js': 'export const c = 1;\n' }, 'Improve workforce scenario calculation');
    const ai = fakeAnthropic(() => JSON.stringify(THREE));
    const result = await processCommit(dir, 'HEAD', { env: aiEnv, fetch: ai.fetch });
    assert.equal(result.analysis, 'anthropic');
    assert.deepEqual(categoriesOf(notes(vault), hash), ['bug-fix', 'code-change', 'feature-update']);
    const req = ai.requests[0];
    assert.equal(req.headers['x-api-key'], 'test-key');
    assert.equal(req.body.model, 'claude-opus-5');
    assert.equal(req.body.output_config.format.type, 'json_schema');
    const code = notes(vault).find((n) => n.category === 'code-change');
    assert.match(code.text, /- `src\/`/, 'directory paths from the AI are kept');
  });

  it('supports OpenAI', async () => {
    const { dir, vault } = obsidianRepo('openai');
    const { hash } = commit(dir, { 'src/a.js': 'export const a = 1;\n' }, 'change a');
    const requests = [];
    const fetch = async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: 's', categories: [THREE.categories[1]] }) } }] }));
    };
    await processCommit(dir, 'HEAD', { env: cleanEnv({ CHANGELOG_AI_PROVIDER: 'openai', OPENAI_API_KEY: 'k' }), fetch });
    assert.equal(requests[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(requests[0].body.response_format.type, 'json_schema');
    assert.deepEqual(categoriesOf(notes(vault), hash), ['bug-fix']);
  });

  it('falls back to local analysis when the AI API fails', async () => {
    const { dir, vault } = obsidianRepo('ai-down');
    const { hash } = commit(dir, { 'src/a.js': 'export const a = 1;\n' }, 'fix: correct value');
    const ai = fakeAnthropic(() => new Response('{"error":"overloaded"}', { status: 529 }));
    const result = await processCommit(dir, 'HEAD', { env: aiEnv, fetch: ai.fetch });
    assert.equal(result.analysis, 'local');
    assert.match(result.warnings[0], /AI analysis failed.*529/);
    assert.deepEqual(categoriesOf(notes(vault), hash), ['bug-fix']);
  });

  it('falls back when the AI response is invalid', async () => {
    for (const bad of ['Sure! Here is your changelog:', '{"categories":[{"type":"security-hole","title":"x","description":"y"}]}', '{"summary":"x"}']) {
      const { dir, vault } = obsidianRepo('ai-invalid');
      const { hash } = commit(dir, { 'src/a.js': 'export const a = 1;\n' }, 'refactor: tidy');
      const result = await processCommit(dir, 'HEAD', { env: aiEnv, fetch: fakeAnthropic(() => bad).fetch });
      assert.equal(result.analysis, 'local', bad);
      assert.match(result.warnings[0], /failed validation/);
      assert.deepEqual(categoriesOf(notes(vault), hash), ['code-change']);
    }
  });

  it('AI enabled without a key uses local analysis and says why', async () => {
    const { dir } = obsidianRepo('ai-nokey');
    commit(dir, { 'src/a.js': 'export const a = 1;\n' }, 'feat: a');
    const result = await processCommit(dir, 'HEAD', { env: cleanEnv({ CHANGELOG_AI_PROVIDER: 'anthropic' }) });
    assert.equal(result.analysis, 'local');
    assert.match(result.warnings[0], /ANTHROPIC_API_KEY is not set/);
  });
});

describe('duplicate prevention', () => {
  it('never writes the same commit + category twice', async () => {
    const { dir, vault } = obsidianRepo('dupe');
    const { hash } = commit(dir, { 'src/a.js': 'export function a() {}\nexport function b() {}\n' }, 'feat: add a');
    const first = await processCommit(dir, 'HEAD', { env: cleanEnv() });
    assert.equal(first.published.length, 1);
    const second = await processCommit(dir, 'HEAD', { env: cleanEnv() });
    assert.equal(second.status, 'duplicate', 'hook ran twice');
    const forced = await processCommit(dir, 'HEAD', { env: cleanEnv() }, { force: true });
    assert.equal(forced.duplicates.length, 1, 'destination check catches it even when forced');
    // Even with local state wiped (e.g. fresh clone), the destination check holds.
    fs.rmSync(path.join(dir, '.changelog'), { recursive: true, force: true });
    const fresh = await processCommit(dir, 'HEAD', { env: cleanEnv() });
    assert.equal(fresh.duplicates.length, 1);
    assert.equal(notes(vault).filter((n) => n.frontmatter.commitHash === hash).length, 1);
  });
});

describe('Notion destination (mocked API)', () => {
  it('appends structured entries to the right category pages, newest first', async () => {
    const { dir, api, pages, env } = notionRepo('notion');
    const { hash } = commit(dir, { 'apps/web/src/scenario.js': 'export const s = 1;\n', 'src/calc.js': 'export const c = 1;\n' }, 'Improve scenarios');
    const result = await processCommit(dir, 'HEAD', { env: { ...env, CHANGELOG_AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' }, fetch: async (url, init) => (String(url).includes('anthropic') ? fakeAnthropic(() => JSON.stringify(THREE)).fetch(url, init) : api.fetch(url, init)) });
    assert.equal(result.published.length, 3);
    for (const id of Object.values(pages)) assert.deepEqual(api.commits(id), [hash]);
    const blocks = api.pages.get(pages.bugFixes).blocks;
    const text = (b) => b[b.type].rich_text[0].text.content;
    assert.equal(text(blocks[0]), 'intro', 'intro stays on top');
    assert.match(text(blocks[1]), /^\d{4}-\d{2}-\d{2} · 🐛 Fix · web$/);
    assert.equal(text(blocks[2]), 'Fixed rounding in totals');
    assert.ok(blocks.some((b) => b.type === 'bulleted_list_item' && text(b) === 'Author: Test Author'));
    assert.ok(blocks.some((b) => b.type === 'toggle' && text(b).startsWith('Files changed')));

    const second = commit(dir, { 'src/d.js': 'export const d = 1;\n' }, 'fix: d');
    await processCommit(dir, 'HEAD', { env, fetch: api.fetch });
    assert.deepEqual(api.commits(pages.bugFixes), [second.hash, hash], 'newest entry goes above the previous one');

    // Duplicate check reads the page
    fs.rmSync(path.join(dir, '.changelog'), { recursive: true, force: true });
    const again = await processCommit(dir, 'HEAD', { env, fetch: api.fetch });
    assert.equal(again.published.length, 0);
    assert.ok(again.duplicates.length >= 1);
  });

  it('can create the three pages', async () => {
    const api = fakeNotion();
    const parent = api.addPage('Parent');
    const ids = await NotionDestination.createPages(`https://www.notion.so/My-Page-${parent.replace(/-/g, '')}`, 'tok', api.fetch);
    assert.equal(new Set(Object.values(ids)).size, 3);
    const create = api.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/pages'));
    assert.equal(create[0].body.parent.page_id, parent);
    assert.deepEqual(create.map((c) => c.body.properties.title.title[0].text.content).sort(), ['Bug Fixes', 'Code Changes', 'Feature Updates']);
  });

  it('queues entries when Notion is down and syncs them later without duplicates', async () => {
    const { dir, api, pages, env } = notionRepo('notion-down');
    const { hash } = commit(dir, { 'src/a.js': 'export const a = 1;\n' }, 'fix: correct a');
    api.down = true;
    const result = await processCommit(dir, 'HEAD', { env, fetch: api.fetch });
    assert.equal(result.status, 'queued');
    assert.match(result.error, /fetch failed/);
    const queue = listQueue(dir);
    assert.equal(queue.length, 1);
    assert.equal(path.basename(queue[0].file), `${hash.slice(0, 7)}-bug-fix.json`);

    const stillDown = await syncQueue(dir, { env, fetch: api.fetch });
    assert.equal(stillDown.failed.length, 1);
    assert.equal(listQueue(dir)[0].attempts, 1);

    api.down = false;
    const synced = await syncQueue(dir, { env, fetch: api.fetch });
    assert.equal(synced.published.length, 1);
    assert.equal(listQueue(dir).length, 0);
    assert.equal((await syncQueue(dir, { env, fetch: api.fetch })).published.length, 0);
    assert.equal(api.commits(pages.bugFixes).length, 1);
  });

  it('a queued entry that already exists is dropped, not duplicated', async () => {
    const { dir, api, pages, env } = notionRepo('notion-requeue');
    commit(dir, { 'src/a.js': 'export const a = 1;\n' }, 'fix: a');
    await processCommit(dir, 'HEAD', { env, fetch: api.fetch });
    const { enqueue } = await dist('store.js');
    const entry = (await processCommit(dir, 'HEAD', { env, fetch: api.fetch }, { dryRun: true })).entries[0];
    enqueue(dir, entry, 'simulated earlier failure');
    const result = await syncQueue(dir, { env, fetch: api.fetch });
    assert.equal(result.duplicates.length, 1);
    assert.equal(api.commits(pages.bugFixes).length, 1);
  });
});

describe('Obsidian destination', () => {
  it('appends every commit to one note per category, with the author', async () => {
    const { dir, vault } = obsidianRepo('obs');
    const { hash } = commit(dir, { 'src/a.js': 'export function a() {}\nexport function b() {}\n' }, 'feat(planning): add workforce simulation\n\n- Added scenario creation\n- Added calculation');
    await processCommit(dir, 'HEAD', { env: cleanEnv() });
    const second = commit(dir, { 'src/b.js': 'export function c() {}\nexport function d() {}\n' }, 'feat: add scenario export');
    await processCommit(dir, 'HEAD', { env: cleanEnv() });
    const features = notes(vault).filter((n) => n.category === 'feature-update');
    assert.equal(new Set(features.map((n) => n.file)).size, 1, 'one shared note');
    assert.deepEqual(features.map((n) => n.frontmatter.commitHash), [second.hash, hash], 'newest first');
    const note = features[1];
    assert.equal(note.frontmatter.commit, hash.slice(0, 7));
    assert.equal(note.frontmatter.author, 'Test Author');
    assert.equal(note.frontmatter.branch, 'main');
    assert.match(note.text, /^### \d{4}-\d{2}-\d{2} · ✨ Feature · planning$/m);
    assert.match(note.text, /^\*\*Add workforce simulation\*\*$/m);
    assert.match(note.text, /\*\*Changes\*\*\n\n- Added scenario creation\n- Added calculation/);
    assert.match(note.text, /Files changed \(1\)<\/summary>\n\n- `src\/a\.js`/);
    const text = fs.readFileSync(note.file, 'utf8');
    assert.match(text, /^# Feature Updates$/m);
    assert.match(text, /^## .+ feature updates$/m);
    assert.match(text, /^tags:\n {2}- changelog\n {2}- feature$/m);
    const vaultFiles = fs.readdirSync(vault).sort();
    assert.deepEqual(vaultFiles, ['.obsidian', 'Development'], 'nothing else in the vault is touched');
  });

  it('queues when the vault is unavailable and publishes on sync', async () => {
    const { dir, vault } = obsidianRepo('obs-offline');
    const { hash } = commit(dir, { 'src/a.js': 'export const a = 1;\n' }, 'fix: a');
    fs.renameSync(vault, `${vault}-away`);
    const result = await processCommit(dir, 'HEAD', { env: cleanEnv() });
    assert.equal(result.status, 'queued');
    assert.match(result.error, /vault not found/);
    fs.renameSync(`${vault}-away`, vault);
    const synced = await syncQueue(dir, { env: cleanEnv() });
    assert.equal(synced.published.length, 1);
    assert.deepEqual(categoriesOf(notes(vault), hash), ['bug-fix']);
  });
});

it('offline mode: AI and destination unreachable, nothing throws', async () => {
  const { dir, env } = notionRepo('offline');
  commit(dir, { 'src/a.js': 'export const a = 1;\n' }, 'feat: offline work');
  const offline = async () => {
    throw new TypeError('fetch failed');
  };
  const result = await processCommit(dir, 'HEAD', { env: { ...env, CHANGELOG_AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' }, fetch: offline });
  assert.equal(result.analysis, 'local');
  assert.equal(result.status, 'queued');
  assert.equal(listQueue(dir).length, 1);
});

it('switching destinations does not copy history; queued entries go to the new destination', async () => {
  const { dir, vault } = obsidianRepo('switch');
  const first = commit(dir, { 'src/a.js': 'export const a = 1;\n' }, 'fix: a');
  await processCommit(dir, 'HEAD', { env: cleanEnv() });
  // Second commit fails to publish (vault offline) and is queued.
  const second = commit(dir, { 'src/b.js': 'export const b = 1;\n' }, 'fix: b');
  const realVault = vault;
  writeConfig(dir, { destination: { type: 'obsidian', obsidian: { vaultPath: path.join(vault, 'missing'), changelogFolder: 'x' } } });
  await processCommit(dir, 'HEAD', { env: cleanEnv() });
  assert.equal(listQueue(dir).length, 1);

  const api = fakeNotion();
  const pages = { codeChanges: api.addPage(), bugFixes: api.addPage(), featureUpdates: api.addPage() };
  writeConfig(dir, { destination: { type: 'notion', notion: { pages } } });
  const env = cleanEnv({ NOTION_TOKEN: 'tok' });
  await syncQueue(dir, { env, fetch: api.fetch });
  const third = commit(dir, { 'src/c.js': 'export const c = 1;\n' }, 'fix: c');
  await processCommit(dir, 'HEAD', { env, fetch: api.fetch });

  const inNotion = api.commits(pages.bugFixes).sort();
  assert.deepEqual(inNotion, [second.hash, third.hash].sort(), 'old Obsidian entries were not migrated');
  assert.deepEqual(notes(realVault).map((n) => n.frontmatter.commitHash), [first.hash], 'Obsidian history untouched');
});
