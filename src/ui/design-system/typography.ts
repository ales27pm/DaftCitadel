import { TextStyle } from 'react-native';

import { ThemeTokens, ThemeIntent, mapIntentToColor } from './tokens';

export type TypographyVariant = 'caption' | 'body' | 'bodyLarge' | 'title' | 'headline';

export const createTextStyle = (
  theme: ThemeTokens,
  variant: TypographyVariant,
  intent: ThemeIntent = 'primary',
  weight: keyof ThemeTokens['typography']['weights'] = 'regular',
): TextStyle => {
  const { typography } = theme;
  const fontSize = typography.sizes[variant];
  const weightValue = typography.weights[weight];
  const color =
    intent === 'primary' ? theme.colors.textPrimary : mapIntentToColor(theme, intent);

  return {
    fontFamily: typography.fontFamily,
    fontSize,
    fontWeight: weightValue as TextStyle['fontWeight'],
    lineHeight: fontSize * typography.lineHeights.standard,
    letterSpacing:
      intent === 'primary'
        ? typography.letterSpacings.normal
        : typography.letterSpacings.airy,
    color,
  };
};

export const typographyVariants: Record<TypographyVariant, TypographyVariant> = {
  caption: 'caption',
  body: 'body',
  bodyLarge: 'bodyLarge',
  title: 'title',
  headline: 'headline',
};
