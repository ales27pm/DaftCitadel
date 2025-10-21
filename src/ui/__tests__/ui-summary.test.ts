import { mapIntentToColor, lightTokens } from '../design-system/tokens';
import { resolveBreakpoint } from '../layout';
import { buildWaveformPath } from '../editors/waveform/path';

describe('ui primitives', () => {
  it('provides neon palette lookups', () => {
    expect(mapIntentToColor(lightTokens, 'tertiary')).toEqual(
      lightTokens.colors.accentTertiary,
    );
  });

  it('classifies desktop breakpoints', () => {
    expect(resolveBreakpoint(1440)).toBe('desktop');
  });

  it('builds waveform paths deterministically', () => {
    const waveform = new Float32Array([0, 1, -1, 0]);
    const path = buildWaveformPath(waveform, 4, 20);
    expect(path.toCmds().length).toBeGreaterThan(4);
  });
});
