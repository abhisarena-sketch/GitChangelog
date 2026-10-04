// End-to-end: the real CLI binary, real `git commit`s firing the installed hook.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import YAML from 'yaml';
import { categoriesOf, cleanEnv, cli, commit, git, makeRepo, notes, tmp, writeConfig } from './helpers.mjs';

function vaultDir(name) {
  const vault = tmp(`${name}-vault`);
  fs.mkdirSync(path.join(vault, '.obsidian'));
  return vault;
}

const init = (dir, vault, extra = []) => cli(dir, ['init', '--destination', 'obsidian', '--vault', vault, '--no-ai', '--yes', ...extra]);
const status = (dir) => git(dir, ['status', '--porcelain', '--untracked-files=all']).trim();

describe('installation', () => {
  it('fresh repository: init, first commit is logged by the hook', () => {
    const dir = tmp('fresh');
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.name', 'Test Author']);
    git(dir, ['config', 'user.email', 'a@example.com']);
    const vault = vaultDir('fresh');
    const res = init(dir, vault);
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /post-commit hook installed/);
    const { hash, output } = commit(dir, { 'index.html': '<h1>Hello</h1>\n', 'style.css': 'h1 { color: red; }\n' }, 'Initial site');
    assert.match(output, /Commit completed/);
    assert.match(output, /Git ChangeLog/);
    assert.equal(notes(vault).filter((n) => n.frontmatter.commitHash === hash).length, 1);
  });

  it('existing repository: only .changelogrc.yml appears; history can be analyzed', () => {
    const dir = makeRepo('existing', { 'main.py': 'print("v1")\n', 'requirements.txt': 'flask==3.0\n' });
    const old = commit(dir, { 'main.py': 'def handler():\n    try:\n        run()\n    except ValueError:\n        return None\n' }, 'Fix crash on bad input').hash;
    const vault = vaultDir('existing');
    assert.equal(init(dir, vault).status, 0);
    assert.equal(status(dir), '?? .changelogrc.yml', 'nothing else is added to the project');
    assert.ok(!fs.existsSync(path.join(dir, 'package.json')), 'no Node files in a Python project');
    const res = cli(dir, ['analyze', '--commit', old]);
    assert.equal(res.status, 0, res.out);
    assert.deepEqual(categoriesOf(notes(vault), old), ['bug-fix']);
  });

  for (const [lang, files] of [
    ['java', { 'pom.xml': '<project/>\n', 'src/main/java/App.java': 'class App {}\n' }],
    ['go', { 'go.mod': 'module x\n', 'main.go': 'package main\n' }],
    ['rust', { 'Cargo.toml': '[package]\nname="x"\n', 'src/main.rs': 'fn main() {}\n' }],
  ]) {
    it(`${lang} repository works without Node files in the project`, () => {
      const dir = makeRepo(lang, files);
      const vault = vaultDir(lang);
      assert.equal(init(dir, vault).status, 0);
      commit(dir, {}, 'chore: add changelog config');
      const { hash } = commit(dir, { 'NOTES.md': 'notes\n' }, 'docs: add notes');
      assert.deepEqual(categoriesOf(notes(vault), hash), ['code-change']);
      assert.ok(!fs.existsSync(path.join(dir, 'node_modules')));
    });
  }

  it('chains into an existing post-commit hook and uninstall restores it exactly', () => {
    const dir = makeRepo('chain');
    const hookFile = path.join(dir, '.git', 'hooks', 'post-commit');
    const original = '#!/bin/sh\necho ran >> "$(git rev-parse --show-toplevel)/.git/existing-hook-ran"\nexit 0\n';
    fs.writeFileSync(hookFile, original, { mode: 0o755 });
    const vault = vaultDir('chain');
    const res = init(dir, vault);
    assert.match(res.out, /Existing post-commit hook found/);
    const { hash } = commit(dir, { 'a.txt': 'a\n' }, 'Add a');
    assert.ok(fs.existsSync(path.join(dir, '.git', 'existing-hook-ran')), 'original hook still runs');
    assert.equal(notes(vault).filter((n) => n.frontmatter.commitHash === hash).length, 1, 'our block ran despite `exit 0`');
    assert.equal(cli(dir, ['uninstall']).status, 0);
    assert.equal(fs.readFileSync(hookFile, 'utf8'), original);
  });

  it('reinstall is idempotent', () => {
    const dir = makeRepo('reinstall');
    const vault = vaultDir('reinstall');
    init(dir, vault);
    init(dir, vault);
    const hook = fs.readFileSync(path.join(dir, '.git', 'hooks', 'post-commit'), 'utf8');
    assert.equal(hook.match(/>>> git-changelog >>>/g).length, 1);
    assert.equal(cli(dir, ['uninstall']).status, 0);
    assert.ok(!fs.existsSync(path.join(dir, '.git', 'hooks', 'post-commit')), 'a hook file we created is removed');
    init(dir, vault);
    assert.match(cli(dir, ['status']).out, /Hook: ✓ Installed/);
  });

  it('integrates with Husky instead of .git/hooks', () => {
    const dir = makeRepo('husky');
    fs.mkdirSync(path.join(dir, '.husky'));
    fs.writeFileSync(path.join(dir, '.husky', 'pre-commit'), 'npm test\n');
    const res = init(dir, vaultDir('husky'));
    assert.match(res.out, /Husky detected/);
    const huskyHook = fs.readFileSync(path.join(dir, '.husky', 'post-commit'), 'utf8');
    assert.match(huskyHook, /git-changelog/);
    assert.ok(!fs.existsSync(path.join(dir, '.git', 'hooks', 'post-commit')));
    assert.equal(fs.readFileSync(path.join(dir, '.husky', 'pre-commit'), 'utf8'), 'npm test\n');
    cli(dir, ['uninstall']);
    assert.ok(!fs.existsSync(path.join(dir, '.husky', 'post-commit')));
  });

  it('integrates with Lefthook config and preserves existing commands', () => {
    const dir = makeRepo('lefthook');
    const original = '# team hooks\npre-commit:\n  commands:\n    lint:\n      run: npm run lint # keep me\n';
    fs.writeFileSync(path.join(dir, 'lefthook.yml'), original);
    const res = init(dir, vaultDir('lefthook'));
    assert.match(res.out, /Lefthook detected/);
    const config = YAML.parse(fs.readFileSync(path.join(dir, 'lefthook.yml'), 'utf8'));
    assert.match(config['post-commit'].commands['git-changelog'].run, /hook/);
    assert.equal(config['pre-commit'].commands.lint.run, 'npm run lint');
    assert.match(fs.readFileSync(path.join(dir, 'lefthook.yml'), 'utf8'), /# keep me/);
    cli(dir, ['uninstall']);
    assert.equal(fs.readFileSync(path.join(dir, 'lefthook.yml'), 'utf8'), original);
  });

  it('uninstall --purge removes config and local state', () => {
    const dir = makeRepo('purge');
    init(dir, vaultDir('purge'));
    const res = cli(dir, ['uninstall', '--purge', '--yes']);
    assert.equal(res.status, 0, res.out);
    assert.ok(!fs.existsSync(path.join(dir, '.changelogrc.yml')));
    assert.ok(!fs.existsSync(path.join(dir, '.changelog')));
    assert.equal(status(dir), '');
  });
});

