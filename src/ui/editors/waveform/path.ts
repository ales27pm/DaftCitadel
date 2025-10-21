import { Skia, SkPath } from '@shopify/react-native-skia';

export const buildWaveformPath = (
  data: Float32Array,
  width: number,
  height: number,
): SkPath => {
  const path = Skia.Path.Make();
  const amplitude = height / 2;
  const step = Math.max(1, Math.floor(data.length / width));

  path.moveTo(0, amplitude);

  for (let x = 0; x < width; x += 1) {
    const index = Math.min(data.length - 1, x * step);
    const value = data[index];
    const y = amplitude - value * amplitude;
    path.lineTo(x, y);
  }

  for (let x = width - 1; x >= 0; x -= 1) {
    const index = Math.min(data.length - 1, x * step);
    const value = data[index];
    const y = amplitude + value * amplitude;
    path.lineTo(x, y);
  }

  path.close();
  return path;
};
