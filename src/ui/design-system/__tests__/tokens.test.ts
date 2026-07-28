import { createTextStyle } from '../typography';
import { ThemeIntent, createThemeTokens, lightTokens, mapIntentToColor } from '../tokens';

describe('design tokens', () => {
  it('maps intents to colors', () => {
    const intents: ThemeIntent[] = [
      'primary',
      'secondary',
      'tertiary',
      'success',
      'warning',
      'critical',
    ];
    intents.forEach((intent) => {
      const color = mapIntentToColor(lightTokens, intent);
      expect(typeof color).toBe('string');
      expect(color.length).toBeGreaterThan(0);
    });
  });

  it('creates typography styles', () => {
    const style = createTextStyle(lightTokens, 'bodyLarge', 'secondary', 'medium');
    expect(style.fontFamily).toEqual(lightTokens.typography.fontFamily);
    expect(style.fontSize).toBe(lightTokens.typography.sizes.bodyLarge);
    expect(style.color).toBe(mapIntentToColor(lightTokens, 'secondary'));
  });

  it('derives accent, density, surface, and glow tokens without mutating bases', () => {
    const customized = createThemeTokens('dark', {
      accentPalette: 'magenta',
      density: 'compact',
      glow: 'vivid',
      surface: 'spectral',
    });

    expect(customized.colors.accentPrimary).toBe('#E75DC7');
    expect(customized.spacing.lg).toBeLessThan(lightTokens.spacing.lg);
    expect(customized.effects.glowOpacity).toBeGreaterThan(0.1);
    expect(customized.effects.surfaceTextureOpacity).toBeGreaterThan(0.14);
    expect(customized.motion.ambient).toBeLessThan(lightTokens.motion.ambient);
    expect(customized.motion.ambientTravel).toBeGreaterThan(
      lightTokens.motion.ambientTravel,
    );
    expect(customized.appearance).toEqual({
      accentPalette: 'magenta',
      density: 'compact',
      glow: 'vivid',
      surface: 'spectral',
    });
    expect(lightTokens.appearance.accentPalette).toBe('mint');
  });

  it('uses calm glow settings for slower, subtler ambient motion', () => {
    const calm = createThemeTokens('dark', { glow: 'calm' });
    const vivid = createThemeTokens('dark', { glow: 'vivid' });

    expect(calm.motion.ambient).toBeGreaterThan(vivid.motion.ambient);
    expect(calm.motion.ambientTravel).toBeLessThan(vivid.motion.ambientTravel);
    expect(calm.motion.ambientScaleDelta).toBeLessThan(vivid.motion.ambientScaleDelta);
  });
});
