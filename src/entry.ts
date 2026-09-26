import type { AnalysisResult, ChangelogEntry, CommitInfo } from './types.js';
import { redact } from './redact.js';

/** Turns an analysis into standardized entries: one per category, secrets scrubbed from every field. */
export function buildEntries(commit: CommitInfo, analysis: AnalysisResult, redactSecrets = true): ChangelogEntry[] {
  const clean = redactSecrets ? redact : (s: string) => s;
  return analysis.items.map((item) => ({
    id: `${commit.hash}:${item.type}`,
    category: item.type,
    title: clean(item.title),
    summary: clean(item.description),
    changes: item.changes.map(clean),
    technicalDetails: item.technicalDetails.map(clean),
    files: item.files.length ? item.files : commit.files.map((f) => f.path),
    areas: commit.areas,
    analysis: analysis.source,
    truncated: commit.truncated,
    commit: {
      hash: commit.hash,
      shortHash: commit.shortHash,
      author: commit.author,
      email: commit.email,
      date: commit.date,
      message: clean(commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject),
      branch: commit.branch,
      repository: commit.repository,
      stats: { files: commit.files.length, insertions: commit.insertions, deletions: commit.deletions },
    },
  }));
}
