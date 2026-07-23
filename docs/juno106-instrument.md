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
4. The iOS and Android module bridges validate and forward compact event payloads
   to [`SceneGraph`](../audio-engine/src/SceneGraph.cpp).
5. [`InstrumentNode`](../audio-engine/src/instruments/InstrumentNode.cpp) owns the
   fixed event queue, while
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
on the render path. Split denser arrangements across instrument tracks or reduce
their event count instead of raising the realtime bound casually.

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
musical release behavior. Transport stop is deliberately stronger: both native
bridges call `SceneGraph::panicInstruments()`, immediately resetting voices and
effect history before silencing render output. Panic discards queued transient
live-input events while retaining persisted timeline events for transport
restart. Moving the app from active to an inactive or background state stops
transport through the same path, preventing stuck notes. Returning to the
foreground does not auto-resume playback.

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

These commands validate compilation, not physical-device audio output, route
changes, latency, or interruption recovery. Record those separately when they
are exercised on iOS or Android hardware; do not infer device evidence from a
portable test, simulator build, or web export.
