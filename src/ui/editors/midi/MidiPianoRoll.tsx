import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  StyleProp,
  View,
  ViewStyle,
  useWindowDimensions,
} from 'react-native';

import { ThemeIntent, mapIntentToColor } from '../../design-system/tokens';
import { useTheme } from '../../design-system/theme';
import { parseTimeSignature, quarterNoteBeatsPerBar } from '../../utils/timeSignature';

interface GridMetrics {
  startBeat: number;
  visibleBeats: number;
}

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
  const { width: viewportWidth } = useWindowDimensions();
  const { denominator, numerator } = useMemo(
    () => parseTimeSignature(timeSignature),
    [timeSignature],
  );
  const signatureBeatInQuarterNotes = 4 / denominator;
  const [gridState, setGridState] = useState<GridMetrics>({
    startBeat: 0,
    visibleBeats: Math.ceil(Math.max(1, viewportWidth || 0) / pixelsPerBeat),
  });

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const nextState = {
        startBeat: Math.floor(event.nativeEvent.contentOffset.x / pixelsPerBeat),
        visibleBeats: Math.ceil(Math.max(1, viewportWidth || 0) / pixelsPerBeat),
      };
      setGridState((current) =>
        current.startBeat === nextState.startBeat &&
        current.visibleBeats === nextState.visibleBeats
          ? current
          : nextState,
      );
    },
    [pixelsPerBeat, viewportWidth],
  );

  const noteHeight = useMemo(() => Math.max(18, Math.floor(720 / KEY_COUNT)), []);

  const contentWidth = useMemo(
    () => totalBars * pixelsPerBeat * quarterNoteBeatsPerBar(timeSignature),
    [pixelsPerBeat, timeSignature, totalBars],
  );

  useEffect(() => {
    const visibleBeats = Math.ceil(Math.max(1, viewportWidth || 0) / pixelsPerBeat);
    setGridState((current) =>
      current.visibleBeats === visibleBeats ? current : { ...current, visibleBeats },
    );
  }, [pixelsPerBeat, viewportWidth]);

  const horizontalContentStyle = useMemo(() => ({ width: contentWidth }), [contentWidth]);
  const verticalContentStyle = useMemo(
    () => ({ height: KEY_COUNT * noteHeight }),
    [noteHeight],
  );
  const rollStyle = useMemo(
    () => ({ flex: 1, backgroundColor: theme.colors.surfaceVariant }),
    [theme.colors.surfaceVariant],
  );
  const gridLineBase = useMemo<ViewStyle>(
    () => ({ position: 'absolute', top: 0, width: 1, height: '100%' }),
    [],
  );
  const buildGridLineStyle = useCallback(
    (left: number, isBarStart: boolean): ViewStyle => ({
      ...gridLineBase,
      left,
      backgroundColor: isBarStart ? theme.colors.accentSecondary : theme.colors.surface,
      opacity: isBarStart ? 0.45 : 0.25,
    }),
    [gridLineBase, theme.colors.accentSecondary, theme.colors.surface],
  );
  const noteBaseStyle = useMemo<ViewStyle>(
    () => ({ position: 'absolute', opacity: 0.9, borderRadius: theme.radii.sm }),
    [theme.radii.sm],
  );
  const buildNoteStyle = useCallback(
    (
      top: number,
      left: number,
      widthValue: number,
      heightValue: number,
      color: string,
    ): ViewStyle => ({
      ...noteBaseStyle,
      top,
      left,
      width: widthValue,
      height: heightValue,
      backgroundColor: color,
    }),
    [noteBaseStyle],
  );

  return (
    <ScrollView
      horizontal
      nestedScrollEnabled
      onScroll={onScroll}
      scrollEventThrottle={16}
      style={style}
      contentContainerStyle={horizontalContentStyle}
      showsHorizontalScrollIndicator={false}
    >
      <ScrollView
        scrollEnabled
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
        contentContainerStyle={verticalContentStyle}
      >
        <View style={rollStyle}>
          {Array.from({
            length: Math.ceil(gridState.visibleBeats / signatureBeatInQuarterNotes) + 2,
          }).map((_, index) => {
            const firstGridIndex = Math.floor(
              gridState.startBeat / signatureBeatInQuarterNotes,
            );
            const gridIndex = firstGridIndex + index;
            const left = gridIndex * signatureBeatInQuarterNotes * pixelsPerBeat;
            const isBarStart = gridIndex % numerator === 0;
            const lineStyle = buildGridLineStyle(left, isBarStart);
            return (
              <View key={`grid-${gridIndex}`} pointerEvents="none" style={lineStyle} />
            );
          })}
          {notes.map((note) => {
            const left = note.start * pixelsPerBeat;
            const width = Math.max(1, note.duration * pixelsPerBeat);
            const clampedPitch = Math.max(
              FIRST_VISIBLE_MIDI_KEY,
              Math.min(note.pitch, LAST_VISIBLE_MIDI_KEY),
            );
            const visualPitchIndex = clampedPitch - FIRST_VISIBLE_MIDI_KEY + 1;
            const top = (KEY_COUNT - visualPitchIndex) * noteHeight;
            const color = mapIntentToColor(theme, note.intent ?? 'tertiary');
            const noteStyle = buildNoteStyle(top, left, width, noteHeight - 2, color);

            return (
              <View
                key={note.id}
                accessibilityLabel={`MIDI note ${note.pitch}`}
                style={noteStyle}
              />
            );
          })}
        </View>
      </ScrollView>
    </ScrollView>
  );
};
