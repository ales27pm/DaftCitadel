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
   `AudioEngineBridge::initialize`, which allocates a `SceneGraph` configured with the render
   quantum supplied by React Native. Android then starts its priority `AudioTrack` render thread.
   iOS defers `AVAudioSession` activation and `AVAudioEngine` construction until the user starts
   transport, so application launch does not claim an audio route before playback is requested.
3. **Scene graph**: The graph primes DSP nodes with `prepare`, sizes stack-backed scratch
   buffers to the reported buffer length, and constructs a reusable topological ordering of the
   signal graph.
   Initialization rejects buffers larger than the engine's static capacity (1024 frames) so that
   real-time rendering always fits within the pre-allocated scratch space shared by both
   platforms.
4. **Automation**: When JavaScript publishes automation lanes, the TurboModule forwards each
   automation point to `SceneGraph::scheduleAutomation`, which queues callbacks in the bounded
   scheduler so parameter updates execute on the exact frame requested.

## Build Prerequisites

Before running the React Native shell against the native engine ensure the runtime matches the
assumptions baked into `createProductionSessionEnvironment`:

- **Sample rate** – The production bridge requests 48 kHz. The iOS driver configures
  `AVAudioSession`; Android builds a floating-point stereo `AudioTrack` and rejects unsupported
  device formats instead of silently starting a mismatched engine.
- **Frames per buffer** – Both mobile platforms target a 256-frame render quantum. Device buffers
  are bounded by the C++ engine's static capacity and all render scratch storage is allocated
  before the callback or render loop starts.
- **Error handling** – If the device cannot satisfy the requested configuration the JavaScript
  bootstrap shuts down any partially initialized engine and falls back to a passive environment.
  A missing native engine or sample loader follows the same path. Keep the native logging
  (`os_log` / Logcat) enabled so configuration mismatches can be diagnosed during bring-up.
  The iOS bridge catches Objective-C framework exceptions at the Promise boundary and reports the
  failing AVFoundation phase as a normal rejection; no native exception may escape into React
  Native's asynchronous TurboModule dispatcher.
- **First-launch session** – Persistent production and passive environments create an empty
  `Untitled Session`. The richer demo fixture references development-only sample paths and is
  intentionally limited to the explicit demo environment, so a clean mobile install never starts
  with unresolved WAV files.
- **Installer metadata** – Run `scripts/daftcitadel.sh` so the runtime emits
  `~/DaftCitadel/citadel_profile.json` and `~/DaftCitadel/plugin_cache_hints.json`. The TypeScript
  session environment reads these files to preload plugin caches and align sample directories with
  the expectations baked into the native audio bridge.

## Threading Model

| Thread          | Responsibilities                                                                                        | Real-time Constraints                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Audio render    | `SceneGraph::render` mixes connected nodes into an output buffer and drains the scheduler.              | Non-blocking try-lock guards against control mutations; render returns silence on contention. |
| Control / UI    | React Native publishes automation lanes, node configuration, and tempo changes via TurboModule methods. | Uses short-lived mutexes on mutation paths; render keeps playing even if a lock is contended. |
| Asset / tooling | Shell automation from `scripts/daftcitadel.sh` can prepare plugins and assets.                          | External to the engine; informs configuration defaults only.                                  |

The render thread attempts to acquire the bridge mutex with `std::try_to_lock`; on contention it
renders silence for the current quantum, preventing audio drop-outs caused by blocking locks.
Device teardown always stops and joins/detaches the platform callback before destroying the C++
graph, including React Native invalidation and fast-refresh lifecycles.
On iOS, device lifecycle work is serialized on a dedicated audio-control queue; the real-time
render callback remains owned by `AURemoteIO` and never runs on that control queue.

## DSP Nodes and Routing

- `SineOscillatorNode` – phase-accurate oscillator with frequency parameter.
- `GainNode` – multiplicative gain stage, frequently scheduled for automation curves.
- `MixerNode` – collects upstream buffers into a summing bus.
- `TrackOutputNode` – applies the track's dB-derived gain, pan, mute, and solo state.
- `ClipPlayerNode` – resolves registered planar PCM buffers without retaining JavaScript memory.

Connections are stored as ordered `source → destination` pairs. Each render pass walks the
graph in topological order, accumulating upstream audio into per-node scratch buffers before
invoking `DSPNode::process`. To emit audio to the hardware output, connect a node to the
special destination `SceneGraph::kOutputBusId` (mirrored in TypeScript as `OUTPUT_BUS`). If no
explicit output is connected, sink nodes (those without outgoing edges) are mixed into the
final buffer as a fallback.

Enabled audio routes must be acyclic. Session validation rejects feedback cycles before a
transition is staged, and `SceneGraph::connect` independently refuses self-cycles or edges that
would close a longer cycle. A routing connection's optional `gain` defaults to unity; non-unity
values are realised as stable native `GainNode` stages between the source and destination so the
persisted routing contract matches rendered output.

## Automation and Scheduling

