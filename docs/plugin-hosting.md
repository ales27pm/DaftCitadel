# Plugin Hosting Integration

This document describes how Daft Citadel discovers, sandboxes, and controls third-party audio plugins across Apple (AUv3) and Android/desktop (VST3) platforms. It also outlines the crash-recovery workflow and how to validate new integrations.

## Overview

The JavaScript layer interacts with native plugin hosts through the `PluginHost` facade (`src/audio/plugins/PluginHost.ts`). It exposes:

- Discovery (`listAvailablePlugins`)
- Instantiation with optional sandbox identifiers
- Preset loading and parameter automation
- Crash notifications and recovery hooks

The host depends on the typed bridge contract defined in `src/audio/plugins/NativePluginHost.ts` and emits lifecycle updates through a `NativeEventEmitter`.

> **Current capability:** plugin audio rendering is disabled on iOS and Android. Both native modules expose `runtimeReady: false`, return no discovery results, and reject instantiation. The control bridges remain as implementation scaffolding, but neither platform wires `PluginHostBridge::SetRenderCallback` into the device render path; Android also does not package the required VST3 sandbox executable. JavaScript treats a host as available only when native explicitly reports `runtimeReady: true`.

## Installer plugin sourcing

The `scripts/daftcitadel.sh` bootstrap now favors vendor-maintained endpoints and exposes modular feature toggles.

- **Canonical URLs first.** Tyrell N6 is pulled directly from `https://u-he.com/downloads/TyrellN6/TyrellN6_Linux.tar.xz`, with a minimal mirror list retained purely as a fallback. The legacy HTML scrapers and rotating CDN mirrors were removed, drastically reducing the chance of breakage when u-he refreshes its downloads portal.
- **Resolver hygiene.** Surge XT continues to rely on the release manifest MD5 sums, Helm still reads the maintained `helm_download.js` lookup table, and Vital reuses the nixpkgs resolver for version/hash pairs before falling back to the vendor CDN. All download helpers enforce SHA-256 or MD5 verification as before.
- **Module-aware assets.** The `--modules`/`--without-module` CLI switches allow precise opt-in for `ai`, `gui`, `synths`, `assets`, `groove`, and `experimental` feature sets. Heavy preset/sample payloads are grouped into named packs (`bpb909`, `daftpack`, `surge-presets`, `vital-daft`) that can be toggled via `--packs=bpb909,daftpack`.
- **Creative extras.** Enabling the `groove` module clones the BitwigBuddy extension and Daft Punk MIDI studies, auto-importing `.mid` files into the Citadel library. The `experimental` module checks out the ForSynth Fortran toolkit, compiles the bundled demos, and ships a `forsynth-demo` launcher for quick experiments.
- **Cache hints for React Native.** Each run emits `~/DaftCitadel/plugin_cache_hints.json`, describing the installed plugin binaries, cache directories, availability flags, and module provenance. The TypeScript `PluginHost` reads this alongside `citadel_profile.json` to pre-warm descriptor caches and to expose unavailable modules as disabled toggles in the UI.

## AUv3 (iOS) bridge

Location: [`native/plugins/ios/AUv3PluginHost.swift`](../native/plugins/ios/AUv3PluginHost.swift)

Implemented scaffolding:

1. **Component discovery** – Uses `AVAudioUnitComponentManager` to enumerate AUv3 effects. Each component is converted into a structured descriptor that lists audio/MIDI capabilities and parameter metadata sourced from the unit's parameter tree.
2. **Sandbox provisioning** – Plugins run inside a per-identifier directory under `Application Support/Plugins`. The host sets `isExcludedFromBackup` to avoid leaking presets into iCloud and surfaces permission failures via the `sandboxPermissionRequired` event.
3. **Instantiation target** – Descriptor, preset, and parameter scaffolding is retained for completion, but the exported method currently rejects with `runtime_unavailable`. AUAudioUnit activation and audio rendering must be implemented together before a unit can appear active.
4. **Preset and automation** – Presets are loaded through `currentPreset`; automation is scheduled with `AUParameterAutomationEvent` using millisecond timestamps converted to sample offsets.
5. **Crash-handling target** – Event payload and cleanup helpers exist, but no render observer is active while instantiation is disabled. Crash recovery must be verified with the future render bridge before capability is enabled.

