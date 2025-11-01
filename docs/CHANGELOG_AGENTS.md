# Changelog Agents

<!-- managed-by: agents_sync.py v1 -->

## Overview

Chronological log of notable automation and documentation updates related to Daft Citadel agents. Use this to understand when requirements changed, which scripts were touched, and what follow-up actions were taken.

## Entries

- 2025-11-01 — Rebuilt agent documentation to replace placeholder templates with actionable workflows covering roadmap, architecture, and contribution processes. Follow-up: ensure future automation runs preserve curated sections.
- 2025-11-02 — Corrected architecture/roadmap guidance to match current TypeScript modules and updated the agent workflow documentation for `plan --json`. Follow-up: audit remaining docs for stale references during the next automation sweep.
- 2025-10-22 — Added diagnostics best practices to repository-wide AGENTS.md to clarify ethical packet capture expectations. Follow-up: notify security review board of the new guidance.
- 2025-10-05 — Introduced mandatory `npm run manage:agents` check in CI after recurring drift incidents. Follow-up: retroactively update onboarding docs with the new requirement.
- 2025-09-17 — Scoped `src/audio/AGENTS.md` to enforce TurboModule parity between platforms. Follow-up: audit Android bridge for missing feature flags.

## Maintenance Tips

- Keep entries immutable; append new bullet points rather than editing history.
- Reference relevant pull requests or incident tickets when available to aid future investigations.
- Verify that each entry notes any scripts or directories impacted so contributors know where to focus when regressions occur.
