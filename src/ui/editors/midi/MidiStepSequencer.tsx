import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { MidiNoteEvent } from '../../../session';
import { StudioButton, StudioPanel, StudioText, useTheme } from '../../design-system';

interface MidiStepSequencerProps {
  disabled?: boolean;
  notes: ReadonlyArray<MidiNoteEvent>;
  onAuditionEnd?: (pitch: number) => void;
  onAuditionStart?: (pitch: number, velocity: number) => void;
  onChange: (notes: MidiNoteEvent[]) => void;
  pending?: boolean;
}

const STEP_COUNT = 16;
const STEPS_PER_BEAT = 4;

const styles = StyleSheet.create({
  root: { gap: 12 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'space-between',
  },
  copy: { flex: 1, minWidth: 170 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  step: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 9,
    borderWidth: 1,
    flexBasis: '21%',
    flexGrow: 1,
    height: 54,
    justifyContent: 'center',
    minWidth: 48,
  },
  controls: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  control: { flexGrow: 1, gap: 7, minWidth: 145 },
  controlRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'space-between',
  },
  stepButton: { minWidth: 44, paddingHorizontal: 10 },
  preview: { alignSelf: 'stretch' },
});

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

const pitchName = (pitch: number): string => {
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  return `${names[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
};

const resolveStep = (startBeat: number): number => Math.round(startBeat * STEPS_PER_BEAT);

export const MidiStepSequencer: React.FC<MidiStepSequencerProps> = ({
  disabled = false,
  notes,
  onAuditionEnd,
  onAuditionStart,
  onChange,
  pending = false,
}) => {
  const theme = useTheme();
  const [pitch, setPitch] = useState(60);
  const [velocity, setVelocity] = useState(100);
  const [durationSteps, setDurationSteps] = useState(1);
  const locked = disabled || pending;

  const notesByStep = useMemo(() => {
    const map = new Map<number, MidiNoteEvent>();
    notes.forEach((note) => {
      const step = resolveStep(note.startBeat);
      if (step >= 0 && step < STEP_COUNT && !map.has(step)) {
        map.set(step, note);
      }
    });
    return map;
  }, [notes]);

  const toggleStep = (step: number) => {
    if (locked) {
      return;
    }
    const existing = notesByStep.get(step);
    if (existing) {
      onChange(notes.filter((note) => note.id !== existing.id));
      return;
    }
    const startBeat = step / STEPS_PER_BEAT;
    const note: MidiNoteEvent = {
      id: `step-${step + 1}`,
      pitch,
      startBeat,
      durationBeats: Math.min(
        durationSteps / STEPS_PER_BEAT,
        STEP_COUNT / STEPS_PER_BEAT - startBeat,
      ),
      velocity,
    };
    onChange(
      [...notes, note].sort(
        (left, right) => left.startBeat - right.startBeat || left.pitch - right.pitch,
      ),
    );
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.copy}>
          <StudioText variant="label" weight="bold">
            16-step pattern
          </StudioText>
          <StudioText variant="caption" tone="secondary">
            Select a sound, then tap a step to add or remove its note.
          </StudioText>
        </View>
        <StudioText selectable variant="caption" tone="mint" weight="bold">
          {notesByStep.size}/16 STEPS
        </StudioText>
      </View>

      <View accessibilityLabel="MIDI step grid" role="group" style={styles.grid}>
        {Array.from({ length: STEP_COUNT }, (_unused, step) => {
          const note = notesByStep.get(step);
          const downbeat = step % STEPS_PER_BEAT === 0;
          return (
            <Pressable
              key={step}
              accessibilityHint={note ? 'Removes this note' : `Adds ${pitchName(pitch)}`}
              accessibilityLabel={`Step ${step + 1}${note ? `, ${pitchName(note.pitch)}` : ', empty'}`}
              accessibilityRole="button"
              accessibilityState={{ disabled: locked, selected: Boolean(note) }}
              disabled={locked}
              onPress={() => toggleStep(step)}
              style={({ pressed }) => [
                styles.step,
                {
                  backgroundColor: note
                    ? theme.colors.accentPrimary
                    : downbeat
                      ? theme.colors.surfaceElevated
                      : theme.colors.surfaceVariant,
                  borderColor: note
                    ? theme.colors.accentPrimary
                    : downbeat
                      ? theme.colors.accentTertiary
                      : theme.colors.border,
                  opacity: locked ? 0.5 : pressed ? 0.76 : 1,
                },
              ]}
              testID={`midi-step-${step + 1}`}
            >
              <StudioText
                selectable={false}
                variant="caption"
                weight="bold"
                style={{
                  color: note
                    ? theme.colors.accentPrimaryInk
                    : theme.colors.textSecondary,
                }}
              >
                {step + 1}
              </StudioText>
              <StudioText
                selectable={false}
                variant="caption"
                weight="bold"
                style={{
                  color: note ? theme.colors.accentPrimaryInk : theme.colors.textTertiary,
                }}
              >
                {note ? pitchName(note.pitch) : '—'}
              </StudioText>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.controls}>
        <StudioPanel padding={10} style={styles.control} variant="subtle">
          <StudioText variant="caption" tone="secondary" weight="bold">
            PITCH
          </StudioText>
          <View style={styles.controlRow}>
            <StudioButton
              compact
              accessibilityLabel="Pitch down"
              disabled={locked || pitch <= 24}
              label="−"
              onPress={() => setPitch((current) => clamp(current - 1, 24, 96))}
              style={styles.stepButton}
            />
            <StudioText selectable variant="body" tone="cyan" weight="bold">
              {pitchName(pitch)}
            </StudioText>
            <StudioButton
              compact
              accessibilityLabel="Pitch up"
              disabled={locked || pitch >= 96}
              label="+"
              onPress={() => setPitch((current) => clamp(current + 1, 24, 96))}
              style={styles.stepButton}
            />
          </View>
          <View style={styles.controlRow}>
            <StudioButton
              compact
              accessibilityLabel="Octave down"
              disabled={locked || pitch <= 35}
              label="− OCT"
              onPress={() => setPitch((current) => clamp(current - 12, 24, 96))}
            />
            <StudioButton
              compact
              accessibilityLabel="Octave up"
              disabled={locked || pitch >= 85}
              label="+ OCT"
              onPress={() => setPitch((current) => clamp(current + 12, 24, 96))}
            />
          </View>
        </StudioPanel>

        <StudioPanel padding={10} style={styles.control} variant="subtle">
          <StudioText variant="caption" tone="secondary" weight="bold">
            VELOCITY
          </StudioText>
          <View style={styles.controlRow}>
            <StudioButton
              compact
              accessibilityLabel="Decrease velocity"
              disabled={locked || velocity <= 1}
              label="−"
              onPress={() => setVelocity((current) => clamp(current - 8, 1, 127))}
              style={styles.stepButton}
            />
            <StudioText selectable variant="body" tone="magenta" weight="bold">
              {velocity}
            </StudioText>
            <StudioButton
              compact
              accessibilityLabel="Increase velocity"
              disabled={locked || velocity >= 127}
              label="+"
              onPress={() => setVelocity((current) => clamp(current + 8, 1, 127))}
              style={styles.stepButton}
            />
          </View>
        </StudioPanel>

        <StudioPanel padding={10} style={styles.control} variant="subtle">
          <StudioText variant="caption" tone="secondary" weight="bold">
            NOTE LENGTH
          </StudioText>
          <View style={styles.controlRow}>
            <StudioButton
              compact
              accessibilityLabel="Shorten note"
              disabled={locked || durationSteps <= 1}
              label="−"
              onPress={() =>
                setDurationSteps((current) => clamp(current - 1, 1, STEPS_PER_BEAT))
              }
              style={styles.stepButton}
            />
            <StudioText selectable variant="body" tone="mint" weight="bold">
              {durationSteps}/16
            </StudioText>
            <StudioButton
              compact
              accessibilityLabel="Lengthen note"
              disabled={locked || durationSteps >= STEPS_PER_BEAT}
              label="+"
              onPress={() =>
                setDurationSteps((current) => clamp(current + 1, 1, STEPS_PER_BEAT))
              }
              style={styles.stepButton}
            />
          </View>
        </StudioPanel>
      </View>

      <StudioButton
        accessibilityHint="Hold to audition the selected pitch on the Juno instrument"
        disabled={locked || !onAuditionStart || !onAuditionEnd}
        label={`Hold to audition ${pitchName(pitch)}`}
        onPress={() => undefined}
        onPressIn={() => onAuditionStart?.(pitch, velocity)}
        onPressOut={() => onAuditionEnd?.(pitch)}
        style={styles.preview}
        testID="audition-midi-pitch"
        variant="secondary"
      />
    </View>
  );
};
