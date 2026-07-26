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
