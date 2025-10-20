#!/usr/bin/env bash
# Daft Apex — All-in-One Free DAW Setup (Ubuntu 24.x)
# Installs: PipeWire/JACK realtime + Ardour + Carla + Surge XT + Helm + ZynAddSubFX + Dragonfly + x42 + ZamAudio + Calf
# Creates: Valid Ardour template (124 BPM / 4-4), Lua “Auto-Wire”, GUI, desktop launcher
# Usage: sudo bash daft_apex_allinone.sh [--auto] [--gpu-off]

set -euo pipefail

AUTO=false
GPU_OFF=false
for a in "$@"; do
  case "$a" in
    --auto) AUTO=true ;;
    --gpu-off) GPU_OFF=true ;;
  esac
done
yesno(){ $AUTO && return 0; read -r -p "$1 [y/N]: " A; [[ "${A,,}" =~ ^y(es)?$ ]]; }

# ---------- root & distro ----------
[[ $EUID -eq 0 ]] || { echo "[ERR] Run as root (sudo)."; exit 1; }
grep -qi ubuntu /etc/os-release || { echo "[ERR] Target: Ubuntu 24.x"; exit 1; }

# ---------- user ----------
USER_NAME="${SUDO_USER:-$(logname 2>/dev/null || true)}"
[[ -n "${USER_NAME:-}" ]] || { echo "[ERR] Could not resolve login user."; exit 1; }
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"
[[ -d "$USER_HOME" ]] || { echo "[ERR] No home for $USER_NAME"; exit 1; }
as_user(){ sudo -u "$USER_NAME" -H bash -lc "$*"; }

# ---------- paths ----------
BASE="$USER_HOME/DaftCitadel"
VENV="$BASE/.venv"
LOG="$USER_HOME/daft_apex.log"
mkdir -p "$BASE"; touch "$LOG"; chown -R "$USER_NAME:$USER_NAME" "$BASE" "$LOG"

