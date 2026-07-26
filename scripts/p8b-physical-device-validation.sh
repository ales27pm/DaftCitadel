#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/p8b-physical-device-validation.sh --platform <android|ios> [options]

Options:
  --platform <android|ios>          Validation platform target.
  --android-package <package>        Android app package (android only).
  --android-device <adb-id>          Android device id for adb target (android only).
  --ios-device-udid <udid>          iOS device udid (ios only).
  --ios-bundle-id <bundle-id>        Optional iOS bundle identifier for trace labels.
  --duration <seconds>              Capture duration for automated collectors (default: 120).
  --output-dir <path>               Output folder for traces and command scripts.
  --collect-memory                  Include periodic Android meminfo sampling (android only).
  --no-logcat                       Skip adb logcat collection.
  --help                            Show this help message.

Examples:
  scripts/p8b-physical-device-validation.sh --platform android --android-package com.example.app
  scripts/p8b-physical-device-validation.sh --platform ios --ios-device-udid 00008030-001C195E26A2002E
USAGE
}

ensure_command() {
  local command_name=$1
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "error: required command '$command_name' not found" >&2
    exit 1
  fi
}

resolve_android_device() {
  local requested_device=${1:-}
  if [[ -n "$requested_device" ]]; then
    adb -s "$requested_device" get-state >/dev/null
    echo "$requested_device"
    return
  fi

  local connected_devices
  connected_devices=$(adb devices | awk '$2=="device"{print $1}')
  if [[ -z "$connected_devices" ]]; then
    echo "error: no connected adb devices found" >&2
    exit 1
  fi
  local device_count
  device_count=$(printf '%s\n' "$connected_devices" | grep -c .)
  if [[ "$device_count" -gt 1 ]]; then
    echo "error: multiple adb devices connected; set --android-device" >&2
    echo "$connected_devices" >&2
    exit 1
  fi
  echo "$connected_devices"
}

write_manual_trace_commands() {
  local out_file=$1
  local platform=$2
  if [[ "$platform" == "ios" ]]; then
    cat <<'EOF' >"$out_file"
Manual command notes:

iOS
- Instruments (Time Profiler): profile DaftCitadel audio process on-device for sustained playback.
- Allocations: run repeated route/interruption/background scenarios and monitor retained bytes.
- Keep XRuns and p50/p95/p99 from JS diagnostics in playback logs during each scenario.

Scenario playbook:
1. Baseline capture:
   - start transport and keep playback running for 90 s.
   - capture XRuns/p50/p95/p99 at the end.
2. Route change:
   - switch between speaker/headset at least twice.
   - keep each route active for 45 s and capture diagnostics.
3. Interruption:
   - trigger interruption (system alert / incoming call workflow) and resume audio.
   - capture diagnostics after resume.
4. Background/foreground:
   - background app for 45 s, reopen, resume playback.
   - capture diagnostics.

During each scenario, record:
- XRuns
- p50RenderDurationMicros
- p95RenderDurationMicros
- p99RenderDurationMicros
- clipBufferBytes
- activeVoices
- realtimeQueueDepth / overflows / failures
EOF
    return
  fi

  cat <<'EOF' >"$out_file"
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
EOF
}

write_ios_capture_commands() {
  local out_file=$1
  local output_dir=$2
  local ios_device_udid=$3
  local ios_bundle_id=$4
  local duration=$5

  cat <<'EOF' >"$out_file"
#!/usr/bin/env bash
set -euo pipefail

PCAP_OUT="${output_dir}/ios-traffic.pcap"
TRACE_OUT_PREFIX="${output_dir}/ios"

scripts/rvictl-capture.sh -u "${ios_device_udid}" -o "$PCAP_OUT" -d "${duration}"

xcrun xctrace record \
  --template "Time Profiler" \
  --device "${ios_device_udid}" \
  --target "${ios_bundle_id}" \
  --launch \
  --output "${TRACE_OUT_PREFIX}-time-profiler.trace"

xcrun xctrace record \
  --template "Allocations" \
  --device "${ios_device_udid}" \
  --target "${ios_bundle_id}" \
  --launch \
  --output "${TRACE_OUT_PREFIX}-allocations.trace"
EOF
}

