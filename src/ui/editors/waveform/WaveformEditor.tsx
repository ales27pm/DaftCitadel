import React, { useEffect, useMemo, useRef } from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import { Canvas, Path, Skia } from '@shopify/react-native-skia';

import { useTheme } from '../../design-system';
import { buildWaveformPath } from './path';

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

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
  const canvasWidth = Number.isFinite(width) ? Math.max(1, width) : 1;
  const progress = clamp01(playhead ?? 0);
  const lastReportedProgress = useRef(progress);
  const canvasStyle = useMemo(
    () => [{ width: canvasWidth, height }, style],
    [canvasWidth, height, style],
  );

  useEffect(() => {
    if (lastReportedProgress.current !== progress) {
      lastReportedProgress.current = progress;
      onPlayheadChange?.(progress);
    }
  }, [onPlayheadChange, progress]);

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
    <Canvas style={canvasStyle}>
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
