#!/usr/bin/env bash
# daftcitadel.sh — consolidated Daft Citadel deployment utility
# Targets: Ubuntu 24.04+, desktop or containerized builds
# Profiles:
#   apex     — streamlined toolchain (legacy daft_apex_allinone)
#   hybrid   — balanced toolchain (legacy daft_apex_citadel)
#   citadel  — maximal toolchain with AI/Isobar trainers (legacy v6.5)
# Usage: sudo bash scripts/daftcitadel.sh [--profile=citadel] [--auto] [--gpu-off]

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ASSETS_DIR="$SCRIPT_DIR/../assets"
DEPS_DIR="$SCRIPT_DIR/../deps"
if [[ ! -d "$ASSETS_DIR" ]]; then
    echo "[ERR] Assets directory not found at $ASSETS_DIR" >&2
    exit 1
fi

if [[ ! -d "$DEPS_DIR" ]]; then
    mkdir -p "$DEPS_DIR"
fi

PROFILE="citadel"
AUTO=false
GPU_OFF=false
DAW_PATH="/usr/lib/lv2:/usr/lib/vst3:/usr/lib/ladspa:$HOME/.lv2:$HOME/.vst3:$HOME/.vst"
DAW_PATH_OVERRIDE=false
TARGET_USER=""
CONTAINER_MODE=false
WITH_REAPER=false
SKIP_ASSETS=false
MODULE_ENABLES=()
MODULE_DISABLES=()
SELECTED_SAMPLE_PACKS=()
PACK_SELECTION_OVERRIDDEN=false

usage() {
    cat <<'EOF'
Daft Citadel deployment

Options:
  --profile=[apex|hybrid|citadel]  Select deployment profile (default: citadel)
  --auto                           Non-interactive mode
  --gpu-off                        Skip CUDA/GPU acceleration tooling
  --daw-path=PATH                  Override plugin discovery paths
  --user=NAME                      Force target login user (for containers)
  --container                      Skip host-only tweaks (systemd/cpufreq)
  --with-reaper                    Include Reaper evaluation install
  --skip-assets                    Skip large sample/preset downloads
  --module=NAME                    Enable an optional module (ai/gui/synths/assets/groove/experimental/reaper)
  --modules=a,b,c                  Enable multiple modules in a single flag
  --without-module=NAME            Disable a module selected by the profile
  --packs=list                     Limit heavy downloads to comma-separated pack identifiers
  -h, --help                       Show this message
EOF
}

ARGS=()
for arg in "$@"; do
    case "$arg" in
        --profile=*) PROFILE="${arg#*=}" ;;
        --auto) AUTO=true ;;
        --gpu-off) GPU_OFF=true ;;
        --daw-path=*)
            DAW_PATH="${arg#*=}"
            DAW_PATH_OVERRIDE=true
            ;;
        --user=*) TARGET_USER="${arg#*=}" ;;
        --container) CONTAINER_MODE=true ;;
        --with-reaper) WITH_REAPER=true ;;
        --skip-assets) SKIP_ASSETS=true ;;
        --module=*) MODULE_ENABLES+=("${arg#*=}") ;;
        --modules=*)
            IFS=',' read -r -a __modules <<<"${arg#*=}"
            for module_name in "${__modules[@]}"; do
                [[ -n "$module_name" ]] && MODULE_ENABLES+=("$module_name")
            done
            ;;
        --without-module=*) MODULE_DISABLES+=("${arg#*=}") ;;
        --packs=*)
            PACK_SELECTION_OVERRIDDEN=true
            IFS=',' read -r -a __packs <<<"${arg#*=}"
            SELECTED_SAMPLE_PACKS=()
            for pack in "${__packs[@]}"; do
                pack="${pack,,}"
                [[ -n "$pack" ]] && SELECTED_SAMPLE_PACKS+=("$pack")
            done
            ;;
        -h|--help) usage; exit 0 ;;
        *) ARGS+=("$arg") ;;
    esac
done
set -- "${ARGS[@]}"

confirm() {
    if $AUTO; then
        return 0
    fi
    if ! [[ -t 0 ]]; then
        echo "[WARN] Non-interactive shell detected; defaulting to 'no'" >&2
        return 1
    fi
    read -r -p "$1 [y/N]: " ans
    [[ "${ans,,}" =~ ^y(es)?$ ]]
}

require_root() {
    if [[ $EUID -ne 0 ]]; then
        echo "[ERR] Run as root."
        exit 1
    fi
}

require_distro() {
    if ! grep -qi "ubuntu" /etc/os-release; then
        echo "[ERR] Ubuntu 24.04+ required."
        exit 1
    fi
}

resolve_user() {
    if [[ -n "$TARGET_USER" ]]; then
        USER_NAME="$TARGET_USER"
    else
        USER_NAME="${SUDO_USER:-$(logname 2>/dev/null || true)}"
    fi
    if [[ -z "$USER_NAME" ]]; then
        echo "[ERR] Could not resolve invoking user."
        exit 1
    fi
    USER_HOME=$(getent passwd "$USER_NAME" | cut -d: -f6)
    if [[ -z "$USER_HOME" || ! -d "$USER_HOME" ]]; then
        echo "[ERR] Home directory for $USER_NAME not found."
        exit 1
    fi
}

as_user() {
    sudo -u "$USER_NAME" -H bash -lc "$*"
}

log() {
    local message="$1"
    printf '%s\n' "$message"
    if [[ -n "${LOG:-}" ]]; then
        printf '%s\n' "$message" >>"$LOG"
    fi
}

sanitize_filename_component() {
    local input="$1"
    if [[ -z "$input" ]]; then
        echo ""
        return
    fi
    echo "$input" | tr -c 'A-Za-z0-9._-' '_'
}

apt_install() {
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
}

