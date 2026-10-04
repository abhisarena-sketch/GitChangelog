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

/** In-memory Notion API. Set `api.down = true` to simulate an outage. */
export function fakeNotion() {
  const api = { down: false, databases: new Map(), pages: [], calls: [] };
  api.addDatabase = (title = 'Name') => {
    const id = randomUUID();
    api.databases.set(id, { properties: { [title]: { type: 'title', title: {} } } });
    return id;
  };
  api.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    api.calls.push({ url, method: init.method, body });
    if (!String(url).startsWith('https://api.notion.com/v1/')) throw new Error(`unexpected request to ${url}`);
    if (api.down) throw new TypeError('fetch failed');
    const p = new URL(url).pathname.replace('/v1', '');
    let m;
    if (p === '/users/me') return json(200, { object: 'user' });
    if (p === '/databases' && init.method === 'POST') {
      const id = randomUUID();
      const properties = Object.fromEntries(Object.entries(body.properties).map(([k, v]) => [k, { type: Object.keys(v)[0], ...v }]));
      api.databases.set(id, { properties, title: body.title });
      return json(200, { id });
    }
    if ((m = p.match(/^\/databases\/([^/]+)\/query$/))) {
      const results = api.pages.filter(
        (pg) => pg.parent.database_id === m[1] && pg.properties.Commit?.rich_text.map((t) => t.text.content).join('') === body.filter.rich_text.equals,
      );
      return json(200, { results });
    }
    if ((m = p.match(/^\/databases\/([^/]+)$/))) {
      const db = api.databases.get(m[1]);
      if (!db) return json(404, { message: `Could not find database with ID: ${m[1]}` });
      if (init.method === 'PATCH') {
        for (const [k, v] of Object.entries(body.properties)) db.properties[k] = { type: Object.keys(v)[0], ...v };
      }
      return json(200, { id: m[1], properties: db.properties });
    }
    if (p === '/pages' && init.method === 'POST') {
      if (!api.databases.has(body.parent.database_id)) return json(404, { message: 'database not found' });
      api.pages.push(body);
      return json(200, { id: randomUUID() });
    }
    return json(400, { message: `unhandled ${init.method} ${p}` });
  };
  return api;
}

export function notionRepo(name, files) {
  const dir = makeRepo(name, files);
  const api = fakeNotion();
  const databases = { codeChanges: api.addDatabase(), bugFixes: api.addDatabase(), featureUpdates: api.addDatabase('Title') };
  writeConfig(dir, { destination: { type: 'notion', notion: { databases } } });
  commit(dir, {}, 'chore: add changelog config');
  return { dir, api, databases, env: cleanEnv({ NOTION_TOKEN: 'ntn_test_token_for_fake_api' }) };
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
