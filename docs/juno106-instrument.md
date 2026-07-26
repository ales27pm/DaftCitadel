# Juno-106 Instrument

Daft Citadel's Juno-106 is a persisted session instrument backed by the portable
C++ audio graph. The Performance screen can create and play it in a native
development or release build; web, Expo Go, and forced-passive builds retain the
session editing workflow without pretending that live synthesis is available.

## Ownership and signal path

The integration is split into narrow layers:

1. [`src/session/models.ts`](../src/session/models.ts) owns the persisted
   `instrumentType: 'juno106'` routing node, its parameter map and preset
   metadata, MIDI-only clips, and track automation curves. A Juno track routes
   MIDI input to the instrument and stereo instrument output to the track output.
2. [`src/ui/screens/JunoPerformancePanel.tsx`](../src/ui/screens/JunoPerformancePanel.tsx)
   owns Performance-screen interactions. Session actions persist edits; live
   controls send MIDI and parameter changes through the active audio bridge.
3. [`src/audio/SessionAudioBridge.ts`](../src/audio/SessionAudioBridge.ts)
   materializes the persisted graph, translates MIDI clips and supported
   automation into absolute-frame events, and exposes relative-frame live
   controls.
4. The iOS and Android module bridges validate names and payloads on their
   control threads, resolve graph nodes and parameters to stable numeric IDs,
   and publish fixed `RealtimeControlCommand` records through the shared
   [`RealtimeControlPlane`](../audio-engine/src/RealtimeControlPlane.cpp).
5. The control plane owns a preallocated 4,096-command SPSC queue. The C++ DSP
   render entrypoints drain it without mutexes, allocation, logging, I/O,
   JavaScript, or exception handling, then invoke
   [`SceneGraph`](../audio-engine/src/SceneGraph.cpp). Android performs the
   required blocking `AudioTrack.write` only after DSP rendering in its device
   driver; that render loop is separately kept free of logging and exception
   handling.
6. [`InstrumentNode`](../audio-engine/src/instruments/InstrumentNode.cpp) owns the
   fixed 1,024-event instrument timeline, while
   [`Juno106Node`](../audio-engine/src/instruments/juno/Juno106Node.cpp) translates
   events into the allocation-free render path in
   [`JunoDSPEngine`](../audio-engine/src/instruments/juno/JunoDSPEngine.cpp).

The engine supports note on/off, sustain, pitch bend, channel and polyphonic
aftertouch, all-notes-off, exact-frame parameter changes, polyphonic voice
stealing, LFO pitch modulation, and stereo chorus. A normal note release keeps
rendering the envelope and chorus history until their tails drain.

## Performance workflow

1. Open **Performance** and select **Add Juno**. This adds a routed, empty
   Juno-106 track to the current persisted session.
2. Hold a key on the 13-key touch keyboard to send note-on; release it to send
   note-off. A live note starts the native transport when needed. Use **All
   notes off** to release held notes explicitly.
3. Adjust the DCO, LFO, VCF, envelope, output, and chorus controls. Each edit is
   persisted first and is then sent to the live node when native controls are
   available.
4. Select **Init Juno**, **Neon Bass**, or **Soft Pad** to apply a versioned
   built-in preset. Editing an individual parameter changes the patch back to a
   custom patch.

MIDI-only clips do not require an audio file. Their beat-relative notes are
converted to absolute transport frames from the session tempo. Automation curve
names matching a Juno parameter, with or without the `instrument.` prefix, are
scheduled at their exact millisecond-derived frames; `filter.cutoff` remains a
supported alias for `cutoffHz`. Locating the transport clears the native queue
and reapplies the persisted instrument schedule.

Each instrument node accepts at most 1,024 queued MIDI and parameter events in
total. The JavaScript bridge rejects an oversized combined schedule before
sending it, and the C++ node uses the same fixed capacity without growing memory
on the render path. The outer realtime command queue is independently bounded at
4,096 commands and rejects overflow atomically. Split denser arrangements across
instrument tracks or reduce their event count instead of raising either realtime
bound casually.

## Realtime control invariants

P8a establishes the following portable invariants:

- node names and readable parameter names are resolved before crossing the
  realtime boundary;
- numeric node handles are monotonic and never reused, so a delayed command
  cannot target a replacement node that happens to reuse the same string ID;
- live MIDI, parameters, locate, transport-loop changes, all-notes-off, and panic
  use a fixed SPSC queue with atomic batch publication;
- the iOS source-node callback, iOS and Android DSP bridges, Android device render
  loop, and common render entrypoint contain no mutex acquisition, logging,
  `try`/`catch`, explicit allocation, or `std::function` dispatch; the device
  driver retains only the required `AudioTrack.write` operation;
- add/remove/connect/disconnect are rejected while transport is playing;
  `GraphReconciler` serializes structural mutations, pauses playback, captures
  the stopped frame, and resumes only after a successful rebuild;
- plugin render callbacks are declared `noexcept`; unavailable or failed plugin
  renders increment atomics rather than logging from the audio thread;
