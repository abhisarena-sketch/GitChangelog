// Deterministic, offline analysis. Every rule adds evidence to a category; the commit prefix is a
// strong signal, not the final word. A commit can land in more than one category.
import type { AnalysisItem, AnalysisResult, Category, CommitInfo } from '../types.js';
import { isDocsOrTest, isSourceFile } from '../git.js';

const CONVENTIONAL = /^(\w+)(\([^)]*\))?(!)?:\s*/;
const PREFIX_CATEGORY: Record<string, Category> = {
  feat: 'feature-update', feature: 'feature-update',
  fix: 'bug-fix', bugfix: 'bug-fix', hotfix: 'bug-fix', security: 'bug-fix',
  refactor: 'code-change', perf: 'code-change', docs: 'code-change', doc: 'code-change', test: 'code-change',
  tests: 'code-change', chore: 'code-change', style: 'code-change', build: 'code-change', ci: 'code-change',
  deps: 'code-change', revert: 'code-change', config: 'code-change',
};

const WORDS: Record<Category, [RegExp, number][]> = {
  'bug-fix': [
    [/\b(fix(es|ed|ing)?|bug(s|fix)?|hotfix|crash(es|ed|ing)?|regression|broken|incorrect|wrong|typo in logic|vulnerab\w*|cve-\d+|exploit|leak(s|ed)?|race condition|deadlock|null pointer|npe|off[- ]by[- ]one)\b/i, 2],
    [/\b(resolve[sd]?|patch(es|ed)?|prevent(s|ed)?|handle[sd]? (error|exception|empty|null|missing)|error handling)\b/i, 1],
  ],
  'feature-update': [
    [/\b(feature|implement(s|ed|ing)?|introduc(e|es|ed|ing)|new|support(s|ed)? for|integrat(e|es|ed|ion)|endpoint|workflow)\b/i, 2],
    [/\b(add(s|ed|ing)?|create[sd]?|enable[sd]?|allow(s|ed)?)\b/i, 1],
  ],
  'code-change': [
    [/\b(refactor(s|ed|ing)?|clean ?up|restructur\w*|reorganiz\w*|rename[sd]?|extract(s|ed)?|simplif\w*|tidy|lint|format(ting)?|bump(s|ed)?|upgrade[sd]?|dependenc(y|ies)|docs?|documentation|readme|tests?|typing|types|config(uration)?|ci|tooling|optimi[sz]\w*|perf(ormance)?)\b/i, 2],
  ],
};

const DEPENDENCY_MANIFEST =
  /(^|\/)(package\.json|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|requirements[^/]*\.txt|pyproject\.toml|setup\.py|Gemfile|composer\.json|[^/]+\.csproj|pubspec\.yaml|Podfile|mix\.exs|deno\.json)$/i;

