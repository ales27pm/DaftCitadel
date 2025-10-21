# Audio Engine Architecture

## Overview

The audio engine couples a real-time safe C++ DSP core with React Native bindings. It is
inspired by the routing and dependency injection patterns implemented in
`scripts/daftcitadel.sh`, which consolidate plugin search paths, GPU toggles, and user-aware
configuration. We reuse the same ideas by centralising sample-rate/transport configuration
inside the native `SceneGraph`, exposing deterministic scheduling to JavaScript.

```
React Native (TypeScript) ── TurboModules ──> Platform Bridges (JNI / Objective-C++)
                                                │
                                                ▼
                                         C++ Core (audio-engine/)
```

The native module supports reusable DSP nodes, a lock-free scheduler, and automation lanes
that align to buffer boundaries for deterministic playback.

## Initialization Flow

1. **JavaScript bootstrap**: `AudioEngine` in `src/audio/AudioEngine.ts` validates that the
   TurboModule is loaded, then calls `initialize(sampleRate, framesPerBuffer)`.
2. **Platform bridge**: Android calls `AudioEngineBridge::initialize`, iOS invokes the same
   static method from Objective-C++. Both allocate a `SceneGraph` that preps DSP nodes at the
   requested sample rate.
3. **Scene graph**: The graph primes DSP nodes with `prepare`, sets the initial tempo and
   allocates a stack-based scratch buffer sized to the render quantum (default 128 frames).
4. **Automation**: When JavaScript publishes automation lanes, the TurboModule forwards each
   entry to `SceneGraph::scheduleAutomation`, which queues the callback in the lock-free
   scheduler.

## Threading Model

| Thread          | Responsibilities                                                                                        | Real-time Constraints                                               |
| --------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Audio render    | `SceneGraph::render` mixes connected nodes into an output buffer and drains the scheduler.              | No dynamic allocation; lock-free queues ensure bounded work.        |
| Control / UI    | React Native publishes automation lanes, node configuration, and tempo changes via TurboModule methods. | Uses mutex-protected bridge objects; never blocks the audio thread. |
| Asset / tooling | Shell automation from `scripts/daftcitadel.sh` can prepare plugins and assets.                          | External to the engine; informs configuration defaults only.        |

The render thread never locks user-facing mutexes. Control APIs acquire a bridge-level mutex
once per transaction to mutate the scene graph safely.

## DSP Nodes and Routing

- `SineOscillatorNode` – phase-accurate oscillator with frequency parameter.
- `GainNode` – multiplicative gain stage, frequently scheduled for automation curves.
- `MixerNode` – collects upstream buffers into a summing bus.

Connections are stored as ordered `source → destination` pairs. The renderer walks the
connections in insertion order, clearing a stack-based scratch buffer for each pass before
accumulating into the destination.

## Automation and Scheduling

- `StaticAutomationLane` (header-only) – lock-free ring buffer for control events.
- `RealTimeScheduler` – deterministic queue that executes callbacks when the render clock
  reaches the target frame.
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

5. Integrate with React Native by registering a TurboModule named `AudioEngineModule` that
   calls into the provided bridge methods.
