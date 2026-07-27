import React, { useEffect, useMemo, useState } from 'react';
import { LayoutChangeEvent, StyleProp, View, ViewStyle } from 'react-native';

import { useTheme } from '../../design-system';

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export interface WaveformEditorProps {
  waveform: Float32Array;
  width: number;
  height?: number;
  style?: StyleProp<ViewStyle>;
  playhead?: number;
  onPlayheadChange?: (position: number) => void;
}

export const WaveformEditor: React.FC<WaveformEditorProps> = ({
  waveform,
  width,
  height = 160,
  style,
  playhead,
  onPlayheadChange,
}) => {
  const theme = useTheme();
  const [canvasWidth, setCanvasWidth] = useState(width);
  const containerStyle = useMemo(
    () => [
      {
        width,
        height,
        position: 'relative' as const,
        overflow: 'hidden' as const,
      },
      style,
    ],
    [height, style, width],
  );
  const [progress, setProgress] = useState<number>(() => clamp01(playhead ?? 0));

  useEffect(() => {
    if (Number.isFinite(width) && width > 0 && width !== canvasWidth) {
      setCanvasWidth(width);
    }
  }, [canvasWidth, width]);

  useEffect(() => {
    const value = clamp01(playhead ?? 0);
    setProgress(value);
    onPlayheadChange?.(value);
  }, [onPlayheadChange, playhead]);

  const handleLayout = (event: LayoutChangeEvent) => {
    const newWidth = event.nativeEvent.layout.width;
    if (Number.isFinite(newWidth) && newWidth > 0 && newWidth !== canvasWidth) {
      setCanvasWidth(newWidth);
    }
  };

  const barHeights = useMemo(() => {
    const barCount = Math.max(24, Math.min(96, Math.floor(canvasWidth / 4)));
    if (waveform.length === 0 || barCount <= 0) {
      return Array.from({ length: 24 }, () => 2);
    }

    const samplesPerBar = Math.max(1, Math.floor(waveform.length / barCount));
    return Array.from({ length: barCount }, (_, barIndex) => {
      const start = barIndex * samplesPerBar;
      const end = Math.min(waveform.length, start + samplesPerBar);
      let peak = 0;
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        peak = Math.max(peak, Math.abs(waveform[sampleIndex] ?? 0));
      }
      return Math.max(2, peak * height);
    });
  }, [canvasWidth, height, waveform]);

  const waveformRowStyle = useMemo<ViewStyle>(
    () => ({
      height,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 1,
    }),
    [height],
  );

  const progressStyle = useMemo<ViewStyle>(
    () => ({
      position: 'absolute',
      left: Math.max(0, Math.min(canvasWidth - 2, progress * canvasWidth)),
      top: 0,
      bottom: 0,
      width: 2,
      borderRadius: 1,
      backgroundColor: theme.colors.accentSecondary,
    }),
    [canvasWidth, progress, theme.colors.accentSecondary],
  );

  return (
    <View style={containerStyle} onLayout={handleLayout}>
      <View style={waveformRowStyle}>
        {barHeights.map((barHeight, index) => (
          <View
            key={index}
            style={{
              flex: 1,
              height: barHeight,
              borderRadius: 1,
              backgroundColor: theme.colors.waveform,
              opacity: 0.85,
            }}
          />
        ))}
      </View>
      <View pointerEvents="none" style={progressStyle} />
    </View>
  );
};