apt_install_available() {
    local pkg
    local to_install=()
    local missing=()
    for pkg in "$@"; do
        if apt-cache show "$pkg" >/dev/null 2>&1; then
            to_install+=("$pkg")
        else
            missing+=("$pkg")
        fi
    done
    if ((${#to_install[@]})); then
        apt_install "${to_install[@]}"
    fi
    if ((${#missing[@]})); then
        log "[WARN] Skipping unavailable packages: ${missing[*]}"
    fi
}

sysctl_set() {
    local key="$1"
    local value="$2"
    if $CONTAINER_MODE; then
        log "[SKIP] sysctl $key (container mode)"
        return
    fi
    if ! grep -q "^$key" /etc/sysctl.conf 2>/dev/null; then
        echo "$key=$value" >> /etc/sysctl.conf
    fi
    sysctl -w "$key=$value" >/dev/null || log "[WARN] Unable to set $key"
}

dl() {
    local url="$1"
    local dest="$2"
    log "[DL] $url"
    mkdir -p "$(dirname "$dest")"
    curl -L --fail --retry 5 --retry-all-errors --progress-bar \
        -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36" \
        "$url" -o "$dest"
}

optional_dl() {
    local url="$1"
    local dest="$2"
    local label="${3:-$url}"
    if dl "$url" "$dest"; then
        return 0
    else
        local status=$?
        rm -f "$dest"
        log "[WARN] Optional download failed for $label (exit $status); continuing without it"
        return 0
    fi
}

CHECK_SHA256_MATCH_INDEX=-1
CHECK_SHA256_ACTUAL=""

check_sha256() {
    local file="$1"
    shift
    local actual
    local expected
    local index=0

    if (($# == 0)); then
        return 2
    fi

    actual=$(sha256sum "$file" | awk '{print $1}')
    for expected in "$@"; do
        expected="${expected,,}"
        if [[ -n "$expected" && "$actual" == "$expected" ]]; then
            CHECK_SHA256_MATCH_INDEX=$index
            CHECK_SHA256_ACTUAL="$actual"
            return 0
        fi
        ((index++))
    done

    CHECK_SHA256_MATCH_INDEX=-1
    CHECK_SHA256_ACTUAL="$actual"
    return 1
}

verify_sha256() {
    local file="$1"
    shift
    local expected_hashes=()

    if (($# == 0)); then
        log "[ERR] No expected checksums provided for $file"
        exit 1
    fi

    for expected in "$@"; do
        expected_hashes+=("${expected,,}")
    done

    if check_sha256 "$file" "${expected_hashes[@]}"; then
        local match_index=${CHECK_SHA256_MATCH_INDEX:-0}
        if (( match_index == 0 )); then
            log "[CHECK] Verified $file"
        else
            log "[CHECK] Verified $file (matched alternate checksum #$((match_index + 1)))"
        fi
        return 0
    fi

    log "[ERR] SHA256 mismatch for $file"
    log "[ERR] Expected one of: ${expected_hashes[*]}"
    log "[ERR] Actual:   ${CHECK_SHA256_ACTUAL:-unknown}"
    exit 1
}

verify_md5() {
    local file="$1"
    local expected="$2"
    local actual
    actual=$(md5sum "$file" | awk '{print $1}')
    if [[ "$actual" != "${expected,,}" ]]; then
        log "[ERR] MD5 mismatch for $file"
        log "[ERR] Expected: ${expected,,}"
        log "[ERR] Actual:   $actual"
        exit 1
    fi
    log "[CHECK] Verified MD5 for $file"
}

check_md5() {
    local file="$1"
    local expected="$2"
    local actual
    actual=$(md5sum "$file" | awk '{print $1}')
    if [[ "$actual" == "${expected,,}" ]]; then
        return 0
    fi
    return 1
}

download_and_verify() {
    local url="$1"
    local dest="$2"
    shift 2
    if (($# == 0)); then
        log "[ERR] Missing checksum metadata for $url"
        exit 1
    fi
    if [[ -f "$dest" ]]; then
        if check_sha256 "$dest" "$@"; then
            log "[CACHE] Using cached $(basename "$dest")"
            verify_sha256 "$dest" "$@"
            return 0
        fi
        log "[WARN] Cached archive $(basename "$dest") failed checksum verification; re-downloading"
        rm -f "$dest"
    fi
    dl "$url" "$dest"
    verify_sha256 "$dest" "$@"
}

download_and_verify_md5() {
    local url="$1"
    local dest="$2"
    local md5="$3"
    if [[ -f "$dest" ]]; then
        if check_md5 "$dest" "$md5"; then
            log "[CACHE] Using cached $(basename "$dest")"
            verify_md5 "$dest" "$md5"
            return 0
        fi
        log "[WARN] Cached archive $(basename "$dest") failed checksum verification; re-downloading"
        rm -f "$dest"
    fi
    dl "$url" "$dest"
    verify_md5 "$dest" "$md5"
}

version_lt() {
    local current="$1"
    local required="$2"
    dpkg --compare-versions "$current" lt "$required"
}

pack_selected() {
    local needle="${1,,}"
    local pack
    for pack in "${SELECTED_SAMPLE_PACKS[@]}"; do
        if [[ "$pack" == "$needle" ]]; then
            return 0
        fi
    done
    return 1
}

normalize_module_name() {
    local module="${1,,}"
    module="${module// /}"
    module="${module//-}"
    echo "$module"
}

enable_named_module() {
    local module
    module=$(normalize_module_name "$1")
    case "$module" in
        ai|ml)
            ENABLE_AI=true
            ;;
        gui|interface)
            ENABLE_GUI=true
            ;;
        synths|expandedsynths|instruments)
            ENABLE_EXPANDED_SYNTHS=true
            ;;
        assets|samples|packs)
            ENABLE_HEAVY_ASSETS=true
            ;;
        groove|grooveboxes|groovetools|midi)
            ENABLE_GROOVE_TOOLS=true
            ;;
        experimental|forsynth|labs)
            ENABLE_EXPERIMENTAL_SYNTHS=true
            ;;
        reaper)
            WITH_REAPER=true
            ;;
        *)
            log "[WARN] Unknown module '${1}'"
            ;;
    esac
}

disable_named_module() {
    local module
    module=$(normalize_module_name "$1")
    case "$module" in
        base)
            log "[WARN] Base module cannot be disabled"
            ;;
        ai|ml)
            ENABLE_AI=false
            ;;
        gui|interface)
            ENABLE_GUI=false
            ;;
        synths|expandedsynths|instruments)
            ENABLE_EXPANDED_SYNTHS=false
            ;;
        assets|samples|packs)
            ENABLE_HEAVY_ASSETS=false
            ;;
        groove|grooveboxes|groovetools|midi)
            ENABLE_GROOVE_TOOLS=false
            ;;
        experimental|forsynth|labs)
            ENABLE_EXPERIMENTAL_SYNTHS=false
            ;;
        reaper)
            WITH_REAPER=false
            ;;
        *)
            log "[WARN] Unknown module '${1}'"
            ;;
    esac
}

resolve_latest_surge_release() {
    python3 <<'PY'
import json
import re
import shlex
import sys
import urllib.request

headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "DaftCitadelInstaller/1.0",
}
try:
    req = urllib.request.Request(
        "https://api.github.com/repos/surge-synthesizer/releases-xt/releases/latest",
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        release = json.load(resp)
except Exception:
    sys.exit(1)

assets = release.get("assets", [])
deb_asset = None
md5_asset = None
pattern = re.compile(r"surge-xt-linux-x64-.*\\.deb$")
for asset in assets:
    name = asset.get("name", "")
    if deb_asset is None and pattern.search(name):
        deb_asset = asset
    if asset.get("name") == "md5sum.txt":
        md5_asset = asset

if deb_asset is None or md5_asset is None:
    sys.exit(1)

try:
    md5_req = urllib.request.Request(md5_asset["browser_download_url"], headers=headers)
    with urllib.request.urlopen(md5_req, timeout=20) as resp:
        md5_body = resp.read().decode("utf-8", "ignore")
except Exception:
    sys.exit(1)

md5_value = ""
for line in md5_body.splitlines():
    parts = line.strip().split()
    if len(parts) >= 2 and parts[1].strip('*') == deb_asset["name"]:
        md5_value = parts[0].lower()
        break

if not md5_value:
    sys.exit(1)

print("SURGE_DYNAMIC_URL=" + shlex.quote(deb_asset["browser_download_url"]))
print("SURGE_DYNAMIC_MD5=" + shlex.quote(md5_value))
print("SURGE_DYNAMIC_VERSION=" + shlex.quote(release.get("tag_name", "")))
PY
}

resolve_helm_manifest() {
    python3 <<'PY'
import re
import shlex
import sys
import urllib.parse
import urllib.request

headers = {
    "User-Agent": "DaftCitadelInstaller/1.0",
}
try:
    req = urllib.request.Request("https://tytel.org/static/js/helm_download.js", headers=headers)
    with urllib.request.urlopen(req, timeout=20) as resp:
        body = resp.read().decode("utf-8", "ignore")
except Exception:
    sys.exit(1)

match = re.search(r'download_lookup\.linux64_r\s*=\s*"([^"]+)"', body)
if not match:
    sys.exit(1)

relative = match.group(1)
version_match = re.search(r'helm_([0-9_]+)_amd64', relative)
version = version_match.group(1).replace('_', '.') if version_match else ""
full_url = urllib.parse.urljoin("https://tytel.org", relative)

print("HELM_DYNAMIC_URL=" + shlex.quote(full_url))
print("HELM_DYNAMIC_VERSION=" + shlex.quote(version))
PY
}

resolve_vital_manifest() {
    python3 <<'PY'
import base64
import re
import shlex
import sys
import urllib.request

headers = {
    "User-Agent": "DaftCitadelInstaller/1.0",
}
channels = ["nixos-24.05", "nixos-unstable"]
for channel in channels:
    url = f"https://raw.githubusercontent.com/NixOS/nixpkgs/{channel}/pkgs/applications/audio/vital/default.nix"
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8", "ignore")
    except Exception:
        continue
    version_match = re.search(r'version\s*=\s*"([0-9.]+)";', body)
    hash_match = re.search(r'hash\s*=\s*"sha256-([A-Za-z0-9+/=]+)";', body)
    if not version_match or not hash_match:
        continue
    version = version_match.group(1)
    b64_hash = hash_match.group(1)
    padding = '=' * (-len(b64_hash) % 4)
    try:
        sha256_hex = base64.b64decode(b64_hash + padding).hex()
    except Exception:
        continue
    underscored = version.replace('.', '_')
    vital_url = f"https://builds.vital.audio/VitalAudio/vital/{underscored}/VitalInstaller.zip"
    print("VITAL_DYNAMIC_URL=" + shlex.quote(vital_url))
    print("VITAL_DYNAMIC_VERSION=" + shlex.quote(version))
    print("VITAL_DYNAMIC_SHA256=" + shlex.quote(sha256_hex))
    sys.exit(0)
sys.exit(1)
PY
}

json_get_field() {
    local file="$1"
    local path="$2"
    python3 - "$file" "$path" <<'PY'
import json
import sys

file_path, key_path = sys.argv[1:3]
try:
    with open(file_path, 'r', encoding='utf-8') as handle:
        data = json.load(handle)
    for key in key_path.split('.'):
        if isinstance(data, dict):
            data = data.get(key)
        else:
            data = None
            break
    if data is not None:
        print(data)
except Exception:
    pass
PY
}

