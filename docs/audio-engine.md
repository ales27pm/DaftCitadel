# Audio Engine Architecture

## Overview

The audio engine couples a real-time safe C++ DSP core with React Native bindings. It is
inspired by the routing and dependency injection patterns implemented in
`scripts/daftcitadel.sh`, which consolidate plugin search paths, GPU toggles, and user-aware
configuration. We reuse the same ideas by centralising sample-rate/transport configuration
inside the native `SceneGraph`, exposing deterministic scheduling to JavaScript.

```text
React Native (TypeScript) ── TurboModules ──> Platform Bridges (JNI / Objective-C++)
                                                │
                                                ▼
                                         C++ Core (audio-engine/)
```

The native module supports reusable DSP nodes, a bounded real-time scheduler, and automation
lanes that align to buffer boundaries for deterministic playback.

## Initialization Flow

1. **JavaScript bootstrap**: `AudioEngine` in `src/audio/AudioEngine.ts` validates that the
   TurboModule is loaded and calls `initialize(sampleRate, framesPerBuffer)`.
2. **Platform bridge**: Android and iOS both forward initialization to
   `AudioEngineBridge::initialize`, which allocates a `SceneGraph` configured with the actual
   render quantum supplied by React Native.
3. **Scene graph**: The graph primes DSP nodes with `prepare`, sizes stack-backed scratch
   buffers to the reported buffer length, and constructs a reusable topological ordering of the
   signal graph.
   Initialization rejects buffers larger than the engine's static capacity (1024 frames) so that
   real-time rendering always fits within the pre-allocated scratch space shared by both
   platforms.
4. **Automation**: When JavaScript publishes automation lanes, the TurboModule forwards each
   automation point to `SceneGraph::scheduleAutomation`, which queues callbacks in the bounded
   scheduler so parameter updates execute on the exact frame requested.

## Threading Model

| Thread          | Responsibilities                                                                                        | Real-time Constraints                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Audio render    | `SceneGraph::render` mixes connected nodes into an output buffer and drains the scheduler.              | Non-blocking try-lock guards against control mutations; render returns silence on contention. |
| Control / UI    | React Native publishes automation lanes, node configuration, and tempo changes via TurboModule methods. | Uses short-lived mutexes on mutation paths; render keeps playing even if a lock is contended. |
| Asset / tooling | Shell automation from `scripts/daftcitadel.sh` can prepare plugins and assets.                          | External to the engine; informs configuration defaults only.                                  |

The render thread attempts to acquire the bridge mutex with `std::try_to_lock`; on contention it
renders silence for the current quantum, preventing audio drop-outs caused by blocking locks.

## DSP Nodes and Routing

- `SineOscillatorNode` – phase-accurate oscillator with frequency parameter.
- `GainNode` – multiplicative gain stage, frequently scheduled for automation curves.
- `MixerNode` – collects upstream buffers into a summing bus.

Connections are stored as ordered `source → destination` pairs. Each render pass walks the
graph in topological order, accumulating upstream audio into per-node scratch buffers before
invoking `DSPNode::process`. To emit audio to the hardware output, connect a node to the
special destination `SceneGraph::kOutputBusId` (mirrored in TypeScript as `OUTPUT_BUS`). If no
explicit output is connected, sink nodes (those without outgoing edges) are mixed into the
final buffer as a fallback.

## Automation and Scheduling

- `StaticAutomationLane` (header-only) – lock-free ring buffer for control events.
- `RealTimeScheduler` – deterministic queue backed by a pre-allocated vector that executes
  callbacks when the render clock reaches the target frame.
- `ClockSyncService` (TypeScript) – converts tempo and buffer information into frame
  positions, ensuring UI automation remains buffer-aligned before being submitted to native
  code.

Unit tests in `src/audio/__tests__/automation.test.ts` guarantee buffer-accurate quantization
and sorted automation points.

## Extension Points

- **Custom DSP nodes**: Derive from `DSPNode`, implement `process`, and register via the
  bridge `addNode` helpers.
- **Platform services**: Extend the JNI/Objective-C++ bridges to expose diagnostics or
  hardware integration (e.g., Android AAudio or iOS AVAudioEngine backends).
- **Scheduling**: Use `SceneGraph::scheduleAutomation` to run arbitrary parameter updates at
  known frames; additional helpers can wrap more complex envelopes.

## Build and Testing

1. Install dependencies: `npm install`
2. Lint TypeScript surfaces: `npm run lint`
3. Run Jest tests: `npm test`
4. (Native) Configure CMake for host validation:

   ```bash
   cmake -S audio-engine -B audio-engine/build -DDAFT_AUDIO_ENGINE_BUILD_TESTS=ON
   cmake --build audio-engine/build
   ```

5. Integrate with React Native by registering the `AudioEngineModule` TurboModule on both
   mobile platforms (see the section below for specifics).

## React Native TurboModule bridge

- **iOS** – `native/audio/ios/AudioEngineModule.mm` conforms to `RCTBridgeModule` and
  `RCTTurboModule`, forwards every method in `src/audio/NativeAudioEngine.ts` to
  `daft::audio::bridge::AudioEngineBridge`, and surfaces diagnostics via `getRenderDiagnostics`.
  Add the source file plus the `audio-engine` headers to your Xcode target so that
  `TurboModuleRegistry.getEnforcing('AudioEngineModule')` resolves on-device.
- **Android** – `native/audio/android/src/main/java/com/daftcitadel/audio/AudioEngineModule.kt`
  implements the TurboModule interface and delegates to JNI helpers located under
  `native/audio/android/src/main/jni/AudioEngineModule.cpp`. The accompanying
  `CMakeLists.txt` builds a shared library named `daft_audio_engine_module` that links the
  core engine (`audio-engine/`) and exposes the TurboModule through
  `AudioEnginePackage`.
- **Unit tests** – `src/audio/__tests__/AudioEngineNative.test.ts` performs a smoke test that
  initializes the native module, adds a node, connects it to `OUTPUT_BUS`, and confirms the
  diagnostics contract. The React Native Jest mock (`__mocks__/react-native.ts`) has been
  extended to track TurboModule state to keep the test suite green.
