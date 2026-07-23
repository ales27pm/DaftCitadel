# Portable Juno core reference metrics

These references cover the CPU-only core imported from
`ales27pm/junoNATIVE@90d1fa368a4e4b5b145c6ff81d7501d02e319e8b`. They intentionally
compare signal metrics instead of committing architecture-sensitive WAV files.

Both scenarios render stereo with 256-frame offline blocks and output gain
`0.2`, which is also the engine's fixed default master gain. Voices are summed
to mono before the single global BBD chorus. The single-note case renders MIDI
C4 at velocity `0.8` for 0.5 seconds, then one second of release. The chord case
renders six notes `48, 55, 60, 64, 67, 72` at velocity `0.65` for 0.4 seconds,
then 0.6 seconds of release.

| Rate | Scenario | Frames | Peak | RMS | Stereo difference RMS | Attack RMS | Sustain RMS | Release-tail RMS |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 44,100 Hz | Single note | 66,150 | 0.163077 | 0.065693 | 0.056608 | 0.073183 | 0.101544 | 0.014389 |
| 44,100 Hz | Six-voice chord | 44,100 | 0.652604 | 0.141230 | 0.121684 | 0.121735 | 0.196068 | 0.057850 |
| 48,000 Hz | Single note | 72,000 | 0.163088 | 0.065711 | 0.056609 | 0.073236 | 0.101122 | 0.014413 |
| 48,000 Hz | Six-voice chord | 48,000 | 0.653051 | 0.141268 | 0.121714 | 0.121775 | 0.196186 | 0.057926 |

The spectral reference uses a 1,024-frame Hann window during the sustained
portion. Bands are normalized as low `< 250 Hz`, mid `250–2,000 Hz`, and high
`>= 2,000 Hz`.

| Rate | Scenario | Low energy | Mid energy | High energy |
| ---: | --- | ---: | ---: | ---: |
| 44,100 Hz | Single note | 0.143127 | 0.856872 | 0.000001 |
| 44,100 Hz | Six-voice chord | 0.459190 | 0.540809 | 0.000001 |
| 48,000 Hz | Single note | 0.454950 | 0.545049 | 0.000001 |
| 48,000 Hz | Six-voice chord | 0.476354 | 0.523645 | 0.000001 |

`JunoCoreTests.cpp` checks peak within `0.002`, RMS values within `0.001`, and
normalized spectral bands within `0.02`. It also verifies exact silence before
notes and after release, finite output, six-voice limiting, correlation above
`0.999999999`, and per-sample agreement within `1e-7` across different offline
block sizes.

To print newly measured values while running the direct native harness:

```bash
DAFT_JUNO_PRINT_REFERENCES=1 npm run native:core:test:direct
```

Print mode emits every candidate metric without applying the committed metric
comparisons. Reference updates must be reviewed against the pinned upstream
baseline, then the harness must be rerun without print mode. Tests never rewrite
this file or accept new values automatically.
