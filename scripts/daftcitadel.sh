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
if [[ ! -d "$ASSETS_DIR" ]]; then
    echo "[ERR] Assets directory not found at $ASSETS_DIR" >&2
    exit 1
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
    echo "$1" | tee -a "$LOG"
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
    curl -L --fail --retry 5 --retry-all-errors --progress-bar "$url" -o "$dest"
}

verify_sha256() {
    local file="$1"
    local expected="$2"
    local actual
    actual=$(sha256sum "$file" | awk '{print $1}')
    if [[ "$actual" != "$expected" ]]; then
        log "[ERR] SHA256 mismatch for $file"
        log "[ERR] Expected: $expected"
        log "[ERR] Actual:   $actual"
        exit 1
    fi
    log "[CHECK] Verified $file"
}

download_and_verify() {
    local url="$1"
    local dest="$2"
    local sha="$3"
    dl "$url" "$dest"
    verify_sha256 "$dest" "$sha"
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
case "$PROFILE" in
    apex)
        PROFILE_NAME="Daft Apex"
        ENABLE_AI=false
        ENABLE_GUI=true
        ENABLE_HEAVY_ASSETS=false
        ENABLE_EXPANDED_SYNTHS=false
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
        ;;
    *)
        echo "[ERR] Unknown profile: $PROFILE" >&2
        usage
        exit 1
        ;;
esac

if $SKIP_ASSETS; then
    ENABLE_HEAVY_ASSETS=false
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
[[ $CONTAINER_MODE == true ]] && JSON_CONTAINER=true || JSON_CONTAINER=false

