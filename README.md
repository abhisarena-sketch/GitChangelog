Turn every Git commit into engineering knowledge.

Git ChangeLog automatically analyzes your Git commits and turns them into structured documentation.

It detects what actually changed and categorizes each commit into:

🧩 Code Changes
🐛 Bug Fixes
🚀 Feature Updates

Then it publishes the result to your preferred destination:

📝 Notion
💎 Obsidian

No manual changelog writing. No copy-pasting commit history. Just commit your code and let Git ChangeLog document what happened.

✨ Why Git ChangeLog?

Git remembers what changed.

Git ChangeLog helps you remember what happened.

A typical Git history might look like:

fix stuff
update API
changes
final fix
new version

Useful? Not really.

Git ChangeLog turns that history into structured engineering knowledge:

🚀 Feature Update

Added workforce simulation

• Added scenario creation
• Added workforce requirement calculations
• Added scenario comparison
• Added simulation API

Files:
• src/scenarios/
• src/api/scenarios.ts

Commit:
abc1234

Your Git history becomes easier to understand, search, review, and revisit.

🚀 Quick Start

You don't need to modify your application.

Git ChangeLog works with virtually any Git repository.

1. Run the installer

From inside any Git repository:

npx git-changelog init
2. Choose your destination
Git ChangeLog Setup

✓ Git repository detected

Where should changelogs be stored?

❯ Notion
  Obsidian
3. Choose your AI provider
How should commits be analyzed?

❯ Anthropic
  OpenAI
  Local / No AI
4. Install the Git hook
Install post-commit hook?

❯ Yes
  No

You'll then see:

✓ Configuration created
✓ Post-commit hook installed
✓ Destination configured

You're ready.

Make your next commit:

    git commit -m "Add employee search"

Git ChangeLog will automatically document it.

That's it.

🎬 How It Works
                    git commit
                         │
                         ▼
                ┌─────────────────┐
                │ Git post-commit │
                │      hook       │
                └────────┬────────┘
                         │
                         ▼
                ┌─────────────────┐
                │ Inspect commit  │
                │ + diff + files  │
                └────────┬────────┘
                         │
                         ▼
                ┌─────────────────┐
                │ Commit Analyzer │
                │                 │
                │ AI / Local      │
                └────────┬────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │ Classify changes    │
              │                     │
              │ Code Changes        │
              │ Bug Fixes           │
              │ Feature Updates     │
              └──────────┬──────────┘
                         │
                    ┌────┴────┐
                    ▼         ▼
                Notion     Obsidian

The core engine is destination-agnostic, so additional destinations can be added without changing the commit-analysis engine.

🤖 AI-Powered Commit Analysis

Git ChangeLog can use AI to understand the actual changes in a commit.

Supported providers:

Anthropic
OpenAI
Local / No AI mode

The analyzer considers:

Commit message
Changed files
Git diff
Code structure
Added functionality
Removed functionality
Bug-related changes
Refactoring
Configuration changes
API changes
UI changes
Database changes

The commit message is only a signal.

Git ChangeLog analyzes the actual diff before deciding how a change should be classified.

Example

Commit:

update employee module

The diff might reveal:

Added employee search API
Added search filters
Added search UI

Git ChangeLog can therefore produce:

🚀 Feature Update

Added employee search functionality

• Added employee search API
• Added search filters
• Added search interface
🧠 Change Classification

Every commit can contain one or multiple types of changes.

🚀 Feature Updates

Used for changes that introduce or materially expand functionality.

Examples:

New features
New APIs
New UI workflows
New integrations
New automation
New modules
New capabilities
🐛 Bug Fixes

Used for changes that correct incorrect or broken behavior.

Examples:

Application bugs
API errors
Incorrect calculations
Broken workflows
UI bugs
Database issues
Security fixes
Integration failures
🧩 Code Changes

Used for engineering changes where a feature or bug fix isn't the primary purpose.

Examples:

Refactoring
Code cleanup
Architecture changes
Performance improvements
Dependency updates
Configuration changes
Type improvements
Developer tooling
Tests
Documentation

A single commit can belong to multiple categories.

For example:

feature-update
bug-fix
code-change
📝 Notion

Git ChangeLog can publish your changelog directly into Notion.

You can configure three logical databases:

Notion
│
├── Code Changes
├── Bug Fixes
└── Feature Updates

Each entry can contain structured information such as:

Property	Description
Title	Human-readable change title
Type	Change category
Date	Commit date
Commit	Git commit hash
Author	Commit author
Repository	Repository name
Branch	Git branch
Summary	Change summary
Changes	Detailed changes
Files Changed	Relevant files

