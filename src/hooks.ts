// post-commit installation. Never overwrites an existing hook: our block is inserted right after the
// shebang (so a trailing `exit`/`exec` in the user's hook can't skip it) and removed by its markers.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { git, tryGit } from './git.js';

export const START = '# >>> git-changelog >>>';
export const END = '# <<< git-changelog <<<';
const BLOCK_RE = /\n?# >>> git-changelog >>>[\s\S]*?# <<< git-changelog <<<\n?/;
const LEFTHOOK_FILES = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml'];
const LEFTHOOK_COMMAND = 'git-changelog';

export type HookMethod = 'git' | 'husky' | 'lefthook';

export interface HookEnvironment {
  hooksDir: string;
  gitHook: string;
  husky: string | null; // .husky dir if the repo uses Husky
  lefthook: string | null; // lefthook config file
  preCommit: boolean; // pre-commit framework config present
  existingHook: boolean; // a post-commit hook we did not write already exists
}

const toPosix = (p: string) => p.split(path.sep).join('/');

/** Shell snippet run by the hook. Prefers the CLI that ran `init`, then whatever is on PATH. */
export function hookCommand(cliPath: string): string {
  const cli = toPosix(cliPath).replace(/"/g, '\\"');
  return [
    'if [ -z "$GIT_CHANGELOG_SKIP" ]; then',
    `  if command -v node >/dev/null 2>&1 && [ -f "${cli}" ]; then`,
    `    node "${cli}" hook || true`,
    '  elif command -v git-changelog >/dev/null 2>&1; then',
    '    git-changelog hook || true',
    '  else',
    '    echo "Git ChangeLog: ⚠ git-changelog is not installed (npm install -g git-changelog-cli)"',
    '  fi',
    'fi',
  ].join('\n');
}

export const hookBlock = (cliPath: string) =>
  `${START}\n# Added by Git ChangeLog. Remove with: git-changelog uninstall\n${hookCommand(cliPath)}\n${END}\n`;

export function detectHooks(root: string): HookEnvironment {
  const hooksDir = path.resolve(root, git(root, ['rev-parse', '--git-path', 'hooks']).trim());
  const gitHook = path.join(hooksDir, 'post-commit');
  const hooksPath = tryGit(root, ['config', '--get', 'core.hooksPath']) ?? '';
  const huskyDir = path.join(root, '.husky');
  const husky = fs.existsSync(huskyDir) || /(^|[\\/])\.husky([\\/]|$)/.test(hooksPath) ? huskyDir : null;
  const lefthook = LEFTHOOK_FILES.map((f) => path.join(root, f)).find((f) => fs.existsSync(f)) ?? null;
  const existing = fs.existsSync(gitHook) ? fs.readFileSync(gitHook, 'utf8') : '';
  return {
    hooksDir,
    gitHook,
    husky,
    lefthook,
    preCommit: fs.existsSync(path.join(root, '.pre-commit-config.yaml')),
    existingHook: !!existing && !existing.includes(START),
  };
}

function insertBlock(file: string, block: string): void {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let next: string;
  if (current.includes(START)) {
    next = current.replace(BLOCK_RE, (m) => (m.startsWith('\n') ? '\n' : '') + block); // reinstall: refresh in place
  } else if (!current.trim()) {
    next = `#!/bin/sh\n${block}`;
  } else if (current.startsWith('#!')) {
    const nl = current.indexOf('\n');
    next = nl === -1 ? `${current}\n${block}` : `${current.slice(0, nl + 1)}${block}${current.slice(nl + 1)}`;
  } else {
    next = `${block}${current}`;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  fs.chmodSync(file, 0o755);
}

function removeBlock(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const current = fs.readFileSync(file, 'utf8');
  if (!current.includes(START)) return false;
  const next = current.replace(BLOCK_RE, '\n');
  // If only a shebang is left, the file was ours.
  if (!next.replace(/^#![^\n]*/, '').trim()) fs.rmSync(file);
  else fs.writeFileSync(file, next.replace(/^\n/, ''));
  return true;
}

function lefthookDoc(file: string) {
  return YAML.parseDocument(fs.readFileSync(file, 'utf8'));
}

export function installHook(root: string, cliPath: string): { method: HookMethod; file: string; notes: string[] } {
  const env = detectHooks(root);
  const notes: string[] = [];
  if (env.preCommit) notes.push('pre-commit framework detected; its hooks are left untouched');

  if (env.lefthook) {
    // Lefthook regenerates .git/hooks, so register with its config instead.
    const doc = lefthookDoc(env.lefthook);
    doc.setIn(['post-commit', 'commands', LEFTHOOK_COMMAND, 'run'], hookCommand(cliPath));
    fs.writeFileSync(env.lefthook, doc.toString());
    notes.push('Lefthook detected: added to its post-commit commands. Run `lefthook install` if hooks are not active yet');
    return { method: 'lefthook', file: env.lefthook, notes };
  }
  if (env.husky) {
    const file = path.join(env.husky, 'post-commit');
    insertBlock(file, hookBlock(cliPath));
    notes.push('Husky detected: added to .husky/post-commit');
    return { method: 'husky', file, notes };
  }
  if (env.existingHook) notes.push('Existing post-commit hook found: Git ChangeLog was chained into it');
  insertBlock(env.gitHook, hookBlock(cliPath));
  return { method: 'git', file: env.gitHook, notes };
}

/** Removes only the Git ChangeLog portion from every place it could have been installed. */
export function uninstallHook(root: string): string[] {
  const env = detectHooks(root);
  const removed: string[] = [];
  for (const file of [env.gitHook, env.husky && path.join(env.husky, 'post-commit')]) {
    if (file && removeBlock(file)) removed.push(file);
  }
  if (env.lefthook) {
    const doc = lefthookDoc(env.lefthook);
    if (doc.hasIn(['post-commit', 'commands', LEFTHOOK_COMMAND])) {
      doc.deleteIn(['post-commit', 'commands', LEFTHOOK_COMMAND]);
      const commands = doc.getIn(['post-commit', 'commands']) as { items?: unknown[] } | undefined;
      if (commands && !commands.items?.length) doc.deleteIn(['post-commit', 'commands']);
      const hook = doc.getIn(['post-commit']) as { items?: unknown[] } | undefined;
      if (hook && !hook.items?.length) doc.deleteIn(['post-commit']);
      fs.writeFileSync(env.lefthook, doc.toString());
      removed.push(env.lefthook);
    }
  }
  return removed;
}

export function hookStatus(root: string): { installed: boolean; method?: HookMethod; file?: string } {
  const env = detectHooks(root);
  if (env.lefthook && lefthookDoc(env.lefthook).hasIn(['post-commit', 'commands', LEFTHOOK_COMMAND])) {
    return { installed: true, method: 'lefthook', file: env.lefthook };
  }
  const husky = env.husky && path.join(env.husky, 'post-commit');
  if (husky && fs.existsSync(husky) && fs.readFileSync(husky, 'utf8').includes(START)) return { installed: true, method: 'husky', file: husky };
  if (fs.existsSync(env.gitHook) && fs.readFileSync(env.gitHook, 'utf8').includes(START)) return { installed: true, method: 'git', file: env.gitHook };
  return { installed: false };
}
