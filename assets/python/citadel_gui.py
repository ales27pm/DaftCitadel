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