Example:

Feature Updates

Added workforce simulation

Summary
Introduced scenario-based workforce simulation.

Changes
• Added scenario creation
• Added workforce calculations
• Added scenario comparison

Repository
workforce-platform

Branch
main

Commit
abc1234
💎 Obsidian

Git ChangeLog can also write changelogs directly into an Obsidian vault.

Example structure:

Development/
└── Changelog/
    ├── Code Changes/
    ├── Bug Fixes/
    └── Feature Updates/

Example file:

Development/Changelog/Feature Updates/
2026-09-26-added-workforce-planning-abc123.md

Each note contains frontmatter:

---
type: feature-update
date: 2026-09-26
commit: abc1234
author: Developer
repository: workforce-platform
branch: main
tags:
  - changelog
  - feature
---

And structured Markdown:

# Added workforce planning

## Summary

Introduced workforce planning functionality.

## Changes

- Added workforce requirement calculation
- Added scenario creation
- Added scenario comparison

## Files Changed

- src/planning/
- src/api/planning.ts

## Commit

`abc1234`

This means your engineering history becomes part of your Obsidian knowledge base.

🔌 Destination Architecture

Git ChangeLog uses a destination adapter architecture.

                    Commit Analyzer
                           │
                           ▼
                    Change Result
                           │
                           ▼
                 Destination Adapter
                    │           │
                    ▼           ▼
                 Notion      Obsidian

The core analyzer does not need to know where the changelog is stored.

This makes it possible to add destinations in the future, such as:

GitHub
GitLab
Jira
Linear
Confluence
Slack
Other documentation systems

Only Notion and Obsidian are currently supported.

🔐 Privacy & Security

Your source code may contain sensitive information.

Git ChangeLog is designed to minimize unnecessary exposure.

Secret protection

Git ChangeLog should never intentionally send sensitive files or credentials to an AI provider.

Examples include:

.env
.env.*
*.pem
*.key
credentials.*
secrets.*

Additional secret redaction is applied before AI analysis where possible.

Prompt injection protection

Git diffs are treated as untrusted input.

Code, comments, strings, commit messages, and other repository content must never be treated as instructions to execute actions.

Git ChangeLog does not execute code from a Git diff.

Local mode

If you don't want to send source code to an external AI provider, use:

Local / No AI

In this mode Git ChangeLog uses deterministic signals such as:

Commit messages
Conventional Commit prefixes
Changed files
Diff patterns
Keywords
File types
⚙️ Configuration

Git ChangeLog uses:

.changelogrc.yml

Example:

version: 1

destination:
  type: obsidian

  obsidian:
    vaultPath: "/path/to/vault"
    changelogFolder: "Development/Changelog"

ai:
  enabled: true
  provider: anthropic
  model: claude-sonnet

git:
  maxDiffSize: 50000

privacy:
  redactSecrets: true

ignore:
  paths:
    - node_modules
    - dist
    - build
    - coverage
    - .next
    - target
    - vendor

Only one destination is active at a time.

🔄 Switching Destinations

Switch between Notion and Obsidian:

git-changelog destination notion

or:

git-changelog destination obsidian

Switching destinations does not automatically duplicate historical changelogs.

Historical migration can be performed separately.

🔁 Failed Syncs

A Git commit should never fail because the changelog system failed.

For example:

git commit
     │
     ▼
commit succeeds
     │
     ▼
Git ChangeLog
     │
     ├── AI unavailable
     ├── Notion unavailable
     ├── Obsidian unavailable
     └── permission error

The commit remains successful.

Git ChangeLog can queue failed destination operations for later synchronization.

Run:

git-changelog sync

to retry pending operations.

🧹 Duplicate Prevention

Git ChangeLog uses the Git commit hash and change category to prevent duplicates.

For example:

abc1234 + feature-update
abc1234 + bug-fix
abc1234 + code-change

Each combination can exist only once.

This allows a single commit to legitimately appear in multiple categories without creating duplicate entries.

📦 Works With Any Git Repository

Git ChangeLog is not tied to a particular programming language or framework.

It can be installed into repositories containing:

JavaScript
TypeScript
Python
Java
Go
Rust
PHP
Ruby
C#
C++
React
Next.js
Django
Spring
Laravel
Node.js
And other Git-based projects

The target repository does not need to be a Node.js project.

Git ChangeLog itself is distributed through npm, but it operates on Git repositories regardless of their technology stack.

🏢 Monorepo Support

Git ChangeLog can work with monorepos and identify affected areas based on changed paths.

Example:

apps/
├── web/
├── api/
└── admin/

packages/
├── ui/
├── database/
└── shared/

