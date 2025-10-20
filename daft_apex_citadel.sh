#!/usr/bin/env bash
# Daft_Punk_Ubuntu_Apex_Citadel — v5.3 (Consolidated Turn-Key)
# Ubuntu 24.04+ • Low-latency PipeWire/JACK • Ardour + Carla • Surge XT + Helm • Citadel GUI
# Flags: --auto (no prompts)  --gpu-off (force CPU)

set -euo pipefail

AUTO=false
GPU_OFF=false
for arg in "$@"; do
  case "$arg" in
    --auto) AUTO=true ;;
    --gpu-off) GPU_OFF=true ;;
  esac
done
confirm() { $AUTO && return 0; read -r -p "$1 [y/N]: " a; [[ "${a,,}" =~ ^y(es)?$ ]]; }

# --- Root & distro checks ---
[[ $EUID -eq 0 ]] || { echo "[ERR] Run as root (sudo)."; exit 1; }
grep -qi Ubuntu /etc/os-release || { echo "[ERR] Target: Ubuntu 24.04+."; exit 1; }

# --- Resolve invoking user ---
USER_NAME="${SUDO_USER:-$(logname 2>/dev/null || echo "")}" 
[[ -n "${USER_NAME:-}" ]] || { echo "[ERR] Cannot resolve non-root username."; exit 1; }
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"
[[ -d "$USER_HOME" ]] || { echo "[ERR] Cannot resolve home for $USER_NAME."; exit 1; }
as_user(){ sudo -u "$USER_NAME" -H bash -lc "$*"; }

# --- Paths ---
BASE="$USER_HOME/DaftCitadel"
VENV="$BASE/.venv"
LOG="$USER_HOME/daft_citadel.log"
mkdir -p "$BASE"; touch "$LOG"; chown -R "$USER_NAME:$USER_NAME" "$BASE" "$LOG"
echo "[IGNITION] Citadel deployment @ $(date)" | tee -a "$LOG"

