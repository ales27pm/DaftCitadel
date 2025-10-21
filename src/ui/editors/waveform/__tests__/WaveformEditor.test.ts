import { buildWaveformPath } from '../path';

describe('buildWaveformPath', () => {
  it('creates a closed path that spans the requested width', () => {
    const waveform = new Float32Array([0, 0.5, -0.5, 1, -1, 0]);
    const width = 6;
    const height = 10;
    const path = buildWaveformPath(waveform, width, height);

    const commandIterator = path.toCmds();
    expect(commandIterator.length).toBeGreaterThan(width);

    const serialized = path.toSVGString();
    expect(serialized).toContain(`L${width - 1}`);
    expect(serialized.endsWith('Z')).toBe(true);
  });
});
