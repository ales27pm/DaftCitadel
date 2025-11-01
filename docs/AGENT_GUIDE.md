# Agent Guide

<!-- managed-by: agents_sync.py v1 -->

## Overview

This guide explains how Daft Citadel uses automation agents to keep contributor instructions, diagnostics runbooks, and code quality rules in sync. Follow the workflows below whenever you plan or apply updates so that the generated AGENTS.md files accurately reflect repository policy.

## Agent Tooling Basics

- `scripts/agents_sync.py plan` — Reads `agents.config.json`, compares desired instructions with the workspace, and prints proposed changes. Use the `--json` flag when you need machine-readable output for CI annotations.
- `scripts/agents_sync.py apply` — Applies the planned changes, writing Markdown files and committing them if `--auto-branch` is provided.
- `npm run manage:agents` — Convenience script that runs `plan` followed by `apply --auto-branch` for quick local iteration; CI also executes it to ensure drift does not reach `main`.

## Daily Workflow

1. Run `python3 scripts/agents_sync.py plan` from the repository root to preview upcoming changes. The command prints a human-readable summary to stdout.
2. When you need a machine-readable snapshot, rerun `plan` with `--json`; this writes `.agents/reports/<timestamp>.plan.json`, which you can inspect locally or upload as a CI artifact.
3. Apply the plan with `python3 scripts/agents_sync.py apply --auto-branch` to generate files on a dedicated branch. If you are already on a feature branch, omit `--auto-branch` and commit manually.
4. Execute the required quality gates before opening a PR:
   - `npm run prettier`
   - `npm run lint`
   - `npm run typecheck`
   - `npm run test`
   - `npm run manage:agents`
5. Review the generated Markdown for accuracy, especially platform-specific instructions related to diagnostics or sideloading.

## Editing `agents.config.json`

- Scope entries map to directory prefixes. Nested scopes override parent rules, so place the most restrictive guidance closest to the relevant code.
- When adding new directories, include descriptive `notes` blocks that explain why the scope exists (e.g., “TurboModule bridge requires platform guards”).
- Avoid duplicating instructions from parent scopes; reference them instead to keep maintenance light.
- After editing, re-run the workflow above to regenerate Markdown.

## Troubleshooting

- **Unexpected placeholders**: If the plan introduces generic “Candidate Sections” headers, re-run `plan --json` to inspect which content was detected. Update `agents.config.json` to include a curated template, then apply again.
- **Merge conflicts**: When rebasing, regenerate documentation after resolving conflicts to ensure the managed files reflect the merged state.
- **CI failures**: The CI job surfaces report paths in the log. Download the referenced `.report.json` artifact to review the failure, then reproduce locally.

## Best Practices

- Keep platform guidance explicit: call out iOS entitlements, Android permissions, and Linux tooling separately so researchers know which steps apply to them.
- Link to the source modules or runbooks for every actionable step. This keeps the documentation trustworthy as the code evolves.
- Favor checklists for operational tasks (sideloading, diagnostics) so that support teams can verify completion quickly.

## Changelog

- 2025-11-01 • Reframed the agent guide with daily workflow steps, troubleshooting tips, and platform-specific best practices.
