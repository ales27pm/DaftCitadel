# Agents Playbook

<!-- managed-by: agents_sync.py v1 -->
> Synchronized by `scripts/manageAgents.js`. Update `agents.config.json` to modify this file.

```agents.managed
- docs/ROADMAP.md
- docs/ARCHITECTURE.md
- docs/AGENT_GUIDE.md
- docs/CONTRIBUTING_AGENTS.md
- docs/CHANGELOG_AGENTS.md
```

<!-- Optional: explicitly remove stale files managed by past runs -->
```agents.remove
# - docs/OLD_EXPERIMENT.md
```

## Purpose
This playbook captures the baseline rules for every directory in the repository. Nested `AGENTS.md` files may add requirements for their folders but must not weaken these expectations.

## Core Engineering Principles
1. **Ship production-quality code.** Prefer typed, platform-aware abstractions and avoid placeholders or partial implementations. Test doubles are acceptable when they improve determinism.
2. **Keep the app cross-platform.** Gate iOS- and Android-specific behavior with `Platform.OS` checks and prefer shared modules when possible.
3. **Rely on supported diagnostics APIs.** For network research features, use Apple-approved interfaces (CoreWLAN, NetworkExtension, `rvictl`) and Android public APIs (`WifiManager`, `VpnService`). Document any required entitlements or setup steps in `docs/`.
4. **Defend maintainability.** Write clear comments, exhaustive prop types, and follow the established module boundaries so new contributors can reason about changes quickly.

## Required Workflow Before Commit
1. Format and lint: `npm run prettier` then `npm run lint`.
2. Validate types and tests: `npm run typecheck` and `npm run test`.
3. Synchronize automation rules: `npm run manage:agents`.
4. Stage only intentional changes and review the diff for generated files or large assets.

## Pull Request Expectations
- Provide a summary, test plan, and any platform-specific verification notes.
- Include screenshots when modifying user-visible UI.
- Reference updated documentation or runbooks if behavior changes.

## Incident & Recovery Notes
- If automation regenerates unwanted files, revert them and adjust `agents.config.json` before re-running `npm run manage:agents`.
- For broken development environments, rerun `npm install` and consult `docs/AGENT_GUIDE.md` for setup and troubleshooting tips.

## Observability & Logging
- Surface actionable errors with `console` (JS) or `os_log` (Swift) and ensure logs include context identifiers (session IDs, connection state) for diagnostics.
- When adding telemetry, respect platform privacy policies and gate experimental probes behind feature flags stored under `src/session`.

## Session Shutdown Protocol
- Run the complete end-session system whenever a session concludes so audio bridges, plugin hosts, and persistence layers are consistently released.
- Back this policy with automated tests that exercise the teardown trigger and confirm the shutdown pipeline executes every time.

## Notes
- Keep secrets, API keys, and private certificates out of the repository.
- Prefer small, focused commits so automation and reviewers can trace intent quickly.
