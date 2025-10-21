import { createTextStyle } from '../typography';
import { ThemeIntent, lightTokens, mapIntentToColor } from '../tokens';

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
});
