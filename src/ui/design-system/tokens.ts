import { ColorSchemeName } from 'react-native';

export type ColorTokens = {
  background: string;
  surface: string;
  surfaceVariant: string;
  surfaceElevated: string;
  surfacePressed: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  accentPrimary: string;
  accentPrimaryInk: string;
  accentSecondary: string;
  accentTertiary: string;
  waveform: string;
  midiNote: string;
  statusSuccess: string;
  statusWarning: string;
  statusCritical: string;
};

export interface SpacingScale {
  none: 0;
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
  xxl: number;
}

export interface RadiusScale {
  sm: number;
  md: number;
  lg: number;
  pill: number;
}

export interface ElevationScale {
  sm: number;
  md: number;
  lg: number;
}

export interface OpacityScale {
  disabled: number;
  overlay: number;
}

export interface TypographyScale {
  fontFamily: string;
  weights: {
    regular: string;
    medium: string;
    bold: string;
  };
  sizes: {
    caption: number;
    body: number;
    bodyLarge: number;
    title: number;
    headline: number;
  };
  lineHeights: {
    tight: number;
    standard: number;
    relaxed: number;
  };
  letterSpacings: {
    dense: number;
    normal: number;
    airy: number;
  };
}

export interface ThemeTokens {
  colors: ColorTokens;
  spacing: SpacingScale;
  radii: RadiusScale;
  elevation: ElevationScale;
  opacity: OpacityScale;
  typography: TypographyScale;
  scheme: ColorSchemeName;
}

// NOTE: Both "light" and "dark" variants embrace neon-inspired dark palettes.
// The light scheme is a slightly brighter dark theme until a true light mode ships.
export const lightTokens: ThemeTokens = {
  scheme: 'light',
  colors: {
    background: '#05070C',
    surface: '#0B1018',
    surfaceVariant: '#111926',
    surfaceElevated: '#182334',
    surfacePressed: '#223047',
    border: '#273446',
    textPrimary: '#F4F7FB',
    textSecondary: '#A9B5C5',
    textTertiary: '#748397',
    accentPrimary: '#5CE6C3',
    accentPrimaryInk: '#06231D',
    accentSecondary: '#E171F5',
    accentTertiary: '#63C7F5',
    waveform: '#63C7F5',
    midiNote: '#E171F5',
    statusSuccess: '#5CE6C3',
    statusWarning: '#F2C66D',
    statusCritical: '#FF7A88',
  },
  spacing: {
    none: 0,
    xs: 4,
    sm: 8,
    md: 12,
    lg: 20,
    xl: 28,
    xxl: 40,
  },
  radii: {
    sm: 8,
    md: 10,
    lg: 14,
    pill: 999,
  },
  elevation: {
    sm: 6,
    md: 16,
    lg: 28,
  },
  opacity: {
    disabled: 0.38,
    overlay: 0.64,
  },
  typography: {
    fontFamily: 'System',
    weights: {
      regular: '400',
      medium: '600',
      bold: '700',
    },
    sizes: {
      caption: 12,
      body: 16,
      bodyLarge: 18,
      title: 24,
      headline: 32,
    },
    lineHeights: {
      tight: 1.1,
      standard: 1.3,
      relaxed: 1.5,
    },
    letterSpacings: {
      dense: -0.25,
      normal: 0,
      airy: 0.5,
    },
  },
};

export const darkTokens: ThemeTokens = {
  ...lightTokens,
  scheme: 'dark',
  colors: { ...lightTokens.colors },
};

export const TOKENS_BY_SCHEME: Record<'light' | 'dark', ThemeTokens> = {
  light: lightTokens,
  dark: darkTokens,
};

export type ThemeIntent =
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'success'
  | 'warning'
  | 'critical';

export const mapIntentToColor = (theme: ThemeTokens, intent: ThemeIntent): string => {
  switch (intent) {
    case 'primary':
      return theme.colors.accentPrimary;
    case 'secondary':
      return theme.colors.accentSecondary;
    case 'tertiary':
      return theme.colors.accentTertiary;
    case 'success':
      return theme.colors.statusSuccess;
    case 'warning':
      return theme.colors.statusWarning;
    case 'critical':
      return theme.colors.statusCritical;
    default:
      return theme.colors.accentPrimary;
  }
};
