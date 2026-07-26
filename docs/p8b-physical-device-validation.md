# P8b — Physical-device validation protocol (Issue #70)

This protocol defines the minimum evidence needed before P8b is marked complete.

## Scope and pass criteria

- Route changes, interruption handling, background/foreground transitions, and
  peripheral changes are executed on physical hardware.
- Diagnostics are collected for sustained sessions and include `xruns`, `p50`,
  `p95`, and `p99`.
- Regressions are called out if any scenario increases xruns, drops below target
  render percentiles, or introduces sustained memory growth while active.

## 1) Baseline capture setup

```bash
git status
./scripts/p8b-physical-device-validation.sh --help
```

- Device connected and unlocked.
- App installed in a debug/release variant with native diagnostics enabled.
- Route set to a known baseline and sample rate set intentionally (for example 48 kHz, 256 buffer).
- Keep this metadata for every run:
  - Device model + OS version
  - App/package name and build variant
  - sample rate + buffer size
  - route at baseline
  - temperature/throttling notes

## 2) iOS physical capture

1. Collect packet or app-level logs:

   ```bash
   scripts/rvictl-capture.sh -u <udid> -o artifacts/p8b-ios-$(date +%Y%m%d-%H%M%S).pcap -d 600
   ```

2. Run Instruments / Time Profiler and Allocations:

   - Time Profiler on the audio process during continuous playback.
   - Allocations during a 5–10 minute sustained run at the chosen buffer size.
   - Confirm zero growth in sustained allocator paths and no lock-based stalls in callback.

3. Lifecycle scenarios (at least once each, in this order):

   - Route change
   - Headset/case peripheral changes
   - Incoming call / interruption
   - Home-button/background → reopen foreground
   - Stop/start transport and `locate` transitions

4. Record evidence:

   - Keep screenshots and trace exports for each scenario.
   - Record `xruns` and render percentiles from app diagnostics.
   - Export a short excerpt showing `activeVoices`, queue metrics, and diagnostics.

## 3) Android physical capture

1. Start capture helper on the device:

   ```bash
   scripts/p8b-physical-device-validation.sh --platform android \
     --android-package <your.package.id> \
     --duration 600 \
     --collect-memory
   ```

2. Run one full lifecycle loop:

   - Baseline playback + route switch (speaker/headset/wired).
   - Interruption simulation (call UI interruption or media focus loss if available).
   - Background/foreground transition with app brought back to active state.
   - Return to playback with sustained transport.

3. Capture platform traces:

   - `perfetto` during lifecycle transitions for scheduler/audio slices.
   - `simpleperf` profile during sustain for CPU hotspots and scheduling latency.

4. Record evidence:

   - `adb logcat` or equivalent capture for app diagnostics tags.
   - Trace exports for both lifecycle and sustained scenarios.
   - `xruns` and `p50/p95/p99` values at end of each scenario.

## 4) Required evidence artifact checklist

- [ ] iOS session traces captured and stored (Time Profiler + Allocations).
- [ ] Android Perfetto/Simpleperf traces captured and stored.
- [ ] Route/interruption/background/peripheral scenarios executed end-to-end.
- [ ] Diagnostic snapshot for each scenario includes:
  - `xruns`
  - `p50RenderDurationMicros`
  - `p95RenderDurationMicros`
  - `p99RenderDurationMicros`
  - memory or clip-buffer footprint
- [ ] Device metadata and command transcript committed with findings.

## Commands for repeatability

- Re-runable capture helper:
  - `scripts/p8b-physical-device-validation.sh --platform android --android-package ...`
  - `scripts/p8b-physical-device-validation.sh --platform ios --ios-device-udid ...`
- Native diag polling target:
  - `AudioEngine.getRenderDiagnostics()` should report queue depth, xruns, and percentiles
    when called during the scenario.