A commit affecting:

apps/api/
packages/database/

can be documented with those affected areas.

🪝 Git Hook Safety

Git ChangeLog installs a post-commit hook.

It is designed to coexist with existing Git tooling such as:

Husky
Lefthook
pre-commit
Overcommit
Custom Git hooks

Git ChangeLog must never blindly overwrite an existing hook.

When uninstalling:

git-changelog uninstall

only Git ChangeLog's own hook section should be removed.

Existing hooks remain intact.

📋 CLI
Initialize
git-changelog init
Uninstall
git-changelog uninstall
Check status
git-changelog status
Analyze the latest commit
git-changelog analyze
Analyze a specific commit
git-changelog analyze --commit <hash>
Retry failed operations
git-changelog sync
Configure destination
git-changelog destination
Switch to Notion
git-changelog destination notion
Switch to Obsidian
git-changelog destination obsidian
View configuration
git-changelog config
Diagnose configuration
git-changelog doctor
🧪 Conventional Commits

Git ChangeLog works with Conventional Commits but does not depend on them.

These prefixes can provide additional signals:

feat:
fix:
refactor:
perf:
docs:
test:
chore:
build:
ci:

For example:

git commit -m "feat: add employee search"

The commit message can help the analyzer, but the actual diff remains the primary source of truth.

📊 Large Repositories & Large Diffs

Git ChangeLog is designed to avoid unnecessarily processing huge diffs.

By default, generated and dependency directories can be excluded:

node_modules/
dist/
build/
coverage/
.next/
vendor/
target/
.git/

Large diffs can be truncated according to:

git:
  maxDiffSize: 50000

The analyzer is informed when a diff has been truncated.

🛠️ Development

Clone the repository:

git clone <repository-url>
cd git-changelog

Install dependencies:

npm install

Run tests:

npm test

Run linting:

npm run lint

Run type checking:

npm run typecheck

Build:

npm run build

Run locally:

npm run dev
🏗️ Architecture
src/
├── cli/
│
├── core/
│   ├── analyzer/
│   ├── classifier/
│   └── pipeline/
│
├── git/
│   ├── commits/
│   ├── diff/
│   └── hooks/
│
├── ai/
│   ├── anthropic/
│   ├── openai/
│   └── local/
│
├── destinations/
│   ├── notion/
│   └── obsidian/
│
├── config/
│
└── utils/

The architecture intentionally separates:

Git
 ↓
Analysis
 ↓
Classification
 ↓
Structured Change
 ↓
Destination

This allows the project to evolve without coupling Git processing to a particular documentation platform.

🗺️ Roadmap
Current

Git repository detection

Post-commit hook architecture

Change classification

Notion destination

Obsidian destination

Anthropic support

OpenAI support

Local / no-AI mode

Duplicate prevention

Failed sync handling

CLI

Configuration system

Planned

GitHub destination

GitLab destination

Jira integration

Linear integration

Confluence integration

Slack notifications

Web dashboard

Additional AI providers

More sophisticated local classification

Changelog analytics

The roadmap may change as the project evolves.

🤝 Contributing

Contributions are welcome.

Before submitting a pull request:

Fork the repository.
Create a feature branch.
Make your changes.
Add or update tests.
Run linting and type checks.
Update documentation when required.
Open a pull request.

Please read:

CONTRIBUTING.md

before contributing.

Good first issues are also available for contributors who are new to the project.

🐛 Issues & Feature Requests

Found a bug?

Open a bug report.

Have an idea?

Open a feature request.

Please include enough information to reproduce the issue whenever possible.

🔒 Security

If you discover a security vulnerability, please do not disclose sensitive details in a public issue.

See:

SECURITY.md

for the security reporting process.

💬 Support

For questions, configuration problems, and general discussion, see:

SUPPORT.md

Community discussions may also be used for questions that could benefit other users.

📜 License

Git ChangeLog is open source and distributed under the terms of the license included in this repository.

See:

LICENSE

for details.

🌟 Support the Project

If Git ChangeLog saves you time, consider giving the project a star ⭐

It helps other developers discover the project and helps guide future development.

If you use Git ChangeLog in your project, we'd also love to hear how you're using it.

📣 Get Involved

Git ChangeLog is intended to grow with the developer community.

You can help by:

⭐ Starring the repository
🐛 Reporting bugs
💡 Suggesting features
🔧 Submitting pull requests
📚 Improving documentation
📝 Sharing your experience
🌍 Adding integrations

The goal is simple:

Make Git history useful beyond the commit log.

Git ChangeLog

Your Git history, automatically turned into engineering knowledge.

npx git-changelog init

            