say(){ echo -e "$*" | tee -a "$LOG"; }
sysctl_set(){ local k="$1" v="$2"; grep -q "^$k=" /etc/sysctl.conf 2>/dev/null || echo "$k=$v" >> /etc/sysctl.conf; sysctl -w "$k=$v" >/dev/null; }
dl(){ local u="$1" d="$2"; say "[DL] $u -> $d"; mkdir -p "$(dirname "$d")"; curl -L --fail --retry 5 --retry-delay 2 --progress-bar "$u" -o "$d"; }
apt_install(){ DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"; }

say "[IGNITION] $(date)"

# ---------- system update ----------
say "[SYS] Updating apt…"
apt-get update -y
apt-get upgrade -y
add-apt-repository -y universe
add-apt-repository -y multiverse
apt-get update -y

# ---------- audio: pipewire/jack + realtime ----------
say "[AUDIO] PipeWire/JACK + realtime"
apt_install pipewire pipewire-jack pipewire-pulse wireplumber \
            dbus-user-session jackd2 rtirq-init alsa-utils libasound2-plugins \
            ubuntustudio-pipewire-config pavucontrol

getent group realtime >/dev/null || groupadd -r realtime
usermod -a -G audio "$USER_NAME" || true
usermod -a -G realtime "$USER_NAME" || true

mkdir -p /etc/security/limits.d
cat >/etc/security/limits.d/90-audio.conf <<'EOF_LIMITS'
@audio    -  rtprio   95
@audio    -  memlock  unlimited
@realtime -  rtprio   98
@realtime -  memlock  unlimited
EOF_LIMITS

# user autostart to enable user units & set 64f quantum
as_user "mkdir -p ~/.config/daftcitadel ~/.config/autostart"
cat >"$USER_HOME/.config/daftcitadel/first-login.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
systemctl --user enable --now pipewire pipewire-pulse wireplumber || true
pw-metadata -n settings 0 clock.force-quantum 64 || true
rm -f "$HOME/.config/autostart/daftcitadel-first-login.desktop" "$HOME/.config/daftcitadel/first-login.sh" || true
EOS
chmod +x "$USER_HOME/.config/daftcitadel/first-login.sh"
cat >"$USER_HOME/.config/autostart/daftcitadel-first-login.desktop" <<EOD
[Desktop Entry]
Type=Application
Name=DaftCitadel Audio Init
Exec=$USER_HOME/.config/daftcitadel/first-login.sh
OnlyShowIn=GNOME;KDE;XFCE;LXQt;MATE;Unity;Pantheon;
X-GNOME-Autostart-enabled=true
EOD
chown -R "$USER_NAME:$USER_NAME" "$USER_HOME/.config/daftcitadel" "$USER_HOME/.config/autostart"

# ---------- tuning ----------
say "[TUNE] performance governor & swappiness=1"
for g in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do [[ -w "$g" ]] && echo performance > "$g" || true; done
sysctl_set vm.swappiness 1
# optional: increase inotify watches
sysctl_set fs.inotify.max_user_watches 524288

# ---------- GPU (optional) ----------
if ! $GPU_OFF && lspci | grep -qi nvidia; then
  say "[GPU] NVIDIA detected: installing CUDA toolkit (keeps current driver)"
  apt_install nvidia-cuda-toolkit
  as_user 'grep -q CUDA_VISIBLE_DEVICES ~/.bashrc || echo "export CUDA_VISIBLE_DEVICES=0" >> ~/.bashrc'
else
  say "[GPU] CPU mode or no NVIDIA"
fi

# ---------- DAWs & tools ----------
say "[DAW] Installing Ardour + Carla + helpers"
apt_install ardour carla carla-lv2 carla-vst lmms qjackctl pulseaudio-utils p7zip-full unzip zip wget curl git pv

# ---------- plugins (repo) ----------
say "[PLUGINS] Installing repo synths/FX (Dragonfly, x42, Zam, Calf, Zyn)…"
apt_install dragonfly-reverb dragonfly-reverb-lv2 dragonfly-reverb-vst3 \
           x42-plugins zam-plugins calf-plugins \
           zynaddsubfx zynaddsubfx-data zynaddsubfx-lv2

# ---------- plugins (official .deb) ----------
say "[PLUGINS] Surge XT + Helm…"
SURGE="/tmp/surge-xt.deb"
dl "https://github.com/surge-synthesizer/releases-xt/releases/download/1.3.4/surge-xt-linux-x64-1.3.4.deb" "$SURGE"
apt-get install -y "$SURGE" || apt-get -f install -y
rm -f "$SURGE"
HELM="/tmp/helm.deb"
dl "https://tytel.org/static/dist/helm_0.9.0_amd64_r.deb" "$HELM"
apt-get install -y "$HELM" || apt-get -f install -y
rm -f "$HELM"

# ---------- soundfonts & preview ----------
say "[MIDI] FluidSynth + soundfonts"
apt_install fluidsynth fluid-soundfont-gm fluid-soundfont-gs
as_user 'grep -q "alias fsynth=" ~/.bashrc || echo "alias fsynth='\''fluidsynth -a pulseaudio /usr/share/sounds/sf2/FluidR3_GM.sf2'\''" >> ~/.bashrc'

# ---------- plugin paths (separated) ----------
say "[ENV] Setting clean plugin paths"
PATCH="$USER_HOME/.profile"
as_user "sed -i '/^# Citadel plugin paths/,$d' '$PATCH' || true"
cat >> "$PATCH" <<'ENV'
# Citadel plugin paths
export LV2_PATH="${LV2_PATH:-/usr/lib/lv2:$HOME/.lv2}"
export VST3_PATH="${VST3_PATH:-/usr/lib/vst3:$HOME/.vst3}"
export VST_PATH="${VST_PATH:-/usr/lib/vst:$HOME/.vst}"
export LADSPA_PATH="${LADSPA_PATH:-/usr/lib/ladspa:$HOME/.ladspa}"
ENV

# ---------- filesystem scaffold & venv ----------
say "[FS] Creating project layout"
as_user "mkdir -p '$BASE'/{Presets/{Surge,Helm,Daft},Samples/{909,Daft},Projects,MIDIs,Models,Templates,Scripts,Docs}"
say "[PY] venv + libs"
apt_install python3 python3-venv python3-pip python3-dev build-essential libasound2-dev libsndfile1-dev libportmidi-dev
as_user "python3 -m venv '$VENV' && '$VENV/bin/pip' install --upgrade pip"
as_user "'$VENV/bin/pip' install PySide6 torch mido midiutil music21 pygame isobar || '$VENV/bin/pip' install git+https://github.com/ideoforms/isobar.git#egg=isobar"

# ---------- quick riff generator ----------
cat >"$BASE/citadel_hub.py" <<'PY'
import os, random, time, subprocess
from midiutil import MIDIFile
from pathlib import Path
BASE = Path(os.environ.get("CITADEL_HOME", str(Path.home() / "DaftCitadel")))
SF2  = "/usr/share/sounds/sf2/FluidR3_GM.sf2"
def make_midi(path:Path, notes, tempo=124, dur=0.25, vel=100):
    m=MIDIFile(1); m.addTempo(0,0,tempo); t=0
    for n in notes: m.addNote(0,0,int(n),t,dur,vel); t+=dur
    with open(path,"wb") as f: m.writeFile(f)
def gen(style="da_funk", bars=16):
    pool=[36,38,40,41,43,45,47] if style=="da_funk" else [60,62,64,65,67,69,71]
    seq=[random.choice(pool)+(random.choice([-12,12]) if random.random()<0.25 else 0) for _ in range(bars*4)]
    out=BASE/"MIDIs"/f"citadel_{style}_{int(time.time())}.mid"; make_midi(out, seq); print(f"[RIFF] {out}")
    try: subprocess.run(["fluidsynth","-a","pulseaudio",SF2,str(out)], check=True)
    except Exception as e: print("[WARN] preview:", e)
if __name__=="__main__": gen()
PY
chown "$USER_NAME:$USER_NAME" "$BASE/citadel_hub.py"

# ---------- AI trainer (optional) ----------
cat >"$BASE/daft_midi_trainer.py" <<'PY'
import os, sys, subprocess, zipfile, urllib.request
from pathlib import Path
import numpy as np
import torch, torch.nn as nn, torch.optim as optim
from music21 import converter, note, chord
from midiutil import MIDIFile
BASE = Path(os.environ.get("CITADEL_HOME", str(Path.home() / "DaftCitadel")))
MIDIS=BASE/"MIDIs"; MODELS=BASE/"Models"; MIDIS.mkdir(parents=True, exist_ok=True); MODELS.mkdir(parents=True, exist_ok=True)
class LSTM(nn.Module):
    def __init__(self,v,hidden=256,layers=2): super().__init__(); self.emb=nn.Embedding(v,128); self.lstm=nn.LSTM(128,hidden,layers,batch_first=True); self.fc=nn.Linear(hidden,v); self.layers=layers; self.hidden=hidden
    def f(self,x,h): y,h=self.lstm(self.emb(x),h); return self.fc(y),h
    def init(self,b,d): z=lambda: torch.zeros(self.layers,b,self.hidden,device=d); return z(),z()
def parse():
    toks=[]
    for p in MIDIS.glob("*.mid"):
        try:
            m=converter.parse(p)
            for el in m.flat.notes:
                if isinstance(el,note.Note): toks.append(str(el.pitch))
                elif isinstance(el,chord.Chord): toks.append(".".join(n.nameWithOctave for n in el.pitches))
        except Exception as e: print("[WARN] parse",p,":",e)
    vocab=sorted(set(toks)); t2i={t:i for i,t in enumerate(vocab)}; i2t={i:t for t,i in t2i.items()}
    seq=[t2i[t] for t in toks]; X,Y=[],[]
    for i in range(0,len(seq)-33): X.append(seq[i:i+32]); Y.append(seq[i+1:i+33])
    return np.array(X,dtype=np.int64),np.array(Y,dtype=np.int64),i2t,len(vocab)
def train(E=20,lr=1e-3):
    X,Y,i2t,V=parse()
    if len(X)==0: print("[ERR] add MIDI to",MIDIS); sys.exit(1)
    d=torch.device("cuda" if torch.cuda.is_available() else "cpu"); m=LSTM(V).to(d); opt=optim.Adam(m.parameters(),lr=lr); ce=nn.CrossEntropyLoss(); bs=64
    for e in range(1,E+1):
        tot=0.0
        for i in range(0,len(X),bs):
            xb=torch.tensor(X[i:i+bs],device=d); yb=torch.tensor(Y[i:i+bs],device=d)
            h=m.init(xb.size(0),d); opt.zero_grad(); o,_=m.f(xb,h); L=ce(o.reshape(-1,o.size(-1)), yb.reshape(-1)); L.backward(); opt.step(); tot+=float(L)
        print(f"[TRAIN] {e}/{E} loss={tot/max(1,len(X)//bs):.4f}")
    torch.save({"s":m.state_dict(),"V":V,"i2t":i2t}, MODELS/"daft_lstm.pth"); print("[MODEL] saved",MODELS/"daft_lstm.pth")
def gen(style="da_funk",bars=16,tempo=124):
    chk=MODELS/"daft_lstm.pth"
    if not chk.exists(): print("[ERR] train first"); sys.exit(1)
    pay=torch.load(chk,map_location="cpu"); i2t=pay["i2t"]; V=pay["V"]
    d=torch.device("cuda" if torch.cuda.is_available() else "cpu"); m=LSTM(V).to(d).eval(); m.load_state_dict(pay["s"])
    seed="C2" if style=="da_funk" else "C4"; seed_idx=next((i for i,t in i2t.items() if t==seed),0)
    seq=[seed_idx]*32; h=m.init(1,d); out=[]
    for _ in range(bars*4):
        x=torch.tensor([seq],device=d); y,_=m.f(x,h); p=torch.softmax(y[0,-1],dim=0).detach().cpu().numpy()
        import numpy as np
        nxt=int(np.random.choice(len(p),p=p/p.sum())); out.append(nxt); seq=seq[1:]+[nxt]
    from midiutil import MIDIFile; M=MIDIFile(1); M.addTempo(0,0,tempo); t=0
    from music21 import note as m21n
    for idx in out:
        tok=i2t[idx]
        if "." in tok:
            for nm in tok.split("."): M.addNote(0,0,m21n.Note(nm).pitch.midi,t,0.25,100)
        else: M.addNote(0,0,m21n.Note(tok).pitch.midi,t,0.25,100)
        t+=0.25
    outp=MIDIS/f"daft_gen_{style}.mid"
    with open(outp,"wb") as f: M.writeFile(f)
    print("[RIFF]",outp)
if __name__=="__main__":
    if "--train" in sys.argv: train()
    else:
        style="da_funk"
        for a in sys.argv:
            if a.startswith("--generate="): style=a.split("=")[1]
        gen(style=style)
PY
chown "$USER_NAME:$USER_NAME" "$BASE/daft_midi_trainer.py"

# ---------- Ardour template (valid, with routes & send) ----------
say "[ARDOUR] Writing template"
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
  <Routes>
    <Route id="1" name="DP_Bass" active="yes" default-type="midi" role="normal">
      <Outputs>
        <Port type="audio" name="DP_Bass/out 1"/>
        <Port type="audio" name="DP_Bass/out 2"/>
      </Outputs>
      <Sends>
        <Send name="To FX_Plate" pre-fader="yes" target="FX_Plate" gain="0.0"/>
      </Sends>
    </Route>
    <Route id="2" name="FX_Plate" active="yes" default-type="audio" role="bus">
      <Outputs>
        <Port type="audio" name="FX_Plate/out 1"/>
        <Port type="audio" name="FX_Plate/out 2"/>
      </Outputs>
    </Route>
    <Route id="3" name="Vocoder" active="yes" default-type="audio" role="bus">
      <Outputs>
        <Port type="audio" name="Vocoder/out 1"/>
        <Port type="audio" name="Vocoder/out 2"/>
      </Outputs>
    </Route>
  </Routes>
  <Playlists/><Bundles/><Click/><ControlProtocols/><RouteGroups/><VCAs/><Monitor/>
</Session>
XML
chown "$USER_NAME:$USER_NAME" "$BASE/Templates/daft_chain.ardour"

# ---------- Ardour Lua “Auto-Wire” ----------
say "[ARDOUR] Installing Lua Auto-Wire"
as_user "mkdir -p ~/.config/ardour/scripts"
cat > "$USER_HOME/.config/ardour/scripts/DaftAutoWire.lua" <<'LUA'
ardour { ["type"] = "EditorAction", name = "Daft Auto-Wire", author = "Citadel", license = "MIT" }
function find_plugin(pm, want)
  for t = 0, pm:nplugintypes()-1 do
    local typ = pm:plugintype(t)
    for i = 0, pm:nplugins(typ)-1 do
      local info = pm:plugin(typ, i)
      local s = ((info:name() or "") .. " " .. (info:label() or "") .. " " .. (info:unique_id() or "")):lower()
      if s:find(want) then return typ, i, info end
    end
  end
  return nil
end
function add_to(route, typ, idx) local pm=ARDOUR.LuaAPI.plugin_manager(); local p=pm:load(typ, idx, Session); if not p:isnil() then route:add_processor_by_index(p, -1, nil, true); return true end; return false end
function factory () return function ()
  local s=Session; if s==nil then return end
  local pm=ARDOUR.LuaAPI.plugin_manager()
  local dp,fx,voc=nil,nil,nil
  for r in s:get_routes():iter() do
    local n=r:name()
    if n=="DP_Bass" then dp=r elseif n=="FX_Plate" then fx=r elseif n=="Vocoder" then voc=r end
  end
  if dp then
    for _,w in ipairs({"surge xt","helm","yoshimi"}) do local t,i,inf=find_plugin(pm,w); if t then add_to(dp,t,i); print("[AutoWire] Instrument:",inf:name()); break end end
  end
  if fx then
    for _,w in ipairs({"dragonfly.*plate","dragonfly reverb","plate reverb","reverb"}) do local t,i,_=find_plugin(pm,w); if t then if add_to(fx,t,i) then print("[AutoWire] Reverb on FX_Plate") break end end end
  end
  if voc then
    for _,w in ipairs({"calf.*vocoder","vocoder"}) do local t,i,_=find_plugin(pm,w); if t then if add_to(voc,t,i) then print("[AutoWire] Vocoder on Vocoder") break end end end
  end
  s:save_state("auto-wired")
end end
LUA
chown "$USER_NAME:$USER_NAME" "$USER_HOME/.config/ardour/scripts/DaftAutoWire.lua"

# ---------- GUI (PySide6) ----------
say "[GUI] Installing simple control app + launcher"
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
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    for line in p.stdout or []: yield line.rstrip()
    p.wait(); yield f"[exit {p.returncode}]"
class Log(QtWidgets.QPlainTextEdit):
    def __init__(self): super().__init__(); self.setReadOnly(True); self.setMaximumBlockCount(10000)
    def ln(self, s): self.appendPlainText(s)
class GUI(QtWidgets.QMainWindow):
    def __init__(self):
        super().__init__(); self.setWindowTitle("Daft Citadel — Free DAW"); self.resize(980,640)
        self.cfg = load_cfg(); self.log = Log()
        self.btn_audio = QtWidgets.QPushButton("Start/Repair Audio (PipeWire/JACK)")
        self.btn_quantum = QtWidgets.QPushButton(f"Set Quantum = {self.cfg['quantum']} frames")
        self.btn_gen = QtWidgets.QPushButton("Generate Quick Riff (Da Funk)")
        self.btn_train = QtWidgets.QPushButton("Train AI (load MIDIs first)")
        self.btn_gen_ai = QtWidgets.QPushButton("Generate AI Riff (if trained)")
        self.btn_ardour = QtWidgets.QPushButton("Open Ardour (Daft Template)")
        self.btn_autowire = QtWidgets.QPushButton("Run Auto-Wire in Ardour (see Scripting window)")
        self.btn_midis = QtWidgets.QPushButton("Open MIDIs folder")
        grid=QtWidgets.QGridLayout()
        grid.addWidget(self.btn_audio,0,0); grid.addWidget(self.btn_quantum,0,1)
        grid.addWidget(self.btn_gen,1,0); grid.addWidget(self.btn_gen_ai,1,1)
        grid.addWidget(self.btn_train,2,0,1,2)
        grid.addWidget(self.btn_ardour,3,0); grid.addWidget(self.btn_autowire,3,1)
        grid.addWidget(self.btn_midis,4,0)
        top=QtWidgets.QWidget(); top.setLayout(grid)
        split=QtWidgets.QSplitter(QtCore.Qt.Vertical); split.addWidget(top); split.addWidget(self.log); split.setStretchFactor(1,1)
        self.setCentralWidget(split)
        self.btn_audio.clicked.connect(self.start_audio)
        self.btn_quantum.clicked.connect(self.set_quantum)
        self.btn_gen.clicked.connect(self.generate_quick)
        self.btn_train.clicked.connect(self.train)
        self.btn_gen_ai.clicked.connect(self.generate_ai)
        self.btn_ardour.clicked.connect(self.open_ardour)
        self.btn_autowire.clicked.connect(self.hint_autowire)
        self.btn_midis.clicked.connect(lambda: subprocess.Popen(["xdg-open", str(BASE/"MIDIs")]))
        self.status()
    def status(self):
        self.log.ln(f"[BASE] {BASE}"); self.log.ln(f"[VENV] {VENV_BIN}")
        self.log.ln("[Tip] Start Audio → Open Ardour → Window > Scripting > Actions > Daft Auto-Wire > Run")
    def start_audio(self):
        cmds=[["systemctl","--user","enable","--now","pipewire","pipewire-pulse","wireplumber"],
              ["pw-metadata","-n","settings","0","clock.force-quantum",str(self.cfg["quantum"])]]
        for c in cmds:
            self.log.ln("$ "+" ".join(c))
            for ln in run_user(c): self.log.ln(ln)
    def set_quantum(self):
        q,ok=QtWidgets.QInputDialog.getInt(self,"Quantum (frames@48k)","Frames:",self.cfg["quantum"],16,1024,1)
        if not ok: return
        self.cfg["quantum"]=q; save_cfg(self.cfg)
        self.btn_quantum.setText(f"Set Quantum = {q} frames")
        for ln in run_user(["pw-metadata","-n","settings","0","clock.force-quantum",str(q)]): self.log.ln(ln)
    def generate_quick(self):
        cmd=[str(VENV_BIN/"python"), str(BASE/"citadel_hub.py")]
        self.log.ln("$ "+" ".join(cmd))
        for ln in run_user(cmd): self.log.ln(ln)
    def train(self):
        cmd=[str(VENV_BIN/"python"), str(BASE/"daft_midi_trainer.py"), "--train"]
        self.log.ln("$ "+" ".join(cmd)); for ln in run_user(cmd): self.log.ln(ln)
    def generate_ai(self):
        cmd=[str(VENV_BIN/"python"), str(BASE/"daft_midi_trainer.py"), "--generate=da_funk"]
        self.log.ln("$ "+" ".join(cmd)); for ln in run_user(cmd): self.log.ln(ln)
    def open_ardour(self):
        tpl = BASE/"Templates"/"daft_chain.ardour"
        cmd = ["ardour","--new","DaftCitadel"]
        if tpl.exists() and tpl.stat().st_size>0:
            try:
                txt=tpl.read_text(errors="ignore")
                if "Tempo" in txt or "TempoMap" in txt: cmd+=["--template",str(tpl)]
            except Exception: pass
        self.log.ln("$ "+" ".join(cmd)); subprocess.Popen(cmd)
    def hint_autowire(self):
        self.log.ln("In Ardour: Window → Scripting → Actions → select 'Daft Auto-Wire' → Run")
if __name__=="__main__":
    app=QtWidgets.QApplication(sys.argv); w=GUI(); w.show(); sys.exit(app.exec())
PY
chown "$USER_NAME:$USER_NAME" "$BASE/citadel_gui.py"

# ---------- launcher ----------
as_user "mkdir -p ~/.local/share/applications"
cat > "$USER_HOME/.local/share/applications/citadel-gui.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Daft Citadel (GUI)
Exec=$VENV/bin/python $BASE/citadel_gui.py
Icon=multimedia-volume-control
Terminal=false
Categories=AudioVideo;Audio;Midi;Music;
DESK
chown "$USER_NAME:$USER_NAME" "$USER_HOME/.local/share/applications/citadel-gui.desktop"
as_user "update-desktop-database ~/.local/share/applications || true"

# ---------- clear stale plugin caches ----------
as_user "rm -rf ~/.cache/ardour*/plugin_metadata ~/.cache/lv2 2>/dev/null || true"

# ---------- git snapshot ----------
as_user "cd '$BASE' && git init >/dev/null 2>&1 || true && git add . && git commit -m 'Daft Apex initial' >/dev/null 2>&1 || true"

cat <<MSG

────────────────────────────────────────────────────────
[DAFT APEX READY]
Base:     $BASE
GUI:      $VENV/bin/python $BASE/citadel_gui.py  (Menu: "Daft Citadel (GUI)")
Ardour:   ardour --new "DaftCitadel" --template $BASE/Templates/daft_chain.ardour
Tips:
  1) Log out/in once to activate realtime PipeWire services.
  2) In Ardour: Window → Scripting → Actions → "Daft Auto-Wire" → Run
     (Inserts Surge XT/Helm on DP_Bass, Dragonfly Plate on FX_Plate, Vocoder on Vocoder bus.)
  3) In GUI: Start/Repair Audio → Generate Quick Riff → Open Ardour.

Everything uses FREE software and factory presets (Surge/Helm/Zyn/Dragonfly/etc).
────────────────────────────────────────────────────────
MSG

