import type { AnalysisResult, CommitInfo, FetchLike } from '../types.js';
import type { Config, Secrets } from '../config.js';
import { aiKey } from '../config.js';
import { AnthropicProvider, OpenAIProvider, SYSTEM_PROMPT, buildUserPrompt, validateAnalysis } from './ai.js';
import type { AiProvider } from './ai.js';
import { analyzeLocally } from './local.js';

export function createProvider(config: Config, secrets: Secrets, fetchImpl: FetchLike): AiProvider | null {
  if (!config.ai.enabled) return null;
  const key = aiKey(config, secrets);
  if (!key) return null;
  return config.ai.provider === 'openai'
    ? new OpenAIProvider(key, config.ai.model, fetchImpl)
    : new AnthropicProvider(key, config.ai.model, fetchImpl);
}

/** AI analysis when configured, otherwise (or on any failure) deterministic local analysis. */
export async function analyzeCommit(
  commit: CommitInfo,
  config: Config,
  secrets: Secrets,
  fetchImpl: FetchLike = fetch,
): Promise<AnalysisResult> {
  if (!config.ai.enabled) return analyzeLocally(commit);
  const provider = createProvider(config, secrets, fetchImpl);
  if (!provider) {
    const env = config.ai.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    return { ...analyzeLocally(commit), warnings: [`AI enabled but ${env} is not set; used local analysis`] };
  }
  try {
    const parsed = validateAnalysis(await provider.complete(SYSTEM_PROMPT, buildUserPrompt(commit)), commit);
    if (!parsed) throw new Error('AI response failed validation');
    return { source: provider.name, summary: parsed.summary, items: parsed.items, warnings: [] };
  } catch (err) {
    return { ...analyzeLocally(commit), warnings: [`AI analysis failed (${(err as Error).message}); used local analysis`] };
  }
}
