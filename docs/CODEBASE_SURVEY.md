# Codebase Survey

<!-- managed-by: maintainDocs manual -->

## Purpose

This survey summarises the production code that currently lives in the Daft Citadel repository so roadmap items and documentation updates stay anchored to real modules. Each section lists the primary entry points and distinctive behaviours that surfaced while reviewing the implementation directory by directory.

## Application Shell (`src/ui/`)

- [`src/ui/navigation/AppNavigator.tsx`](../src/ui/navigation/AppNavigator.tsx) defines the stack + tab navigator composition, wires the design system theme, and registers arrangement, mixer, and performance screens.
- [`src/ui/session/SessionAppProvider.tsx`](../src/ui/session/SessionAppProvider.tsx) selects between passive and production session environments, retries with the passive bridge when `NativeAudioEngine` is unavailable, and surfaces errors through React boundaries.
- [`src/ui/session/SessionViewModelProvider.tsx`](../src/ui/session/SessionViewModelProvider.tsx) memoises derived state from `SessionManager`, including transport diagnostics, plugin crash alerts, and retry handlers.
- [`src/ui/design-system/`](../src/ui/design-system) hosts tokens, typography primitives, and animated components that keep arrangement, mixer, and performance surfaces visually consistent.
- Test coverage in [`src/ui/__tests__/`](../src/ui/__tests__) exercises the session UI hooks and ensures key providers render without native bindings by stubbing passive environments.

## Session Core (`src/session/`)

- [`src/session/sessionManager.ts`](../src/session/sessionManager.ts) orchestrates storage, undo/redo history, cloud synchronisation, and audio bridge updates behind an `AsyncMutex` to prevent concurrent write corruption.
- [`src/session/storage/`](../src/session/storage) contains JSON and SQLite adapters that satisfy the `SessionStorageAdapter` contract, including transactional writes and optimistic concurrency checks.
- [`src/session/models.ts`](../src/session/models.ts) normalises session payloads (tracks, clips, automation, routing) and validates structural integrity before persistence or playback.
- [`src/session/history.ts`](../src/session/history.ts) implements bounded undo/redo stacks that the manager consults when rolling back failed edits.
- [`src/ui/session/environment.ts`](../src/ui/session/environment.ts) bootstraps passive vs. production environments, wiring `SessionAudioBridge`, native diagnostics polling, and plugin host lifecycles.

## Audio and Plugin Runtime (`src/audio/`)

- [`src/audio/AudioEngine.ts`](../src/audio/AudioEngine.ts) validates buffer payloads, initialises the native engine, applies node graph mutations, and exposes transport/diagnostics handles consumed by session hooks.
- [`src/audio/SessionAudioBridge.ts`](../src/audio/SessionAudioBridge.ts) diff-compares session routing graphs, loads clip buffers, provisions plugin instances, and retries failed bindings before falling back to the last known good descriptor.
- [`src/audio/plugins/PluginHost.ts`](../src/audio/plugins/PluginHost.ts) launches AUv3/VST3 hosts, tracks crash state, and emits retry tokens understood by the UI providers.
- [`src/audio/Automation.ts`](../src/audio/Automation.ts) keeps tempo-aligned scheduling for automation lanes and publishes transport-aware envelopes to the engine.
- [`src/audio/NativeAudioEngine.ts`](../src/audio/NativeAudioEngine.ts) shapes the TurboModule contract and exposes diagnostics subscriptions used by `useAudioDiagnostics`.

## Collaboration and Services (`src/services/`)

- [`src/services/collab/`](../src/services/collab) supplies encryption primitives, patch serialisation helpers, and latency monitors that feed into the collaboration roadmap track.
- [`src/services/platform/`](../src/services/platform) encapsulates environment detection, permission gating, and logging bridges shared across the app shell.
- [`src/services/collab/protocol.ts`](../src/services/collab/protocol.ts) defines authenticated collaboration envelopes, replay windows, acknowledgements, and bounded flow-control messages.

## Typings and Shared Utilities (`src/types/`)

- Public TypeScript interfaces and stubs live under [`src/types/`](../src/types), while [`src/audio/NativeAudioEngine.ts`](../src/audio/NativeAudioEngine.ts) defines the native engine contract and [`src/audio/plugins/types.ts`](../src/audio/plugins/types.ts) describes plugin manifests and restart state.
- Utility definitions (feature flags, analytics payloads, diagnostic snapshots) centralise cross-module typing to keep hooks and services strongly typed without importing deep implementation details.

## Testing Infrastructure (`src/__tests__/`)

- [`src/__tests__/maintainDocs.integration.test.ts`](../src/__tests__/maintainDocs.integration.test.ts) executes the documentation maintenance script in sandboxed directories, covering dry-run, interpreter resolution, and failure modes.
- Integration tests for session UI, storage adapters, and collaboration flows live alongside their respective modules and rely on deterministic fixtures plus passive audio bridges for portability.

## Tooling and Automation (`scripts/`)

- [`scripts/maintainDocs.js`](../scripts/maintainDocs.js) orchestrates managed documentation updates, executes `agents_sync.py` plan/apply cycles with timeouts and buffer limits, and optionally runs Prettier across Markdown files.
- [`scripts/manageAgents.js`](../scripts/manageAgents.js) coordinates repository-wide AGENTS.md regeneration through `agents_sync.py` and returns non-zero when local verification finds drift.
- Installer wrappers [`daft_apex_citadel.sh`](../daft_apex_citadel.sh) and [`daft_apex_allinone.sh`](../daft_apex_allinone.sh) select profiles for the consolidated installer, which provisions audio assets, profile manifests, and plugin cache hints required by the runtime.

## Audio Engine Assets (`audio-engine/` and `assets/`)

- Native audio scaffolding, including host binaries and entitlements required for diagnostics research, live under [`audio-engine/`](../audio-engine). These assets align with the `NativeAudioEngine` contract exposed to TypeScript.
- Shared UI, plugin, and documentation assets are stored in [`assets/`](../assets), keeping large binaries out of the TypeScript source tree while remaining versioned for deterministic builds.

## Managed Documentation (`docs/`)

- Roadmaps, architecture notes, and operational guides (e.g., [`docs/ROADMAP.md`](./ROADMAP.md), [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)) are regenerated through `npm run manage:agents`. Update these files alongside feature work so maintainDocs can keep them in sync.
- [`docs/MAINTENANCE_LOG.md`](./MAINTENANCE_LOG.md) records automation runs; update it when maintainDocs uncovers drift or when manual interventions are required.

## Next Steps

- Keep this survey current as new modules land—particularly when introducing diagnostics features or network capture helpers that require additional entitlements or tooling.
- Link future roadmap items back to the relevant sections above to ensure the documentation and implementation move together.
