#!/usr/bin/env bash
# daftcitadel.sh — consolidated Daft Citadel deployment utility
# Targets: Ubuntu 24.04+, desktop or containerized builds
# Profiles:
#   apex     — streamlined toolchain (legacy daft_apex_allinone)
#   hybrid   — balanced toolchain (legacy daft_apex_citadel)
#   citadel  — maximal toolchain with AI/Isobar trainers (legacy v6.5)
# Usage: sudo bash scripts/daftcitadel.sh [--profile=citadel] [--auto] [--gpu-off]

set -euo pipefail

PROFILE="citadel"
AUTO=false
GPU_OFF=false
DAW_PATH="/usr/lib/lv2:/usr/lib/vst3:/usr/lib/ladspa:$HOME/.lv2:$HOME/.vst3:$HOME/.vst"
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
        --daw-path=*) DAW_PATH="${arg#*=}" ;;
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

extract_zip_as_user() {
    local archive="$1"
    local dest="$2"
    as_user "mkdir -p '$dest'"
    as_user "unzip -o '$archive' -d '$dest'"
}

require_root
require_distro
resolve_user

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
apt_install pipewire pipewire-jack pipewire-pulse wireplumber jackd2 rtirq-init alsa-utils libasound2-plugins ubuntustudio-pipewire-config dbus-user-session pw-top
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

# Surge XT
if [[ ! -f /tmp/surge.deb ]]; then
    dl "https://github.com/surge-synthesizer/releases-xt/releases/download/1.3.6/surge-xt-linux-x64-1.3.6.deb" /tmp/surge.deb
fi
apt-get install -y /tmp/surge.deb || apt-get -f install -y
rm -f /tmp/surge.deb

# Helm
if [[ ! -f /tmp/helm.deb ]]; then
    dl "https://tytel.org/static/dist/helm_0.9.0_amd64_r.deb" /tmp/helm.deb
fi
apt-get install -y /tmp/helm.deb || apt-get -f install -y
rm -f /tmp/helm.deb

if $ENABLE_EXPANDED_SYNTHS; then
    # Vital
    if [[ ! -f /tmp/vital.zip ]]; then
        dl "https://get.vital.audio/Vital-1.5.5.lin.zip" /tmp/vital.zip
    fi
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
if command -v convert >/dev/null 2>&1; then
    convert "$THEME_DIR/icon.svg" "$THEME_DIR/icon.png"
fi
cat >"$THEME_DIR/style.qss" <<'EOF_QSS'
QMainWindow {
    background-color: #0b0b11;
}
QPushButton {
    background-color: #ff4d00;
    color: #ffffff;
    border: 1px solid #00e5ff;
    padding: 8px 14px;
    font-family: "Orbitron";
    font-size: 15px;
    letter-spacing: 1px;
}
QPushButton:hover {
    background-color: #ff6f1a;
}
QComboBox, QSpinBox, QListWidget {
    background-color: #141426;
    color: #00e5ff;
    border: 1px solid #00e5ff;
    selection-background-color: #1f1f33;
}
QPlainTextEdit {
    background-color: #080810;
    color: #0dffef;
    font-family: "JetBrains Mono", "Courier New", monospace;
    font-size: 12px;
}
QLabel {
    color: #00e5ff;
    font-family: "Orbitron";
    font-size: 14px;
}
QSplitter::handle {
    background-color: #00e5ff;
}
EOF_QSS
chown -R "$USER_NAME:$USER_NAME" "$THEME_DIR"

if $ENABLE_GUI; then
    log "[PY] Creating Python virtual environment and installing libraries"
    apt_install python3 python3-venv python3-pip python3-dev build-essential libasound2-dev libsndfile1-dev libportmidi-dev imagemagick fonts-orbitron fonts-roboto fonts-jetbrains-mono
    as_user "python3 -m venv '$VENV'"
    as_user "source '$VENV/bin/activate' && pip install --upgrade pip"
    if $ENABLE_AI; then
        as_user "source '$VENV/bin/activate' && pip install torch==2.2.1 --extra-index-url https://download.pytorch.org/whl/cu121"
    else
        log "[AI] Skipping Torch deployment for $PROFILE profile"
    fi
    as_user "source '$VENV/bin/activate' && pip install mido midiutil music21 pygame PySide6 isobar numpy"

    if $ENABLE_AI; then
        log "[AI] Deploying Daft MIDI trainer"
        cat >"$BASE/daft_midi_trainer.py" <<'EOF_TRAINER'
import os
import subprocess
import zipfile
from pathlib import Path
from typing import Dict, List

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from midiutil import MIDIFile
from music21 import chord, converter, note

