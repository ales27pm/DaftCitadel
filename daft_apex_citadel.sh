#!/usr/bin/env bash
# Wrapper for the hybrid Daft Apex Citadel profile.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec "$SCRIPT_DIR/scripts/daftcitadel.sh" --profile=hybrid "$@"