apt_install(){ DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"; }
sysctl_set(){ local k="$1" v="$2"; grep -q "^$k=" /etc/sysctl.conf 2>/dev/null || echo "$k=$v" >> /etc/sysctl.conf; sysctl -w "$k=$v" >/dev/null; }
dl(){ local url="$1" dest="$2"; echo "[DL] $url -> $dest" | tee -a "$LOG"; mkdir -p "$(dirname "$dest")"; curl -L --fail --retry 5 --retry-delay 2 --progress-bar "$url" -o "$dest"; }

# --- Preflight ---
echo "[SYS] Updating…" | tee -a "$LOG"
apt-get update -y
apt_install software-properties-common
apt-get upgrade -y
add-apt-repository -y universe
add-apt-repository -y multiverse
apt-get update -y

# --- Audio: PipeWire/JACK + realtime (user-bus safe) ---
echo "[AUDIO] PipeWire/JACK + realtime…" | tee -a "$LOG"
apt_install pipewire pipewire-jack pipewire-pulse wireplumber \
            jackd2 rtirq-init alsa-utils libasound2-plugins \
            ubuntustudio-pipewire-config dbus-user-session

getent group realtime >/dev/null || groupadd -r realtime
if ! id -nG "$USER_NAME" | grep -q "\baudio\b"; then
  if usermod -a -G audio "$USER_NAME"; then
    echo "[AUDIO] Added $USER_NAME to audio group" | tee -a "$LOG"
  else
    echo "[WARN] Failed to add $USER_NAME to audio group" | tee -a "$LOG"
  fi
fi
if ! id -nG "$USER_NAME" | grep -q "\brealtime\b"; then
  if usermod -a -G realtime "$USER_NAME"; then
    echo "[AUDIO] Added $USER_NAME to realtime group" | tee -a "$LOG"
  else
    echo "[WARN] Failed to add $USER_NAME to realtime group" | tee -a "$LOG"
  fi
fi

mkdir -p /etc/security/limits.d
cat >/etc/security/limits.d/audio.conf <<'EOF2'
@audio    -  rtprio     95
@audio    -  memlock    unlimited
@realtime -  rtprio     98
@realtime -  memlock    unlimited
EOF2

if command -v loginctl >/dev/null 2>&1; then
  LINGER_STATE=$(loginctl show-user "$USER_NAME" -p Linger 2>/dev/null | cut -d= -f2 || echo "")
  if [[ "$LINGER_STATE" != "yes" ]]; then
    if loginctl enable-linger "$USER_NAME"; then
      echo "[SYS] Enabled linger for $USER_NAME" | tee -a "$LOG"
    else
      echo "[WARN] Could not enable linger for $USER_NAME" | tee -a "$LOG"
    fi
  fi
else
  echo "[WARN] loginctl not available; skipping linger enable." | tee -a "$LOG"
fi
as_user "mkdir -p ~/.config/daftcitadel ~/.config/autostart"
cat >"$USER_HOME/.config/daftcitadel/first-login.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
if command -v systemctl >/dev/null 2>&1; then
  if ! systemctl --user enable --now pipewire pipewire-pulse wireplumber; then
    echo "[WARN] Unable to enable PipeWire services" >&2
  fi
else
  echo "[WARN] systemctl unavailable; cannot enable PipeWire services" >&2
fi
if command -v pw-metadata >/dev/null 2>&1; then
  if ! pw-metadata -n settings 0 clock.force-quantum 64; then
    echo "[WARN] Unable to set PipeWire quantum" >&2
  fi
else
  echo "[WARN] pw-metadata not found; skipping quantum configuration" >&2
fi
rm -f "$HOME/.config/autostart/daftcitadel-first-login.desktop" "$HOME/.config/daftcitadel/first-login.sh"
EOS
chmod +x "$USER_HOME/.config/daftcitadel/first-login.sh"
cat >"$USER_HOME/.config/autostart/daftcitadel-first-login.desktop" <<EOD
[Desktop Entry]
Type=Application
Name=DaftCitadel First-Login Init
Exec=$USER_HOME/.config/daftcitadel/first-login.sh
OnlyShowIn=GNOME;KDE;XFCE;LXQt;MATE;Unity;Pantheon;
X-GNOME-Autostart-enabled=true
EOD
chown -R "$USER_NAME:$USER_NAME" "$USER_HOME/.config/daftcitadel" "$USER_HOME/.config/autostart"

# --- Kernel & memory tuning ---
echo "[TUNE] governor=performance, swappiness=1" | tee -a "$LOG"
count=0
for g in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
  if [[ -w "$g" ]] && echo performance > "$g" 2>/dev/null; then
    ((count++))
  fi
done
if [[ $count -eq 0 ]]; then
  echo "[WARN] Could not set CPU governor to performance (may require manual configuration)." | tee -a "$LOG"
fi
sysctl_set vm.swappiness 1

# --- GPU / CUDA (non-intrusive) ---
gpu_detect() {
  GPU_METHOD=""
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
    GPU_METHOD="nvidia-smi"
    return 0
  fi
  if [[ -e /proc/driver/nvidia/version ]]; then
    GPU_METHOD="/proc/driver/nvidia"
    return 0
  fi
  local drivers=(/sys/bus/pci/devices/*/driver)
  for drv in "${drivers[@]}"; do
    [[ -e "$drv" ]] || continue
    if readlink "$drv" 2>/dev/null | grep -qi nvidia; then
      GPU_METHOD="$drv"
      return 0
    fi
  done
  if command -v lspci >/dev/null 2>&1 && lspci | grep -qi nvidia; then
    GPU_METHOD="lspci"
    return 0
  fi
  return 1
}
if ! $GPU_OFF && gpu_detect; then
  echo "[GPU] NVIDIA detected via $GPU_METHOD → install CUDA toolkit (keep your driver)" | tee -a "$LOG"
  apt_install nvidia-cuda-toolkit
  as_user 'grep -q CUDA_VISIBLE_DEVICES ~/.bashrc || echo "export CUDA_VISIBLE_DEVICES=0" >> ~/.bashrc'
else
  echo "[GPU] CPU pipeline (no NVIDIA or --gpu-off)." | tee -a "$LOG"
fi

# --- DAWs & hosts ---
echo "[DAW] Ardour, LMMS, Carla, tools…" | tee -a "$LOG"
if dpkg -l | grep -q "^ii  ardour"; then
  echo "[DAW] Core DAW packages already installed; skipping." | tee -a "$LOG"
else
  apt_install ardour lmms carla carla-lv2 carla-vst \
              qjackctl pulseaudio-utils p7zip-full unzip zip wget curl git pv
fi

# Optional: Reaper
REAPER_URL="https://www.reaper.fm/files/7.x/reaper712_linux_x86_64.tar.xz"
REAPER_SHA="b9686aac85fa7b8912a04cf99884232304977d7b615ce607b1a2b4dd19f18fd4"
if $AUTO; then INSTALL_REAPER=false; else confirm "[OPT] Install Reaper as alt DAW?" && INSTALL_REAPER=true || INSTALL_REAPER=false; fi
if $INSTALL_REAPER; then
  TMP=/tmp/reaper.tar.xz; dl "$REAPER_URL" "$TMP"
  if ! echo "$REAPER_SHA  $TMP" | sha256sum -c -; then
    echo "[ERR] Reaper checksum mismatch" | tee -a "$LOG"
    rm -f "$TMP"
    exit 1
  fi
  mkdir -p /opt/reaper && tar -xJf "$TMP" --strip-components=1 -C /opt/reaper
  ln -sf /opt/reaper/reaper /usr/local/bin/reaper
  rm -f "$TMP"
fi

# --- Plugins (Ubuntu repos) ---
echo "[PLUGINS] LV2/VST3 suites from repos…" | tee -a "$LOG"
apt_install yoshimi zynaddsubfx hydrogen \
           calf-plugins lsp-plugins mda-lv2 x42-plugins dragonfly-reverb

# --- Plugins (official .debs) ---
echo "[PLUGINS] Surge XT & Helm…" | tee -a "$LOG"
if dpkg -l | grep -q "^ii  surge-xt"; then
  echo "[PLUGINS] Surge XT already installed; skipping." | tee -a "$LOG"
else
  SURGE_DEB="/tmp/surge-xt-linux-x64-1.3.4.deb"
  SURGE_SHA="a6e55064487f624147d515b9ae5fc79a568b69746675b2083abde628ca7bb151"
  dl "https://github.com/surge-synthesizer/releases-xt/releases/download/1.3.4/surge-xt-linux-x64-1.3.4.deb" "$SURGE_DEB"
  if ! echo "$SURGE_SHA  $SURGE_DEB" | sha256sum -c -; then
    echo "[ERR] Surge XT checksum mismatch" | tee -a "$LOG"
    rm -f "$SURGE_DEB"
    exit 1
  fi
  if ! apt-get install -y "$SURGE_DEB"; then
    apt-get install -f -y
    apt-get install -y "$SURGE_DEB"
  fi
  rm -f "$SURGE_DEB"
fi
if dpkg -l | grep -q "^ii  helm"; then
  echo "[PLUGINS] Helm already installed; skipping." | tee -a "$LOG"
else
  HELM_DEB="/tmp/helm_0.9.0_amd64_r.deb"
  HELM_SHA="aedf8b676657f72782513e5ad5f9c61a6bc21fe9357b23052928adafa8215eca"
  dl "https://tytel.org/static/dist/helm_0.9.0_amd64_r.deb" "$HELM_DEB"
  if ! echo "$HELM_SHA  $HELM_DEB" | sha256sum -c -; then
    echo "[ERR] Helm checksum mismatch" | tee -a "$LOG"
    rm -f "$HELM_DEB"
    exit 1
  fi
  if ! apt-get install -y "$HELM_DEB"; then
    apt-get install -f -y
    apt-get install -y "$HELM_DEB"
  fi
  rm -f "$HELM_DEB"
fi

# --- SoundFonts & FluidSynth ---
echo "[MIDI] FluidSynth + GM SoundFonts…" | tee -a "$LOG"
apt_install fluidsynth fluid-soundfont-gm fluid-soundfont-gs
as_user 'grep -q "alias fsynth=" ~/.bashrc || echo "alias fsynth='\''fluidsynth -a pulseaudio /usr/share/sounds/sf2/FluidR3_GM.sf2'\''" >> ~/.bashrc'

# --- Filesystem scaffold ---
as_user "mkdir -p '$BASE'/{Presets/{Surge,Helm,Daft},Samples/{909,Daft},Projects,MIDIs,Models,Templates,Scripts,Docs}"

# --- Python venv + libs ---
echo "[PY] venv + libs…" | tee -a "$LOG"
apt_install python3 python3-venv python3-pip python3-dev build-essential \
            libasound2-dev libsndfile1-dev libportmidi-dev
as_user "python3 -m venv '$VENV'"
cat >"$BASE/requirements.txt" <<'REQ'
torch==2.3.1
mido==1.3.0
midiutil==1.2.1
music21==9.1.0
pygame==2.5.2
PySide6==6.7.1
isobar==0.2.1
REQ
chown "$USER_NAME:$USER_NAME" "$BASE/requirements.txt"
as_user "'$VENV/bin/pip' install --upgrade pip setuptools wheel"
as_user "'$VENV/bin/pip' install -r '$BASE/requirements.txt' || '$VENV/bin/pip' install git+https://github.com/ideoforms/isobar.git@v1.3.0#egg=isobar"

# --- Citadel hub (quick riff) ---
cat >"$BASE/citadel_hub.py" <<'PY'
import os, subprocess, random, time
from midiutil import MIDIFile
from pathlib import Path
BASE = Path(os.environ.get("CITADEL_HOME", str(Path.home() / "DaftCitadel")))
SF2 = "/usr/share/sounds/sf2/FluidR3_GM.sf2"
def preview(p: Path):
    try: subprocess.run(["fluidsynth","-a","pulseaudio",SF2,str(p)], check=True)
    except Exception as e: print(f"[WARN] Preview failed: {e}")
def write_midi(path: Path, notes, tempo=124, dur=0.25, vel=100):
    mf=MIDIFile(1); mf.addTempo(0,0,tempo); t=0
    for n in notes: mf.addNote(0,0,int(n),t,dur,vel); t+=dur
    with open(path,"wb") as f: mf.writeFile(f)
def generate_quick(style="da_funk", bars=16):
    pool=[36,38,40,41,43,45,47] if style=="da_funk" else [60,62,64,65,67,69,71]
    seq=[random.choice(pool)+(random.choice([-12,12]) if random.random()<0.25 else 0) for _ in range(bars*4)]
    out=BASE/"MIDIs"/f"citadel_{style}_{int(time.time())}.mid"; write_midi(out, seq); print(f"[RIFF] {out}"); preview(out)
if __name__=="__main__": generate_quick()
PY
chown "$USER_NAME:$USER_NAME" "$BASE/citadel_hub.py"

# --- AI trainer ---
cat >"$BASE/daft_midi_trainer.py" <<'PY'
import os, sys, subprocess, zipfile, urllib.request
from pathlib import Path
import numpy as np
import torch, torch.nn as nn, torch.optim as optim
from music21 import converter, note, chord
from midiutil import MIDIFile
BASE = Path(os.environ.get("CITADEL_HOME", str(Path.home() / "DaftCitadel")))
MIDIS = BASE/"MIDIs"; MODELS = BASE/"Models"
SF2 = "/usr/share/sounds/sf2/FluidR3_GM.sf2"
MIDIS.mkdir(parents=True, exist_ok=True); MODELS.mkdir(parents=True, exist_ok=True)
CORPUS = []  # add legally-shareable Daft-inspired MIDIs to train
class DaftLSTM(nn.Module):
    def __init__(self, vocab, hidden=256, layers=2):
        super().__init__(); self.embed=nn.Embedding(vocab,128)
        self.lstm=nn.LSTM(128,hidden,layers,batch_first=True); self.fc=nn.Linear(hidden,vocab)
        self.layers=layers; self.hidden=hidden
    def forward(self,x,h): x=self.embed(x); y,h=self.lstm(x,h); return self.fc(y),h
    def init_hidden(self,b,dev): z=lambda: torch.zeros(self.layers,b,self.hidden,device=dev); return (z(),z())
def download_corpus():
    for url in CORPUS:
        name=url.split("/")[-1].split("?")[0] or "midi.mid"; dest=MIDIS/name
        if dest.exists(): continue
        print(f"[DL] {url} → {dest}"); urllib.request.urlretrieve(url,dest)
        if dest.suffix==".zip": 
            with zipfile.ZipFile(dest) as z: z.extractall(MIDIS)
            dest.unlink(missing_ok=True)
def parse_sequences():
    toks=[]
    for p in MIDIS.glob("*.mid"):
        try:
            m=converter.parse(p)
            for el in m.flat.notes:
                if isinstance(el, note.Note): toks.append(str(el.pitch))
                elif isinstance(el, chord.Chord): toks.append(".".join(n.nameWithOctave for n in el.pitches))
        except Exception as e: print(f"[WARN] parse {p}: {e}")
    if not toks:
        print("[WARN] No note tokens extracted; using fallback C-major scale for training.")
        toks=["C4","D4","E4","F4","G4","A4","B4"]
    vocab=sorted(set(toks)); tok2i={t:i for i,t in enumerate(vocab)}; i2tok={i:t for t,i in tok2i.items()}
    seq=[tok2i[t] for t in toks]; X,Y=[],[]
    for i in range(0,len(seq)-33): X.append(seq[i:i+32]); Y.append(seq[i+1:i+33])
    return np.array(X,dtype=np.int64),np.array(Y,dtype=np.int64),tok2i,i2tok
def train(epochs=30, lr=1e-3):
    dev=torch.device("cuda" if torch.cuda.is_available() else "cpu")
    X,Y,tok2i,i2tok=parse_sequences()
    if len(X)==0: print("[ERR] No MIDI sequences in ~/DaftCitadel/MIDIs"); sys.exit(1)
    model=DaftLSTM(vocab=len(tok2i)).to(dev); opt=optim.Adam(model.parameters(),lr=lr); crit=nn.CrossEntropyLoss()
    bs=64; 
    for ep in range(1,epochs+1):
        total=0.0
        for i in range(0,len(X),bs):
            xb=torch.tensor(X[i:i+bs],device=dev); yb=torch.tensor(Y[i:i+bs],device=dev)
            h=model.init_hidden(xb.size(0),dev); opt.zero_grad()
            out,_=model(xb,h); loss=crit(out.reshape(-1,out.size(-1)), yb.reshape(-1))
            loss.backward(); opt.step(); total+=float(loss)
        print(f"[TRAIN] epoch {ep}/{epochs} loss={total/max(1,len(X)//bs):.4f}")
    torch.save({"state":model.state_dict(),"vocab":len(tok2i),"i2tok":i2tok}, MODELS/"daft_lstm.pth")
    print(f"[MODEL] Saved → {MODELS/'daft_lstm.pth'}")
def sample(style="da_funk", bars=16, tempo=124):
    chk=MODELS/"daft_lstm.pth"
    if not chk.exists(): print("[ERR] Model not trained. Run: python daft_midi_trainer.py --train"); sys.exit(1)
    pay=torch.load(chk,map_location="cpu"); i2tok=pay["i2tok"]; vocab=pay["vocab"]
    dev=torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model=DaftLSTM(vocab=vocab).to(dev).eval(); model.load_state_dict(pay["state"])
    seed="C2" if style=="da_funk" else "C4"; seed_idx=next((i for i,t in i2tok.items() if t==seed),0)
    seq=[seed_idx]*32; h=model.init_hidden(1,dev); out=[]
    for _ in range(bars*4):
        x=torch.tensor([seq],device=dev); y,_=model(x,h)
        p=torch.softmax(y[0,-1],dim=0).detach().cpu().numpy(); nxt=int(np.random.choice(len(p),p=p/p.sum()))
        out.append(nxt); seq=seq[1:]+[nxt]
    trk,t=0,0; mf=MIDIFile(1); mf.addTempo(trk,0,tempo)
    for idx in out:
        tok=i2tok.get(idx)
        if tok is None:
            print(f"[WARN] Unknown token index {idx}; skipping")
            continue
        if "." in tok:
            for nm in tok.split("."):
                try:
                    mf.addNote(trk,0,note.Note(nm).pitch.midi,t,0.25,100)
                except (ValueError, AttributeError) as exc:
                    print(f"[WARN] Invalid token '{nm}': {exc}")
                    continue
        else:
            try:
                mf.addNote(trk,0,note.Note(tok).pitch.midi,t,0.25,100)
            except (ValueError, AttributeError) as exc:
                print(f"[WARN] Invalid token '{tok}': {exc}")
                continue
        t+=0.25
    outp=MIDIS/f"daft_gen_{style}.mid"
    with open(outp,"wb") as f: mf.writeFile(f)
    print(f"[RIFF] {outp}")
    try: subprocess.run(["fluidsynth","-a","pulseaudio",SF2,str(outp)],check=True)
    except Exception: pass
if __name__=="__main__":
    if "--train" in sys.argv: download_corpus(); train()
    else:
        style="da_funk"
        for a in sys.argv:
            if a.startswith("--generate="): style=a.split("=")[1]
        sample(style=style)
PY
chown "$USER_NAME:$USER_NAME" "$BASE/daft_midi_trainer.py"

# --- Valid Ardour template (Tempo Map 124 BPM / 4-4) ---
mkdir -p "$BASE/Templates"
cat >"$BASE/Templates/daft_chain.ardour" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<Session version="7000" name="DaftChain">
  <Config/>
  <TempoMap>
    <Tempo time="0" bpm="124.0" note-type="4"/>
    <Meter time="0" num="4" den="4"/>
  </TempoMap>
  <Locations>
    <Location name="start" id="1" start="0" end="0" flags="IsMark Start"/>
    <Location name="end" id="2" start="0" end="300000000" flags="IsMark End"/>
  </Locations>
  <Routes/>
  <Playlists/><Bundles/><Click/><ControlProtocols/><RouteGroups/><VCAs/><Monitor/>
</Session>
XML
chown "$USER_NAME:$USER_NAME" "$BASE/Templates/daft_chain.ardour"

# --- GUI (PySide6) ---
echo "[GUI] App setup (PySide6 already installed)…" | tee -a "$LOG"
cat > "$BASE/citadel_gui.py" <<'PY'
import json, os, subprocess, sys
from pathlib import Path
from PySide6 import QtCore, QtWidgets
HOME = Path.home()
BASE = Path(os.environ.get("CITADEL_HOME", str(HOME / "DaftCitadel")))
VENV_BIN = BASE / ".venv" / "bin"
SF2 = "/usr/share/sounds/sf2/FluidR3_GM.sf2"
CFG_DIR = HOME / ".config" / "DaftCitadel"; CFG_DIR.mkdir(parents=True, exist_ok=True)
CFG = CFG_DIR / "config.json"
def load_cfg():
    if CFG.exists():
        try: return json.loads(CFG.read_text())
        except Exception: pass
    return {"quantum": 64}
def save_cfg(d): CFG.write_text(json.dumps(d, indent=2))
def run_user(cmd, env=None):
    try:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
        try:
            for line in p.stdout or []:
                yield line.rstrip()
            p.wait(timeout=120)
        except subprocess.TimeoutExpired:
            p.kill()
            yield f"[TIMEOUT] Command exceeded 120s: {' '.join(cmd)}"
        yield f"[exit {p.returncode}]"
    except Exception as exc:
        yield f"[ERROR] {exc}"
class Log(QtWidgets.QPlainTextEdit):
    def __init__(self): super().__init__(); self.setReadOnly(True); self.setMaximumBlockCount(10000)
    def ln(self, s): self.appendPlainText(s)
class GUI(QtWidgets.QMainWindow):
    def __init__(self):
        super().__init__(); self.setWindowTitle("Daft Citadel — Turn-Key DAW"); self.resize(980,640)
        self.cfg = load_cfg(); self.log = Log()
        self.btn_audio = QtWidgets.QPushButton("Start / Repair Audio (PipeWire/JACK)")
        self.btn_quantum = QtWidgets.QPushButton(f"Set Quantum = {self.cfg['quantum']} frames")
        self.btn_gen = QtWidgets.QPushButton("Generate Quick Riff (Da Funk)")
        self.btn_gen_ai = QtWidgets.QPushButton("Generate AI Riff (if trained)")
        self.btn_preview = QtWidgets.QPushButton("Preview Latest Riff")
        self.btn_train = QtWidgets.QPushButton("Train Model (logs below)")
        self.btn_ardour = QtWidgets.QPushButton("Open Ardour (Daft Template)")
        self.btn_carla = QtWidgets.QPushButton("Open Carla Patchbay")
        self.btn_proj = QtWidgets.QPushButton("Open Projects")
        self.btn_midis = QtWidgets.QPushButton("Open MIDIs")
        self.btn_presets = QtWidgets.QPushButton("Open Presets")
        grid=QtWidgets.QGridLayout()
        grid.addWidget(self.btn_audio,0,0,1,2); grid.addWidget(self.btn_quantum,0,2)
        grid.addWidget(self.btn_gen,1,0); grid.addWidget(self.btn_gen_ai,1,1); grid.addWidget(self.btn_preview,1,2)
        grid.addWidget(self.btn_train,2,0,1,3)
        grid.addWidget(self.btn_ardour,3,0); grid.addWidget(self.btn_carla,3,1)
        grid.addWidget(self.btn_proj,4,0); grid.addWidget(self.btn_midis,4,1); grid.addWidget(self.btn_presets,4,2)
        top=QtWidgets.QWidget(); top.setLayout(grid)
        split=QtWidgets.QSplitter(QtCore.Qt.Vertical); split.addWidget(top); split.addWidget(self.log); split.setStretchFactor(1,1)
        self.setCentralWidget(split)
        self.btn_audio.clicked.connect(self.start_audio)
        self.btn_quantum.clicked.connect(self.set_quantum)
        self.btn_gen.clicked.connect(self.generate_quick)
        self.btn_gen_ai.clicked.connect(self.generate_ai)
        self.btn_preview.clicked.connect(self.preview)
        self.btn_train.clicked.connect(self.train)
        self.btn_ardour.clicked.connect(self.open_ardour)
        self.btn_carla.clicked.connect(lambda: subprocess.Popen(["carla"]))
        self.btn_proj.clicked.connect(lambda: self.open_path(BASE/"Projects"))
        self.btn_midis.clicked.connect(lambda: self.open_path(BASE/"MIDIs"))
        self.btn_presets.clicked.connect(lambda: self.open_path(BASE/"Presets"))
        self.status()
    def status(self):
        self.log.ln(f"[BASE] {BASE}"); self.log.ln(f"[VENV] {VENV_BIN}"); self.log.ln(f"[SF2 ] {SF2}")
        self.log.ln("[Tip] Click Start/Repair Audio, then Generate & Preview.")
    def start_audio(self):
        cmds = [
            ["systemctl","--user","enable","--now","pipewire","pipewire-pulse","wireplumber"],
            ["pw-metadata","-n","settings","0","clock.force-quantum",str(self.cfg["quantum"])],
        ]
        for cmd in cmds:
            self.log.ln(f"$ {' '.join(cmd)}")
            for ln in run_user(cmd): self.log.ln(ln)
    def set_quantum(self):
        q, ok = QtWidgets.QInputDialog.getInt(self, "Quantum (frames @48k)", "Frames (32–256):", self.cfg["quantum"], 16, 1024, 1)
        if not ok: return
        self.cfg["quantum"]=q; save_cfg(self.cfg)
        self.btn_quantum.setText(f"Set Quantum = {q} frames")
        self.log.ln(f"[AUDIO] Setting quantum to {q}…")
        for ln in run_user(["pw-metadata","-n","settings","0","clock.force-quantum",str(q)]): self.log.ln(ln)
    def generate_quick(self):
        cmd=[str(VENV_BIN/"python"), str(BASE/"citadel_hub.py")]
        self.log.ln(f"$ {' '.join(cmd)}")
        for ln in run_user(cmd): self.log.ln(ln)
    def generate_ai(self):
        cmd=[str(VENV_BIN/"python"), str(BASE/"daft_midi_trainer.py"), "--generate=da_funk"]
        self.log.ln(f"$ {' '.join(cmd)}")
        for ln in run_user(cmd): self.log.ln(ln)
    def preview(self):
        mids=sorted((BASE/"MIDIs").glob("*.mid"), key=lambda p:p.stat().st_mtime, reverse=True)
        if not mids: self.log.ln("[WARN] No MIDI yet."); return
        last=mids[0]; self.log.ln(f"[PLAY] {last}")
        for ln in run_user(["fluidsynth","-a","pulseaudio",SF2,str(last)]): self.log.ln(ln)
    def train(self):
        cmd=[str(VENV_BIN/"python"), str(BASE/"daft_midi_trainer.py"), "--train"]
        self.log.ln(f"$ {' '.join(cmd)}")
        for ln in run_user(cmd): self.log.ln(ln)
    def open_ardour(self):
        tpl = BASE/"Templates"/"daft_chain.ardour"
        cmd = ["ardour","--new","DaftCitadel"]
        if tpl.exists() and tpl.stat().st_size>0:
            try:
                txt = tpl.read_text(errors="ignore")
                if "Tempo" in txt or "TempoMap" in txt: cmd+=["--template", str(tpl)]
            except Exception: pass
        self.log.ln(f"$ {' '.join(cmd)}"); subprocess.Popen(cmd)
    def open_path(self, p: Path):
        p.mkdir(parents=True, exist_ok=True); subprocess.Popen(["xdg-open", str(p)])
if __name__=="__main__":
    app=QtWidgets.QApplication(sys.argv); w=GUI(); w.show(); sys.exit(app.exec())
PY
chown "$USER_NAME:$USER_NAME" "$BASE/citadel_gui.py"

# --- Desktop launcher ---
as_user "mkdir -p ~/.local/share/applications"
cat >"$USER_HOME/.local/share/applications/citadel-gui.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Daft Citadel (GUI)
Exec="$VENV/bin/python" "$BASE/citadel_gui.py"
Icon=multimedia-volume-control
Terminal=false
Categories=AudioVideo;Audio;Midi;Music;
DESK
chown "$USER_NAME:$USER_NAME" "$USER_HOME/.local/share/applications/citadel-gui.desktop"
as_user "if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database ~/.local/share/applications; fi"

# --- Clean plugin env (separate per format) ---
PATCH="$USER_HOME/fix_citadel_paths.sh"
cat > "$PATCH" <<'SH'
set -euo pipefail
PROF="$HOME/.profile"
if ! sed -i '/^# Citadel DAW plugin paths/,$d' "$PROF" 2>/dev/null; then
  echo "[WARN] Unable to clean existing plugin path block in $PROF" >&2
fi
cat >> "$PROF" <<'ENV'
# Citadel DAW plugin paths (separated by format)
export LV2_PATH="${LV2_PATH:-/usr/lib/lv2:~/.lv2}"
export VST3_PATH="${VST3_PATH:-/usr/lib/vst3:~/.vst3}"
export VST_PATH="${VST_PATH:-/usr/lib/vst:~/.vst}"
export LADSPA_PATH="${LADSPA_PATH:-/usr/lib/ladspa:~/.ladspa}"
ENV
echo "[OK] Updated $PROF. Re-login or: source ~/.profile"
SH
chown "$USER_NAME:$USER_NAME" "$PATCH"
as_user "bash ~/fix_citadel_paths.sh"

# --- Clear stale plugin caches once (avoid LV2 parsing noise) ---
as_user "rm -rf ~/.cache/ardour*/plugin_metadata ~/.cache/lv2 2>/dev/null"

# --- Git init ---
as_user "cd '$BASE' && { [ -d .git ] || git init >/dev/null 2>&1; } && if [ -n \"\$(git status --porcelain)\" ]; then git add . && git commit -m 'Citadel Forge v5.3' >/dev/null 2>&1; fi"

# --- Final ---
cat <<'MSG'

────────────────────────────────────────────────────────
[CITADEL ONLINE]
────────────────────────────────────────────────────────
Installation complete!

Base:     $BASE
GUI:      $VENV/bin/python $BASE/citadel_gui.py  (launcher: 'Daft Citadel (GUI)')
Train:    $VENV/bin/python $BASE/daft_midi_trainer.py --train
Generate: $VENV/bin/python $BASE/daft_midi_trainer.py --generate=da_funk
Ardour:   ardour --new "DaftCitadel" --template $BASE/Templates/daft_chain.ardour
NOTE: Log out and back in (or reboot) once to finish user audio setup.
      Then launch "Daft Citadel (GUI)" from your app menu.
────────────────────────────────────────────────────────

After install (one-time):
1. Log out/in (activates the user audio services).
2. Open Daft Citadel (GUI). Click Start / Repair Audio, then Generate Quick Riff → Preview.
3. Click Open Ardour (Daft Template) to start recording/mixing at 124 BPM / 4-4.
MSG
