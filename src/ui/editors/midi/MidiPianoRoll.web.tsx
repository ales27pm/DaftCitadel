import React, { useCallback, useMemo } from 'react';
import { ScrollView, StyleProp, View, ViewStyle } from 'react-native';

import { ThemeIntent, mapIntentToColor } from '../../design-system/tokens';
import { useTheme } from '../../design-system/theme';
import { parseTimeSignature, quarterNoteBeatsPerBar } from '../../utils/timeSignature';

export interface MidiNote {
  id: string;
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
  intent?: ThemeIntent;
}

export interface MidiPianoRollProps {
  notes: MidiNote[];
  totalBars: number;
  timeSignature: string;
  pixelsPerBeat?: number;
  style?: StyleProp<ViewStyle>;
}

const KEY_COUNT = 88;
const FIRST_VISIBLE_MIDI_KEY = 21;
const LAST_VISIBLE_MIDI_KEY = FIRST_VISIBLE_MIDI_KEY + KEY_COUNT - 1;
const DEFAULT_PIXELS_PER_BEAT = 48;

export const MidiPianoRoll: React.FC<MidiPianoRollProps> = ({
  notes,
  totalBars,
  timeSignature,
  pixelsPerBeat = DEFAULT_PIXELS_PER_BEAT,
  style,
}) => {
  const theme = useTheme();
  const { denominator, numerator } = parseTimeSignature(timeSignature);
  const noteHeight = 18;
  const signatureBeatInQuarterNotes = 4 / denominator;
  const totalSignatureBeats = Math.max(1, totalBars * numerator);
  const totalQuarterNoteBeats = Math.max(
    signatureBeatInQuarterNotes,
    totalBars * quarterNoteBeatsPerBar(timeSignature),
  );
  const contentWidth = totalQuarterNoteBeats * pixelsPerBeat;
  const contentHeight = KEY_COUNT * noteHeight;
  const horizontalContentStyle = useMemo(() => ({ width: contentWidth }), [contentWidth]);
  const verticalContentStyle = useMemo(
    () => ({ height: contentHeight }),
    [contentHeight],
  );
  const rollStyle = useMemo<ViewStyle>(
    () => ({
      position: 'relative',
      width: contentWidth,
      height: contentHeight,
      backgroundColor: theme.colors.surfaceVariant,
    }),
    [contentHeight, contentWidth, theme.colors.surfaceVariant],
  );
  const buildGridLineStyle = useCallback(
    (gridIndex: number): ViewStyle => ({
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: gridIndex * signatureBeatInQuarterNotes * pixelsPerBeat,
      width: 1,
      backgroundColor:
        gridIndex % numerator === 0 ? theme.colors.accentSecondary : theme.colors.surface,
      opacity: gridIndex % numerator === 0 ? 0.45 : 0.25,
    }),
    [
      numerator,
      pixelsPerBeat,
      signatureBeatInQuarterNotes,
      theme.colors.accentSecondary,
      theme.colors.surface,
    ],
  );
  const buildNoteStyle = useCallback(
    (note: MidiNote): ViewStyle => {
      const clampedPitch = Math.max(
        FIRST_VISIBLE_MIDI_KEY,
        Math.min(note.pitch, LAST_VISIBLE_MIDI_KEY),
      );
      const visualPitchIndex = clampedPitch - FIRST_VISIBLE_MIDI_KEY + 1;
      return {
        position: 'absolute',
        top: (KEY_COUNT - visualPitchIndex) * noteHeight,
        left: note.start * pixelsPerBeat,
        width: Math.max(1, note.duration * pixelsPerBeat),
        height: noteHeight - 2,
        borderRadius: theme.radii.sm,
        backgroundColor: mapIntentToColor(theme, note.intent ?? 'tertiary'),
        opacity: 0.9,
      };
    },
    [pixelsPerBeat, theme],
  );

  return (
    <ScrollView
      horizontal
      nestedScrollEnabled
      style={style}
      contentContainerStyle={horizontalContentStyle}
      showsHorizontalScrollIndicator={false}
    >
      <ScrollView
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
        contentContainerStyle={verticalContentStyle}
      >
        <View style={rollStyle}>
          {Array.from({ length: totalSignatureBeats + 1 }).map((_, gridIndex) => (
            <View
              key={`grid-${gridIndex}`}
              pointerEvents="none"
              style={buildGridLineStyle(gridIndex)}
            />
          ))}
          {notes.map((note) => (
            <View
              key={note.id}
              accessibilityLabel={`MIDI note ${note.pitch}`}
              style={buildNoteStyle(note)}
            />
          ))}
        </View>
      </ScrollView>
    </ScrollView>
  );
};
