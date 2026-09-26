# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-26

### Added

- `git-changelog` CLI: `init`, `status`, `analyze`, `sync`, `destination`, `config`, `doctor`, `uninstall`.
- `post-commit` hook installer that chains into existing hooks and integrates with Husky and Lefthook, with clean uninstall.
- Destinations behind a `ChangelogDestination` interface: Obsidian (notes with YAML frontmatter in per-category folders, vault auto-detection) and Notion (typed database properties, database creation, schema completion).
- AI analysis with Anthropic and OpenAI using strict JSON-schema output and validation.
- Deterministic local analysis (no AI) from commit prefixes, keywords, paths and diff patterns.
- Multi-category commits, monorepo area detection, prioritized diff truncation.
- Duplicate prevention by commit hash + category, a processed-commit ledger, and a local retry queue with `sync`.
- Secret redaction, sensitive-file exclusion and prompt-injection hardening.