import isobar as iso


class DaftMIDITransformer(nn.Module):
    def __init__(self, vocab_size: int, sequence_length: int = 64, d_model: int = 256, nhead: int = 8, num_layers: int = 6):
        super().__init__()
        self.sequence_length = sequence_length
        self.embedding = nn.Embedding(vocab_size, d_model)
        self.position = nn.Parameter(torch.zeros(1, sequence_length, d_model))
        encoder_layer = nn.TransformerEncoderLayer(d_model, nhead, dim_feedforward=1024, batch_first=True)
        self.transformer = nn.TransformerEncoder(encoder_layer, num_layers)
        self.fc = nn.Linear(d_model, vocab_size)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.embedding(x)
        x = x + self.position[:, : x.size(1)]
        out = self.transformer(x)
        return self.fc(out)


class DaftMIDITrainer:
    def __init__(self, base_dir: Path):
        self.base_dir = base_dir
        self.midis_dir = base_dir / "MIDIs"
        self.models_dir = base_dir / "Models"
        self.midis_dir.mkdir(parents=True, exist_ok=True)
        self.models_dir.mkdir(parents=True, exist_ok=True)
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.sequence_length = 64
        self.note_to_idx: Dict[str, int] = {}
        self.idx_to_note: Dict[int, str] = {}
        self.model: DaftMIDITransformer | None = None
        self.sf2 = Path("/usr/share/sounds/sf2/FluidR3_GM.sf2")

    def _download_corpus(self) -> None:
        sources = {
            "harder_better.mid": "https://www.presetpatch.com/midi/Daft_Punk_Harder_Better_Faster_Stronger.mid",
            "da_funk.mid": "https://mididb.com/files/DaftPunk_DaFunk.mid",
            "around_the_world.mid": "https://mididb.com/files/DaftPunk_AroundTheWorld.mid",
            "daft_pack.zip": "https://archive.org/download/daft_punk_midi_samples/daft_midi_pack.zip",
        }
        for name, url in sources.items():
            target = self.midis_dir / name
            if target.exists():
                continue
            subprocess.run(["curl", "-L", "--fail", "--retry", "5", url, "-o", str(target)], check=True)
            if target.suffix == ".zip":
                with zipfile.ZipFile(target) as zf:
                    zf.extractall(self.midis_dir)
                target.unlink(missing_ok=True)

    def _prepare_sequences(self) -> np.ndarray:
        notes: List[str] = []
        for midi_file in sorted(self.midis_dir.glob("*.mid")):
            try:
                parsed = converter.parse(midi_file)
            except Exception as exc:  # pylint: disable=broad-except
                print(f"[WARN] Could not parse {midi_file}: {exc}")
                continue
            for element in parsed.flat.notes:
                if isinstance(element, note.Note):
                    notes.append(str(element.pitch))
                elif isinstance(element, chord.Chord):
                    notes.append(".".join(str(n) for n in element.pitches))
        unique = sorted(set(notes))
        if not unique:
            raise RuntimeError("No MIDI notes were extracted from the corpus.")
        self.note_to_idx = {n: i for i, n in enumerate(unique)}
        self.idx_to_note = {i: n for n, i in self.note_to_idx.items()}
        indices = [self.note_to_idx[n] for n in notes]
        sequences = []
        for i in range(0, len(indices) - self.sequence_length):
            chunk = indices[i : i + self.sequence_length + 1]
            sequences.append(chunk)
        if len(sequences) < 32:
            raise RuntimeError("Insufficient MIDI material. Add more files to ~/DaftCitadel/MIDIs.")
        return np.array(sequences, dtype=np.int64)

    def train(self, epochs: int = 50, lr: float = 5e-4) -> Path:
        self._download_corpus()
        data = self._prepare_sequences()
        x = torch.tensor(data[:, :-1], dtype=torch.long, device=self.device)
        y = torch.tensor(data[:, 1:], dtype=torch.long, device=self.device)
        dataset = torch.utils.data.TensorDataset(x, y)
        loader = torch.utils.data.DataLoader(dataset, batch_size=64, shuffle=True)

        model = DaftMIDITransformer(len(self.note_to_idx), sequence_length=self.sequence_length).to(self.device)
        optimizer = optim.Adam(model.parameters(), lr=lr)
        criterion = nn.CrossEntropyLoss()

        for epoch in range(1, epochs + 1):
            losses = []
            for xb, yb in loader:
                optimizer.zero_grad()
                out = model(xb)
                loss = criterion(out.reshape(-1, out.size(-1)), yb.reshape(-1))
                loss.backward()
                nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
                optimizer.step()
                losses.append(loss.item())
            mean_loss = float(np.mean(losses))
            print(f"[TRAIN] Epoch {epoch:02d}/{epochs} | Loss {mean_loss:.4f}")
        artifact = self.models_dir / "daft_transformer.pth"
        torch.save(
            {
                "state_dict": model.state_dict(),
                "note_to_idx": self.note_to_idx,
                "idx_to_note": self.idx_to_note,
                "sequence_length": self.sequence_length,
            },
            artifact,
        )
        print(f"[MODEL] Saved transformer to {artifact}")
        self.model = model
        return artifact

    def _ensure_model(self) -> DaftMIDITransformer:
        if self.model is not None:
            return self.model
        artifact = self.models_dir / "daft_transformer.pth"
        checkpoint = torch.load(artifact, map_location=self.device)
        model = DaftMIDITransformer(len(checkpoint["note_to_idx"]), sequence_length=checkpoint["sequence_length"])
        model.load_state_dict(checkpoint["state_dict"])
        model.to(self.device)
        model.eval()
        self.note_to_idx = checkpoint["note_to_idx"]
        mapping = checkpoint["idx_to_note"]
        if mapping and isinstance(next(iter(mapping.keys())), str):
            mapping = {int(k): v for k, v in mapping.items()}
        self.idx_to_note = mapping
        self.model = model
        return model

    def _render_notes(self, tokens: List[int], tempo: int, name: str) -> Path:
        midi = MIDIFile(1)
        midi.addTempo(0, 0, tempo)
        timestamp = 0.0
        for token in tokens:
            note_name = self.idx_to_note[token]
            duration = 0.25
            velocity = 100
            if "." in note_name:
                for component in note_name.split('.'):
                    midi.addNote(0, 0, note.Note(component).pitch.midi, timestamp, duration, velocity)
            else:
                midi.addNote(0, 0, note.Note(note_name).pitch.midi, timestamp, duration, velocity)
            timestamp += duration
        output = self.midis_dir / f"{name}.mid"
        with open(output, "wb") as handle:
            midi.writeFile(handle)
        print(f"[RIFF] Wrote {output}")
        return output

    def generate_transformer(self, style: str, tempo: int, bars: int) -> Path:
        model = self._ensure_model()
        seed_note = {
            "da_funk": "C2",
            "around_world": "D2",
            "harder_better": "F2",
        }.get(style, "C2")
        sequence = [self.note_to_idx.get(seed_note, 0)] * self.sequence_length
        generated: List[int] = []
        total_steps = bars * 16
        for _ in range(total_steps):
            logits = model(torch.tensor([sequence], dtype=torch.long, device=self.device))
            probabilities = torch.softmax(logits[0, -1], dim=0).cpu().numpy()
            token = int(np.random.choice(len(probabilities), p=probabilities))
            generated.append(token)
            sequence = sequence[1:] + [token]
        return self._render_notes(generated, tempo, f"daft_gen_{style}")

    def generate_isobar(self, style: str, tempo: int, bars: int) -> Path:
        scale = iso.Scale.minor if style == "da_funk" else iso.Scale.major
        root = 36 if style == "da_funk" else 60
        filename = self.midis_dir / f"isobar_{style}.mid"
        device = iso.io.midi.MidiFileOutputDevice(filename)
        timeline = iso.Timeline(tempo=tempo, output_device=device)
        pattern = iso.PDegree(iso.PSeq([0, 2, 3, 5, 7, 5, 3, 2], 1), scale) + root
        amplitude = iso.PSequence([80, 65, 55, 70]) + iso.PBrown(0, 2, -12, 12)
        rhythm = iso.PEuclidean(16, 10, 16)
        timeline.schedule(
            {
                "note": pattern,
                "duration": 0.25,
                "amplitude": amplitude,
                "gate": rhythm,
            },
            duration=bars,
        )
        timeline.run()
        print(f"[ISOBAR] Wrote {filename}")
        return filename

    def preview(self, midi_path: Path) -> None:
        if not self.sf2.exists():
            print(f"[WARN] SoundFont {self.sf2} missing; skipping preview")
            return
        try:
            subprocess.run(["fluidsynth", "-a", "pulseaudio", str(self.sf2), str(midi_path)], check=True)
        except subprocess.CalledProcessError as exc:
            print(f"[WARN] Fluidsynth exited with {exc.returncode}")

    def run(self, mode: str, style: str, tempo: int, bars: int) -> None:
        if mode == "train":
            artifact = self.train()
            print(f"[DONE] Model trained: {artifact}")
            return
        self._download_corpus()
        self._prepare_sequences()
        if mode == "isobar":
            midi_path = self.generate_isobar(style, tempo, bars)
        else:
            midi_path = self.generate_transformer(style, tempo, bars)
        self.preview(midi_path)


