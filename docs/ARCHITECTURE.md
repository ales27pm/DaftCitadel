# Architecture

<!-- managed-by: agents_sync.py v1 -->

## Overview

Daft Citadel combines a React Native shell, a TypeScript session core, and a native-capable audio subsystem. The app renders its UI with components from `src/ui/`, persists and synchronises projects through `src/session/`, and communicates with host audio engines and plugin processes through the bridge utilities in `src/audio/`. This document captures how those pieces fit together so changes land with full awareness of their cross-module impact.

## Layered System Breakdown

1. **User interface (`src/ui/`)**
   - [`AppNavigator`](../src/ui/navigation/AppNavigator.tsx) composes the tab + stack navigation model and injects theming from the design system.
   - [`SessionAppProvider`](../src/ui/session/SessionAppProvider.tsx) boots the session layer and exposes derived state (tracks, transport, diagnostics) through React context, consumed by screens under `src/ui/screens/`.
   - The design system in `src/ui/design-system/` defines neon-inspired tokens, theming hooks, and animated primitives that keep Arrangement, Mixer, and Performance surfaces visually consistent.
   - Editors in `src/ui/editors/` rely on Skia and Reanimated to render arrangement timelines and waveforms; fixtures under `src/ui/session/fixtures.tsx` allow deterministic stories/tests without native bindings.
2. **Session core (`src/session/`)**
   - [`SessionManager`](../src/session/sessionManager.ts) orchestrates persistence, undo/redo, and communication with the audio bridge while guarding mutations with an `AsyncMutex`.
   - Models and validation utilities in [`src/session/models.ts`](../src/session/models.ts) normalise clip, routing, automation, and plugin definitions before storage or playback.
   - Storage adapters in `src/session/storage/` provide JSON and SQLite implementations behind the shared `SessionStorageAdapter` contract, while `cloud.ts` exposes optional synchronisation hooks.
   - Collaboration patch helpers live in [`src/services/collab/types.ts`](../src/services/collab/types.ts) and integrate with the manager through `createRemoteSessionPatchApplier`.
3. **Audio and plugin integration (`src/audio/`)**
   - [`AudioEngine`](../src/audio/AudioEngine.ts) wraps the native module contract (`NativeAudioEngine`) and enforces buffer semantics before delegating to platform code.
   - [`SessionAudioBridge`](../src/audio/SessionAudioBridge.ts) diff-compares session routing graphs, provisions plugin sandboxes, and calls into the engine to realise the desired node graph while preserving the last working plugin binding whenever descriptor resolution fails or reloads error out.
   - The plugin host facade (`src/audio/plugins/`) requires an explicit native `runtimeReady` capability before exposing AUv3/VST3 components. Current mobile bridges fail closed until their audio render callbacks are implemented.
   - Automation helpers in [`src/audio/Automation.ts`](../src/audio/Automation.ts) maintain tempo-aligned scheduling for clip buffers and plugin envelopes.
4. **Supporting services (`src/services/`)**
   - Collaboration services under `src/services/collab/` manage encryption, signalling payloads, and latency monitoring for remote sessions.
   - Platform utilities in `src/services/platform/` expose environment flags (simulator vs. device), permission checks, and logging bridges used throughout the UI and session layers.
5. **Tooling (`scripts/`, `.agents/`)**
   - [`scripts/agents_sync.py`](../scripts/agents_sync.py) keeps AGENTS.md artefacts aligned with `agents.config.json`.
   - Installer scripts such as [`scripts/daftcitadel.sh`](../scripts/daftcitadel.sh) provision audio assets and profile manifests that the React Native app reads at runtime.

## Runtime Flow

1. **Application bootstrap**
   - The React entry point mounts `AppNavigator` inside `SessionAppProvider`, which constructs a `SessionManager` with the active storage adapter and optional cloud provider. Mobile release builds and custom development clients with the local audio module attempt the native environment; Expo Go, web, tests, and native initialization failures use the passive bridge.
   - `SessionViewModelProvider` derives memoised view state (tracks, transport, diagnostics, plugin alerts) and exposes helper hooks like `useTransportControls`.
2. **Session hydration**
   - On first render, `SessionViewModelProvider` calls `SessionManager.loadSession`. When no session exists, it can seed one through the optional `bootstrapSession` callback.
   - Storage adapters initialise lazily (SQLite or JSON depending on platform) and resolve the requested session into normalised `Session` models.
3. **Audio graph application**
   - `SessionManager` forwards session updates to `SessionAudioBridge`, which computes a routing diff, loads clip buffers via `AudioEngine`, and instantiates plugin nodes through `PluginHost`, retrying hot swaps safely before falling back to the previous instance when necessary.
   - Transport commands triggered by hooks such as `useTransportControls` delegate to optional bridge methods (`startTransport`, `locateTransport`), while diagnostics data is polled from or subscribed to `NativeAudioEngine` through `useAudioDiagnostics`.
4. **Collaboration and patch streaming**
   - When collaboration is enabled, remote patches deserialised by `deserializeCollabSessionPatch` are applied through `createRemoteSessionPatchApplier`, ensuring undo/redo history remains coherent.
   - Latency and crash telemetry bubble into the session provider, allowing UI surfaces (Mixer, Performance) to react to degraded states.

## Platform Considerations

- **iOS** – `NativeAudioEngine` and AUv3 plugin bridges surface diagnostics via `NativeEventEmitter`; when unavailable (e.g., simulator), `useAudioDiagnostics` falls back to an `unavailable` state. Use `os.log` for native errors so the provider can surface actionable messages.
- **Android** – TurboModules expose the same audio bridge API, but storage defaults to the JSON adapter on emulators that lack SQLite bindings. Plugin sandboxes should request scoped storage permissions before instantiation.
- **Desktop** – The TypeScript layers operate unchanged; native engines are expected to satisfy the `NativeAudioEngine` contract and make clip buffer registration fast enough for large sessions. Installer manifests prepared by `scripts/daftcitadel.sh` feed platform capabilities into the UI.

## Error Handling and Observability

- `SessionManager` logs listener failures and protects state with `AsyncMutex` to prevent partial writes under concurrent updates.
- `useAudioDiagnostics` converts raw native metrics into `SessionDiagnosticsView` records, presenting degraded states in the Performance screen while keeping previous samples for trend lines.
- Plugin crashes propagate through `PluginHost.onCrash`, with `SessionViewModelProvider` limiting alert history to the five most recent incidents and exposing retry hooks per instance.

## Security and Privacy

- Collaboration packets are encrypted via the primitives in `src/services/collab/EncryptionManager.ts`, and session patches reject malformed signatures before being applied.
- Storage adapters scrub plugin restart tokens and sandbox hints before persisting sessions to prevent leaking host-specific state across devices.
- Diagnostics polling is opt-in for builds lacking the native module, ensuring sideloaded research builds do not crash when entitlements are missing.

## References

- [`docs/audio-engine.md`](./audio-engine.md) — Native engine architecture and threading model.
- [`docs/plugin-hosting.md`](./plugin-hosting.md) — Plugin discovery, sandboxing, and crash recovery.
- [`docs/session-management.md`](./session-management.md) — Session models, storage adapters, and migration workflow.
- [`docs/ui-architecture.md`](./ui-architecture.md) — Design system, navigation, and editor breakdown.
- [`docs/gui-phase-roadmap.md`](./gui-phase-roadmap.md) — GUI implementation milestones that build on this architecture.

## Changelog

- 2025-11-02 • Rewrote the architecture overview to mirror the current TypeScript modules, runtime flow, and platform contracts.