describe('failure handling', () => {
  it('the commit succeeds when the vault is unavailable; sync publishes later', () => {
    const dir = makeRepo('fail');
    const vault = vaultDir('fail');
    init(dir, vault);
    fs.renameSync(vault, `${vault}-offline`);
    const { hash, output, status: code } = commit(dir, { 'a.js': 'export const a = 1;\n' }, 'feat: add a');
    assert.equal(code, 0);
    assert.match(output, /Unable to publish changelog: Obsidian vault not found/);
    assert.match(output, /retry queue/);
    assert.match(cli(dir, ['status']).out, /Pending:\n\s+1/);
    fs.renameSync(`${vault}-offline`, vault);
    const res = cli(dir, ['sync']);
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /Queue cleared/);
    assert.deepEqual(categoriesOf(notes(vault), hash), ['feature-update']);
  });

  it('the commit succeeds with a broken config', () => {
    const dir = makeRepo('broken');
    init(dir, vaultDir('broken'));
    fs.writeFileSync(path.join(dir, '.changelogrc.yml'), 'destination: [not valid\n');
    const { status: code, output } = commit(dir, { 'a.txt': 'a\n' }, 'x');
    assert.equal(code, 0);
    assert.match(output, /Unable to publish changelog/);
  });

  it('GIT_CHANGELOG_SKIP=1 skips the hook', () => {
    const dir = makeRepo('skip');
    const vault = vaultDir('skip');
    init(dir, vault);
    const { output } = commit(dir, { 'a.txt': 'a\n' }, 'x', { env: cleanEnv({ GIT_CHANGELOG_SKIP: '1' }) });
    assert.doesNotMatch(output, /Git ChangeLog/);
    assert.equal(notes(vault).length, 0);
  });
});

