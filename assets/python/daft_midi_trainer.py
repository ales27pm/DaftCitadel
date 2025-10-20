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
