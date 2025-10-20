#!/usr/bin/env bash
# Wrapper maintained for backwards compatibility.
# Delegates to scripts/daftcitadel.sh with the citadel profile.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec "$SCRIPT_DIR/scripts/daftcitadel.sh" --profile=citadel "$@"
