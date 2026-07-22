# Juno core provenance

The portable CPU synthesis core in this directory is adapted from
[`ales27pm/junoNATIVE`](https://github.com/ales27pm/junoNATIVE) at commit
`90d1fa368a4e4b5b145c6ff81d7501d02e319e8b`.

Imported and adapted source concepts:

| Upstream path | Git blob at the pinned revision |
| --- | --- |
| `rtn-juno-engine/cpp/engine/JunoDSPEngine.cpp` | `86f3375980594f20e593fb6c37afed4af8239efd` |
| `rtn-juno-engine/cpp/engine/JunoDSPEngine.hpp` | `4f6f113028b69c1b5d61cc0c63e39bc3a57f10ad` |
| `rtn-juno-engine/cpp/engine/JunoVoice.cpp` | `3898bbfbd630107d7cc95f7b6c2e08a478cf5903` |
| `rtn-juno-engine/cpp/engine/JunoVoice.hpp` | `a9304f9196508112d10cc01ee5c075e010033819` |
| `rtn-juno-engine/cpp/dsp/BBDChorus.hpp` | `94d73a1fe8280005872c2dcba95c376ce285a477` |
| `rtn-juno-engine/cpp/dsp/NonlinearVCF.hpp` | `648139a05257657bc6c7c3d982d3dea610471974` |

DaftCitadel adaptations place the code in the `daft::audio::juno` namespace,
remove the iOS/Metal path, remove string-based queued parameters and mutex-backed
state, validate public inputs, and keep allocation outside `render()`.

The upstream revision does not contain a `LICENSE`, `COPYING`, or `NOTICE` file.
This file records provenance; it does not create or replace a license grant.
Redistribution outside repositories controlled by the original rights holder
must first confirm the applicable licensing terms.

Deliberately excluded from this import:

- `JunoAudioEngine` and all AVFoundation/React Native wrappers;
- `JunoRenderEngine` and the Metal implementation;
- `RCUParameterManager` because it transports `std::string` values and owns
  mutex-backed state;
- `Juno106PatchParser`, which belongs to the later bounded preset/SysEx phase.