def main() -> None:
    base_dir = Path(os.environ.get("CITADEL_HOME", Path.home() / "DaftCitadel"))
    trainer = DaftMIDITrainer(base_dir)
    mode = "train"
    style = "da_funk"
    tempo = 128
    bars = 16
    for arg in sys.argv[1:]:
        if arg == "--train":
            mode = "train"
        elif arg.startswith("--generate="):
            mode = "generate"
            style = arg.split("=", 1)[1]
        elif arg == "--isobar":
            mode = "isobar"
        elif arg.startswith("--tempo="):
            tempo = int(arg.split("=", 1)[1])
        elif arg.startswith("--bars="):
            bars = int(arg.split("=", 1)[1])
    trainer.run(mode, style, tempo, bars)


if __name__ == "__main__":
    import sys

    main()
EOF_TRAINER
    else
        cat >"$BASE/daft_midi_trainer.py" <<'EOF_STUB'
#!/usr/bin/env python3
"""Stub trainer for profiles without AI support."""
import sys


def main() -> None:
    print("Daft Citadel AI features are disabled for this profile.")
    print("Re-run the installer with --profile=hybrid or --profile=citadel to enable them.")
    if sys.argv[1:]:
        print("Arguments received:", " ".join(sys.argv[1:]))


if __name__ == "__main__":
    main()