- `StaticAutomationLane` (header-only) – lock-free ring buffer for control events.
- `RealTimeScheduler` – deterministic queue backed by a pre-allocated vector that executes
  callbacks when the render clock reaches the target frame.
- `ClockSyncService` (TypeScript) – converts tempo and buffer information into frame
  positions, ensuring UI automation remains buffer-aligned before being submitted to native
  code.

Unit tests in `src/audio/__tests__/automation.test.ts` guarantee buffer-accurate quantization
and sorted automation points. Scheduled callbacks resolve a node by ID and incarnation at dispatch
time, so removing or replacing a node cannot leave a dangling pointer in the scheduler.

## Clip Buffer Registry

Audio clips used by native playback nodes are registered explicitly so the real-time render
thread never touches React Native memory. The flow is:

1. Prepare Float32 PCM channel data on the JavaScript side and call
   `AudioEngine.uploadClipBuffer(bufferKey, sampleRate, channels, frames, channelData)`.
   The method validates payload size and forwards the request to
   `NativeAudioEngine.registerClipBuffer`.
2. Platform bridges (`native/audio/ios/AudioEngineModule.mm` and
   `native/audio/android/src/main/java/com/daftcitadel/audio/AudioEngineModule.kt`) copy the
   channel data into native heap storage and register it with
   `daft::audio::bridge::AudioEngineBridge::registerClipBuffer`.
   The legacy React Native boundary transports each contiguous channel as base64-encoded
   Float32 PCM. iOS decodes it into immutable `std::vector<float>` storage; Android normalises it
   into `FloatArray` slices before crossing the JNI boundary. This explicit wire shape avoids
   platform-dependent `ArrayBuffer` coercion in legacy module interop.
3. The bridge exposes `AudioEngineBridge::clipBufferForKey` so future clip playback nodes can
   resolve the metadata and channel spans without re-copying data across language boundaries.
4. When a clip is removed from the session graph, `ClipBufferCache` decrements its reference count
   and calls `AudioEngine.releaseClipBuffer`, which forwards to
   `NativeAudioEngine.unregisterClipBuffer`. The native bridge tracks per-buffer reference counts
   and frees the associated heap allocation once the last reference has been released.

The Jest harness (`src/audio/__tests__/AudioEngineNative.test.ts`) now uploads a clip buffer
before configuring playback nodes to guarantee coverage of the new registration path and the
React Native mock in `__mocks__/react-native.ts` mirrors the native registry for deterministic
tests.

## Extension Points

- **Custom DSP nodes**: Derive from `DSPNode`, implement `process`, and register via the
  bridge `addNode` helpers.
- **Platform services**: Extend the existing Android `AudioTrack` or iOS `AVAudioEngine` drivers
  to expose route changes, interruptions, and hardware diagnostics.
- **Scheduling**: Use `SceneGraph::scheduleAutomation` to run arbitrary parameter updates at
  known frames; additional helpers can wrap more complex envelopes.

The current graph exposes one main audio bus. MIDI and sidechain routing edges are explicitly
warned and skipped until dedicated native buses land. AUv3/VST host discovery is wired, but a
production plugin render callback still needs to be registered with the device path before plugin
DSP can contribute to that main bus.

## Build and Testing

1. Install dependencies: `npm install`
2. Lint TypeScript surfaces: `npm run lint`
3. Run Jest tests: `npm test`
4. (Native) Configure CMake for host validation:

   ```bash
   cmake -S audio-engine -B audio-engine/build -DDAFT_AUDIO_ENGINE_BUILD_TESTS=ON
   cmake --build audio-engine/build
   ```

5. Regenerate the Expo native hosts with `npm run prebuild`; the local module and config plugin
   register the bridge on both platforms.

## React Native TurboModule bridge

- **iOS** – `native/audio/ios/AudioEngineModule.mm` conforms to `RCTBridgeModule` and
  `RCTTurboModule`, forwards every method in `src/audio/NativeAudioEngine.ts` to
  `daft::audio::bridge::AudioEngineBridge`, and surfaces diagnostics via `getRenderDiagnostics`.
  `DaftCitadelNative.podspec` compiles those sources and the
  device driver into the generated Xcode workspace.
- **Android** – `native/audio/android/src/main/java/com/daftcitadel/audio/AudioEngineModule.kt`
  implements the TurboModule interface and delegates to JNI helpers located under
  `native/audio/android/src/main/jni/AudioEngineModule.cpp`. The accompanying
  `CMakeLists.txt` builds a shared library named `daft_audio_engine_module` that links the
  core engine (`audio-engine/`) and exposes the TurboModule through `AudioEnginePackage`, which
  the Expo config plugin inserts into `MainApplication`.
- **Unit tests** – `src/audio/__tests__/AudioEngineNative.test.ts` performs a smoke test that
  initializes the native module, adds a node, connects it to `OUTPUT_BUS`, and confirms the
  diagnostics contract (including the aggregate `clipBufferBytes` field surfaced by
  `getRenderDiagnostics`). The React Native Jest mock (`__mocks__/react-native.ts`) has been
  extended to track TurboModule state to keep the test suite green.
