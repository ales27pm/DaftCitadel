# GUI Phase Roadmap

This roadmap outlines the GUI-focused development phase for Daft Citadel. It builds on the foundations documented in [Phase 0 Audit](./phase-0-audit.md) and the current [UI architecture](./ui-architecture.md), translating the existing scaffolding into a production-ready, session-aware workstation experience across iOS, Android, and desktop targets.

## Current State Snapshot

- **Navigation and shell** – [`AppNavigator`](../src/ui/navigation/AppNavigator.tsx) wires tab and stack navigation with theming via [`ThemeProvider`](../src/ui/design-system/theme.tsx). Tabs surface Arrangement, Mixer, Performance, and Settings screens, but deeper flows (detailed editors, plugin racks) are not yet routed.
- **Design system** – Neon primitives (`NeonSurface`, `NeonToolbar`, etc.) in [`src/ui/design-system/components.tsx`](../src/ui/design-system/components.tsx) provide animated theming with accessibility metadata. Token coverage is strong, yet variant support for dense data views and status/severity badges is limited.
- **Session view models** – [`SessionViewModelProvider`](../src/ui/session/SessionViewModelProvider.tsx) already normalises [`Session` models](../src/session/models.ts) into track, transport, diagnostics, and plugin-alert view models. The provider expects a functional [`SessionManager`](../src/session/sessionManager.ts) + audio bridge, but current screens mostly render demo/fake data.
- **Screens and editors** – Arrangement, Mixer, and Performance screens ([`src/ui/screens`](../src/ui/screens)) visualise structure, meters, and diagnostics with Reanimated/Skia editors ([`src/ui/editors`](../src/ui/editors)). Interaction remains read-only, and there is no persistence of edits.
- **Collaboration/diagnostics services** – Collaboration primitives in [`src/services/collab`](../src/services/collab) handle encryption, signaling, and latency tracking, yet no GUI entry points expose them.

## Phase Objectives

1. **Replace demo data with real-time session state** backed by the audio engine and persistence layers.
2. **Deliver interactive editing UX** for arrangement timelines, automation, and mixer controls with deterministic undo/redo.
3. **Surface diagnostics, collaboration, and plugin health** through dedicated GUI affordances that are cross-platform safe.
4. **Harden navigation, theming, and accessibility** for multi-device deployments, including sideloaded builds on iOS and Android.
5. **Establish regression coverage** (Jest + React Native Testing Library) for all new view models and critical UI interactions.

## Workstreams and Milestones

### 1. Session-Connected UI Foundation

- Implement the native TurboModule bridges required by [`AudioEngine`](../src/audio/AudioEngine.ts) and expose them through `SessionManager` so `SessionViewModelProvider` receives live transport and diagnostics snapshots.
- Wire [`storageAdapter.native.ts`](../src/ui/session/storageAdapter.native.ts) into the provider bootstrap to hydrate sessions from disk/secure storage across platforms; add fallbacks for simulators lacking native storage APIs.
- Extend [`useTransportControls`](../src/ui/session/useTransportControls.ts) to invoke native transport commands via the audio bridge, with optimistic UI updates and error handling per platform (`os.log` on iOS, Logcat on Android).
- Deliver Jest integration tests in [`src/ui/session/__tests__`](../src/ui/session/__tests__) that mock the bridge and assert state transitions (loading → ready → error), transport command retries, and diagnostics polling backoff.

**Milestone:** Screens render real session data (tracks, clips, automation, diagnostics) with refresh/retry flows fully exercised in tests.

### 2. Arrangement & Editing Experience

- Replace the synthesized waveform/MIDI data in [`ArrangementScreen`](../src/ui/screens/ArrangementScreen.tsx) with selectors from [`buildTracks`](../src/ui/session/selectors.ts); ensure Skia editors gracefully degrade when unavailable (feature-detect via `Platform.select`).
- Introduce gesture handlers for clip move/resize and MIDI note editing. Use dependency-injected controllers so unit tests can simulate gestures without native bindings.
- Persist edits through `SessionManager.updateSession`, adding optimistic history entries via [`history.ts`](../src/session/history.ts) and syncing automation curves through [`serialization.ts`](../src/session/serialization.ts).
- Expand design-system tokens for grid rulers, selection highlights, and error states; update [`src/ui/design-system/__tests__/`](../src/ui/design-system/__tests__) to cover the new intents.
- Add undo/redo to the UI, exposing history depth via the toolbar and locking controls during concurrent collaboration updates.

**Milestone:** Arrangement view supports editing clips/notes/automation with undo/redo, visual feedback, and persisted state.

### 3. Mixer & Performance Instrumentation

