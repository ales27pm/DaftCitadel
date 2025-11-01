# Contributing Agents

<!-- managed-by: agents_sync.py v1 -->

## Overview

Use this document when proposing changes to the automation agent configuration or the instructions surfaced through AGENTS.md. It defines review expectations, testing requirements, and communication practices that keep the workflow safe for collaborators.

## Contribution Checklist

1. **Understand the scope**
   - Locate the applicable section in `agents.config.json`. Nested scopes inherit from parents; confirm you are editing the right block before making changes.
   - Review any AGENTS.md files within that scope to understand existing guarantees.
2. **Design the update**
   - Draft the new instruction text locally and validate that it is clear, actionable, and platform aware.
   - When introducing new required commands (e.g., additional lint checks), ensure corresponding scripts exist and succeed.
3. **Regenerate documentation**
   - Run `python3 scripts/agents_sync.py plan --json` and verify that the plan contains only the intended changes.
   - Apply with `python3 scripts/agents_sync.py apply --auto-branch` or, if working on a feature branch, run without `--auto-branch` and commit manually.
4. **Run mandatory quality gates**
   - `npm run prettier`
   - `npm run lint`
   - `npm run typecheck`
   - `npm run test`
   - `npm run manage:agents`
5. **Open a pull request**
   - Summarize the motivation, affected scopes, and any new platform requirements (entitlements, permissions, tooling).
   - Attach CI results and mention reviewers responsible for the impacted areas.

## Review Guidelines

- Validate that updated instructions align with project policy (cross-platform support, ethical diagnostics practices, absence of placeholders).
- Confirm referenced scripts or runbooks exist and are current.
- Reject changes that weaken testing or security obligations without a documented exception approved by project leads.
- Encourage contributors to include before/after context or screenshots when AGENTS.md adjustments affect UX or developer tooling.

## Communication Expectations

- Use the `#daft-citadel-agents` Slack channel for coordination, especially when changes alter required workflows.
- Document any temporary deviations (e.g., skipping a command due to CI outage) in `docs/CHANGELOG_AGENTS.md` so future contributors understand the timeline.
- When blocking a PR, provide concrete remediation steps and link to the relevant section of this document.

## Incident Response

- If automation generates incorrect instructions, revert the offending commit, notify release engineering, and open a follow-up ticket.
- Capture reproduction details in `.agents/reports/` artifacts and attach them to the incident ticket.
- Update this document or the agent guide with lessons learned once the incident is resolved.

## Changelog

- 2025-11-01 • Added end-to-end contribution checklist, review guidelines, and incident response procedures.