const BUG_PATTERNS = [
  /\b(try\s*[{:]|catch\s*\(|except\b|rescue\b|recover\(\))/,
  /(!==?\s*(null|undefined|nil)|===?\s*(null|undefined)|\bis None\b|\bis not None\b|if err != nil|\?\.|\?\?|Optional\.ofNullable|\.isEmpty\(\)|== nullptr|^\s*if not \w|\.nil\?|\.blank\?)/,
  /\b(throw new|raise \w+|return err|panic\()/,
];
const FEATURE_PATTERNS = [
  /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|interface|enum|struct|trait|impl|def|func|fn|module)\s+\w+/,
  /^\s*(public|private|protected|internal)\s+(static\s+)?(async\s+)?[\w<>[\],\s]+\s+\w+\s*\(/,
  /(@(Get|Post|Put|Delete|Patch|Request)Mapping|@app\.(get|post|put|delete|route)|router\.(get|post|put|delete|patch)|app\.(get|post|put|delete|patch)\(|Route::(get|post|put|delete)|path\(['"])/,
];

function addedLines(diff: string): string[] {
  return diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
}

function score(commit: CommitInfo): { scores: Record<Category, number>; prefix?: Category } {
  const scores: Record<Category, number> = { 'feature-update': 0, 'bug-fix': 0, 'code-change': 0 };
  const match = commit.subject.match(CONVENTIONAL);
  const prefix = match ? PREFIX_CATEGORY[match[1].toLowerCase()] : undefined;
  if (prefix) scores[prefix] += 3;

  const subject = commit.subject.replace(CONVENTIONAL, '');
  for (const category of Object.keys(WORDS) as Category[]) {
    for (const [re, weight] of WORDS[category]) {
      // Each additional distinct keyword ("fix … bug") is extra evidence.
      const distinct = new Set((subject.match(new RegExp(re.source, 'gi')) ?? []).map((w) => w.toLowerCase())).size;
      if (distinct) scores[category] += weight + (distinct - 1);
      else if (re.test(commit.body)) scores[category] += weight / 2;
    }
  }

  const files = commit.files;
  const behavioral = files.filter((f) => !isDocsOrTest(f.path) && f.omitted !== 'lockfile' && !DEPENDENCY_MANIFEST.test(f.path));
  const newSource = behavioral.filter((f) => f.status === 'A' && isSourceFile(f.path));
  if (newSource.length) scores['feature-update'] += 2;
  if (files.some((f) => DEPENDENCY_MANIFEST.test(f.path) || f.omitted === 'lockfile')) scores['code-change'] += 1;

  const added = addedLines(commit.diff);
  if (BUG_PATTERNS.some((re) => added.some((l) => re.test(l)))) scores['bug-fix'] += 1;
  const newDefinitions = added.filter((l) => FEATURE_PATTERNS.some((re) => re.test(l))).length;
  if (newDefinitions >= 2 && commit.insertions > commit.deletions * 2) scores['feature-update'] += 1;
  // Roughly balanced churn with no new files usually means restructuring.
  if (!newSource.length && commit.deletions > 10 && Math.abs(commit.insertions - commit.deletions) < 0.25 * commit.deletions) {
    scores['code-change'] += 1;
  }

  // Docs/tests/config-only commits cannot change behavior, whatever the message says.
  if (!behavioral.length) {
    scores['code-change'] += 3;
    if (prefix !== 'feature-update') scores['feature-update'] = 0;
    if (prefix !== 'bug-fix') scores['bug-fix'] = 0;
  }
  return { scores, prefix };
}

export function classify(commit: CommitInfo): Category[] {
  const { scores, prefix } = score(commit);
  const ranked = (Object.keys(scores) as Category[]).sort((a, b) => scores[b] - scores[a]);
  const top = scores[ranked[0]] > 0 ? ranked[0] : prefix ?? 'code-change';
  const picked = new Set<Category>([top]);
  for (const c of ranked) if (scores[c] >= 3) picked.add(c);
  return [...picked];
}

const VERB: Record<string, string> = { A: 'Added', D: 'Removed', M: 'Updated', T: 'Changed type of' };

export function analyzeLocally(commit: CommitInfo): AnalysisResult {
  const title = commit.subject.replace(CONVENTIONAL, '').replace(/^./, (c) => c.toUpperCase()).trim() || 'Untitled change';
  const firstParagraph = commit.body.split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').trim();
  const bodyBullets = commit.body.split('\n').map((l) => l.match(/^\s*[-*•]\s+(.+)/)?.[1]).filter((l): l is string => !!l);
  const fileChanges = commit.files
    .slice(0, 20)
    .map((f) => `${VERB[f.status] ?? 'Changed'} \`${f.path}\``)
    .concat(commit.files.length > 20 ? [`…and ${commit.files.length - 20} more files`] : []);
  const details = [`${commit.files.length} file(s) changed, +${commit.insertions}/-${commit.deletions} lines`];
  if (commit.truncated) details.push('Diff exceeded the size limit and was partially analyzed');

  const items: AnalysisItem[] = classify(commit).map((type) => ({
    type,
    title,
    description: firstParagraph && !firstParagraph.startsWith('-') ? firstParagraph : title,
    changes: bodyBullets.length ? bodyBullets : fileChanges,
    technicalDetails: details,
    files: commit.files.map((f) => f.path),
  }));
  return { source: 'local', summary: title, items, warnings: [] };
}