write_android_capture_commands() {
  local out_file=$1
  local output_dir=$2
  local device_id=$3
  local android_package=$4
  local duration=$5

  cat <<'EOF' >"$out_file"
#!/usr/bin/env bash
set -euo pipefail

PERFETTO_LOCAL_DIR="/data/misc/perfetto-traces"
PERFETTO_REMOTE_TRACE="$PERFETTO_LOCAL_DIR/p8b-physical.trace"
PERFETTO_REMOTE_CONFIG="$PERFETTO_LOCAL_DIR/p8b-config.pbtxt"
PERFETTO_REMOTE_LOG="/data/local/tmp/perfetto.log"
SIMPLEPERF_REMOTE_OUT="/data/local/tmp/p8b-simpleperf.data"
PERFETTO_CONFIG="${output_dir}/perfetto-config.pbtxt"
PERFETTO_TRACE="${output_dir}/p8b-physical.trace"
SIMPLEPERF_OUT="${output_dir}/p8b-simpleperf.perf.data"
MEMINFO_OUT="${output_dir}/android-meminfo.log"

cat <<'CFG' > "$PERFETTO_CONFIG"
buffers {
  size_kb: 8192
  fill_policy: RING_BUFFER
}
data_sources {
  config {
    name: "track_event"
  }
}
CFG

adb -s "${device_id}" shell mkdir -p "$PERFETTO_LOCAL_DIR"
adb -s "${device_id}" push "$PERFETTO_CONFIG" "$PERFETTO_LOCAL_DIR/p8b-config.pbtxt"

adb -s "${device_id}" shell nohup "perfetto -c $PERFETTO_LOCAL_DIR/p8b-config.pbtxt -o $PERFETTO_LOCAL_DIR/p8b-physical.trace > /data/local/tmp/perfetto.log 2>&1" >/dev/null 2>&1
sleep 2

adb -s "${device_id}" shell simpleperf record --app "${android_package}" --duration "${duration}" -g -o "$SIMPLEPERF_REMOTE_OUT"
echo "Perfetto command running in background: remote trace will be at $PERFETTO_REMOTE_TRACE"
echo "Simpleperf output remote path: $SIMPLEPERF_REMOTE_OUT"

adb -s "${device_id}" pull "$PERFETTO_LOCAL_DIR/p8b-physical.trace" "$PERFETTO_TRACE"
adb -s "${device_id}" pull "/data/local/tmp/p8b-simpleperf.data" "$SIMPLEPERF_OUT"

adb -s "${device_id}" shell "rm $PERFETTO_LOCAL_DIR/p8b-config.pbtxt $PERFETTO_LOCAL_DIR/p8b-physical.trace /data/local/tmp/p8b-simpleperf.data $PERFETTO_REMOTE_LOG 2>/dev/null || true"
EOF
}

write_diagnostics_sheet() {
  local output_dir=$1
  cat <<'EOF' > "$output_dir/p8b-diagnostics-template.csv"
scenario,start_utc,end_utc,xruns,p50RenderDurationMicros,p95RenderDurationMicros,p99RenderDurationMicros,activeVoices,realtimeQueueDepth,realtimeQueueOverflows,realtimeCommandFailures,clipBufferBytes,notes
baseline,,,,,,,,,,,, 
route_change,,,,,,,,,,,, 
interruption,,,,,,,,,,,, 
background,,,,,,,,,,,, 
return_to_baseline,,,,,,,,,,,, 
EOF
}

collect_android_memory() {
  local device_id=$1
  local package_id=$2
  local output_dir=$3
  local interval=5

  local pid_file="$output_dir/android-meminfo.pid"
  local mem_file="$output_dir/android-meminfo.log"
  {
    while :; do
      local now
      now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      printf '[%s] ' "$now"
      adb -s "$device_id" shell dumpsys meminfo "$package_id" | sed -n '1,60p' | tr '\n' '|' 
      printf '\n'
      sleep "$interval"
    done
  } >"$mem_file" &
  echo $! > "$pid_file"
}