- diagnostics use lock-free atomics and include active voices, pending instrument
  events, realtime queue depth and overflows, command failures, xruns, render
  count, average/max duration, and p50/p95/p99 histogram estimates.

The control-plane tests run a concurrent producer against render callbacks at
48 kHz with both 128- and 256-frame buffers. They exercise note on/off, sustain,
pitch bend, channel/poly aftertouch, parameter commands, panic, deliberate queue
saturation, stale graph publication tokens, finite output, and clean voice/event
drain. Optimized non-sanitized builds enforce p99 below 70% of the corresponding
buffer budget and zero xruns; sanitizer builds validate safety without being
used as performance evidence.

## Presets, SysEx, and storage

The session package exports the following strict APIs:

- `parseJuno106SysExMessage` accepts exactly one 25-byte Roland Juno-106
  message. `parseJuno106SysExBank` accepts at most 128 consecutive messages
  (3,200 bytes).
- Both parsers require `F0 41` framing, an `F7` terminator, 7-bit data fields,
  the pinned slider/switch layout, and a valid Roland checksum. Malformed or
  oversized input is rejected before mapping.
- `mapJuno106SysExPatchToPreset`, `validateJuno106Preset`,
  `serializeJuno106Preset`, and `deserializeJuno106Preset` produce and validate
  the versioned `daftcitadel.juno106-preset` record. A serialized record is
  limited to 4,096 UTF-8 bytes.
- `Juno106PresetStore` provides `save`, `load`, `list`, `delete`, and atomic
  `importSysEx` operations. It uses AsyncStorage by default or an injected
  `Juno106PresetStorageBackend`, and stores at most 128 presets per validated
  namespace.

The Performance screen currently exposes the built-in presets. The SysEx and
user-preset storage APIs are programmatic session APIs; there is no file picker
or hardware SysEx capture UI in this screen.

## Native availability and shutdown

Native synthesis requires the local `AudioEngineModule`, so it is unavailable
in Expo Go and on web. If native initialization or the sample loader fails,
`SessionAppProvider` falls back to the passive bridge. Set
`EXPO_PUBLIC_DAFT_CITADEL_USE_NATIVE_BRIDGE=false` to force that fallback in a
custom client. The Performance screen then shows **NATIVE UNAVAILABLE**, keeps
patch and preset persistence functional, and disables the keyboard; passive
transport behavior is not audio-render evidence.

The keyboard cleanup path sends all-notes-off, which follows the instrument's
musical release behavior. Transport stop is deliberately stronger: the control
thread stops graph publication, waits for any in-flight callback, resets voices
and effect history, and discards queued transient commands before returning.
This prevents stale gestures and stuck notes without taking a mutex in the audio
callback. Moving the app from active to an inactive or background state stops
transport through the same path. Returning to the foreground does not
auto-resume playback.

## Validation

Run the JavaScript, session, UI, and portable native checks from the repository
root:

```bash
npm run format:check
npm run lint -- --quiet
npm run typecheck
npm run test:ci
npm run native:core:test:direct
npm run native:core:test:direct:sanitize
npm run native:core:test
npm run native:core:test:sanitize
npm run export:web
```

The native test output includes `REALTIME_CONTROL_P99_US` records for 128 and
256 frames. Use an optimized CMake build for the enforced 70%-budget gate:

```bash
cmake -S audio-engine -B audio-engine/build-release \
  -DDAFT_AUDIO_ENGINE_BUILD_TESTS=ON \
  -DCMAKE_BUILD_TYPE=Release
cmake --build audio-engine/build-release --parallel
ctest --test-dir audio-engine/build-release --output-on-failure
```

`npm run verify` is the broader local gate (Expo Doctor, formatting, lint,
types, Jest, managed-doc checks, production dependency audit, shell syntax, and
the native core). `npm run verify:sanitize` runs the same gate with ASan/UBSan.

Compile the checked-in platform hosts only on machines with the documented SDKs:

```bash
(cd android && ./gradlew app:assembleDebug)
(cd ios && pod install && xcodebuild \
  -workspace DaftCitadel.xcworkspace \
  -scheme DaftCitadel \
  -sdk iphonesimulator \
  -configuration Debug \
  CODE_SIGNING_ALLOWED=NO build)
```

## P8b physical-device validation

Portable tests, sanitizers, simulator compilation, and web export do **not**
prove physical-device behavior. P8b is the proof stage and must record each claim:

- Real traces on physical iPhone and Android hardware (Instrumentations / Time Profiler
  for iOS; Perfetto and/or Simpleperf for Android).
- Dedicated lifecycle scenarios (route switch, interruption, background/foreground,
  peripheral changes) in a controlled, repeated sequence.
- `xruns` and render duration percentiles (`p50`/`p95`/`p99`) from on-device
  diagnostics in sustained playback.
- Exact device metadata: OS/build, package/app name, sample rate, buffer size,
  transport BPM/sleep state, route, duration, and battery/thermal conditions.

Use the dedicated protocol and evidence checklist here:

- [P8b physical-device validation](./p8b-physical-device-validation.md)

When reporting completion, attach command transcripts and logs for every scenario
and device so future readers can reproduce the same checks.
