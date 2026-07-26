Manual command notes:

Android
- Perfetto (manual):
  - adb shell perfetto -o /data/misc/perfetto-traces/p8b-$(date -u +%Y%m%d-%H%M%S).pftrace -t 120000 -c -
- Simpleperf (manual):
  - adb shell pidof <package>
  - adb shell simpleperf record --app <package> --duration 120 -g -o /data/local/tmp/p8b-$(date -u +%Y%m%d-%H%M%S).perf.data

Scenario playbook (manual):
1. Baseline capture:
   - start transport and keep playback running for 90 s
   - capture XRuns/p50/p95/p99 at the end
2. Route change:
   - switch between speaker and wired/wireless outputs (2 transitions minimum)
   - keep each route active for 45 s
3. Interruption simulation:
   - trigger temporary audio focus loss
   - verify recovery to steady playback and re-check diagnostics
4. Background/foreground:
   - home-button/background (or adb keyevent KEYCODE_HOME) for 45 s
   - return to app and resume playback, then capture diagnostics
5. Sustained return-to-baseline:
   - continue playback another 120 s
   - capture final XRuns and percentile stats

During each scenario, record:
- XRuns
- p50RenderDurationMicros
- p95RenderDurationMicros
- p99RenderDurationMicros
- render load / clipBufferBytes / memory trend
