# Roadmap

<!-- managed-by: agents_sync.py v1 -->

## Overview

This roadmap captures the near-term delivery goals for Daft Citadel as we bring the React Native shell online with the audio/session subsystems that already exist in the repository. Each focus area references concrete modules so contributors can trace work items back to code.

## Q4 2025 Focus Areas

### Session-connected UI bring-up

- **Objective**: Replace demo fixtures with live session state across Arrangement, Mixer, and Performance screens.
- **Scope**:
  - Wire [`SessionAppProvider`](../src/ui/session/SessionAppProvider.tsx) to construct a real [`SessionManager`](../src/session/sessionManager.ts) using the correct storage adapter per platform.
  - Finalise the `SessionAudioBridge` diff so session routing updates reach [`AudioEngine`](../src/audio/AudioEngine.ts) and plugin sandboxes.
  - Extend selectors in [`src/ui/session/selectors.ts`](../src/ui/session/selectors.ts) so screens consume real transport, diagnostics, and track data without relying on placeholder fixtures.
- **Done when**: Launching the app with an existing session shows accurate track layouts, transport state, and diagnostics without manual refreshes.

### Plugin resilience and crash recovery

- **Objective**: Ensure plugin lifecycle management and crash reporting are production ready on iOS, Android, and desktop builds.
- **Scope**:
  - Harden `PluginHost` (`src/audio/plugins/PluginHost.ts`) so crash retries respect sandbox identifiers and restart tokens emitted by the native hosts.
  - Pipe plugin alerts from `SessionViewModelProvider` into Mixer UI affordances, allowing users to retry failed instances in context.
  - Expand Jest coverage in `src/audio/__tests__/` and `src/ui/session/__tests__/` to validate crash propagation, alert deduplication, and retry success states.
- **Done when**: Crashed plugins surface actionable UI, retries succeed on supported hosts, and tests cover the primary crash + recovery paths.

### Collaboration patch streaming

- **Objective**: Deliver trustworthy remote-edit synchronisation backed by existing collab primitives.
- **Scope**:
  - Finish integrating `createRemoteSessionPatchApplier` (`src/services/collab/types.ts`) with `SessionManager.updateSession` so remote edits flow through undo/redo history.
  - Implement latency and health reporting surfaces using the metrics already produced by `CollabSessionService`.
  - Document the handshake and recovery sequence in `docs/collaboration-performance.md` once the UI exposes collaboration toggles.
- **Done when**: Two clients exchanging patches stay in sync after disconnect/reconnect cycles, with observable health indicators.

### Installer and asset packaging polish

- **Objective**: Keep sideloaded and workstation installs aligned with the app’s runtime expectations.
- **Scope**:
  - Update [`scripts/daftcitadel.sh`](../scripts/daftcitadel.sh) to emit the metadata the React Native app consumes (profile manifests, plugin cache hints).
  - Capture installer regressions in `TEST_SUMMARY.md` and expand sanity checks in CI so regressions surface quickly.
  - Refresh documentation in `docs/audio-engine.md` and `docs/plugin-hosting.md` after installer changes alter runtime assumptions.
- **Done when**: Fresh installs boot with the assets, manifests, and plugin cache layout expected by the TypeScript layers.

## Milestone Tracking

| Milestone                                 | Target     | Owner               | Status                                           |
| ----------------------------------------- | ---------- | ------------------- | ------------------------------------------------ |
| Session UI reads live projects            | 2025-11-15 | Core App            | 🔄 In progress (storage adapter wiring underway) |
| Plugin crash recovery ready for beta      | 2025-11-29 | Audio Platform      | ⏳ Blocked (awaiting sandbox entitlement review) |
| Collaboration patch streaming soft launch | 2025-12-06 | Collaboration Team  | 🟢 On track (integration tests passing locally)  |
| Installer + asset packaging refresh       | 2025-12-13 | Release Engineering | 🟠 At risk (CI coverage gaps being scoped)       |

## Backlog

- Add performance HUD sparklines to `PerformanceScreen` using buffered samples from `useAudioDiagnostics`.
- Investigate Graphite-backed waveform rendering within `src/ui/editors/waveform/` for lower CPU usage on low-end hardware.
- Add a desktop-friendly storage adapter variant that streams large sessions from disk without loading whole files into memory.
- Explore persistent collaboration transcripts stored via `SessionHistory` to aid debugging of remote edit conflicts.

## Operational Considerations

- **Security posture**: Collaboration and plugin telemetry must respect encryption constraints defined in `src/services/collab/EncryptionManager.ts`; redact identifiers before emitting analytics.
- **Testing**: Gate merges on `npm run lint`, `npm run test`, `npm run typecheck`, `npm run prettier`, and `npm run manage:agents`. Expand CI to execute the same checks on macOS and Linux runners.
- **Support readiness**: Keep `TEST_SUMMARY.md` and `docs/collaboration-performance.md` updated so support staff can reproduce expected behaviour and diagnose reports quickly.

## Decision Log

- 2025-10-12 — Confirmed `SessionAudioBridge` as the single source of truth for routing diffs to simplify plugin lifecycle management.
- 2025-10-27 — Adopted `SessionAppProvider` as the entry point for all session-bound UI to avoid duplicating bootstrap code across screens.
- 2025-11-02 — Prioritised collaboration stability over new diagnostics widgets to keep remote editing unblocked.

## Dependencies

- Native teams must expose the full `NativeAudioEngine` contract (transport hooks + diagnostics) before the UI can rely on live data.
- Sandbox entitlement reviews on iOS/Android determine whether plugin restart automation can ship in beta builds.
- CI infrastructure needs macOS runners with audio entitlements to exercise plugin-host smoke tests.

## References

- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — Updated architectural overview powering this roadmap.
- [`docs/session-management.md`](./session-management.md) — Session and storage primitives referenced in focus areas.
- [`docs/gui-phase-roadmap.md`](./gui-phase-roadmap.md) — Detailed GUI workstreams that align with the priorities above.
- [`docs/plugin-hosting.md`](./plugin-hosting.md) — Deep dive into plugin lifecycle behaviour targeted by the plugin resilience track.

## Changelog

- 2025-11-02 • Refocused the roadmap on session-connected UI, plugin resilience, collaboration streaming, and installer readiness with module-specific deliverables.
