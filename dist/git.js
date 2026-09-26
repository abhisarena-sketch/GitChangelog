import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { isSensitiveFile, redactSecrets } from './redact.js';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export function git(cwd, args) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 512 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
}
export function tryGit(cwd, args) {
    try {
        return git(cwd, args).trim();
    }
    catch {
        return null;
    }
}
export const findRepoRoot = (cwd) => tryGit(cwd, ['rev-parse', '--show-toplevel']);
export function resolveCommit(root, ref) {
    const hash = tryGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (!hash)
        throw new Error(`Unknown commit "${ref}"`);
    return hash;
}
export function repositoryName(root) {
    const remote = tryGit(root, ['config', '--get', 'remote.origin.url']);
    const fromRemote = remote?.replace(/\.git$/, '').split(/[/:]/).pop();
    return fromRemote || path.basename(root);
}
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum|gradle\.lockfile|packages\.lock\.json|Podfile\.lock|pubspec\.lock|mix\.lock|flake\.lock)$/;
const GENERATED = /(\.min\.(js|css)|\.map|\.pb\.go|_pb2\.py|\.g\.dart|\.freezed\.dart|\.designer\.cs|\.generated\.[a-z]+)$|(^|\/)(__generated__|generated)\//i;
const SOURCE = /\.(m?[jt]sx?|c[jt]s|py|go|rs|java|kt|kts|scala|groovy|cs|fs|vb|php|rb|swift|m|mm|c|cc|cpp|cxx|h|hpp|dart|ex|exs|erl|clj|lua|r|jl|hs|ml|sql|vue|svelte|astro|html?|css|scss|sass|less|sh|ps1)$/i;
const DOCS_TESTS = /(^|\/)(docs?|tests?|__tests__|spec|specs|examples?)\/|\.(md|mdx|rst|txt|adoc)$|[._-](test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/i;
export const isSourceFile = (p) => SOURCE.test(p);
export const isDocsOrTest = (p) => DOCS_TESTS.test(p);
function isIgnored(file, ignore) {
    return ignore.some((entry) => {
        const e = entry.replace(/^\/+|\/+$/g, '');
        return e && (file === e || file.startsWith(`${e}/`) || file.includes(`/${e}/`));
    });
}
const MONOREPO_ROOTS = /^(apps|packages|services|libs|modules|projects|plugins|crates|components|workspaces)\/([^/]+)\//;
export function detectAreas(files) {
    const areas = new Set();
    for (const f of files) {
        const m = f.match(MONOREPO_ROOTS);
        if (m)
            areas.add(m[2]);
    }
    return [...areas].sort();
}
// Diff priority when the size budget is tight: source first, then config, then docs/tests.
function priority(f) {
    if (isSourceFile(f.path) && !isDocsOrTest(f.path))
        return 0;
    if (!isDocsOrTest(f.path))
        return 1;
    return 2;
}
export function extractCommit(root, hash, opts) {
    const SEP = '\x1f';
    const meta = git(root, ['show', '-s', `--format=%H${SEP}%h${SEP}%an${SEP}%ae${SEP}%aI${SEP}%P${SEP}%s${SEP}%b`, hash]);
    const [full, shortHash, author, email, date, parentList, subject, body] = meta.split(SEP);
    const parents = parentList.trim() ? parentList.trim().split(' ') : [];
    const range = [parents[0] ?? EMPTY_TREE, full];
    const statuses = new Map();
    for (const line of git(root, ['diff', '--no-renames', '--no-ext-diff', '--name-status', '-z', ...range]).split('\0').reduce((acc, tok, i, arr) => {
        if (i % 2 === 0 && tok)
            acc.push([tok, arr[i + 1]]);
        return acc;
    }, [])) {
        statuses.set(line[1], line[0][0]);
    }
    const files = [];
    for (const rec of git(root, ['diff', '--no-renames', '--no-ext-diff', '--numstat', '-z', ...range]).split('\0')) {
        if (!rec)
            continue;
        const [add, del, file] = rec.split('\t');
        if (file === undefined)
            continue;
        const binary = add === '-' && del === '-';
        const f = {
            path: file,
            status: statuses.get(file) ?? 'M',
            additions: binary ? 0 : Number(add),
            deletions: binary ? 0 : Number(del),
            binary,
        };
        if (binary)
            f.omitted = 'binary';
        else if (isSensitiveFile(file))
            f.omitted = 'sensitive';
        else if (isIgnored(file, opts.ignore) || GENERATED.test(file))
            f.omitted = 'ignored';
        else if (LOCKFILE.test(file))
            f.omitted = 'lockfile';
        files.push(f);
    }
    // Only read diff content for files we are allowed to analyze; sensitive files are never read.
    // Within a priority, smaller files first so the budget covers as many files as possible.
    const sendable = files
        .filter((f) => !f.omitted)
        .sort((a, b) => priority(a) - priority(b) || a.additions + a.deletions - (b.additions + b.deletions));
    const blocks = new Map();
    if (sendable.length) {
        // Pathspecs keep sensitive files from ever being read; very large commits skip them to stay under
        // the OS command-line limit (sensitive blocks are then dropped below and never sent).
        const pathspec = sendable.length <= 200 ? ['--', ...sendable.map((f) => `:(literal)${f.path}`)] : [];
        const patch = git(root, ['-c', 'core.quotePath=false', 'diff', '--no-renames', '--no-ext-diff', '--no-color', ...range, ...pathspec]);
        for (const block of patch.split(/^(?=diff --git )/m)) {
            const f = sendable.find((s) => block.startsWith(`diff --git a/${s.path} b/`) || block.startsWith(`diff --git "a/${s.path}"`));
            if (f)
                blocks.set(f.path, block);
        }
    }
    let redactions = 0;
    let diff = '';
    let truncated = false;
    const budget = opts.maxDiffSize;
    for (const f of sendable) {
        let block = blocks.get(f.path);
        if (!block)
            continue;
        if (opts.redactSecrets) {
            const r = redactSecrets(block);
            block = r.text;
            redactions += r.count;
        }
        const remaining = budget - diff.length;
        if (block.length <= remaining) {
            diff += block;
        }
        else if (remaining > 500) {
            diff += `${block.slice(0, remaining - 100)}\n[… diff for ${f.path} truncated …]\n`;
            truncated = true;
        }
        else {
            f.omitted = 'size';
            truncated = true;
        }
    }
    let message = `${subject}\n${body}`;
    if (opts.redactSecrets) {
        const r = redactSecrets(message);
        message = r.text;
        redactions += r.count;
    }
    const [cleanSubject, ...rest] = message.split('\n');
    return {
        hash: full,
        shortHash,
        author,
        email,
        date,
        subject: cleanSubject,
        body: rest.join('\n').trim(),
        branch: tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'HEAD',
        repository: repositoryName(root),
        parents,
        files,
        insertions: files.reduce((n, f) => n + f.additions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
        diff,
        truncated,
        areas: detectAreas(files.map((f) => f.path)),
        redactions,
    };
}
