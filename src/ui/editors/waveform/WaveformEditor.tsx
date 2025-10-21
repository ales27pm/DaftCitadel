import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, StyleProp, ViewStyle } from 'react-native';
import { Canvas, Path, Skia, SkPath } from '@shopify/react-native-skia';
import {
  SharedValue,
  useSharedValue,
  useAnimatedReaction,
  runOnJS,
} from 'react-native-reanimated';

import { useTheme } from '../../design-system';
import { buildWaveformPath } from './path';

export interface WaveformEditorProps {
  waveform: Float32Array;
  width: number;
  height?: number;
  style?: StyleProp<ViewStyle>;
  playhead?: SharedValue<number>;
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
  const waveformPath = useRef<SkPath | null>(null);
  const internalPlayhead = useSharedValue(0);
  const playheadValue = playhead ?? internalPlayhead;
  const canvasStyle = useMemo(() => [{ width, height }, style], [height, style, width]);
  const [progress, setProgress] = useState<number>(() => playheadValue.value ?? 0);

  useEffect(() => {
    waveformPath.current = buildWaveformPath(waveform, width, height);
  }, [height, waveform, width]);

  useAnimatedReaction<number>(
    () => Math.max(0, Math.min(1, playheadValue.value)),
    (value, previous) => {
      if (value !== previous) {
        runOnJS(setProgress)(value);
        if (onPlayheadChange) {
          runOnJS(onPlayheadChange)(value);
        }
      }
    },
    [onPlayheadChange],
  );

  const handleLayout = (event: LayoutChangeEvent) => {
    const newWidth = event.nativeEvent.layout.width;
    waveformPath.current = buildWaveformPath(waveform, newWidth, height);
  };

  const progressPath = useMemo<SkPath>(() => {
    const x = progress * width;
    const path = Skia.Path.Make();
    path.moveTo(x, 0);
    path.lineTo(x, height);
    return path;
  }, [height, progress, width]);

  const waveformRendered = useMemo<SkPath | null>(() => {
    if (!waveformPath.current) {
      waveformPath.current = buildWaveformPath(waveform, width, height);
    }
    return waveformPath.current;
  }, [height, waveform, width]);

  return (
    <Canvas style={canvasStyle} onLayout={handleLayout}>
      {waveformRendered ? (
        <Path
          path={waveformRendered}
          color={theme.colors.waveform}
          style="stroke"
          strokeWidth={1.5}
        />
      ) : null}
      <Path
        path={progressPath}
        color={theme.colors.accentSecondary}
        style="stroke"
        strokeWidth={2}
      />
    </Canvas>
  );
};
