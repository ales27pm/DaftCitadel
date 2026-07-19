# Agent Guide

<!-- managed-by: agents_sync.py v1 -->

## Overview

This guide explains how Daft Citadel uses automation agents to keep contributor instructions, diagnostics runbooks, and code quality rules in sync. Follow the workflows below whenever you plan or apply updates so that the generated AGENTS.md files accurately reflect repository policy.

## Agent Tooling Basics

- `scripts/agents_sync.py plan` — Reads `agents.config.json`, compares desired instructions with the workspace, and prints proposed changes. Use the `--json` flag when you need machine-readable output for CI annotations.
- `scripts/agents_sync.py apply` — Applies the planned changes, writing Markdown files and committing them if `--auto-branch` is provided.
- `npm run manage:agents` — Convenience script that regenerates all AGENTS.md files and then runs `agents_sync.py apply --no-commit` so docs/ROADMAP.md and other managed guides stay synchronized; the command re-runs `agents_sync.py plan` afterward and fails fast if drift remains, and CI also executes it to ensure changes do not reach `main`.
- `npm run maintain:docs` — Self-contained documentation maintenance workflow that invokes `agents_sync.py` directly for roadmap and guide updates, formats everything under `docs/` with Prettier, and exits non-zero if any managed artifact still needs manual intervention; accepts `--no-prettier` and `--check` just like `scripts/maintainDocs.js`.

## Daily Workflow

1. Run `python3 scripts/agents_sync.py plan` from the repository root to preview upcoming changes. The command prints a human-readable summary to stdout.
2. When you need a machine-readable snapshot, rerun `plan` with `--json`; this writes `.agents/reports/<timestamp>.plan.json`, which you can inspect locally or upload as a CI artifact.
3. Apply the plan with `python3 scripts/agents_sync.py apply --auto-branch`. Use the new `--no-commit` flag when you want to review changes before committing, or omit it to let the tool capture a dedicated sync commit on a throwaway branch.
4. Execute the required quality gates before opening a PR:
   - `npm run format`
   - `npm run lint`
   - `npm run typecheck`
   - `npm run test`
   - `npm run manage:agents` _(automatically re-synchronizes AGENTS.md plus managed docs such as docs/ROADMAP.md and stops if any managed file still needs edits)_
   - `npm run maintain:docs` _(runs just the documentation refresh pipeline including Prettier formatting so roadmap-only tweaks do not touch AGENTS.md)_
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

## Automation Testing

- Use the environment overrides exposed by `scripts/manageAgents.js` to create hermetic sandboxes: `MANAGE_AGENTS_ROOT` chooses the workspace root, `MANAGE_AGENTS_CONFIG` points at an alternate config file, and `MANAGE_AGENTS_SYNC_SCRIPT` lets tests swap in a stub `agents_sync.py` implementation.
- Pair those overrides with Jest integration tests to spawn `npm run manage:agents` against a temporary directory. This repository ships `src/__tests__/manageAgents.integration.test.ts` as a reference that copies the real sync script for a happy path run and injects a stub to ensure persistent drift is caught.
- Always clean up temporary directories after the test to avoid polluting subsequent runs or the developer machine.

## Best Practices

- Keep platform guidance explicit: call out iOS entitlements, Android permissions, and Linux tooling separately so researchers know which steps apply to them.
- Link to the source modules or runbooks for every actionable step. This keeps the documentation trustworthy as the code evolves.
- Favor checklists for operational tasks (sideloading, diagnostics) so that support teams can verify completion quickly.

## Changelog

- 2025-11-03 • Added post-apply verification for `npm run manage:agents`, documented the new environment overrides for sandbox testing, and referenced the Jest integration coverage.
- 2025-11-03 • Introduced `npm run maintain:docs` for roadmap-focused upkeep, wired it into CI guidance alongside Prettier automation, and added Jest coverage for the script.
- 2025-11-02 • Documented the updated `npm run manage:agents` workflow that now refreshes docs/ROADMAP.md via `agents_sync.py --no-commit`.
- 2025-11-01 • Reframed the agent guide with daily workflow steps, troubleshooting tips, and platform-specific best practices.