EOF_STUB
    fi
    chown "$USER_NAME:$USER_NAME" "$BASE/daft_midi_trainer.py"

    log "[TEMPLATES] Writing Ardour templates"
    if $ENABLE_EXPANDED_SYNTHS; then
        cat >"$BASE/Templates/da_funk.ardour" <<'EOF_DAFUNK'
<?xml version="1.0" encoding="UTF-8"?>
<Session version="7001" name="Daft_da_funk" sample-rate="48000" meter-denominator="4" meter-numerator="4" tempo="128000">
  <Metadata>
    <Description>Daft Funk template with Vital bass, TAL Vocoder, Surge lead, and Valhalla reverb chain.</Description>
  </Metadata>
  <Routes>
    <Route name="Da Funk Drums" default-type="audio" strict-io="1" remote-control-id="1">
      <Processor id="0" name="a-FluidSynth" type="instrument"/>
      <Processor id="1" name="Calf Multiband Compressor" type="lv2"/>
    </Route>
    <Route name="Vital Bass" default-type="audio" remote-control-id="2">
      <Processor id="0" name="Vital" type="vst3"/>
      <Processor id="1" name="ValhallaSupermassive" type="vst3"/>
    </Route>
    <Route name="Surge Lead" default-type="audio" remote-control-id="3">
      <Processor id="0" name="Surge XT" type="vst3"/>
      <Processor id="1" name="Calf Filter" type="lv2"/>
      <Processor id="2" name="Dragonfly Hall Reverb" type="lv2"/>
    </Route>
    <Route name="Vocoder" default-type="audio" remote-control-id="4">
      <Processor id="0" name="TAL-Vocoder" type="lv2"/>
      <Processor id="1" name="Calf Vintage Delay" type="lv2"/>
    </Route>
  </Routes>
</Session>
EOF_DAFUNK

        cat >"$BASE/Templates/around_world.ardour" <<'EOF_AROUND'
<?xml version="1.0" encoding="UTF-8"?>
<Session version="7001" name="Daft_around_world" sample-rate="48000" meter-denominator="4" meter-numerator="4" tempo="120000">
  <Metadata>
    <Description>Around the World template with filtered Surge bass, vocoder pads, and TR-909 drums.</Description>
  </Metadata>
  <Routes>
    <Route name="TR-909 Kit" default-type="audio" remote-control-id="5">
      <Processor id="0" name="a-FluidSynth" type="instrument"/>
      <Processor id="1" name="Calf Compressor" type="lv2"/>
    </Route>
    <Route name="Surge Bass" default-type="audio" remote-control-id="6">
      <Processor id="0" name="Surge XT" type="vst3"/>
      <Processor id="1" name="ValhallaSupermassive" type="vst3"/>
    </Route>
    <Route name="Vocoder Pads" default-type="audio" remote-control-id="7">
      <Processor id="0" name="TAL-Vocoder" type="lv2"/>
      <Processor id="1" name="Calf Rotary Speaker" type="lv2"/>
    </Route>
    <Route name="FX Bus" default-type="bus" remote-control-id="8">
      <Processor id="0" name="Dragonfly Plate Reverb" type="lv2"/>
      <Processor id="1" name="Calf Stereo Tools" type="lv2"/>
    </Route>
  </Routes>