### Requirements before enabling `runtimeReady`

- Link the Objective-C++ bridge into the React Native target (`PluginHostModule`).
- Add the AudioToolbox and AVFoundation frameworks.
- Register a real-time-safe `PluginHostBridge::SetRenderCallback` that maps each `hostInstanceId` to the AUAudioUnit render block, and clear it during teardown.
- Persist AUv3 sandboxes under `Application Support/Plugins/<format>/<identifier>` so multiple plugin formats can safely share the same identifier without clobbering metadata; the JavaScript sandbox manager mirrors this layout when restoring state after restarts.
- Keep iOS and macOS sandbox models distinct: `com.apple.security.*` file/network entitlements are macOS App Sandbox keys, not permissions to add to this iOS host. Any AUv3 extension owns and declares its own supported capabilities.

## VST3 (Android / desktop) bridge

Location: [`native/plugins/android/src/main/java/com/daftcitadel/plugins/VST3PluginHostModule.kt`](../native/plugins/android/src/main/java/com/daftcitadel/plugins/VST3PluginHostModule.kt)

Implemented scaffolding:

1. **Discovery path** – Scanner and descriptor parsing code exists, but the exported discovery method returns an empty list while the runtime is unavailable.
2. **Sandboxing** – Each plugin instance obtains a dedicated directory under `filesDir/plugin-sandboxes/<identifier>`. Permission failures trigger the `sandboxPermissionRequired` event with the relevant Android storage permissions.
3. **Process isolation target** – The bridge expects a dedicated `vst3sandbox` process and JSON commands over STDIN. No executable is packaged today, so exported instantiation rejects with `runtime_unavailable` before a handle can be created.
4. **Crash recovery** – The React Native layer acknowledges crashes, optionally restarts a fresh process, and receives the sandbox path for post-mortem logs.
5. **Desktop reuse** – The process wrapper can be reused on desktop platforms by shipping the same command-line sandbox binary and reusing the TypeScript host API.

### Requirements before enabling `runtimeReady`

- Package a `vst3sandbox` executable (or `libvst3sandbox.so`) into `filesDir` or the native library directory during installation.
- Connect sandbox rendering to `PluginHostBridge::SetRenderCallback` with bounded, real-time-safe buffer transfer and deterministic teardown.
- Ensure plugins include a `Contents/Info.json` manifest describing parameters. The loader tolerates missing manifests but skips descriptors it cannot parse.
- Keep plugin bundles in `filesDir` or `getExternalFilesDir`; these app-specific roots require no broad storage permission. A future user-selected import flow should use Android's Storage Access Framework instead of legacy read/write permissions.
- Sandbox directories follow the convention `filesDir/plugin-sandboxes/<format>/<identifier>` so AUv3, VST3, and future formats can maintain isolated cache directories. The JavaScript sandbox manager persists this mapping to AsyncStorage to avoid redundant permission prompts.
- When surfacing crash notifications via toasts or system notifications on Android 13+, request the `POST_NOTIFICATIONS` permission to ensure retry affordances are visible.

## JavaScript plugin host workflow

The JS facade coordinates sandboxes, native instantiation, and crash handling:

1. `isPluginHostAvailable()` first requires the native `runtimeReady` signal. The current mobile bridges fail this check, so production session bootstrap omits `PluginHost` entirely.
2. Once a future runtime is ready, `PluginHost.listAvailablePlugins()` caches descriptors for routing graph configuration.
3. `PluginHost.loadPlugin(descriptor, options)` ensures the sandbox exists, requests native instantiation, and registers crash listeners.
4. `PluginHost.scheduleAutomation` validates instance ownership before calling the native automation scheduler; `automateParameter` remains as a compatibility wrapper.
5. `PluginHost.onCrash` subscribers receive normalized crash reports and can trigger session routing recovery.
6. `PluginSandboxManager` centralizes Android permission prompts, persists sandbox metadata per plugin format in AsyncStorage, and reuses resolved sandboxes across launches.
7. Restart tokens emitted by the native hosts are verified before JavaScript attempts an automatic recovery, preventing stale processes from being resurrected.

