# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `ghl whoami`, `repo list|view|create`, `file read|ls`, `branch create`, `commit`,
  `pr list|view|create`, `issue list|create`, `api`, `policy show|check`, `init`, `audit`.
- Policy engine with `repos.allow` / `repos.deny` patterns, `permissions`, `denyOperations`,
  and two opt-in flags (`allowRepoCreate`, `rawApi`).
- Atomic multi-file commits through the Git Data API.
- Append-only JSONL audit log, including denied attempts.
- Token redaction in every printed string.
- `--dry-run` that performs reads only.

## [0.1.0] - 2025-01-01

Initial public sketch. The policy model and the command set are both expected to move
before 1.0; pin a tag if you depend on either.