extract_zip_as_user() {
    local archive="$1"
    local dest="$2"
    as_user "mkdir -p '$dest'"
    as_user "unzip -o '$archive' -d '$dest'"
}

require_root
require_distro
resolve_user

if ! $DAW_PATH_OVERRIDE; then
    DAW_PATH="/usr/lib/lv2:/usr/lib/vst3:/usr/lib/ladspa:$USER_HOME/.lv2:$USER_HOME/.vst3:$USER_HOME/.vst"
fi

PROFILE="${PROFILE,,}"
ENABLE_AI=false
ENABLE_GUI=false
ENABLE_HEAVY_ASSETS=false
ENABLE_EXPANDED_SYNTHS=false
ENABLE_GROOVE_TOOLS=false
ENABLE_EXPERIMENTAL_SYNTHS=false
case "$PROFILE" in
    apex)
        PROFILE_NAME="Daft Apex"
        ENABLE_GUI=true
        ;;
    hybrid)
        PROFILE_NAME="Daft Apex Citadel"
        ENABLE_AI=true
        ENABLE_GUI=true
        ENABLE_HEAVY_ASSETS=true
        ENABLE_EXPANDED_SYNTHS=true
        ;;
    citadel)
        PROFILE_NAME="Daft Citadel"
        ENABLE_AI=true
        ENABLE_GUI=true
        ENABLE_HEAVY_ASSETS=true
        ENABLE_EXPANDED_SYNTHS=true
        ENABLE_GROOVE_TOOLS=true
        ENABLE_EXPERIMENTAL_SYNTHS=true
        ;;
    *)
        echo "[ERR] Unknown profile: $PROFILE" >&2
        usage
        exit 1
        ;;
esac

