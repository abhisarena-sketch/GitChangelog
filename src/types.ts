// Shared, destination-agnostic types. Nothing in here knows about Notion or Obsidian.

export const CATEGORIES = ['feature-update', 'bug-fix', 'code-change'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  'feature-update': 'Feature Updates',
  'bug-fix': 'Bug Fixes',
  'code-change': 'Code Changes',
};

export const CATEGORY_NAMES: Record<Category, string> = {
  'feature-update': 'Feature Update',
  'bug-fix': 'Bug Fix',
  'code-change': 'Code Change',
};

export interface ChangedFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';
  additions: number;
  deletions: number;
  binary: boolean;
  /** Why the diff content was not sent to the analyzer, if it wasn't. */
  omitted?: 'binary' | 'ignored' | 'sensitive' | 'lockfile' | 'size';
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string; // ISO 8601
  subject: string;
  body: string;
  branch: string;
  repository: string;
  parents: string[];
  files: ChangedFile[];
  insertions: number;
  deletions: number;
  /** Redacted, size-limited unified diff of the files that may be analyzed. */
  diff: string;
  truncated: boolean;
  areas: string[];
  redactions: number;
}

/** One classified change, as produced by an analyzer (AI or local) after validation. */
export interface AnalysisItem {
  type: Category;
  title: string;
  description: string;
  changes: string[];
  technicalDetails: string[];
  files: string[];
}

export interface AnalysisResult {
  source: 'anthropic' | 'openai' | 'local';
  summary: string;
  items: AnalysisItem[];
  warnings: string[];
}

/** The standardized record every destination receives. Unique by commit.hash + category. */
export interface ChangelogEntry {
  id: string; // `${commit.hash}:${category}`
  category: Category;
  title: string;
  summary: string;
  changes: string[];
  technicalDetails: string[];
  files: string[];
  areas: string[];
  analysis: AnalysisResult['source'];
  truncated: boolean;
  commit: {
    hash: string;
    shortHash: string;
    author: string;
    email: string;
    date: string;
    message: string;
    branch: string;
    repository: string;
    stats: { files: number; insertions: number; deletions: number };
  };
}

export interface ChangelogDestination {
  readonly name: string;
  initialize(): Promise<void>;
  createEntry(entry: ChangelogEntry): Promise<void>;
  updateEntry?(entry: ChangelogEntry): Promise<void>;
  /** True if an entry for this commit hash and category already exists. */
  exists(commitHash: string, category: Category): Promise<boolean>;
  testConnection(): Promise<boolean>;
}

export type FetchLike = typeof fetch;
