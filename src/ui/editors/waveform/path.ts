import { Skia, SkPath } from '@shopify/react-native-skia';

export const buildWaveformPath = (
  data: Float32Array,
  width: number,
  height: number,
): SkPath => {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    data.length === 0
  ) {
    const fallback = Skia.Path.Make();
    const midY = Math.max(0, height) / 2;
    fallback.moveTo(0, midY);
    fallback.lineTo(Math.max(0, width), midY);
    fallback.close();
    return fallback;
  }

  const path = Skia.Path.Make();
  const amplitude = height / 2;
  const effectiveWidth = Math.max(1, Math.floor(width));
  const denominator = Math.max(1, effectiveWidth - 1);
  const step = Math.max(1, Math.floor((data.length - 1) / denominator));

  const clampValue = (value: number) => {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.max(-1, Math.min(1, value));
  };

  path.moveTo(0, amplitude);

  for (let x = 0; x < width; x += 1) {
    const index = Math.min(data.length - 1, Math.floor(x) * step);
    const value = clampValue(data[index]);
    const y = amplitude - value * amplitude;
    path.lineTo(x, y);
  }

  for (let x = width - 1; x >= 0; x -= 1) {
    const index = Math.min(data.length - 1, Math.floor(x) * step);
    const value = clampValue(data[index]);
    const y = amplitude + value * amplitude;
    path.lineTo(x, y);
  }

  path.close();
  return path;
};
