# Portable Juno core reference metrics

These references cover the CPU-only core imported from
`ales27pm/junoNATIVE@90d1fa368a4e4b5b145c6ff81d7501d02e319e8b`. They intentionally
compare signal metrics instead of committing architecture-sensitive WAV files.

Both scenarios render stereo with 256-frame offline blocks and output gain
`0.2`. The single-note case renders MIDI C4 at velocity `0.8` for 0.5 seconds,
then one second of release. The chord case renders six notes
`48, 55, 60, 64, 67, 72` at velocity `0.65` for 0.4 seconds, then 0.6 seconds
of release.

| Rate | Scenario | Frames | Peak | RMS | Stereo difference RMS | Attack RMS | Sustain RMS | Release-tail RMS |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 44,100 Hz | Single note | 66,150 | 0.163031 | 0.065622 | 0.056528 | 0.079276 | 0.101545 | 0.014207 |
| 44,100 Hz | Six-voice chord | 44,100 | 0.652110 | 0.140816 | 0.121322 | 0.128262 | 0.196081 | 0.057354 |
| 48,000 Hz | Single note | 72,000 | 0.163036 | 0.065639 | 0.056526 | 0.079329 | 0.101122 | 0.014236 |
| 48,000 Hz | Six-voice chord | 48,000 | 0.653647 | 0.140854 | 0.121347 | 0.128305 | 0.196179 | 0.057429 |

The spectral reference uses a 1,024-frame Hann window during the sustained
portion. Bands are normalized as low `< 250 Hz`, mid `250–2,000 Hz`, and high
`>= 2,000 Hz`.

| Rate | Scenario | Low energy | Mid energy | High energy |
| ---: | --- | ---: | ---: | ---: |
| 44,100 Hz | Single note | 0.143135 | 0.856864 | 0.000001 |
| 44,100 Hz | Six-voice chord | 0.459108 | 0.540886 | 0.000006 |
| 48,000 Hz | Single note | 0.454942 | 0.545057 | 0.000001 |
| 48,000 Hz | Six-voice chord | 0.476394 | 0.523599 | 0.000007 |

`JunoCoreTests.cpp` checks peak within `0.002`, RMS values within `0.001`, and
normalized spectral bands within `0.02`. It also verifies exact silence before
notes and after release, finite output, six-voice limiting, correlation above
`0.999999999`, and per-sample agreement within `1e-7` across different offline
block sizes.

To print newly measured values while running the direct native harness:

```bash
DAFT_JUNO_PRINT_REFERENCES=1 npm run native:core:test:direct
```

Reference updates must be reviewed against the pinned upstream baseline. Tests
never rewrite this file or accept new values automatically.
