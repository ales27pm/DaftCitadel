import React, { useMemo } from 'react';
import { SafeAreaView, ScrollView, View } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';

import { MidiPianoRoll, WaveformEditor } from '../editors';
import { NeonSurface, NeonText, NeonToolbar } from '../design-system';
import { useAdaptiveLayout } from '../layout';

const buildExampleWaveform = (size: number): Float32Array => {
  const data = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    data[i] = Math.sin((i / size) * Math.PI * 6) * Math.exp(-i / size);
  }
  return data;
};

const SAMPLE_NOTES = [
  { id: '1', pitch: 60, start: 0, duration: 1, velocity: 90 },
  { id: '2', pitch: 64, start: 1, duration: 1, velocity: 96 },
  { id: '3', pitch: 67, start: 2, duration: 1.5, velocity: 82 },
  { id: '4', pitch: 72, start: 3, duration: 1, velocity: 100 },
];

export const ArrangementScreen: React.FC = () => {
  const adaptive = useAdaptiveLayout();
  const waveform = useMemo(() => buildExampleWaveform(2048), []);
  const playhead = useSharedValue(0.25);
  const safeAreaStyle = useMemo(() => ({ flex: 1 }), []);
  const contentStyle = useMemo(
    () => ({
      paddingHorizontal: adaptive.breakpoint === 'phone' ? 16 : 32,
      paddingBottom: adaptive.breakpoint === 'desktop' ? 48 : 24,
    }),
    [adaptive.breakpoint],
  );
  const waveformCardStyle = useMemo(() => ({ marginBottom: 24 }), []);

  return (
    <SafeAreaView style={safeAreaStyle}>
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        <NeonToolbar
          title="Arrangement"
          actions={[
            { label: 'Undo', onPress: () => undefined, intent: 'secondary' },
            { label: 'Redo', onPress: () => undefined, intent: 'secondary' },
          ]}
        />
        <View accessibilityRole="summary" style={contentStyle}>
          <NeonSurface style={waveformCardStyle}>
            <NeonText variant="headline" weight="bold">
              Waveform Overview
            </NeonText>
            <WaveformEditor
              waveform={waveform}
              width={adaptive.breakpoint === 'phone' ? 320 : 640}
              playhead={playhead}
            />
          </NeonSurface>
          <NeonSurface>
            <NeonText variant="title" weight="medium">
              MIDI Piano Roll
            </NeonText>
            <MidiPianoRoll
              notes={SAMPLE_NOTES}
              totalBars={4}
              pixelsPerBeat={adaptive.breakpoint === 'phone' ? 48 : 64}
            />
          </NeonSurface>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};
