# Contributing to Git ChangeLog

Thanks for helping out! Bug reports, fixes, new destinations and better heuristics are all welcome.

## Development

Requirements: Node.js 20+ and Git.

```bash
npm install
npm run build   # compile src/ → dist/
npm test        # build + run the full suite
```

The tests create real temporary Git repositories and drive the real CLI and hooks. External services are never called: Notion, Anthropic and OpenAI are replaced by in-memory fakes (`test/helpers.mjs`).

Try your build against a scratch repository:

```bash
node /path/to/git-changelog/dist/cli.js init
```

## Project layout

| Path | What lives there |
|---|---|
| `src/git.ts` | Commit extraction, diff budget, monorepo areas |
| `src/redact.ts` | Sensitive-file rules and secret redaction |
| `src/analysis/` | AI providers, prompt, schema validation, local classifier |
| `src/entry.ts`, `src/types.ts` | The standardized `ChangelogEntry` and destination interface |
| `src/engine.ts`, `src/store.ts` | Pipeline, duplicate checks, retry queue |
| `src/destinations/` | Notion and Obsidian adapters |
| `src/hooks.ts` | Hook install/uninstall (Git, Husky, Lefthook) |
| `src/cli.ts`, `src/prompt.ts` | Commands and interactive prompts |

## Adding a destination

1. Implement `ChangelogDestination` (`src/types.ts`) in `src/destinations/<name>.ts`. `exists(hash, category)` must be reliable, because it is what prevents duplicates.
2. Register it in `src/destinations/index.ts` and add its config type in `src/config.ts`.
3. Add setup prompts in `src/cli.ts` (`configureDestination`).
4. Add tests with a fake API, including an outage (entries must queue, then sync without duplicates).

The engine and analyzers must not change for a new destination.

## Guidelines

- Keep the hook safe: nothing may make `git-changelog hook` exit non-zero or hang for long.
- No new runtime dependencies without a strong reason. Today there is one (`yaml`).
- Anything that reaches an AI provider or a destination must go through redaction.
- Add or update a test for every behavior change.
- Update `CHANGELOG.md` under *Unreleased*.

## Pull requests

Open an issue first for large changes. Keep PRs focused, describe the behavior change and how you tested it, and make sure `npm test` passes.

By contributing you agree that your contributions are licensed under the MIT License and that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md).