if ((${#MODULE_ENABLES[@]})); then
    for module_name in "${MODULE_ENABLES[@]}"; do
        enable_named_module "$module_name"
    done
fi

if ((${#MODULE_DISABLES[@]})); then
    for module_name in "${MODULE_DISABLES[@]}"; do
        disable_named_module "$module_name"
    done
fi

if $SKIP_ASSETS; then
    ENABLE_HEAVY_ASSETS=false
fi

if $PACK_SELECTION_OVERRIDDEN && ! $ENABLE_HEAVY_ASSETS; then
    log "[INFO] Enabling sample pack module to honor --packs selection"
    ENABLE_HEAVY_ASSETS=true
fi

if ! $PACK_SELECTION_OVERRIDDEN && $ENABLE_HEAVY_ASSETS && ((${#SELECTED_SAMPLE_PACKS[@]} == 0)); then
    SELECTED_SAMPLE_PACKS=(
        bpb909
        daftpack
        surge-presets
        vital-daft
    )
fi

BASE="$USER_HOME/DaftCitadel"
LOG="$USER_HOME/daft_citadel.log"
VENV="$BASE/.venv"
THEME_DIR="$BASE/Theme"
mkdir -p "$BASE" "$THEME_DIR"
touch "$LOG"
chown -R "$USER_NAME:$USER_NAME" "$BASE" "$LOG"
log "[IGNITION] $PROFILE_NAME deployment - $(date)"

[[ $ENABLE_AI == true ]] && JSON_AI=true || JSON_AI=false
[[ $ENABLE_GUI == true ]] && JSON_GUI=true || JSON_GUI=false
[[ $ENABLE_EXPANDED_SYNTHS == true ]] && JSON_SYNTHS=true || JSON_SYNTHS=false
[[ $ENABLE_HEAVY_ASSETS == true ]] && JSON_ASSETS=true || JSON_ASSETS=false
[[ $ENABLE_GROOVE_TOOLS == true ]] && JSON_GROOVE=true || JSON_GROOVE=false
[[ $ENABLE_EXPERIMENTAL_SYNTHS == true ]] && JSON_EXPERIMENTAL=true || JSON_EXPERIMENTAL=false
[[ $CONTAINER_MODE == true ]] && JSON_CONTAINER=true || JSON_CONTAINER=false

cat >"$BASE/citadel_profile.json" <<EOF_PROFILE_META
{
  "profile": "$PROFILE",
  "features": {
    "ai": $JSON_AI,
    "gui": $JSON_GUI,
    "expandedSynths": $JSON_SYNTHS,
    "heavyAssets": $JSON_ASSETS,
    "grooveTools": $JSON_GROOVE,
    "experimentalSynths": $JSON_EXPERIMENTAL,
    "container": $JSON_CONTAINER
  }
}
EOF_PROFILE_META
chown "$USER_NAME:$USER_NAME" "$BASE/citadel_profile.json"

log "[SYS] Updating system packages"
apt-get update -y
apt-get upgrade -y
if ! command -v add-apt-repository >/dev/null 2>&1; then
    apt_install software-properties-common
fi
for component in universe multiverse restricted; do
    add-apt-repository -y "$component"
done
apt-get update -y

log "[AUDIO] Installing PipeWire/JACK and configuring realtime"
apt_install_available pipewire pipewire-jack pipewire-pulse wireplumber jackd2 rtirq-init alsa-utils libasound2-plugins ubuntustudio-pipewire-config dbus-user-session pw-top
getent group realtime >/dev/null || groupadd -r realtime
usermod -a -G audio,realtime "$USER_NAME" || log "[WARN] Could not update groups for $USER_NAME"
mkdir -p /etc/security/limits.d
cat >/etc/security/limits.d/daftcitadel-audio.conf <<'EOF_LIMITS'
@audio    -  rtprio     95
@audio    -  memlock    unlimited
@realtime -  rtprio     98
@realtime -  memlock    unlimited
EOF_LIMITS
if ! $CONTAINER_MODE && command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$USER_NAME" || log "[WARN] Unable to enable linger for $USER_NAME"
else
    log "[SKIP] loginctl linger (container or unavailable)"
fi

FIRST_LOGIN="$USER_HOME/.config/daftcitadel/first-login.sh"
as_user "mkdir -p ~/.config/daftcitadel ~/.config/autostart"
cat >"$FIRST_LOGIN" <<'EOF_FIRST_LOGIN'
#!/usr/bin/env bash
set -euo pipefail
if command -v systemctl >/dev/null 2>&1; then
    systemctl --user enable --now pipewire pipewire-pulse wireplumber || true
else
    echo "[WARN] systemctl not available; ensure PipeWire services are started manually" >&2
fi
if command -v pw-metadata >/dev/null 2>&1; then
    pw-metadata -n settings 0 clock.force-quantum 32 || true
fi
rm -f "$HOME/.config/autostart/daftcitadel-first-login.desktop" "$HOME/.config/daftcitadel/first-login.sh"
EOF_FIRST_LOGIN
chmod +x "$FIRST_LOGIN"
cat >"$USER_HOME/.config/autostart/daftcitadel-first-login.desktop" <<'EOF_DESKTOP'
[Desktop Entry]
Type=Application
Exec=/bin/bash -lc "$HOME/.config/daftcitadel/first-login.sh"
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
Name=Daft Citadel PipeWire Init
Comment=Enable PipeWire with Daft Citadel tuning on first login
EOF_DESKTOP
chown -R "$USER_NAME:$USER_NAME" "$USER_HOME/.config/daftcitadel" "$USER_HOME/.config/autostart"

sysctl_set vm.swappiness 1

if ! $GPU_OFF && command -v lspci >/dev/null 2>&1 && lspci | grep -qi nvidia; then
    log "[GPU] Installing NVIDIA CUDA toolkit"
    if ! $CONTAINER_MODE; then
        apt_install nvidia-driver-535
    else
        log "[SKIP] NVIDIA driver install (container mode)"
    fi
    apt_install nvidia-cuda-toolkit
    as_user "grep -q CUDA_VISIBLE_DEVICES ~/.bashrc || echo 'export CUDA_VISIBLE_DEVICES=0' >> ~/.bashrc"
else
    log "[GPU] GPU acceleration disabled or NVIDIA hardware not detected"
fi

log "[DAW] Installing core DAWs and utilities"
CORE_DAWS=(ardour carla carla-lv2 carla-vst qjackctl pulseaudio-utils p7zip-full unzip zip wget curl git pv inxi neofetch)
if [[ $PROFILE != "apex" ]]; then
    CORE_DAWS+=(lmms)
fi
apt_install "${CORE_DAWS[@]}"

if $WITH_REAPER || { [[ $PROFILE != "apex" ]] && confirm "Install Reaper (evaluation) as an additional DAW?"; }; then
    REAPER_DL=$(\
        curl -Ls -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36" https://www.reaper.fm/download.php \
            | grep -Eo 'https://www\\.reaper\\.fm/files/7\\.x/reaper[0-9]+_linux_x86_64\\.tar\\.xz' \
            | head -n1 \
            || true
    )
    REAPER_DL="${REAPER_DL:-}"
    if [[ -n "$REAPER_DL" ]]; then
        optional_dl "$REAPER_DL" /tmp/reaper.tar.xz "REAPER Linux archive"
        if [[ -f /tmp/reaper.tar.xz ]]; then
            mkdir -p /opt/reaper
            tar -xJf /tmp/reaper.tar.xz --strip-components=1 -C /opt/reaper
            ln -sf /opt/reaper/reaper /usr/local/bin/reaper
            rm -f /tmp/reaper.tar.xz
        else
            log "[WARN] Skipping REAPER install; archive unavailable"
        fi
    else
        log "[WARN] Could not resolve REAPER Linux URL from download page"
    fi
fi

log "[PLUGINS] Installing LV2/VST3 instruments and effects"
CORE_PLUGINS=(calf-plugins lsp-plugins mda-lv2 x42-plugins dragonfly-reverb hydrogen)
if $ENABLE_EXPANDED_SYNTHS; then
    CORE_PLUGINS+=(yoshimi zynaddsubfx)
fi
apt_install "${CORE_PLUGINS[@]}"
apt_install_available zam-plugins avldrums.lv2 drumgizmo

declare -A HELM_KNOWN_SHAS=(
    ["0.9.0"]="aedf8b676657f72782513e5ad5f9c61a6bc21fe9357b23052928adafa8215eca"
)

declare -A VITAL_FALLBACK_URLS=(
    ["1.5.5"]="https://builds.vital.audio/VitalAudio/vital/1_5_5/VitalInstaller.zip"
)

declare -A VITAL_KNOWN_SHAS=(
    ["1.5.5"]="68f3c7e845f3d7a5b44a83adeb6e34ef221503df00e7964f7d5a1f132a252d13 842c17494881074629435a0de9a74ba6bc00a1e97a7fbdad046e5f11beb53822"
)

VITAL_DEFAULT_VERSION="1.5.5"

surge_installed=false
SURGE_ARCHIVE_PATH=""
surge_version_selected=""
if command -v python3 >/dev/null 2>&1; then
    if SURGE_DYNAMIC_OUTPUT=$(resolve_latest_surge_release 2>/dev/null); then
        eval "$SURGE_DYNAMIC_OUTPUT"
        if [[ -n "${SURGE_DYNAMIC_URL:-}" && -n "${SURGE_DYNAMIC_MD5:-}" ]]; then
            log "[PLUGINS] Resolved Surge XT ${SURGE_DYNAMIC_VERSION:-latest} from GitHub release metadata"
            surge_version_selected="${SURGE_DYNAMIC_VERSION:-latest}"
            surge_filename="surge-xt-$(sanitize_filename_component "${surge_version_selected:-latest}").deb"
            SURGE_ARCHIVE_PATH="$DEPS_DIR/${surge_filename:-surge-xt-latest.deb}"
            if download_and_verify_md5 "$SURGE_DYNAMIC_URL" "$SURGE_ARCHIVE_PATH" "$SURGE_DYNAMIC_MD5"; then
                apt-get install -y "$SURGE_ARCHIVE_PATH" || apt-get -f install -y
                surge_installed=true
            fi
        else
            log "[WARN] Surge XT release metadata incomplete; falling back to pinned build"
        fi
    fi
else
    log "[INFO] python3 unavailable; using static Surge XT mirror"
fi
if ! $surge_installed; then
    SURGE_URL="https://github.com/surge-synthesizer/releases-xt/releases/download/1.3.4/surge-xt-linux-x64-1.3.4.deb"
    SURGE_SHA256="a6e55064487f624147d515b9ae5fc79a568b69746675b2083abde628ca7bb151"
    log "[PLUGINS] Installing Surge XT 1.3.4 from pinned release asset"
    surge_version_selected="${surge_version_selected:-1.3.4}"
    surge_filename="surge-xt-$(sanitize_filename_component "${surge_version_selected:-1.3.4}").deb"
    SURGE_ARCHIVE_PATH="$DEPS_DIR/${surge_filename:-surge-xt-1.3.4.deb}"
    download_and_verify "$SURGE_URL" "$SURGE_ARCHIVE_PATH" "$SURGE_SHA256"
    apt-get install -y "$SURGE_ARCHIVE_PATH" || apt-get -f install -y
fi

HELM_URL=""
HELM_SHA256=""
HELM_VERSION_DISPLAY=""
if command -v python3 >/dev/null 2>&1; then
    if HELM_DYNAMIC_OUTPUT=$(resolve_helm_manifest 2>/dev/null); then
        eval "$HELM_DYNAMIC_OUTPUT"
        if [[ -n "${HELM_DYNAMIC_VERSION:-}" && -n "${HELM_KNOWN_SHAS[$HELM_DYNAMIC_VERSION]:-}" ]]; then
            HELM_URL="$HELM_DYNAMIC_URL"
            HELM_SHA256="${HELM_KNOWN_SHAS[$HELM_DYNAMIC_VERSION]}"
            HELM_VERSION_DISPLAY="$HELM_DYNAMIC_VERSION"
            log "[PLUGINS] Resolved Helm $HELM_DYNAMIC_VERSION via official manifest"
        elif [[ -n "${HELM_DYNAMIC_VERSION:-}" ]]; then
            log "[WARN] Helm version $HELM_DYNAMIC_VERSION missing checksum mapping; using curated fallback"
        fi
    fi
else
    log "[INFO] python3 unavailable; using static Helm manifest fallback"
fi
if [[ -z "${HELM_URL:-}" ]]; then
    HELM_URL="https://tytel.org/static/dist/helm_0.9.0_amd64_r.deb"
    HELM_SHA256="${HELM_KNOWN_SHAS["0.9.0"]}"
    HELM_VERSION_DISPLAY="0.9.0"
fi
log "[PLUGINS] Installing Helm ${HELM_VERSION_DISPLAY:-0.9.0}"
helm_version_for_name="${HELM_VERSION_DISPLAY:-0.9.0}"
helm_filename="helm-$(sanitize_filename_component "$helm_version_for_name").deb"
HELM_ARCHIVE_PATH="$DEPS_DIR/${helm_filename:-helm.deb}"
download_and_verify "$HELM_URL" "$HELM_ARCHIVE_PATH" "$HELM_SHA256"
apt-get install -y "$HELM_ARCHIVE_PATH" || apt-get -f install -y

if $ENABLE_EXPANDED_SYNTHS; then
    # Vital
    # Vital distributes binaries under an EULA; prefer nixpkgs metadata to resolve the latest Linux build.
    VITAL_URL=""
    VITAL_VERSION_DISPLAY=""
    VITAL_DYNAMIC_SHA256=""
    VITAL_CHECKSUM_CANDIDATES=()
    if command -v python3 >/dev/null 2>&1; then
        if VITAL_DYNAMIC_OUTPUT=$(resolve_vital_manifest 2>/dev/null); then
            eval "$VITAL_DYNAMIC_OUTPUT"
            if [[ -n "${VITAL_DYNAMIC_URL:-}" && -n "${VITAL_DYNAMIC_SHA256:-}" ]]; then
                VITAL_URL="$VITAL_DYNAMIC_URL"
                VITAL_VERSION_DISPLAY="${VITAL_DYNAMIC_VERSION:-latest}"
                log "[PLUGINS] Resolved Vital ${VITAL_VERSION_DISPLAY} via nixpkgs manifest"
            fi
        else
            log "[WARN] Unable to fetch Vital metadata from nixpkgs; using curated fallback"
        fi
    else
        log "[INFO] python3 unavailable; using static Vital manifest fallback"
    fi
    if [[ -n "${VITAL_DYNAMIC_SHA256:-}" ]]; then
        VITAL_CHECKSUM_CANDIDATES+=("${VITAL_DYNAMIC_SHA256,,}")
    fi
    if [[ -z "${VITAL_URL:-}" ]]; then
        if [[ -n "${VITAL_FALLBACK_URLS[$VITAL_DEFAULT_VERSION]:-}" ]]; then
            VITAL_VERSION_DISPLAY="$VITAL_DEFAULT_VERSION"
            VITAL_URL="${VITAL_FALLBACK_URLS[$VITAL_VERSION_DISPLAY]}"
            if [[ -z "$VITAL_URL" ]]; then
                log "[ERR] Vital fallback URL resolution failed for $VITAL_VERSION_DISPLAY"
                exit 1
            fi
        else
            log "[ERR] Vital fallback URL metadata missing for $VITAL_DEFAULT_VERSION"
            exit 1
        fi
    fi
    if [[ -n "${VITAL_VERSION_DISPLAY:-}" && -n "${VITAL_KNOWN_SHAS[$VITAL_VERSION_DISPLAY]:-}" ]]; then
        read -r -a __vital_known_shas <<<"${VITAL_KNOWN_SHAS[$VITAL_VERSION_DISPLAY]}"
        for candidate in "${__vital_known_shas[@]}"; do
            candidate="${candidate,,}"
            [[ -z "$candidate" ]] && continue
            duplicate=false
            for existing in "${VITAL_CHECKSUM_CANDIDATES[@]}"; do
                if [[ "$existing" == "$candidate" ]]; then
                    duplicate=true
                    break
                fi
            done
            if ! $duplicate; then
                VITAL_CHECKSUM_CANDIDATES+=("$candidate")
            fi
        done
    fi
    if ((${#VITAL_CHECKSUM_CANDIDATES[@]} == 0)); then
        if [[ "${VITAL_VERSION_DISPLAY:-}" != "$VITAL_DEFAULT_VERSION" ]]; then
            log "[WARN] Missing checksum metadata for Vital ${VITAL_VERSION_DISPLAY:-unknown}; falling back to $VITAL_DEFAULT_VERSION"
            VITAL_VERSION_DISPLAY="$VITAL_DEFAULT_VERSION"
            VITAL_URL="${VITAL_FALLBACK_URLS[$VITAL_VERSION_DISPLAY]}"
            if [[ -z "$VITAL_URL" ]]; then
                log "[ERR] Vital fallback URL resolution failed for $VITAL_VERSION_DISPLAY"
                exit 1
            fi
            VITAL_CHECKSUM_CANDIDATES=()
            if [[ -n "${VITAL_KNOWN_SHAS[$VITAL_VERSION_DISPLAY]:-}" ]]; then
                read -r -a __vital_known_shas <<<"${VITAL_KNOWN_SHAS[$VITAL_VERSION_DISPLAY]}"
                for candidate in "${__vital_known_shas[@]}"; do
                    candidate="${candidate,,}"
                    [[ -z "$candidate" ]] && continue
                    VITAL_CHECKSUM_CANDIDATES+=("$candidate")
                done
            fi
        fi
    fi
    if ((${#VITAL_CHECKSUM_CANDIDATES[@]} == 0)); then
        log "[ERR] No checksum metadata available for Vital ${VITAL_VERSION_DISPLAY:-unknown}"
        exit 1
    fi
    log "[PLUGINS] Installing Vital ${VITAL_VERSION_DISPLAY:-1.5.x}"
    vital_version_for_name="${VITAL_VERSION_DISPLAY:-$VITAL_DEFAULT_VERSION}"
    vital_sanitized_version=$(sanitize_filename_component "$vital_version_for_name")
    VITAL_ARCHIVE_CANDIDATES=()
    if [[ -n "$vital_sanitized_version" ]]; then
        VITAL_ARCHIVE_CANDIDATES+=("VitalInstaller_${vital_sanitized_version}.zip")
        VITAL_ARCHIVE_CANDIDATES+=("Vital_${vital_sanitized_version}.zip")
    fi
    VITAL_ARCHIVE_CANDIDATES+=("VitalInstaller.zip")
    VITAL_ARCHIVE_CANDIDATES+=("Vital.zip")
    VITAL_ARCHIVE_PATH=""
    for candidate_name in "${VITAL_ARCHIVE_CANDIDATES[@]}"; do
        cached_path="$DEPS_DIR/$candidate_name"
        if [[ -f "$cached_path" ]]; then
            if check_sha256 "$cached_path" "${VITAL_CHECKSUM_CANDIDATES[@]}"; then
                log "[CACHE] Using cached Vital archive $candidate_name"
                verify_sha256 "$cached_path" "${VITAL_CHECKSUM_CANDIDATES[@]}"
                VITAL_ARCHIVE_PATH="$cached_path"
                break
            fi
            log "[WARN] Cached Vital archive $candidate_name failed checksum verification; removing"
            rm -f "$cached_path"
        fi
    done
    if [[ -z "$VITAL_ARCHIVE_PATH" ]]; then
        VITAL_ARCHIVE_PRIMARY_NAME="${VITAL_ARCHIVE_CANDIDATES[0]}"
        if [[ -z "$VITAL_ARCHIVE_PRIMARY_NAME" ]]; then
            VITAL_ARCHIVE_PRIMARY_NAME="VitalInstaller.zip"
        fi
        VITAL_ARCHIVE_PATH="$DEPS_DIR/$VITAL_ARCHIVE_PRIMARY_NAME"
        download_and_verify "$VITAL_URL" "$VITAL_ARCHIVE_PATH" "${VITAL_CHECKSUM_CANDIDATES[@]}"
    fi
    VITAL_WORKDIR=$(mktemp -d /tmp/vital.XXXXXX)
    unzip -o "$VITAL_ARCHIVE_PATH" -d "$VITAL_WORKDIR"
    VITAL_ROOT="$VITAL_WORKDIR"
    VITAL_INSTALL_SCRIPT=""
    for candidate in \
        "$VITAL_ROOT/install.sh" \
        "$VITAL_ROOT/install" \
        "$VITAL_ROOT"/VitalInstaller/install.sh \
        "$VITAL_ROOT"/VitalInstaller/install
    do
        if [[ -f "$candidate" ]]; then
            chmod +x "$candidate" || true
            if [[ -x "$candidate" ]]; then
                VITAL_INSTALL_SCRIPT="$candidate"
                break
            fi
        fi
    done
    if [[ -n "$VITAL_INSTALL_SCRIPT" ]]; then
        "$VITAL_INSTALL_SCRIPT" --no-register || true
    else
        VITAL_PAYLOAD=$(find "$VITAL_ROOT" -maxdepth 1 -type d -name 'VitalInstaller*' -print -quit)
        if [[ -n "$VITAL_PAYLOAD" && -d "$VITAL_PAYLOAD" ]]; then
            log "[PLUGINS] Vital installer script missing; performing manual deployment"
            install -d /usr/lib/vst /usr/lib/vst3 /usr/lib/clap /opt/vital
            missing_components=()
            VITAL_VST="$VITAL_PAYLOAD/lib/vst/Vital.so"
            VITAL_VST3_DIR="$VITAL_PAYLOAD/lib/vst3/Vital.vst3"
            VITAL_CLAP="$VITAL_PAYLOAD/lib/clap/Vital.clap"
            VITAL_BIN="$VITAL_PAYLOAD/bin/Vital"
            if [[ -f "$VITAL_VST" ]]; then
                install -m 644 "$VITAL_VST" /usr/lib/vst/Vital.so
            else
                missing_components+=("VST plugin")
            fi
            if [[ -d "$VITAL_VST3_DIR" ]]; then
                rm -rf /usr/lib/vst3/Vital.vst3
                cp -r "$VITAL_VST3_DIR" /usr/lib/vst3/
            else
                missing_components+=("VST3 plugin")
            fi
            if [[ -f "$VITAL_CLAP" ]]; then
                install -m 755 "$VITAL_CLAP" /usr/lib/clap/Vital.clap
            else
                missing_components+=("CLAP plugin")
            fi
            if [[ -f "$VITAL_BIN" ]]; then
                install -m 755 "$VITAL_BIN" /opt/vital/Vital
                ln -sf /opt/vital/Vital /usr/local/bin/Vital
            else
                missing_components+=("standalone binary")
            fi
            if ((${#missing_components[@]})); then
                log "[WARN] Vital manual install missing: ${missing_components[*]}"
            fi
        else
            log "[WARN] Vital payload layout changed; skipping manual install"
        fi
    fi
    rm -rf "$VITAL_WORKDIR"

    # TAL-Vocoder via DISTRHO Ports (Ubuntu-packaged build)
    log "[PLUGINS] Installing DISTRHO Ports collection for TAL instruments"
    apt_install_available dpf-plugins
    if [[ -d /usr/lib/lv2/TAL-Vocoder-2.lv2 || -d /usr/lib/vst3/TAL-Vocoder-2.vst3 ]]; then
        log "[PLUGINS] TAL-Vocoder deployed via DISTRHO Ports packages"
    else
        log "[WARN] TAL-Vocoder files not detected after DISTRHO Ports install; verify package contents"
        log "[INFO] Manual download remains available: https://github.com/DISTRHO/DISTRHO-Ports"
    fi

    # Tyrell N6
    if [[ ! -d /usr/lib/vst3/TyrellN6.vst3 ]]; then
        TYRELL_PRIMARY_URL="https://u-he.com/downloads/TyrellN6/TyrellN6_Linux.tar.xz"
        TYRELL_MIRRORS=(
            "https://dl.u-he.com/downloads/TyrellN6/TyrellN6_Linux.tar.xz"
            "https://uhe-dl.b-cdn.net/TyrellN6_307_Linux.tar.xz"
        )
        TYRELL_ARCHIVE=$(mktemp /tmp/tyrell.XXXXXX.tar.xz)
        glibc_version=$(ldd --version | head -n 1 | awk '{print $NF}')
        if version_lt "$glibc_version" "2.28"; then
            log "[WARN] Tyrell N6 requires glibc 2.28+, detected $glibc_version"
        fi
        tyrell_installed=false
        TYRELL_SOURCES=("$TYRELL_PRIMARY_URL" "${TYRELL_MIRRORS[@]}")
        for mirror in "${TYRELL_SOURCES[@]}"; do
            if dl "$mirror" "$TYRELL_ARCHIVE"; then
                if tar -tJf "$TYRELL_ARCHIVE" >/dev/null 2>&1; then
                    TYRELL_WORKDIR=$(mktemp -d /tmp/tyrell.XXXXXX)
                    if tar -xJf "$TYRELL_ARCHIVE" -C "$TYRELL_WORKDIR" >/dev/null 2>&1; then
                        TYRELL_SRC=$(find "$TYRELL_WORKDIR" -maxdepth 2 -type d -name 'TyrellN6' | head -n 1)
                        if [[ -n "$TYRELL_SRC" && -f "$TYRELL_SRC/TyrellN6.64.so" ]]; then
                            install -d -m 755 /opt/u-he
                            rm -rf /opt/u-he/TyrellN6
                            cp -a "$TYRELL_SRC" /opt/u-he/TyrellN6
                            chown -R root:root /opt/u-he/TyrellN6

                            install -d -m 755 /usr/lib/vst
                            install -m 755 "$TYRELL_SRC/TyrellN6.64.so" /usr/lib/vst/TyrellN6.64.so

                            install -d -m 755 /usr/lib/vst3/TyrellN6.vst3/Contents/x86_64-linux
                            install -m 755 "$TYRELL_SRC/TyrellN6.64.so" /usr/lib/vst3/TyrellN6.vst3/Contents/x86_64-linux/TyrellN6.so
                            install -d -m 755 /usr/lib/vst3/TyrellN6.vst3/Contents/Resources/Documentation

                            TYRELL_DOC=$(find "$TYRELL_SRC" -maxdepth 1 -type f -iname '*user guide.pdf' | head -n 1)
                            if [[ -n "$TYRELL_DOC" ]]; then
                                install -m 644 "$TYRELL_DOC" \
                                    "/usr/lib/vst3/TyrellN6.vst3/Contents/Resources/Documentation/$(basename "$TYRELL_DOC")"
                            fi
                            TYRELL_LICENSE=$(find "$TYRELL_SRC" -maxdepth 1 -type f -iname 'license.txt' | head -n 1)
                            if [[ -n "$TYRELL_LICENSE" ]]; then
                                install -m 644 "$TYRELL_LICENSE" \
                                    "/usr/lib/vst3/TyrellN6.vst3/Contents/Resources/Documentation/$(basename "$TYRELL_LICENSE")"
                            fi

                            install -d -m 755 /usr/lib/clap
                            install -m 755 "$TYRELL_SRC/TyrellN6.64.so" /usr/lib/clap/TyrellN6.clap

                            as_user "mkdir -p ~/.u-he ~/.vst ~/.vst3 ~/.clap"
                            as_user "ln -snf /opt/u-he/TyrellN6 ~/.u-he/TyrellN6"
                            as_user "ln -snf /usr/lib/vst/TyrellN6.64.so ~/.vst/TyrellN6.64.so"
                            as_user "ln -snf /usr/lib/vst3/TyrellN6.vst3 ~/.vst3/TyrellN6.vst3"
                            as_user "ln -snf /usr/lib/clap/TyrellN6.clap ~/.clap/TyrellN6.clap"

                            tyrell_installed=true
                            log "[PLUGINS] Installed Tyrell N6 from $mirror"
                            rm -rf "$TYRELL_WORKDIR"
                            break
                        else
                            log "[WARN] Tyrell N6 payload from $mirror missing expected content"
                        fi
                    else
                        log "[WARN] Unable to extract Tyrell N6 archive from $mirror"
                    fi
                    rm -rf "${TYRELL_WORKDIR:-}"
                else
                    log "[WARN] Tyrell N6 archive from $mirror is not a valid tarball"
                fi
            else
                log "[WARN] Failed to download Tyrell N6 from $mirror"
            fi
            rm -f "$TYRELL_ARCHIVE"
        done
        rm -f "$TYRELL_ARCHIVE"
        if ! $tyrell_installed; then
            log "[WARN] Tyrell N6 download unavailable; skipping automated install"
            log "[INFO] Manual download available from https://u-he.com/products/tyrelln6/"
        fi
    fi

    # OB-Xd
    obxd_target_version="2.17.0"
    obxd_current_version=""
    if [[ -f /usr/lib/vst3/OB-Xd.vst3/Contents/Resources/moduleinfo.json ]]; then
        obxd_current_version=$(json_get_field \
            /usr/lib/vst3/OB-Xd.vst3/Contents/Resources/moduleinfo.json \
            "Version")
    fi

    if [[ "$obxd_current_version" != "$obxd_target_version" ]]; then
        OBXD_ARCHIVE=$(mktemp -t obxd.XXXXXX.zip)
        OBXD_WORKDIR=$(mktemp -d -t obxd.XXXXXX)
        download_and_verify \
            "https://github.com/reales/OB-Xd/releases/download/2.17/Obxd217FreeLinux.zip" \
            "$OBXD_ARCHIVE" \
            "c70c01aba78c499e67ccfa1916204a4ddcff9982ec17ca33a95e5ed605cc9472"
        if unzip -q "$OBXD_ARCHIVE" -d "$OBXD_WORKDIR"; then
            if [[ -d "$OBXD_WORKDIR/OB-Xd.vst3" && -f "$OBXD_WORKDIR/OB-Xd.so" ]]; then
                install -d -m 755 /usr/lib/vst3
                rm -rf /usr/lib/vst3/OB-Xd.vst3
                cp -a "$OBXD_WORKDIR/OB-Xd.vst3" /usr/lib/vst3/
                chmod -R go-w /usr/lib/vst3/OB-Xd.vst3

                install -d -m 755 /usr/lib/vst
                install -m 755 "$OBXD_WORKDIR/OB-Xd.so" /usr/lib/vst/OB-Xd.so

                install -d -m 755 /opt/discoDSP
                rm -rf /opt/discoDSP/OB-Xd
                if [[ -d "$OBXD_WORKDIR/discoDSP/OB-Xd" ]]; then
                    cp -a "$OBXD_WORKDIR/discoDSP/OB-Xd" /opt/discoDSP/
                    chmod -R go-w /opt/discoDSP/OB-Xd
                fi

                install -d -m 755 /usr/share/doc/obxd
                if [[ -f "$OBXD_WORKDIR/OB-Xd Manual.pdf" ]]; then
                    install -m 644 "$OBXD_WORKDIR/OB-Xd Manual.pdf" \
                        "/usr/share/doc/obxd/OB-Xd Manual.pdf"
                fi
                if [[ -f "$OBXD_WORKDIR/License.txt" ]]; then
                    install -m 644 "$OBXD_WORKDIR/License.txt" \
                        /usr/share/doc/obxd/License.txt
                fi

                as_user "mkdir -p ~/.vst ~/.vst3 ~/Documents ~/Documents/discoDSP"
                as_user "ln -snf /usr/lib/vst/OB-Xd.so ~/.vst/OB-Xd.so"
                as_user "ln -snf /usr/lib/vst3/OB-Xd.vst3 ~/.vst3/OB-Xd.vst3"
                if [[ -d /opt/discoDSP/OB-Xd ]]; then
                    as_user "ln -snf /opt/discoDSP/OB-Xd ~/Documents/discoDSP/OB-Xd"
                fi

                obxd_current_version="$obxd_target_version"
                log "[PLUGINS] Installed OB-Xd Legacy $obxd_target_version"
            else
                log "[WARN] OB-Xd payload missing expected plugin binaries"
            fi
        else
            log "[WARN] Failed to extract OB-Xd archive"
        fi
        rm -f "${OBXD_ARCHIVE:-}"
        rm -rf "${OBXD_WORKDIR:-}"
    fi

    log "[INFO] Consider installing Dragonfly Reverb, LSP, Calf, x42, Zam, and DISTRHO Ports for a comprehensive Linux-native toolchain"
    log "[INFO] MT Power Drumkit 2 requires a manual download; native alternatives like AVLDrums or DrumGizmo are installed automatically"
fi

log "[MIDI] Installing FluidSynth and soundfonts"
apt_install fluidsynth fluid-soundfont-gm fluid-soundfont-gs
as_user "grep -q 'alias fsynth=' ~/.bashrc || echo \"alias fsynth='fluidsynth -a pulseaudio /usr/share/sounds/sf2/FluidR3_GM.sf2'\" >> ~/.bashrc"

log "[VAULT] Creating library directories and downloading presets/samples"
as_user "mkdir -p '$BASE'/Presets/Vital '$BASE'/Presets/Surge '$BASE'/Presets/Daft '$BASE'/Samples/909 '$BASE'/Samples/Daft '$BASE'/Projects '$BASE'/MIDIs '$BASE'/Models '$BASE'/Templates '$BASE'/Scripts '$BASE'/Theme"
if $ENABLE_HEAVY_ASSETS && ((${#SELECTED_SAMPLE_PACKS[@]})); then
    if $ENABLE_EXPANDED_SYNTHS && pack_selected "vital-daft"; then
        log "[INFO] Vital factory content ships with the installer; skipping external preset mirror"
        if [[ ! -f "$BASE/Presets/Daft/da_funk_lead.vital" ]]; then
            optional_dl \
                "https://www.syntorial.com/downloads/presets/daft-punk-da-funk-lead.vital" \
                "$BASE/Presets/Daft/da_funk_lead.vital" \
                "Da Funk Vital preset"
        fi
        if [[ ! -f "$BASE/Presets/Daft/derezzed_lead.vital" ]]; then
            optional_dl \
                "https://www.syntorial.com/downloads/presets/daft-punk-derezzed-lead.vital" \
                "$BASE/Presets/Daft/derezzed_lead.vital" \
                "Derezzed Vital preset"
        fi
        if [[ ! -f "$BASE/Presets/Daft/around_the_world.vitalbank" ]]; then
            optional_dl \
                "https://static.synthctrl.com/presets/Daft-Punk-Around-The-World.vitalbank" \
                "$BASE/Presets/Daft/around_the_world.vitalbank" \
                "Around the World Vital bank"
        fi
    fi

    if pack_selected "surge-presets" && [[ ! -d "$BASE/Presets/Surge/surge-sound-data-main" ]]; then
        SURGE_ARCHIVE="$BASE/Presets/surge_sound_data.zip"
        optional_dl \
            "https://github.com/surge-synthesizer/surge-sound-data/archive/refs/heads/main.zip" \
            "$SURGE_ARCHIVE" \
            "Surge XT community presets"
        if [[ -f "$SURGE_ARCHIVE" ]]; then
            extract_zip_as_user "$SURGE_ARCHIVE" "$BASE/Presets/Surge"
            rm -f "$SURGE_ARCHIVE"
        else
            log "[WARN] Surge XT preset archive unavailable; skipping extraction"
        fi
    fi

    if pack_selected "bpb909" && [[ ! -d "$BASE/Samples/909/BPB-Cassette-909" ]]; then
        BPB_ARCHIVE="$BASE/Samples/bpb_cassette_909.zip"
        optional_dl \
            "https://bedroomproducersblog.com/wp-content/uploads/2014/04/BPB-Cassette-909.zip" \
            "$BPB_ARCHIVE" \
            "BPB Cassette 909 sample pack"
        if [[ -f "$BPB_ARCHIVE" ]]; then
            if unzip -q "$BPB_ARCHIVE" -d "$BASE/Samples/909"; then
                mv "$BASE/Samples/909"/BPB* "$BASE/Samples/909/BPB-Cassette-909" 2>/dev/null || true
                chown -R "$USER_NAME:$USER_NAME" "$BASE/Samples/909"
            else
                log "[WARN] Unable to extract BPB Cassette 909 archive"
            fi
            rm -f "$BPB_ARCHIVE"
        else
            log "[WARN] BPB Cassette 909 download gated; see https://bedroomproducersblog.com/2014/04/24/free-909-samples/"
        fi
    fi

    if pack_selected "daftpack" && [[ ! -d "$BASE/Samples/Daft/DaftPack" ]]; then
        DAFTPACK_ARCHIVE="$BASE/Samples/daft_samples.zip"
        optional_dl \
            "https://samplescience.ca/wp-content/uploads/2020/02/samplescience-daftpunk-samples.zip" \
            "$DAFTPACK_ARCHIVE" \
            "DaftPack sample archive"
        if [[ -f "$DAFTPACK_ARCHIVE" ]]; then
            extract_zip_as_user "$DAFTPACK_ARCHIVE" "$BASE/Samples/Daft"
            rm -f "$DAFTPACK_ARCHIVE"
        else
            log "[WARN] DaftPack sample archive unavailable; skipping extraction"
        fi
    fi
else
    log "[VAULT] Skipping heavy preset/sample downloads for $PROFILE profile"
fi

if $ENABLE_GROOVE_TOOLS; then
    log "[GROOVE] Deploying open-source groove generators and MIDI packs"
    apt_install git
    GROOVE_DIR="$BASE/Grooves"
    MIDI_TARGET="$BASE/MIDIs"
    as_user "mkdir -p '$GROOVE_DIR/Extensions' '$GROOVE_DIR/MIDI'"

    BITWIG_DIR="$GROOVE_DIR/Extensions/BitwigBuddy"
    if ! as_user "rm -rf '$BITWIG_DIR' && git clone --depth 1 'https://github.com/centomila/BitwigBuddy-Bitwig-Extension.git' '$BITWIG_DIR'"; then
        log "[WARN] Unable to clone BitwigBuddy extension; repository may be unavailable"
    else
        log "[GROOVE] BitwigBuddy extension synced to $BITWIG_DIR"
    fi

    MIDI_REPO="$GROOVE_DIR/MIDI/DaftPunkMidiTester"
    if ! as_user "rm -rf '$MIDI_REPO' && git clone --depth 1 'https://github.com/hackrockcity/DaftPunkMidiTester.git' '$MIDI_REPO'"; then
        log "[WARN] Unable to retrieve Daft Punk MIDI tester pack"
    else
        as_user "find '$MIDI_REPO' -type f -iname '*.mid' -exec cp -n {} '$MIDI_TARGET/' \;"
        log "[GROOVE] Imported Daft Punk MIDI sketches into $MIDI_TARGET"
    fi
else
    log "[GROOVE] Groove toolkit disabled for $PROFILE profile"
fi

if $ENABLE_EXPERIMENTAL_SYNTHS; then
    log "[LAB] Installing ForSynth experimental suite"
    apt_install git gfortran make
    EXPERIMENTAL_DIR="$BASE/Experimental"
    FORSYNTH_DIR="$EXPERIMENTAL_DIR/ForSynth"
    as_user "mkdir -p '$EXPERIMENTAL_DIR'"
    if as_user "rm -rf '$FORSYNTH_DIR' && git clone --depth 1 'https://github.com/vmagnin/ForSynth.git' '$FORSYNTH_DIR'"; then
        if as_user "cd '$FORSYNTH_DIR' && set -o pipefail && ./build.sh | tee build.log"; then
            log "[LAB] ForSynth examples compiled successfully"
            cat >/usr/local/bin/forsynth-demo <<'EOF_FORSYNTH'
#!/usr/bin/env bash
set -euo pipefail
FORSYNTH_ROOT="$HOME/DaftCitadel/Experimental/ForSynth/build"
if [[ $# -lt 1 ]]; then
    echo "Usage: forsynth-demo <example> [args...]" >&2
    echo "Available demos:" >&2
    ls "$FORSYNTH_ROOT" | sed -e 's/\.out$//' >&2
    exit 1
fi
target="$FORSYNTH_ROOT/$1.out"
if [[ ! -x "$target" ]]; then
    echo "ForSynth demo '$1' not found in $FORSYNTH_ROOT" >&2
    exit 2
fi
shift
"$target" "$@"
EOF_FORSYNTH
            chmod 755 /usr/local/bin/forsynth-demo
        else
            log "[WARN] ForSynth build failed; see $FORSYNTH_DIR/build.log for diagnostics"
            rm -f /usr/local/bin/forsynth-demo
        fi
    else
        log "[WARN] Unable to clone ForSynth repository"
    fi
else
    log "[LAB] Experimental synth lab disabled for $PROFILE profile"
fi

log "[THEME] Downloading Daft Punk themed assets"
if [[ ! -f "$THEME_DIR/background.jpg" ]]; then
    optional_dl \
        "https://upload.wikimedia.org/wikipedia/commons/d/d5/Daft_Punk_Live_2006.jpg" \
        "$THEME_DIR/background.jpg" \
        "Daft Punk live background"
fi
if [[ ! -f "$THEME_DIR/icon.svg" ]]; then
    optional_dl \
        "https://upload.wikimedia.org/wikipedia/commons/7/72/Daft_Punk_logo.svg" \
        "$THEME_DIR/icon.svg" \
        "Daft Punk logo"
fi
# ImageMagick is installed later for GUI-capable profiles; rasterization occurs after install.
STYLE_SRC="$ASSETS_DIR/theme/style.qss"
if [[ -f "$STYLE_SRC" ]]; then
    install -D -m 644 "$STYLE_SRC" "$THEME_DIR/style.qss"
else
    log "[WARN] Theme stylesheet missing from $STYLE_SRC"
fi
chown -R "$USER_NAME:$USER_NAME" "$THEME_DIR"

if $ENABLE_GUI; then
    log "[PY] Creating Python virtual environment and installing libraries"
    apt_install python3 python3-venv python3-pip python3-dev build-essential libasound2-dev libsndfile1-dev libportmidi-dev imagemagick fonts-orbitron fonts-roboto fonts-jetbrains-mono
    if command -v convert >/dev/null 2>&1; then
        if [[ -f "$THEME_DIR/icon.svg" ]]; then
            convert "$THEME_DIR/icon.svg" "$THEME_DIR/icon.png"
        else
            log "[WARN] Theme icon SVG unavailable; skipping rasterization"
        fi
    else
        log "[WARN] ImageMagick convert not available; skipping icon rasterization"
    fi
    as_user "python3 -m venv '$VENV'"
    as_user "source '$VENV/bin/activate' && pip install --upgrade pip"
    if $ENABLE_AI; then
        TORCH_VERSION="2.4.1+cu121"
        TORCH_INDEX="https://download.pytorch.org/whl/cu121"
        TORCH_VARIANT="CUDA 12.1"
        if $GPU_OFF || $CONTAINER_MODE; then
            TORCH_VERSION="2.4.1+cpu"
            TORCH_INDEX="https://download.pytorch.org/whl/cpu"
            TORCH_VARIANT="CPU"
        fi
        log "[AI] Installing PyTorch $TORCH_VERSION ($TORCH_VARIANT build)"
        if ! as_user "source '$VENV/bin/activate' && pip install --index-url '$TORCH_INDEX' torch==$TORCH_VERSION"; then
            log "[WARN] PyTorch $TORCH_VERSION unavailable from $TORCH_INDEX; attempting auto-resolve"
            if ! as_user "source '$VENV/bin/activate' && pip install --index-url '$TORCH_INDEX' torch"; then
                log "[ERR] Unable to install a compatible PyTorch build"
                exit 1
            fi
        fi
    else
        log "[AI] Skipping Torch deployment for $PROFILE profile"
    fi
    as_user "source '$VENV/bin/activate' && pip install mido midiutil music21 pygame PySide6 isobar numpy"

    TRAINER_SRC="$ASSETS_DIR/python/daft_midi_trainer.py"
    TRAINER_STUB_SRC="$ASSETS_DIR/python/daft_midi_trainer_stub.py"
    if $ENABLE_AI; then
        log "[AI] Deploying Daft MIDI trainer"
        if [[ -f "$TRAINER_SRC" ]]; then
            install -D -m 755 "$TRAINER_SRC" "$BASE/daft_midi_trainer.py"
        else
            log "[ERR] Missing trainer asset at $TRAINER_SRC"
            exit 1
        fi
    else
        if [[ -f "$TRAINER_STUB_SRC" ]]; then
            install -D -m 755 "$TRAINER_STUB_SRC" "$BASE/daft_midi_trainer.py"
        else
            log "[ERR] Missing trainer stub asset at $TRAINER_STUB_SRC"
            exit 1
        fi
    fi
    chown "$USER_NAME:$USER_NAME" "$BASE/daft_midi_trainer.py"

    log "[TEMPLATES] Writing Ardour templates"
    TEMPLATE_SRC_DIR="$ASSETS_DIR/templates"
    if [[ ! -d "$TEMPLATE_SRC_DIR" ]]; then
        log "[ERR] Template asset directory missing at $TEMPLATE_SRC_DIR"
        exit 1
    fi
    if $ENABLE_EXPANDED_SYNTHS; then
        install -D -m 644 "$TEMPLATE_SRC_DIR/da_funk.ardour" "$BASE/Templates/da_funk.ardour"
        install -D -m 644 "$TEMPLATE_SRC_DIR/around_world.ardour" "$BASE/Templates/around_world.ardour"
    else
        install -D -m 644 "$TEMPLATE_SRC_DIR/daft_apex.ardour" "$BASE/Templates/daft_apex.ardour"
    fi
    chown -R "$USER_NAME:$USER_NAME" "$BASE/Templates"

    log "[GUI] Creating PySide6 control surface"
    GUI_SRC="$ASSETS_DIR/python/citadel_gui.py"
    if [[ -f "$GUI_SRC" ]]; then
        install -D -m 755 "$GUI_SRC" "$BASE/citadel_gui.py"
    else
        log "[ERR] GUI asset missing at $GUI_SRC"
        exit 1
    fi
    chown "$USER_NAME:$USER_NAME" "$BASE/citadel_gui.py"

    log "[DESKTOP] Creating desktop entry"
    as_user "mkdir -p ~/.local/share/applications"
    cat >"$USER_HOME/.local/share/applications/daft-citadel.desktop" <<EOF_SHORTCUT
[Desktop Entry]
Name=Daft Citadel
Comment=Launch the Daft Citadel controller
Exec=$VENV/bin/python $BASE/citadel_gui.py
Icon=$THEME_DIR/icon.png
Terminal=false
Type=Application
Categories=AudioVideo;Music;
StartupWMClass=DaftCitadel
EOF_SHORTCUT
    chown "$USER_NAME:$USER_NAME" "$USER_HOME/.local/share/applications/daft-citadel.desktop"
else
    log "[PY] GUI stack disabled for this profile"
fi

log "[ENV] Exporting DAW paths to user profile"
PROFILE_BLOCK_START="# >>> DaftCitadel profile >>>"
PROFILE_BLOCK_END="# <<< DaftCitadel profile <<<"
touch "$USER_HOME/.profile"
if ! grep -q "$PROFILE_BLOCK_START" "$USER_HOME/.profile"; then
    cat >>"$USER_HOME/.profile" <<EOF_PROFILE
$PROFILE_BLOCK_START
export CITADEL_DAW_PATH="$DAW_PATH"
export LV2_PATH="\${LV2_PATH:-$DAW_PATH}"
export VST3_PATH="\${VST3_PATH:-$DAW_PATH}"
export VST_PATH="\${VST_PATH:-$DAW_PATH}"
export CITADEL_HOME="$BASE"
$PROFILE_BLOCK_END
EOF_PROFILE
else
    log "[SKIP] Profile exports already present"
fi
chown "$USER_NAME:$USER_NAME" "$USER_HOME/.profile"

log "[GIT] Initializing git repository for Citadel assets"
as_user "cd '$BASE' && git init"
as_user "cd '$BASE' && git add ."
as_user "cd '$BASE' && git commit -m 'Daft Citadel bootstrap' || true"

log "[FINAL] $PROFILE_NAME deployment complete"
log "Profile manifest: $BASE/citadel_profile.json"
if $ENABLE_GUI; then
    log "GUI launcher: $VENV/bin/python $BASE/citadel_gui.py"
fi
if $ENABLE_AI; then
    log "AI trainer:  $VENV/bin/python $BASE/daft_midi_trainer.py --train"
fi
log "Ardour template directory: $BASE/Templates"
log "NOTE: Log out/in to finalize audio group membership."

if $CONTAINER_MODE; then
    log "[FINAL] Deployment complete (reboot not applicable in container)"
elif confirm "Reboot system now?"; then
    log "[REBOOT] Rebooting to finalize configuration"
    reboot
fi

