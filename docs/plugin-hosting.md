# Plugin Hosting Integration

This document describes how Daft Citadel discovers, sandboxes, and controls third-party audio plugins across Apple (AUv3) and Android/desktop (VST3) platforms. It also outlines the crash-recovery workflow and how to validate new integrations.

## Overview

The JavaScript layer interacts with native plugin hosts through the `PluginHost` facade (`src/audio/plugins/PluginHost.ts`). It exposes:

- Discovery (`listAvailablePlugins`)
- Instantiation with optional sandbox identifiers
- Preset loading and parameter automation
- Crash notifications and recovery hooks

The host depends on the typed bridge contract defined in `src/audio/plugins/NativePluginHost.ts` and emits lifecycle updates through a `NativeEventEmitter`.

## AUv3 (iOS) bridge

Location: [`native/plugins/ios/AUv3PluginHost.swift`](../native/plugins/ios/AUv3PluginHost.swift)

Key characteristics:

1. **Component discovery** – Uses `AVAudioUnitComponentManager` to enumerate AUv3 effects. Each component is converted into a structured descriptor that lists audio/MIDI capabilities and parameter metadata sourced from the unit's parameter tree.
2. **Sandbox provisioning** – Plugins run inside a per-identifier directory under `Application Support/Plugins`. The host sets `isExcludedFromBackup` to avoid leaking presets into iCloud and surfaces permission failures via the `sandboxPermissionRequired` event.
3. **Instantiation** – `instantiatePlugin` spins up `AUAudioUnit` instances off the main thread, monitors render callbacks for non-zero error statuses, and publishes crash events that include restart tokens. The host returns CPU load and latency estimates to JS.
4. **Preset and automation** – Presets are loaded through `currentPreset`; automation is scheduled with `AUParameterAutomationEvent` using millisecond timestamps converted to sample offsets.
5. **Crash handling** – Render observers emit a `pluginCrashed` event when the audio unit reports an error. JS acknowledges the crash, optionally restarts the plugin, and the Swift host removes the stale observer tokens to avoid leaks.

### Build requirements

- Link the Objective-C++ bridge into the React Native target (`PluginHostModule`).
- Add the AudioToolbox and AVFoundation frameworks.
- Grant the app the `com.apple.security.network.client` entitlement if plugins perform outbound requests.

## VST3 (Android / desktop) bridge

Location: [`native/plugins/android/src/main/java/com/daftcitadel/plugins/VST3PluginHostModule.kt`](../native/plugins/android/src/main/java/com/daftcitadel/plugins/VST3PluginHostModule.kt)

Highlights:

1. **Discovery** – The host scans `filesDir/plugins` and the external app-specific `plugins` directory for `.vst3` bundles. It parses `Contents/Info.json` for metadata and parameters.
2. **Sandboxing** – Each plugin instance obtains a dedicated directory under `filesDir/plugin-sandboxes/<identifier>`. Permission failures trigger the `sandboxPermissionRequired` event with the relevant Android storage permissions.
3. **Process isolation** – Plugins launch inside a dedicated sandbox process (`vst3sandbox`). Commands (preset loading, parameter changes, automation envelopes) are streamed over STDIN as JSON. Exit codes are monitored on a daemon thread; abnormal termination results in a crash event.
4. **Crash recovery** – The React Native layer acknowledges crashes, optionally restarts a fresh process, and receives the sandbox path for post-mortem logs.
5. **Desktop reuse** – The process wrapper can be reused on desktop platforms by shipping the same command-line sandbox binary and reusing the TypeScript host API.

### Build and runtime prerequisites

- Package a `vst3sandbox` executable (or `libvst3sandbox.so`) into `filesDir` or the native library directory during installation.
- Ensure plugins include a `Contents/Info.json` manifest describing parameters. The loader tolerates missing manifests but skips descriptors it cannot parse.
- Declare the `READ_EXTERNAL_STORAGE` and `WRITE_EXTERNAL_STORAGE` permissions in `AndroidManifest.xml` for plugins stored on shared storage. On Android 13+, only `READ_MEDIA_AUDIO` is required; the host automatically suppresses legacy prompts on API 33+.

## JavaScript plugin host workflow

The JS facade coordinates sandboxes, native instantiation, and crash handling:

1. `PluginHost.listAvailablePlugins()` caches descriptors for routing graph configuration.
2. `PluginHost.loadPlugin(descriptor, options)` ensures the sandbox exists, requests native instantiation, and registers crash listeners.
3. `PluginHost.scheduleAutomation` validates instance ownership before calling the native automation scheduler; `automateParameter` remains as a compatibility wrapper.
4. `PluginHost.onCrash` subscribers receive normalized crash reports and can trigger session routing recovery.
5. `PluginSandboxManager` centralizes Android permission prompts and reuses resolved sandboxes.

## Routing integration

Plugin instances are represented in the session model as `RoutingNode` entries with `slot`, `order`, and automation bindings (see [`src/session/models.ts`](../src/session/models.ts)). The host exports `PluginAutomationEnvelope` utilities so automation curves can be scheduled against native parameters.

### Session audio bridge integration

- [`SessionAudioBridge`](../src/audio/SessionAudioBridge.ts) now provisions plugin sandboxes and instantiates plugins through the shared `PluginHost` whenever a `PluginRoutingNode` is detected in the routing graph.
- Each plugin node is configured with a `hostInstanceId` option, plus per-signal booleans (`acceptsAudio`, `acceptsMidi`, `acceptsSidechain`, and their `emits` counterparts). Native engines must accept these options when wiring audio and MIDI busses.
- Plugin automation targets defined on routing nodes are translated into `PluginHost.scheduleAutomation` calls. Automation signatures embed the session revision to guarantee rescheduling when the timeline changes.
- Stale plugin instances are released after the routing diff executes so native resources are reclaimed promptly.

### UI surfacing

- Mixer channel strips list insert chains with their current state (`active`, `bypassed`, `crashed`).
- Crash notifications collected from `PluginHost.onCrash` are surfaced via `SessionViewModelProvider` and rendered on the Mixer screen for quick triage.

## Testing

Automated coverage includes:

- `src/audio/__tests__/PluginHost.test.ts` – validates JS lifecycle hooks, crash recovery, and automation scheduling using mock native modules.
- `src/audio/__tests__/SessionAudioBridge.test.ts` – exercises plugin lifecycle diffing, automation scheduling, and routing graph mutations.
- `src/session/__tests__/routingGraph.test.ts` – verifies routing graph normalization and validation logic for plugin nodes, sends, and sidechains.
- `src/ui/session/__tests__/SessionViewModelProvider.test.tsx` – ensures crash notifications propagate into the session view model.

Use the following commands before committing:

```bash
npm run lint
npm run test
npm run typecheck
npm run prettier
```

## Limitations & future work

- The Android bridge assumes a sandbox binary capable of handling JSON control messages; provide this executable when packaging the app or during developer setup.
- AUv3 crash detection relies on render observer errors; plug-ins that fail silently may require additional watchdog logic (e.g., heartbeat messages from the audio unit).
- Parameter automation timing assumes millisecond-resolution envelopes; align session tempo maps if sample-accurate timing is required.
- Native engines must map `hostInstanceId` back to the underlying plugin process/AudioUnit. Older builds that only expected the session-level `instanceId` should be updated accordingly.

For additional platform-specific entitlements or signing instructions, refer to the project deployment guides under `docs/`.