## Routing integration

Plugin instances are represented in the session model as `RoutingNode` entries with `slot`, `order`, and automation bindings (see [`src/session/models.ts`](../src/session/models.ts)). The host exports `PluginAutomationEnvelope` utilities so automation curves can be scheduled against native parameters.

### Session audio bridge integration

- [`SessionAudioBridge`](../src/audio/SessionAudioBridge.ts) now provisions plugin sandboxes and instantiates plugins through the shared `PluginHost` whenever a `PluginRoutingNode` is detected in the routing graph.
- Descriptor resolution failures no longer drop audio; the bridge preserves the previous binding and retries hot swaps before falling back to the last working descriptor to keep sessions audible.
- Each plugin node is configured with a `hostInstanceId` option, plus per-signal booleans (`acceptsAudio`, `acceptsMidi`, `acceptsSidechain`, and their `emits` counterparts). Native engines must accept these options when wiring audio and MIDI busses.
- The C++ audio engine exposes a dedicated [`PluginNode`](../audio-engine/include/audio_engine/PluginNode.h) that forwards render buffers to the platform host through [`PluginHostBridge`](../audio-engine/include/audio_engine/PluginHost.h). Hosts should call `PluginHostBridge::SetRenderCallback` when the sandbox process is ready so audio render callbacks can be proxied by `hostInstanceId`.
- Plugin automation targets defined on routing nodes are translated into `PluginHost.scheduleAutomation` calls. Automation signatures embed the session revision to guarantee rescheduling when the timeline changes.
- Stale plugin instances are released after the routing diff executes so native resources are reclaimed promptly.
- Crash recovery triggers a `SessionAudioBridge` rebind that updates node options with the refreshed `hostInstanceId` and replays cached automation lanes through the shared `AutomationPublisher` helper. The recovery manager now rehydrates automation state after a manual or automatic retry succeeds.

### UI surfacing

- Mixer channel strips list insert chains with their current state (`active`, `bypassed`, `crashed`).
- Crash notifications collected from `PluginHost.onCrash` are surfaced via `SessionViewModelProvider` and rendered on the Mixer screen for quick triage.

## Testing

Automated coverage includes:

- `src/audio/__tests__/NativePluginHost.test.ts` – verifies capability detection fails closed without an explicit render-ready signal.
- `src/audio/__tests__/PluginHost.test.ts` – validates the future JS lifecycle contract using a mock native module that explicitly models a render-ready host.
- `src/audio/__tests__/SessionAudioBridge.test.ts` – exercises plugin lifecycle diffing, automation scheduling, routing graph mutations, and crash recovery rebinds.
- `src/session/__tests__/routingGraph.test.ts` – verifies routing graph normalization and validation logic for plugin nodes, sends, and sidechains.
- `src/ui/session/__tests__/SessionViewModelProvider.test.tsx` – ensures crash notifications propagate into the session view model and verifies manual retry hooks update crash state.

Use the following commands before committing:

```bash
npm run lint
npm run test:ci
npm run typecheck
npm run format:check
```

## Limitations & future work

- Mobile plugin hosting is intentionally unavailable until the platform render callbacks and Android sandbox executable are implemented and verified on device.
- AUv3 crash detection relies on render observer errors; plug-ins that fail silently may require additional watchdog logic (e.g., heartbeat messages from the audio unit).
- Parameter automation timing assumes millisecond-resolution envelopes; align session tempo maps if sample-accurate timing is required.
- Native engines must map `hostInstanceId` back to the underlying plugin process/AudioUnit. Older builds that only expected the session-level `instanceId` should be updated accordingly.

For additional platform-specific entitlements or signing instructions, refer to the project deployment guides under `docs/`.