- Connect [`MixerScreen`](../src/ui/screens/MixerScreen.tsx) meters to live engine gain data, smoothing via Reanimated shared values while respecting `prefersReducedMotion` from [`useAdaptiveLayout`](../src/ui/layout/useAdaptiveLayout.ts).
- Implement mixer control bindings (mute, solo, fader, pan) that call into the audio bridge and reflect routing graph changes defined in [`Session` models](../src/session/models.ts).
- Introduce plugin rack drill-down routes (nested stack beneath the Mixer tab) to inspect slot parameters, leveraging plugin descriptors from [`src/audio`](../src/audio) and crash reports from the session provider.
- Build a performance HUD on the Performance screen to visualise diagnostics trends (render load, xruns, buffer usage) with historical charts; cache samples client-side and support export to log files.
- Provide Jest tests and Storybook-like fixtures (`src/ui/session/fixtures.tsx`) to validate meter smoothing, control disable states, and plugin alert retry flows.

**Milestone:** Mixer and Performance tabs offer actionable controls and diagnostics tied to real engine state, with test coverage for control logic.

### 4. Collaboration, Settings, and Deployment UX

- Surface collaboration workflows by integrating [`CollabSessionService`](../src/services/collab/CollabSessionService.ts) into the Settings/Performance tabs: session invites, connection status, latency/packet-loss readouts.
- Add secure key management UI leveraging [`EncryptionManager`](../src/services/collab/EncryptionManager.ts) with platform-specific storage (Keychain/Keystore). Document fallback flows for development builds lacking entitlements.
- Extend Settings to manage profile manifests generated by the installer (`~/DaftCitadel/citadel_profile.json`), mapping toggles to enable/disable plugins and assets.
- Document sideloading steps (Xcode, AltStore, Android Studio) including entitlement requirements for CoreMIDI/CoreWLAN and Wi-Fi diagnostics. Update [`docs/collaboration-performance.md`](./collaboration-performance.md) with new GUI workflows once implemented.

**Milestone:** Collaboration and configuration tasks are discoverable in the GUI, with secure storage and documentation supporting sideloaded deployments.

### 5. Quality, Accessibility, and Release Engineering

- Establish automated snapshot/interaction tests using React Native Testing Library for each screen; mock native modules to keep CI deterministic.
- Audit accessibility roles/labels, ensuring components like [`NeonButton`](../src/ui/design-system/components.tsx) and transport controls expose VoiceOver/TalkBack hints. Add E2E sanity checks using Detox/Appium where feasible.
- Integrate continuous profiling hooks (Flipper, custom diagnostics overlays) to monitor frame times and memory usage across device classes.
- Gate merges on `npm run lint`, `npm run test`, `npm run typecheck`, and `npm run prettier`, and add CI workflow definitions if absent.
- Run `npm audit --production` during release candidates; document remediation steps for any high-severity advisories encountered.

**Milestone:** GUI passes accessibility audits, automated test suites, and release packaging checklists on both iOS and Android.

## Timeline Proposal

| Week | Focus        | Exit Criteria                                                                                |
| ---- | ------------ | -------------------------------------------------------------------------------------------- |
| 1–2  | Workstream 1 | Live session data flowing into UI, diagnostics polling verified by tests.                    |
| 3–5  | Workstream 2 | Interactive arrangement editor with undo/redo, persisted updates, and expanded theming.      |
| 6–7  | Workstream 3 | Mixer controls wired to engine, performance HUD charts, plugin crash recovery UI.            |
| 8–9  | Workstream 4 | Collaboration + settings UX in place, documentation updated for sideloading and manifests.   |
| 10   | Workstream 5 | Accessibility audit, CI green on lint/test/typecheck/prettier, release checklist signed off. |

## Risks and Mitigations

- **TurboModule bridge complexity** – Mitigate by scaffolding platform-specific bridges early, adding unit tests for bridge contracts, and pairing with native engineers for entitlement reviews.
- **Performance regressions on low-end devices** – Profile Reanimated/Skia usage under reduced-motion settings; provide lightweight fallbacks (static renders) when GPU acceleration is unavailable.
- **Collaboration security posture** – Leverage `EncryptionManager` for key rotation, log failures via `console`/`os.log`, and document manual revocation steps in `docs/`.
- **Testing flakiness** – Mock native timers and networking in Jest, and stabilise Detox scripts with retry helpers and device farm baselines.

## Deliverables Checklist

- Updated UI connected to real sessions with interactive editors.
- Enhanced design-system tokens and documentation aligning with new intents.
- Collaboration and diagnostics dashboards exposed in the GUI with secure storage.
- Comprehensive Jest test suites and (where feasible) Detox/Appium smoke tests.
- Refreshed documentation covering UI workflows, sideloading, and deployment.