cat >"$BASE/citadel_profile.json" <<EOF_PROFILE_META
{
  "profile": "$PROFILE",
  "features": {
    "ai": $JSON_AI,
    "gui": $JSON_GUI,
    "expandedSynths": $JSON_SYNTHS,
    "heavyAssets": $JSON_ASSETS,
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
    dl "https://www.reaper.fm/files/7.x/reaper712_linux_x86_64.tar.xz" /tmp/reaper.tar.xz
    mkdir -p /opt/reaper
    tar -xJf /tmp/reaper.tar.xz --strip-components=1 -C /opt/reaper
    ln -sf /opt/reaper/reaper /usr/local/bin/reaper
    rm -f /tmp/reaper.tar.xz
fi

log "[PLUGINS] Installing LV2/VST3 instruments and effects"
CORE_PLUGINS=(calf-plugins lsp-plugins mda-lv2 x42-plugins dragonfly-reverb hydrogen)
if $ENABLE_EXPANDED_SYNTHS; then
    CORE_PLUGINS+=(yoshimi zynaddsubfx)
fi
apt_install "${CORE_PLUGINS[@]}"

SURGE_URL="https://github.com/surge-synthesizer/releases-xt/releases/download/1.3.4/surge-xt-linux-x64-1.3.4.deb"
SURGE_SHA256="a6e55064487f624147d515b9ae5fc79a568b69746675b2083abde628ca7bb151"
HELM_URL="https://tytel.org/static/dist/helm_0.9.0_amd64_r.deb"
HELM_SHA256="aedf8b676657f72782513e5ad5f9c61a6bc21fe9357b23052928adafa8215eca"

download_and_verify "$SURGE_URL" /tmp/surge.deb "$SURGE_SHA256"
apt-get install -y /tmp/surge.deb || apt-get -f install -y
rm -f /tmp/surge.deb

download_and_verify "$HELM_URL" /tmp/helm.deb "$HELM_SHA256"
apt-get install -y /tmp/helm.deb || apt-get -f install -y
rm -f /tmp/helm.deb

if $ENABLE_EXPANDED_SYNTHS; then
    # Vital
    # Vital distributes binaries under an EULA; curated hash from nixpkgs ensures tamper detection.
    VITAL_URL="https://builds.vital.audio/VitalAudio/vital/1_5_5/VitalInstaller.zip"
    VITAL_SHA256="842c17494881074629435a0de9a74ba6bc00a1e97a7fbdad046e5f11beb53822"
    download_and_verify "$VITAL_URL" /tmp/vital.zip "$VITAL_SHA256"
    unzip -o /tmp/vital.zip -d /tmp/vital
    /tmp/vital/install.sh --no-register || true
    rm -rf /tmp/vital /tmp/vital.zip

    # TAL-Vocoder
    if [[ ! -d /usr/lib/lv2/TAL-Vocoder-2.lv2 ]]; then
        dl "https://tal-software.com/downloads/plugins/TAL-Vocoder-64bit-linux-v3.0.4.zip" /tmp/tal-vocoder.zip
        unzip -o /tmp/tal-vocoder.zip -d /usr/lib/lv2/
        rm -f /tmp/tal-vocoder.zip
    fi

    # Tyrell N6
    if [[ ! -d /usr/lib/vst3/TyrellN6.vst3 ]]; then
        dl "https://u-he.com/downloads/TyrellN6/TyrellN6_305_12092_Linux.tar.xz" /tmp/tyrell.tar.xz
        mkdir -p /usr/lib/vst3
        tar -xJf /tmp/tyrell.tar.xz -C /usr/lib/vst3/
        rm -f /tmp/tyrell.tar.xz
    fi

    # OB-Xd
    if [[ ! -d /usr/lib/vst3/OB-Xd.vst3 ]]; then
        dl "https://github.com/reales/OB-Xd/releases/download/v2.11/OB-Xd-2.11-Linux.tar.gz" /tmp/obxd.tar.gz
        tar -xzf /tmp/obxd.tar.gz -C /usr/lib/vst3/
        rm -f /tmp/obxd.tar.gz
    fi

    # Valhalla Supermassive
    if [[ ! -d /usr/lib/vst3/ValhallaSupermassive.vst3 ]]; then
        dl "https://valhalladsp.com/wp-content/uploads/2023/05/ValhallaSupermassive_linux_2.5.0.zip" /tmp/valhalla.zip
        unzip -o /tmp/valhalla.zip -d /usr/lib/vst3/
        rm -f /tmp/valhalla.zip
    fi

    # MT Power Drumkit 2
    if [[ ! -d "$USER_HOME/.vst/MTPowerDrumKit2" ]]; then
        dl "https://www.powerdrumkit.com/downloads/MTPowerDrumKit2_Linux_VST3.zip" /tmp/mtpdk.zip
        as_user "mkdir -p ~/.vst"
        as_user "unzip -o /tmp/mtpdk.zip -d ~/.vst/"
        rm -f /tmp/mtpdk.zip
    fi

    # Kilohearts Essentials
    if [[ ! -d /usr/lib/vst3/Kilohearts ]]; then
        dl "https://kilohearts.com/downloads/files/Kilohearts_Essentials.zip" /tmp/kilohearts.zip
        unzip -o /tmp/kilohearts.zip -d /usr/lib/vst3/
        rm -f /tmp/kilohearts.zip
    fi
fi

log "[MIDI] Installing FluidSynth and soundfonts"
apt_install fluidsynth fluid-soundfont-gm fluid-soundfont-gs
as_user "grep -q 'alias fsynth=' ~/.bashrc || echo \"alias fsynth='fluidsynth -a pulseaudio /usr/share/sounds/sf2/FluidR3_GM.sf2'\" >> ~/.bashrc"

log "[VAULT] Creating library directories and downloading presets/samples"
as_user "mkdir -p '$BASE'/Presets/Vital '$BASE'/Presets/Surge '$BASE'/Presets/Daft '$BASE'/Samples/909 '$BASE'/Samples/Daft '$BASE'/Projects '$BASE'/MIDIs '$BASE'/Models '$BASE'/Templates '$BASE'/Scripts '$BASE'/Theme"
if $ENABLE_HEAVY_ASSETS; then
    if $ENABLE_EXPANDED_SYNTHS; then
        if [[ ! -d "$BASE/Presets/Vital/Vital" ]]; then
            dl "https://storage.googleapis.com/vitalpublic/VitalPresets/vital_factory_presets.zip" "$BASE/Presets/vital_factory_presets.zip"
            extract_zip_as_user "$BASE/Presets/vital_factory_presets.zip" "$BASE/Presets/Vital"
            rm -f "$BASE/Presets/vital_factory_presets.zip"
        fi
        dl "https://www.syntorial.com/downloads/presets/daft-punk-da-funk-lead.vital" "$BASE/Presets/Daft/da_funk_lead.vital"
        dl "https://www.syntorial.com/downloads/presets/daft-punk-derezzed-lead.vital" "$BASE/Presets/Daft/derezzed_lead.vital"
        if [[ ! -f "$BASE/Presets/Daft/around_the_world.vitalbank" ]]; then
            dl "https://static.synthctrl.com/presets/Daft-Punk-Around-The-World.vitalbank" "$BASE/Presets/Daft/around_the_world.vitalbank"
        fi
    fi

    if [[ ! -d "$BASE/Presets/Surge/surge-sound-data-main" ]]; then
        dl "https://github.com/surge-synthesizer/surge-sound-data/archive/refs/heads/main.zip" "$BASE/Presets/surge_sound_data.zip"
        extract_zip_as_user "$BASE/Presets/surge_sound_data.zip" "$BASE/Presets/Surge"
        rm -f "$BASE/Presets/surge_sound_data.zip"
    fi

    if [[ ! -d "$BASE/Samples/909/909_full" ]]; then
        dl "https://archive.org/download/Roland_TR-909_Samples/909_full.zip" "$BASE/Samples/909_full.zip"
        extract_zip_as_user "$BASE/Samples/909_full.zip" "$BASE/Samples/909"
        rm -f "$BASE/Samples/909_full.zip"
    fi

    if [[ ! -d "$BASE/Samples/Daft/DaftPack" ]]; then
        dl "https://samplescience.ca/wp-content/uploads/2020/02/samplescience-daftpunk-samples.zip" "$BASE/Samples/daft_samples.zip"
        extract_zip_as_user "$BASE/Samples/daft_samples.zip" "$BASE/Samples/Daft"
        rm -f "$BASE/Samples/daft_samples.zip"
    fi
else
    log "[VAULT] Skipping heavy preset/sample downloads for $PROFILE profile"
fi

log "[THEME] Downloading Daft Punk themed assets"
dl "https://upload.wikimedia.org/wikipedia/commons/d/d5/Daft_Punk_Live_2006.jpg" "$THEME_DIR/background.jpg"
dl "https://upload.wikimedia.org/wikipedia/commons/7/72/Daft_Punk_logo.svg" "$THEME_DIR/icon.svg"
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
        convert "$THEME_DIR/icon.svg" "$THEME_DIR/icon.png"
    else
        log "[WARN] ImageMagick convert not available; skipping icon rasterization"
    fi
    as_user "python3 -m venv '$VENV'"
    as_user "source '$VENV/bin/activate' && pip install --upgrade pip"
    if $ENABLE_AI; then
        as_user "source '$VENV/bin/activate' && pip install torch==2.2.1 --extra-index-url https://download.pytorch.org/whl/cu121"
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