describe('commands', () => {
  it('status, doctor, analyze --dry-run, config, help', () => {
    const dir = makeRepo('cmds');
    const vault = vaultDir('cmds');
    init(dir, vault);
    commit(dir, { 'src/a.js': 'export function a() {}\n' }, 'feat: add a');

    const st = cli(dir, ['status']).out;
    assert.match(st, /Repository: gcl-cmds-/);
    assert.match(st, /Destination:\n\s+Obsidian/);
    assert.match(st, /AI:\n\s+Local \(no AI\)/);
    assert.match(st, /Last processed commit:\n\s+[0-9a-f]{7}/);

    const doc = cli(dir, ['doctor']);
    assert.equal(doc.status, 0, doc.out);
    assert.match(doc.out, /All checks passed/);
    assert.match(doc.out, /✓ Secret redaction/);

    const dry = cli(dir, ['analyze', '--dry-run']);
    assert.match(dry.out, /dry run/);
    assert.match(dry.out, /Feature Update: Add a/);
    assert.equal(notes(vault).length, 1, 'dry run publishes nothing new');

    assert.match(cli(dir, ['config']).out, /type: obsidian/);
    assert.match(cli(dir, ['--help']).out, /git-changelog <command>/);
    assert.match(cli(dir, ['--version']).out, /^\d+\.\d+\.\d+/);

    fs.rmSync(vault, { recursive: true });
    const broken = cli(dir, ['doctor']);
    assert.equal(broken.status, 1);
    assert.match(broken.out, /✗ Obsidian vault/);
  });

  it('destination switching rewrites config to exactly one destination', () => {
    const dir = makeRepo('switch-cli');
    writeConfig(dir, { destination: { type: 'notion', notion: { pages: { codeChanges: 'a', bugFixes: 'b', featureUpdates: 'c' } } } });
    const vault = vaultDir('switch-cli');
    const res = cli(dir, ['destination', 'obsidian', '--vault', vault, '--yes']);
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /were not copied/);
    const config = YAML.parse(fs.readFileSync(path.join(dir, '.changelogrc.yml'), 'utf8'));
    assert.equal(config.destination.type, 'obsidian');
    assert.equal(config.destination.notion, undefined);
    assert.match(cli(dir, ['config', 'notion']).out, /active destination is obsidian/);
  });

  it('init --ai stores provider choice and never writes secrets to the tracked config', () => {
    const dir = makeRepo('ai-init');
    const res = cli(dir, ['init', '--destination', 'obsidian', '--vault', vaultDir('ai-init'), '--ai', 'openai', '--yes'], { OPENAI_API_KEY: 'sk-test-key-that-must-not-leak-123456' });
    assert.equal(res.status, 0, res.out);
    const text = fs.readFileSync(path.join(dir, '.changelogrc.yml'), 'utf8');
    assert.deepEqual(YAML.parse(text).ai, { enabled: true, provider: 'openai' });
    assert.ok(!text.includes('sk-test'));
    assert.match(res.out, /Privacy: commit diffs/);
  });

  it('outside a Git repository gives an actionable error', () => {
    const res = cli(tmp('nogit'), ['init']);
    assert.equal(res.status, 1);
    assert.match(res.out, /Not a Git repository/);
  });
});
