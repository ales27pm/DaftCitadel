#!/usr/bin/env bash
set -euo pipefail

print_usage() {
  cat <<'USAGE'
Usage: scripts/rvictl-capture.sh -u <device-udid> -o <capture-file> [-d <duration>] [-f <tcpdump-filter>]

Starts a tethered packet capture against a connected iOS device using Apple's rvictl utility. The script
creates a Remote Virtual Interface (RVI), records packets with tcpdump, and tears down the interface when
finished. Requires Xcode command-line tools and sudo privileges.

Options:
  -u <udid>        Device UDID as shown in `xcrun xctrace list devices`.
  -o <path>        Destination pcap file. Parent directory must exist.
  -d <seconds>     Optional capture duration. If omitted, capture runs until interrupted (Ctrl+C).
  -f <expression>  Optional tcpdump capture filter expression (e.g., 'port 443').
  -h               Show this help message.

Examples:
  scripts/rvictl-capture.sh -u 00008030-001C195E26A2002E -o captures/session.pcap -d 60 -f 'port 7000'
USAGE
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: $1 not found in PATH" >&2
    exit 1
  fi
}

cleanup() {
  if [[ -n "${RVI_INTERFACE:-}" ]]; then
    echo "[rvictl] tearing down $RVI_INTERFACE"
    sudo rvictl -x "$DEVICE_UDID" || true
  fi
}

DEVICE_UDID=""
OUTPUT_FILE=""
DURATION=""
TCPDUMP_FILTER=""

while getopts "u:o:d:f:h" opt; do
  case "$opt" in
    u)
      DEVICE_UDID="$OPTARG"
      ;;
    o)
      OUTPUT_FILE="$OPTARG"
      ;;
    d)
      DURATION="$OPTARG"
      ;;
    f)
      TCPDUMP_FILTER="$OPTARG"
      ;;
    h)
      print_usage
      exit 0
      ;;
    *)
      print_usage
      exit 1
      ;;
  esac
done

shift $((OPTIND - 1))

if [[ -z "$DEVICE_UDID" || -z "$OUTPUT_FILE" ]]; then
  echo "error: UDID and output file are required" >&2
  print_usage
  exit 1
fi

require_command sudo
require_command rvictl
require_command tcpdump
require_command mktemp

trap cleanup EXIT

echo "[rvictl] starting capture for device $DEVICE_UDID"
sudo rvictl -s "$DEVICE_UDID"

RVI_INTERFACE="$(rvictl -l | awk -v udid="$DEVICE_UDID" '$0 ~ udid {print $1}' | tail -n 1)"
if [[ -z "$RVI_INTERFACE" ]]; then
  echo "error: could not determine RVI interface for $DEVICE_UDID" >&2
  exit 1
fi

echo "[rvictl] using interface $RVI_INTERFACE"

echo "[tcpdump] writing capture to $OUTPUT_FILE"

sudo tcpdump -i "$RVI_INTERFACE" -w "$OUTPUT_FILE" ${TCPDUMP_FILTER:+"$TCPDUMP_FILTER"} &
CAPTURE_PID=$!

if [[ -n "$DURATION" ]]; then
  (
    sleep "$DURATION"
    kill "$CAPTURE_PID" 2>/dev/null || true
  ) &
fi

wait "$CAPTURE_PID"

echo "[rvictl] capture complete"