</Session>
EOF_AROUND
    else
        cat >"$BASE/Templates/daft_apex.ardour" <<'EOF_APEX'
<?xml version="1.0" encoding="UTF-8"?>
<Session version="7001" name="Daft_Apex" sample-rate="48000" meter-denominator="4" meter-numerator="4" tempo="124000">
  <Metadata>
    <Description>Streamlined Daft Apex template with Surge and Helm layers.</Description>
  </Metadata>
  <Routes>
    <Route name="Helm Bass" default-type="audio" remote-control-id="1">
      <Processor id="0" name="Helm" type="vst3"/>
      <Processor id="1" name="Dragonfly Hall Reverb" type="lv2"/>
    </Route>
    <Route name="Surge Lead" default-type="audio" remote-control-id="2">
      <Processor id="0" name="Surge XT" type="vst3"/>
      <Processor id="1" name="Calf Filter" type="lv2"/>
    </Route>
    <Route name="Beat Bus" default-type="audio" remote-control-id="3">
      <Processor id="0" name="a-FluidSynth" type="instrument"/>
      <Processor id="1" name="Calf Compressor" type="lv2"/>
    </Route>
  </Routes>
</Session>
EOF_APEX
    fi
    chown -R "$USER_NAME:$USER_NAME" "$BASE/Templates"

    log "[GUI] Creating PySide6 control surface"
    cat >"$BASE/citadel_gui.py" <<'EOF_GUI'
import json
import os
import random
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Iterator

from midiutil import MIDIFile
from PySide6 import QtCore, QtGui, QtWidgets

HOME = Path.home()
BASE = Path(os.environ.get("CITADEL_HOME", str(HOME / "DaftCitadel")))
PROFILE_FILE = BASE / "citadel_profile.json"
PROFILE_DATA: dict = {"features": {}}
if PROFILE_FILE.exists():
    try:
        PROFILE_DATA = json.loads(PROFILE_FILE.read_text())
    except json.JSONDecodeError:
        PROFILE_DATA = {"features": {}}
FEATURES = PROFILE_DATA.get("features", {})
AI_ENABLED = bool(FEATURES.get("ai", False))
CONTAINER_MODE = bool(FEATURES.get("container", False))

CFG_DIR = HOME / ".config" / "DaftCitadel"
CFG_DIR.mkdir(parents=True, exist_ok=True)
CFG_FILE = CFG_DIR / "config.json"
THEME_DIR = BASE / "Theme"
VENV_BIN = BASE / ".venv" / "bin"
PYTHON_BIN = VENV_BIN / "python"
TRAINER = BASE / "daft_midi_trainer.py"
SF2 = Path("/usr/share/sounds/sf2/FluidR3_GM.sf2")
STYLES = ["da_funk", "around_world", "harder_better"]


def load_cfg() -> dict:
    if CFG_FILE.exists():
        try:
            return json.loads(CFG_FILE.read_text())
        except json.JSONDecodeError:
            pass
    defaults = {"quantum": 32, "style": STYLES[0], "tempo": 128, "bars": 16}
    CFG_FILE.write_text(json.dumps(defaults, indent=2))
    return defaults


def save_cfg(cfg: dict) -> None:
    CFG_FILE.write_text(json.dumps(cfg, indent=2))


def run_stream(cmd: list[str]) -> Iterator[str]:
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if process.stdout:
        for line in process.stdout:
            yield line.rstrip()
    process.wait()
    yield f"[exit {process.returncode}]"


class LogView(QtWidgets.QPlainTextEdit):
    def __init__(self) -> None:
        super().__init__()
        self.setReadOnly(True)
        self.setMaximumBlockCount(10000)

    def append(self, text: str) -> None:
        self.appendPlainText(text)


