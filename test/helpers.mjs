import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(ROOT, 'dist', 'cli.js');
export const dist = (m) => import(new URL(`../dist/${m}`, import.meta.url));

/** Environment without any real credentials, so tests never reach real services. */
export function cleanEnv(extra = {}) {
  const env = { ...process.env, NO_COLOR: '1', GIT_CHANGELOG_SKIP: '' };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NOTION_TOKEN', 'CHANGELOG_AI_PROVIDER', 'GIT_DIR', 'GIT_WORK_TREE']) delete env[k];
  return { ...env, ...extra };
}

export function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gcl-${name}-`));
}

export const git = (dir, args, env = cleanEnv()) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });

/** A new repository with an initial commit containing `files`. */
export function makeRepo(name, files = { 'README.md': '# test\n' }) {
  const dir = tmp(name);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Test Author']);
  git(dir, ['config', 'user.email', 'author@example.com']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  commit(dir, files, 'initial commit');
  return dir;
}

/** Writes files (null deletes) and commits. Returns { hash, output }. */
export function commit(dir, files, message, { allowEmpty = false, env } = {}) {
  for (const [file, content] of Object.entries(files)) {
    const p = path.join(dir, file);
    if (content === null) fs.rmSync(p, { force: true });
    else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
  }
  git(dir, ['add', '-A']);
  const res = spawnSync('git', ['commit', '-q', ...(allowEmpty ? ['--allow-empty'] : []), '-m', message], {
    cwd: dir, encoding: 'utf8', env: env ?? cleanEnv(),
  });
  if (res.status !== 0) throw new Error(`commit failed: ${res.stderr}${res.stdout}`);
  return { hash: git(dir, ['rev-parse', 'HEAD']).trim(), output: res.stdout + res.stderr, status: res.status };
}

export function cli(dir, args, env = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: cleanEnv(env) });
  return { status: res.status, out: res.stdout + res.stderr };
}

export function writeConfig(dir, config) {
  fs.writeFileSync(path.join(dir, '.changelogrc.yml'), YAML.stringify({ version: 1, ai: { enabled: false, provider: 'anthropic' }, ...config }));
}

export function obsidianRepo(name, files) {
  const dir = makeRepo(name, files);
  const vault = tmp(`${name}-vault`);
  fs.mkdirSync(path.join(vault, '.obsidian'));
  writeConfig(dir, { destination: { type: 'obsidian', obsidian: { vaultPath: vault, changelogFolder: 'Development/Changelog' } } });
  commit(dir, {}, 'chore: add changelog config');
  return { dir, vault };
}

const FOLDERS = { 'Feature Updates': 'feature-update', 'Bug Fixes': 'bug-fix', 'Code Changes': 'code-change' };

/** All changelog entries in a vault, one per `### ` block of the category notes: [{ category, file, frontmatter, text }]. */
export function notes(vault, folder = 'Development/Changelog') {
  const out = [];
  for (const [label, category] of Object.entries(FOLDERS)) {
    const file = path.join(vault, folder, `${label}.md`);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const block of text.split(/^(?=<!-- changelog:)/m).slice(1)) {
      const [, commitHash, date] = block.match(/^<!-- changelog:(\S+) (\S+) -->/);
      const author = block.match(/^- \*\*Author:\*\* (.+)$/m)?.[1];
      const branch = block.match(/ on `([^`]+)`/)?.[1];
      out.push({ category, file, text: block, frontmatter: { type: category, commitHash, date, commit: commitHash.slice(0, 7), author, branch } });
    }
  }
  return out;
}

export const categoriesOf = (list, hash) => list.filter((n) => n.frontmatter.commitHash === hash).map((n) => n.category).sort();

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
/** In-memory Notion API (pages and their top-level blocks). Set `api.down = true` to simulate an outage. */
export function fakeNotion() {
  const api = { down: false, pages: new Map(), calls: [] };
  const newPage = (title = '', children = []) => {
    const id = randomUUID();
    api.pages.set(id, { title, blocks: [] });
    insert(id, children);
    return id;
  };
  const insert = (pageId, children, after) => {
    const blocks = api.pages.get(pageId).blocks;
    const made = children.map((b) => ({ ...b, id: randomUUID() }));
    const at = after ? blocks.findIndex((b) => b.id === after) + 1 : blocks.length;
    blocks.splice(at, 0, ...made);
    return made;
  };
  api.addPage = (title) => newPage(title, [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'intro' } }] } }]);
  /** Commit hashes recorded on a page, newest first. */
  api.commits = (pageId) => api.pages.get(pageId).blocks.map((b) => b[b.type]?.rich_text?.[0]?.text.content).filter((t) => t?.startsWith('Commit: ')).map((t) => t.slice(8));
  api.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    api.calls.push({ url, method: init.method, body });
    if (!String(url).startsWith('https://api.notion.com/v1/')) throw new Error(`unexpected request to ${url}`);
    if (api.down) throw new TypeError('fetch failed');
    const u = new URL(url);
    const p = u.pathname.replace('/v1', '');
    let m;
    if (p === '/users/me') return json(200, { object: 'user' });
    if (p === '/pages' && init.method === 'POST') {
      if (!api.pages.has(body.parent.page_id)) return json(404, { message: 'parent not found' });
      return json(200, { id: newPage(body.properties.title.title[0].text.content, body.children) });
    }
    if ((m = p.match(/^\/pages\/([^/]+)$/))) {
      return api.pages.has(m[1]) ? json(200, { id: m[1] }) : json(404, { message: `Could not find page with ID: ${m[1]}` });
    }
    if ((m = p.match(/^\/blocks\/([^/]+)\/children$/))) {
      if (!api.pages.has(m[1])) return json(404, { message: `Could not find block with ID: ${m[1]}` });
      if (init.method === 'PATCH') return json(200, { results: insert(m[1], body.children, body.after) });
      const blocks = api.pages.get(m[1]).blocks;
      const size = Number(u.searchParams.get('page_size') ?? 100);
      const start = Number(u.searchParams.get('start_cursor') ?? 0);
      const results = blocks.slice(start, start + size);
      return json(200, { results, has_more: start + size < blocks.length, next_cursor: String(start + size) });
    }
    return json(400, { message: `unhandled ${init.method} ${p}` });
  };
  return api;
}

export function notionRepo(name, files) {
  const dir = makeRepo(name, files);
  const api = fakeNotion();
  const pages = { codeChanges: api.addPage(), bugFixes: api.addPage(), featureUpdates: api.addPage() };
  writeConfig(dir, { destination: { type: 'notion', notion: { pages } } });
  commit(dir, {}, 'chore: add changelog config');
  return { dir, api, pages, env: cleanEnv({ NOTION_TOKEN: 'ntn_test_token_for_fake_api' }) };
}

/** Anthropic Messages API mock; `respond(requestBody)` returns the text the model "says". */
export function fakeAnthropic(respond) {
  const api = { requests: [] };
  api.fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body);
    api.requests.push({ url, headers: init.headers, body });
    if (!String(url).startsWith('https://api.anthropic.com/')) throw new Error(`unexpected request to ${url}`);
    const text = respond(body);
    if (text instanceof Response) return text;
    return json(200, { content: [{ type: 'text', text }], stop_reason: 'end_turn' });
  };
  return api;
}