main() {
  local platform=""
  local android_package=""
  local android_device=""
  local ios_device_udid=""
  local ios_bundle_id="com.daftcitadel"
  local duration=120
  local output_dir="artifacts/p8b-physical-device-validation-$(date -u +%Y%m%d-%H%M%S)"
  local collect_memory=0
  local skip_logcat=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --platform)
        platform=$2
        shift 2
        ;;
      --android-package)
        android_package=$2
        shift 2
        ;;
      --android-device)
        android_device=$2
        shift 2
        ;;
      --ios-device-udid)
        ios_device_udid=$2
        shift 2
        ;;
      --ios-bundle-id)
        ios_bundle_id=$2
        shift 2
        ;;
      --duration)
        duration=$2
        shift 2
        ;;
      --output-dir)
        output_dir=$2
        shift 2
        ;;
      --collect-memory)
        collect_memory=1
        shift 1
        ;;
      --no-logcat)
        skip_logcat=1
        shift 1
        ;;
      --help)
        usage
        exit 0
        ;;
      *)
        echo "error: unknown option '$1'" >&2
        usage
        exit 1
        ;;
    esac
  done

  if [[ -z "$platform" ]]; then
    echo "error: --platform is required" >&2
    usage
    exit 1
  fi

  mkdir -p "$output_dir"
  write_diagnostics_sheet "$output_dir"
  write_manual_trace_commands "$output_dir/manual-commands.md" "$platform"

  if [[ "$platform" == "ios" ]]; then
    if [[ -z "$ios_device_udid" ]]; then
      echo "error: --ios-device-udid is required for ios platform" >&2
      exit 1
    fi
    ensure_command xcrun
    if [[ ! -x scripts/rvictl-capture.sh ]]; then
      echo "warning: scripts/rvictl-capture.sh is not executable; install permissions or run manually" >&2
    fi
    write_ios_capture_commands \
      "$output_dir/capture-commands.sh" \
      "$output_dir" \
      "$ios_device_udid" \
      "$ios_bundle_id" \
      "$duration"
  cat <<MSG > "$output_dir/platform-commands.md"
Run iOS capture manually:
- scripts/rvictl-capture.sh -u $ios_device_udid -o "$output_dir/ios-traffic.pcap" -d $duration
- Instruments: Time Profiler + Allocations during scenarios in docs/p8b-physical-device-validation.md
Optional: --ios-bundle-id=$ios_bundle_id
Fill diagnostics from each scenario in: $output_dir/p8b-diagnostics-template.csv
Run `bash \"$output_dir/capture-commands.sh\"` to launch the default capture sequence.
MSG
    echo "Prepared iOS validation command templates in $output_dir."
    exit 0
  fi

  if [[ "$platform" != "android" ]]; then
    echo "error: unsupported platform '$platform'. Use android or ios." >&2
    exit 1
  fi

  ensure_command adb
  if [[ -z "$android_package" ]]; then
    echo "error: --android-package is required for android platform" >&2
    exit 1
  fi

  local device_id
  device_id=$(resolve_android_device "$android_device")
  adb -s "$device_id" shell "pidof $android_package" >/dev/null
  if ! adb -s "$device_id" shell "pm list packages | grep -q \"^package:$android_package$\"" ; then
    echo "error: package '$android_package' is not installed on $device_id" >&2
    exit 1
  fi

cat <<MSG > "$output_dir/platform-commands.md"
Run Android lifecycle scenarios from docs/p8b-physical-device-validation.md with:
- device: $device_id
- package: $android_package
- duration_seconds: $duration
- diagnostics_sheet: $output_dir/p8b-diagnostics-template.csv
- capture script: $output_dir/capture-commands.sh

Manual trace commands saved in this folder:
- manual-commands.md
MSG

  write_android_capture_commands \
    "$output_dir/capture-commands.sh" \
    "$output_dir" \
    "$device_id" \
    "$android_package" \
    "$duration"

  local logcat_pid=""
  local mem_pid_file=""

  cleanup() {
    if [[ -n "${logcat_pid:-}" ]]; then
      kill "$logcat_pid" >/dev/null 2>&1 || true
      wait "$logcat_pid" 2>/dev/null || true
    fi
    if [[ -n "${mem_pid_file:-}" ]]; then
      local pid
      pid=$(cat "$mem_pid_file")
      if [[ -n "$pid" ]]; then
        kill "$pid" >/dev/null 2>&1 || true
        wait "$pid" 2>/dev/null || true
      fi
    fi
  }
  trap cleanup EXIT INT TERM

  if [[ "$skip_logcat" -eq 0 ]]; then
    adb -s "$device_id" logcat -v threadtime \
      AudioEngineModule:V AudioTrack:V AudioFlinger:V ActivityManager:I \
      *:S >"$output_dir/android-logcat.txt" 2>&1 &
    logcat_pid=$!
    echo "Started adb logcat capture: $output_dir/android-logcat.txt"
  fi

  if [[ "$collect_memory" -eq 1 ]]; then
    collect_android_memory "$device_id" "$android_package" "$output_dir"
    mem_pid_file="$output_dir/android-meminfo.pid"
  fi

  echo "Running Android validation capture helper for $duration seconds."
  echo "Output directory: $output_dir"
  echo "Pause and execute lifecycle scenarios from docs/p8b-physical-device-validation.md now."
  sleep "$duration"
  echo "Capture complete. Artifacts written to: $output_dir"
}

main "$@"