class CitadelGUI(QtWidgets.QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Daft Citadel — Control Surface")
        self.resize(1380, 820)

        if (THEME_DIR / "style.qss").exists():
            self.setStyleSheet((THEME_DIR / "style.qss").read_text())
        bg_path = THEME_DIR / "background.jpg"
        if bg_path.exists():
            palette = QtGui.QPalette()
            palette.setBrush(QtGui.QPalette.Window, QtGui.QBrush(QtGui.QPixmap(str(bg_path))))
            self.setPalette(palette)
        icon_png = THEME_DIR / "icon.png"
        if icon_png.exists():
            self.setWindowIcon(QtGui.QIcon(str(icon_png)))

        self.cfg = load_cfg()
        self.log = LogView()

        self.audio_btn = QtWidgets.QPushButton("Initialize Audio")
        self.quantum_btn = QtWidgets.QPushButton(f"Quantum: {self.cfg['quantum']} frames")
        self.style_combo = QtWidgets.QComboBox()
        self.style_combo.addItems(STYLES)
        self.style_combo.setCurrentText(self.cfg["style"])
        self.tempo_spin = QtWidgets.QSpinBox()
        self.tempo_spin.setRange(80, 180)
        self.tempo_spin.setValue(self.cfg["tempo"])
        self.bars_spin = QtWidgets.QSpinBox()
        self.bars_spin.setRange(4, 256)
        self.bars_spin.setValue(self.cfg["bars"])

        self.quick_btn = QtWidgets.QPushButton("Quick Riff")
        self.ai_btn = QtWidgets.QPushButton("AI Riff")
        self.iso_btn = QtWidgets.QPushButton("Isobar Riff")
        self.preview_btn = QtWidgets.QPushButton("Preview Latest MIDI")
        self.train_btn = QtWidgets.QPushButton("Train Transformer")

        self.ardour_btn = QtWidgets.QPushButton("Launch Ardour")
        self.template_combo = QtWidgets.QComboBox()
        template_names = [p.stem for p in sorted((BASE / "Templates").glob("*.ardour"))]
        if not template_names:
            template_names = ["default"]
        self.template_combo.addItems(template_names)
        self.lmms_btn = QtWidgets.QPushButton("Launch LMMS")
        self.carla_btn = QtWidgets.QPushButton("Open Carla")

        self.presets_btn = QtWidgets.QPushButton("Open Presets")
        self.samples_btn = QtWidgets.QPushButton("Open Samples")
        self.midis_btn = QtWidgets.QPushButton("Open MIDIs")
        self.projects_btn = QtWidgets.QPushButton("Open Projects")

        self.presets_list = QtWidgets.QListWidget()
        self.samples_list = QtWidgets.QListWidget()

        left_layout = QtWidgets.QGridLayout()
        left_layout.addWidget(QtWidgets.QLabel("Audio"), 0, 0, 1, 2)
        left_layout.addWidget(self.audio_btn, 1, 0, 1, 2)
        left_layout.addWidget(self.quantum_btn, 1, 2, 1, 2)

        left_layout.addWidget(QtWidgets.QLabel("Riff Generator"), 2, 0, 1, 4)
        left_layout.addWidget(QtWidgets.QLabel("Style"), 3, 0)
        left_layout.addWidget(self.style_combo, 3, 1)
        left_layout.addWidget(QtWidgets.QLabel("Tempo"), 3, 2)
        left_layout.addWidget(self.tempo_spin, 3, 3)
        left_layout.addWidget(QtWidgets.QLabel("Bars"), 4, 2)
        left_layout.addWidget(self.bars_spin, 4, 3)
        left_layout.addWidget(self.quick_btn, 5, 0)
        left_layout.addWidget(self.ai_btn, 5, 1)
        left_layout.addWidget(self.iso_btn, 5, 2)
        left_layout.addWidget(self.preview_btn, 5, 3)
        left_layout.addWidget(self.train_btn, 6, 0, 1, 4)

        left_layout.addWidget(QtWidgets.QLabel("DAWs"), 7, 0, 1, 4)
        left_layout.addWidget(self.ardour_btn, 8, 0)
        left_layout.addWidget(self.template_combo, 8, 1)
        left_layout.addWidget(self.lmms_btn, 8, 2)
        left_layout.addWidget(self.carla_btn, 8, 3)

        left_layout.addWidget(QtWidgets.QLabel("Library"), 9, 0, 1, 4)
        left_layout.addWidget(self.presets_btn, 10, 0)
        left_layout.addWidget(self.samples_btn, 10, 1)
        left_layout.addWidget(self.midis_btn, 10, 2)
        left_layout.addWidget(self.projects_btn, 10, 3)

        left_widget = QtWidgets.QWidget()
        left_widget.setLayout(left_layout)

        right_layout = QtWidgets.QVBoxLayout()
        right_layout.addWidget(QtWidgets.QLabel("Presets"))
        right_layout.addWidget(self.presets_list)
        right_layout.addWidget(QtWidgets.QLabel("Samples"))
        right_layout.addWidget(self.samples_list)
        right_widget = QtWidgets.QWidget()
        right_widget.setLayout(right_layout)

        splitter = QtWidgets.QSplitter(QtCore.Qt.Horizontal)
        splitter.addWidget(left_widget)
        splitter.addWidget(right_widget)
        splitter.setSizes([720, 520])

        root_split = QtWidgets.QSplitter(QtCore.Qt.Vertical)
        root_split.addWidget(splitter)
        root_split.addWidget(self.log)
        root_split.setSizes([620, 200])
        self.setCentralWidget(root_split)

        self.audio_btn.clicked.connect(self.initialize_audio)
        self.quantum_btn.clicked.connect(self.update_quantum)
        self.quick_btn.clicked.connect(self.generate_quick)
        self.ai_btn.clicked.connect(self.generate_ai)
        self.iso_btn.clicked.connect(self.generate_isobar)
        self.preview_btn.clicked.connect(self.preview_latest)
        self.train_btn.clicked.connect(self.train_model)
        self.ardour_btn.clicked.connect(self.launch_ardour)
        self.lmms_btn.clicked.connect(lambda: self.launch_process("lmms"))
        self.carla_btn.clicked.connect(lambda: self.launch_process("carla"))
        self.presets_btn.clicked.connect(lambda: self.open_path(BASE / "Presets"))
        self.samples_btn.clicked.connect(lambda: self.open_path(BASE / "Samples"))
        self.midis_btn.clicked.connect(lambda: self.open_path(BASE / "MIDIs"))
        self.projects_btn.clicked.connect(lambda: self.open_path(BASE / "Projects"))
        self.style_combo.currentTextChanged.connect(self._change_style)
        self.tempo_spin.valueChanged.connect(self._change_tempo)
        self.bars_spin.valueChanged.connect(self._change_bars)
        self.presets_list.itemDoubleClicked.connect(self._focus_asset)
        self.samples_list.itemDoubleClicked.connect(self._focus_asset)

        self.ai_available = AI_ENABLED and TRAINER.exists() and PYTHON_BIN.exists()
        if not self.ai_available:
            self.ai_btn.setEnabled(False)
            self.iso_btn.setEnabled(False)
            self.train_btn.setEnabled(False)
            self.log.append("[INFO] AI toolchain disabled for this profile.")

        self.refresh_lists()
        self._log_status()

    def _log_status(self) -> None:
        self.log.append(f"[BASE] {BASE}")
        self.log.append(f"[PROFILE] {PROFILE_DATA.get('profile', 'unknown')}")
        self.log.append(f"[VENV] {PYTHON_BIN if PYTHON_BIN.exists() else 'missing'}")
        self.log.append(f"[AI] {'enabled' if self.ai_available else 'disabled'}")
        self.log.append(f"[Container] {'yes' if CONTAINER_MODE else 'no'}")

    def initialize_audio(self) -> None:
        if shutil.which("systemctl") and not CONTAINER_MODE:
            cmd = ["systemctl", "--user", "enable", "--now", "pipewire", "pipewire-pulse", "wireplumber"]
            self._run_and_log(cmd)
        else:
            self.log.append("[SKIP] systemctl not available in this environment")
        if shutil.which("pw-metadata"):
            cmd = ["pw-metadata", "-n", "settings", "0", "clock.force-quantum", str(self.cfg["quantum"])]
            self._run_and_log(cmd)
        else:
            self.log.append("[WARN] pw-metadata not found")

    def update_quantum(self) -> None:
        value, ok = QtWidgets.QInputDialog.getInt(self, "Quantum Frames", "Frames (16-512):", self.cfg["quantum"], 16, 512, 1)
        if not ok:
            return
        self.cfg["quantum"] = value
        save_cfg(self.cfg)
        self.quantum_btn.setText(f"Quantum: {value} frames")
        if shutil.which("pw-metadata"):
            cmd = ["pw-metadata", "-n", "settings", "0", "clock.force-quantum", str(value)]
            self._run_and_log(cmd)
        else:
            self.log.append("[WARN] pw-metadata not found")

    def generate_quick(self) -> None:
        style = self.cfg["style"]
        tempo = self.cfg["tempo"]
        bars = self.cfg["bars"]
        midi = MIDIFile(1)
        midi.addTempo(0, 0, tempo)
        note_pool = {
            "da_funk": [36, 38, 40, 43, 45, 47],
            "around_world": [60, 62, 64, 67, 69, 71],
            "harder_better": [48, 50, 53, 55, 58, 60],
        }.get(style, [60])
        timestamp = 0.0
        for _ in range(bars * 16):
            midi.addNote(0, 0, random.choice(note_pool), timestamp, 0.25, random.randint(80, 120))
            timestamp += 0.25
        output = BASE / "MIDIs" / f"quick_{style}.mid"
        with open(output, "wb") as handle:
            midi.writeFile(handle)
        self.log.append(f"[RIFF] Quick riff saved to {output}")
        self._preview_midi(output)

    def generate_ai(self) -> None:
        if not self.ai_available:
            self.log.append("[WARN] AI toolchain is not available.")
            return
        style = self.cfg["style"]
        tempo = self.cfg["tempo"]
        bars = self.cfg["bars"]
        cmd = [str(PYTHON_BIN), str(TRAINER), f"--generate={style}", f"--tempo={tempo}", f"--bars={bars}"]
        self._run_and_log(cmd)

    def generate_isobar(self) -> None:
        if not self.ai_available:
            self.log.append("[WARN] AI toolchain is not available.")
            return
        style = self.cfg["style"]
        tempo = self.cfg["tempo"]
        bars = self.cfg["bars"]
        cmd = [str(PYTHON_BIN), str(TRAINER), f"--generate={style}", "--isobar", f"--tempo={tempo}", f"--bars={bars}"]
        self._run_and_log(cmd)

    def preview_latest(self) -> None:
        midis = sorted((BASE / "MIDIs").glob("*.mid"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not midis:
            self.log.append("[WARN] No MIDI files available.")
            return
        self._preview_midi(midis[0])

    def _preview_midi(self, path: Path) -> None:
        if not SF2.exists():
            self.log.append(f"[WARN] SoundFont missing: {SF2}")
            return
        if not shutil.which("fluidsynth"):
            self.log.append("[WARN] fluidsynth executable not found")
            return
        cmd = ["fluidsynth", "-a", "pulseaudio", str(SF2), str(path)]
        self._run_and_log(cmd)

    def train_model(self) -> None:
        if not self.ai_available:
            self.log.append("[WARN] AI toolchain is not available.")
            return
        cmd = [str(PYTHON_BIN), str(TRAINER), "--train"]
        self._run_and_log(cmd)

    def launch_ardour(self) -> None:
        if not shutil.which("ardour"):
            self.log.append("[WARN] Ardour executable not found")
            return
        template = self.template_combo.currentText()
        template_path = BASE / "Templates" / f"{template}.ardour"
        cmd = ["ardour", "--new", f"Daft_{template}"]
        if template_path.exists():
            cmd.extend(["--template", str(template_path)])
        self._run_and_log(cmd, spawn=True)

    def launch_process(self, name: str) -> None:
        if not shutil.which(name):
            self.log.append(f"[WARN] {name} executable not found")
            return
        self._run_and_log([name], spawn=True)

    def refresh_lists(self) -> None:
        self.presets_list.clear()
        self.samples_list.clear()
        presets_dir = BASE / "Presets"
        if presets_dir.exists():
            for preset in sorted(presets_dir.rglob("*")):
                if preset.suffix.lower() in {".vital", ".vitalbank", ".fxp", ".surge", ".preset"}:
                    self.presets_list.addItem(str(preset.relative_to(BASE)))
        samples_dir = BASE / "Samples"
        if samples_dir.exists():
            for sample in sorted(samples_dir.rglob("*.wav")):
                self.samples_list.addItem(str(sample.relative_to(BASE)))

    def open_path(self, path: Path) -> None:
        path.mkdir(parents=True, exist_ok=True)
        opener = shutil.which("xdg-open")
        if opener:
            subprocess.Popen([opener, str(path)])
        else:
            self.log.append(f"[INFO] Directory available at {path}")

    def _change_style(self, style: str) -> None:
        self.cfg["style"] = style
        save_cfg(self.cfg)

    def _change_tempo(self, value: int) -> None:
        self.cfg["tempo"] = value
        save_cfg(self.cfg)

    def _change_bars(self, value: int) -> None:
        self.cfg["bars"] = value
        save_cfg(self.cfg)

    def _focus_asset(self, item: QtWidgets.QListWidgetItem) -> None:
        path = BASE / item.text()
        self.log.append(f"[ASSET] {path}")

    def _run_and_log(self, cmd: list[str], spawn: bool = False) -> None:
        self.log.append(f"$ {' '.join(cmd)}")
        if spawn:
            subprocess.Popen(cmd)
            return
        for line in run_stream(cmd):
            self.log.append(line)


def main() -> None:
    app = QtWidgets.QApplication(sys.argv)
    window = CitadelGUI()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
EOF_GUI
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
cat >>"$USER_HOME/.profile" <<EOF_PROFILE
export CITADEL_DAW_PATH="$DAW_PATH"
export LV2_PATH="${LV2_PATH:-$DAW_PATH}"
export VST3_PATH="${VST3_PATH:-$DAW_PATH}"
export VST_PATH="${VST_PATH:-$DAW_PATH}"
export CITADEL_HOME="$BASE"
EOF_PROFILE
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

if ! $CONTAINER_MODE && confirm "Reboot system now?"; then
    log "[REBOOT] Rebooting to finalize configuration"
    reboot
fi

