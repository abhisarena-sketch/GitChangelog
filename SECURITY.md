# Security Policy

## Supported versions

Security fixes are released for the latest minor version.

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately through [GitHub Security Advisories](https://github.com/abhisarena-sketch/GitChangelog/security/advisories/new).

Include the affected version, steps to reproduce, and the impact. You will get an acknowledgement within 72 hours and a status update within 7 days.

## Scope

Areas we particularly care about:

- Secrets or sensitive-file contents reaching an AI provider or a destination (redaction bypasses).
- Prompt injection that changes what is written to a destination, or that escapes the JSON schema.
- Content in a commit that can create executable or misleading content in Obsidian notes or Notion pages.
- The post-commit hook failing a commit, hanging, or running anything from repository content.
- Credential handling (`.changelog/secrets.yml`, environment variables).

## How Git ChangeLog protects your data

See the **Privacy** and **Security** sections of the [README](README.md#privacy). In short: sensitive files are never read, secrets are redacted from everything that is sent or written, AI output is schema-validated and never executed, and Local mode sends nothing to an AI provider.
