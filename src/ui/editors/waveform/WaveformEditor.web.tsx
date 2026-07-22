import React, { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '../../design-system';

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    overflow: 'hidden',
  },
  centerLine: {
    position: 'absolute',
    left: 0,
    height: 1,
    opacity: 0.35,
  },
  sample: {
    position: 'absolute',
  },
  playhead: {
    position: 'absolute',
    top: 0,
    width: 2,
  },
});

export interface WaveformEditorProps {
  waveform: Float32Array;
  width: number;
  height?: number;
  style?: StyleProp<ViewStyle>;
  playhead?: number;
  onPlayheadChange?: (position: number) => void;
}

const downsample = (waveform: Float32Array, sampleCount: number): number[] => {
  if (waveform.length <= sampleCount) {
    return Array.from(waveform);
  }
  const bucketSize = waveform.length / sampleCount;
  return Array.from({ length: sampleCount }, (_unused, bucketIndex) => {
    const start = Math.floor(bucketIndex * bucketSize);
    const end = Math.min(waveform.length, Math.ceil((bucketIndex + 1) * bucketSize));
    let peak = 0;
    for (let index = start; index < end; index += 1) {
      if (Math.abs(waveform[index]) > Math.abs(peak)) {
        peak = waveform[index];
      }
    }
    return peak;
  });
};

export const WaveformEditor: React.FC<WaveformEditorProps> = ({
  waveform,
  width,
  height = 160,
  style,
  playhead,
  onPlayheadChange,
}) => {
  const theme = useTheme();
  const progress = clamp01(playhead ?? 0);
  const samples = useMemo(
    () => downsample(waveform, Math.max(1, Math.min(256, Math.floor(width / 2)))),
    [waveform, width],
  );
  const halfHeight = height / 2;
  const sampleWidth = Math.max(1, width / Math.max(1, samples.length));
  const containerStyle = useMemo<ViewStyle>(
    () => ({
      width,
      height,
      backgroundColor: theme.colors.surfaceVariant,
    }),
    [height, theme.colors.surfaceVariant, width],
  );
  const centerLineStyle = useMemo<ViewStyle>(
    () => ({
      top: halfHeight,
      width,
      backgroundColor: theme.colors.waveform,
    }),
    [halfHeight, theme.colors.waveform, width],
  );
  const sampleStyles = useMemo(
    () =>
      samples.map((sample, index): ViewStyle => {
        const sampleHeight = Math.max(1, Math.abs(sample) * halfHeight);
        return {
          left: index * sampleWidth,
          top: sample >= 0 ? halfHeight - sampleHeight : halfHeight,
          width: sampleWidth,
          height: sampleHeight,
          backgroundColor: theme.colors.waveform,
        };
      }),
    [halfHeight, sampleWidth, samples, theme.colors.waveform],
  );
  const playheadStyle = useMemo<ViewStyle>(
    () => ({
      left: progress * width,
      height,
      backgroundColor: theme.colors.accentSecondary,
    }),
    [height, progress, theme.colors.accentSecondary, width],
  );
  const lastReportedProgress = useRef(progress);

  useEffect(() => {
    if (lastReportedProgress.current === progress) {
      return;
    }
    lastReportedProgress.current = progress;
    onPlayheadChange?.(progress);
  }, [onPlayheadChange, progress]);

  return (
    <View
      accessibilityLabel="Audio waveform"
      style={[styles.container, containerStyle, style]}
    >
      <View pointerEvents="none" style={[styles.centerLine, centerLineStyle]} />
      {samples.map((_sample, index) => {
        return (
          <View
            key={index}
            pointerEvents="none"
            style={[styles.sample, sampleStyles[index]]}
          />
        );
      })}
      <View pointerEvents="none" style={[styles.playhead, playheadStyle]} />
    </View>
  );
};
