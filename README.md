# DaftCitadel

Daft Citadel is a turnkey Daft Punk–themed digital audio workstation stack for Ubuntu 24.04+. The project now ships a single consolidated installer, `scripts/daftcitadel.sh`, which powers all legacy entrypoints (`daft_apex_allinone.sh`, `daft_apex_citadel.sh`, `daft_citadel_v6_5.sh`) and the Docker build.

## Profiles

The unified installer supports three deployment profiles:

| Profile  | Description                                                                 | Features Enabled                                                |
|----------|-----------------------------------------------------------------------------|-----------------------------------------------------------------|
| `apex`   | Streamlined workstation with core DAW tooling and light presets             | GUI controller, Surge/Helm synths, lightweight templates        |
| `hybrid` | Balanced workstation (successor to `daft_apex_citadel.sh`)                  | All apex features + AI trainer, extended synth pack, presets    |
| `citadel`| Full experience (successor to `daft_citadel_v6_5.sh`)                        | Everything in hybrid plus the complete sample/preset libraries  |

Use the `--profile` flag on `scripts/daftcitadel.sh` (or invoke one of the wrapper scripts) to select the experience that matches your target system.

## Host installation

```bash
sudo ./daft_citadel_v6_5.sh --auto         # full Citadel stack
sudo ./daft_apex_citadel.sh --auto         # hybrid stack
sudo ./daft_apex_allinone.sh --auto        # streamlined stack
```

Additional flags that can be applied to any wrapper or to `scripts/daftcitadel.sh` directly:

- `--gpu-off` &mdash; skip CUDA tooling.
- Use `--daw-path=PATH` to override the plugin discovery paths exported to the login profile.
- Pass `--with-reaper` to include the Reaper evaluation build without prompting.
- Add `--skip-assets` when you want to omit large sample and preset downloads (useful for constrained environments).

All runs log to `~/daft_citadel.log` and emit a profile manifest at `~/DaftCitadel/citadel_profile.json` for the GUI to consume.

## Containerised deployment

A production-ready Dockerfile and compose definition are provided.

### Build the image

```bash
PROFILE=citadel docker compose build
```

The build step runs the installer inside the image with container-safe settings (no systemd tweaks, no kernel tuning) and provisions a non-root user (`daftpunk` by default).

### Launch the stack

```bash
docker compose up
```

The base stack exposes X11 and PulseAudio so the GUI can run inside the container. Add ALSA passthrough when your host provides `/dev/snd` by layering the optional override file:

```bash
docker compose -f docker-compose.yml -f docker-compose.audio.yml up
```

If the override is omitted, the container will still launch—perfect for headless hosts or CI runners that lack an ALSA device. Adjust the mounted paths for `XDG_RUNTIME_DIR` or `PULSE_SERVER` if your host uses different sockets.

### Customising the container

- `PROFILE` build arg controls the installer profile (`apex`, `hybrid`, or `citadel`).
- `UID`/`GID` build args align the container user with the host user to simplify shared volume permissions.
- The `citadel-data` named volume persists `~/DaftCitadel` between container rebuilds. Mount a host path instead if desired.

The image entrypoint drops the user into an interactive shell with the environment prepared (`CITADEL_HOME` exported and the virtual environment ready at `~/.venv`). Launch the GUI manually inside the container with:

```bash
$CITADEL_HOME/.venv/bin/python $CITADEL_HOME/citadel_gui.py
```

## Repository layout

```text
.
├── Dockerfile
├── assets/
│   ├── python/                # PySide6 GUI + trainer sources
│   ├── templates/             # Ardour session templates
│   └── theme/                 # Citadel Qt stylesheet
├── docker-compose.yml
├── scripts/
│   └── daftcitadel.sh         # unified installer
├── daft_apex_allinone.sh      # wrapper -> scripts/daftcitadel.sh --profile=apex
├── daft_apex_citadel.sh       # wrapper -> scripts/daftcitadel.sh --profile=hybrid
├── daft_citadel_v6_5.sh       # wrapper -> scripts/daftcitadel.sh --profile=citadel
└── README.md
```

All generated assets live under `~/DaftCitadel` on the target system, including the GUI (`citadel_gui.py`), profile metadata, Ardour templates, and presets. Re-running the installer is idempotent; it will update packages and skip downloads that already exist.

## Development workflow

- `scripts/daftcitadel.sh` is written to be profile-aware and container-safe. When modifying it, ensure new sections honour `--container` (skip host-only tweaks) and `--skip-assets` for lightweight builds.
- The GUI reads `citadel_profile.json` to determine which buttons/features to enable. Update the manifest if you add new capabilities.
- Docker builds run the installer during `docker build`; keep the script non-interactive when `--auto` is provided.

Enjoy the groove!
