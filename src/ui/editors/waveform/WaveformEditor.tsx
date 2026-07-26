import React, { useEffect, useMemo, useState } from 'react';
import { LayoutChangeEvent, StyleProp, ViewStyle } from 'react-native';
import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import {
  SharedValue,
  useSharedValue,
  useAnimatedReaction,
  runOnJS,
} from 'react-native-reanimated';

import { useTheme } from '../../design-system';
import { buildWaveformPath } from './path';

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

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
  const [canvasWidth, setCanvasWidth] = useState(width);
  const internalPlayhead = useSharedValue(0);
  const playheadValue = playhead ?? internalPlayhead;
  const canvasStyle = useMemo(
    () => [{ width: canvasWidth, height }, style],
    [canvasWidth, height, style],
  );
  const [progress, setProgress] = useState<number>(() =>
    clamp01(playheadValue.value ?? 0),
  );

  useEffect(() => {
    if (Number.isFinite(width) && width > 0 && width !== canvasWidth) {
      setCanvasWidth(width);
    }
  }, [canvasWidth, width]);

  useAnimatedReaction<number>(
    () => clamp01(playheadValue.value),
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
    if (Number.isFinite(newWidth) && newWidth > 0 && newWidth !== canvasWidth) {
      setCanvasWidth(newWidth);
    }
  };

  const progressPath = useMemo(() => {
    const x = progress * canvasWidth;
    const path = Skia.Path.Make();
    path.moveTo(x, 0);
    path.lineTo(x, height);
    return path;
  }, [canvasWidth, height, progress]);

  const waveformPath = useMemo(
    () => buildWaveformPath(waveform, canvasWidth, height),
    [canvasWidth, height, waveform],
  );

  return (
    <Canvas style={canvasStyle} onLayout={handleLayout}>
      <Path
        path={waveformPath}
        color={theme.colors.waveform}
        style="stroke"
        strokeWidth={1.5}
      />
      <Path
        path={progressPath}
        color={theme.colors.accentSecondary}
        style="stroke"
        strokeWidth={2}
      />
    </Canvas>
  );
};
