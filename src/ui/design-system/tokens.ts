import { ColorSchemeName } from 'react-native';

export type ColorTokens = {
  background: string;
  surface: string;
  surfaceElevated: string;
  surfaceVariant: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  border: string;
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

export const STUDIO_ACCENT_PALETTES = ['mint', 'cyan', 'magenta', 'amber'] as const;
export type StudioAccentPalette = (typeof STUDIO_ACCENT_PALETTES)[number];

export const STUDIO_SURFACES = ['carbon', 'grid', 'spectral'] as const;
export type StudioSurface = (typeof STUDIO_SURFACES)[number];

export const INTERFACE_DENSITIES = ['comfortable', 'compact'] as const;
export type InterfaceDensity = (typeof INTERFACE_DENSITIES)[number];

export const GLOW_INTENSITIES = ['calm', 'balanced', 'vivid'] as const;
export type GlowIntensity = (typeof GLOW_INTENSITIES)[number];

export interface StudioAppearance {
  accentPalette: StudioAccentPalette;
  surface: StudioSurface;
  density: InterfaceDensity;
  glow: GlowIntensity;
}

export const DEFAULT_STUDIO_APPEARANCE: Readonly<StudioAppearance> = {
  accentPalette: 'mint',
  surface: 'carbon',
  density: 'comfortable',
  glow: 'balanced',
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

export interface EffectsScale {
  glowOpacity: number;
  glowRadius: number;
  surfaceTextureOpacity: number;
}

export interface MotionScale {
  fast: number;
  standard: number;
  ambient: number;
  ambientOpacityFloor: number;
  ambientScaleDelta: number;
  ambientTravel: number;
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
  appearance: StudioAppearance;
  colors: ColorTokens;
  spacing: SpacingScale;
  radii: RadiusScale;
  elevation: ElevationScale;
  opacity: OpacityScale;
  effects: EffectsScale;
  motion: MotionScale;
  typography: TypographyScale;
  scheme: ColorSchemeName;
}

// NOTE: Both "light" and "dark" variants embrace neon-inspired dark palettes.
// The light scheme is a slightly brighter dark theme until a true light mode ships.
export const lightTokens: ThemeTokens = {
  scheme: 'light',
  appearance: { ...DEFAULT_STUDIO_APPEARANCE },
  colors: {
    background: '#080B12',
    surface: '#0D121C',
    surfaceElevated: '#141B28',
    surfaceVariant: '#111722',
    textPrimary: '#F7F8FB',
    textSecondary: '#BBC3D2',
    textTertiary: '#7E899B',
    border: 'rgba(158, 173, 196, 0.24)',
    accentPrimary: '#5CE5B5',
    accentPrimaryInk: '#03110C',
    accentSecondary: '#E75DC7',
    accentTertiary: '#58C6E8',
    waveform: '#58C6E8',
    midiNote: '#E75DC7',
    statusSuccess: '#55D992',
    statusWarning: '#F3C66B',
    statusCritical: '#F0787E',
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
    sm: 6,
    md: 12,
    lg: 20,
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
  effects: {
    glowOpacity: 0.055,
    glowRadius: 14,
    surfaceTextureOpacity: 0.1,
  },
  motion: {
    fast: 160,
    standard: 260,
    ambient: 5200,
    ambientOpacityFloor: 0.68,
    ambientScaleDelta: 0.03,
    ambientTravel: 4,
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
  colors: {
    background: '#04070D',
    surface: '#090E17',
    surfaceElevated: '#111824',
    surfaceVariant: '#0D141F',
    textPrimary: '#F8F9FC',
    textSecondary: '#B8C1D0',
    textTertiary: '#788496',
    border: 'rgba(158, 173, 196, 0.22)',
    accentPrimary: '#5CE5B5',
    accentPrimaryInk: '#03110C',
    accentSecondary: '#E75DC7',
    accentTertiary: '#58C6E8',
    waveform: '#58C6E8',
    midiNote: '#E75DC7',
    statusSuccess: '#55D992',
    statusWarning: '#F3C66B',
    statusCritical: '#F0787E',
  },
};

export const TOKENS_BY_SCHEME: Record<'light' | 'dark', ThemeTokens> = {
  light: lightTokens,
  dark: darkTokens,
};

const ACCENT_COLORS: Record<
  StudioAccentPalette,
  Pick<
    ColorTokens,
    | 'accentPrimary'
    | 'accentPrimaryInk'
    | 'accentSecondary'
    | 'accentTertiary'
    | 'waveform'
    | 'midiNote'
  >
> = {
  mint: {
    accentPrimary: '#5CE5B5',
    accentPrimaryInk: '#03110C',
    accentSecondary: '#E75DC7',
    accentTertiary: '#58C6E8',
    waveform: '#58C6E8',
    midiNote: '#E75DC7',
  },
  cyan: {
    accentPrimary: '#58C6E8',
    accentPrimaryInk: '#041116',
    accentSecondary: '#E75DC7',
    accentTertiary: '#5CE5B5',
    waveform: '#72D8F3',
    midiNote: '#E75DC7',
  },
  magenta: {
    accentPrimary: '#E75DC7',
    accentPrimaryInk: '#190514',
    accentSecondary: '#5CE5B5',
    accentTertiary: '#58C6E8',
    waveform: '#58C6E8',
    midiNote: '#F17AD5',
  },
  amber: {
    accentPrimary: '#F3C66B',
    accentPrimaryInk: '#1A1003',
    accentSecondary: '#E75DC7',
    accentTertiary: '#5CE5B5',
    waveform: '#58C6E8',
    midiNote: '#E75DC7',
  },
};

const GLOW_EFFECTS: Record<
  GlowIntensity,
  Pick<EffectsScale, 'glowOpacity' | 'glowRadius'>
> = {
  calm: {
    glowOpacity: 0,
    glowRadius: 0,
  },
  balanced: {
    glowOpacity: 0.055,
    glowRadius: 14,
  },
  vivid: {
    glowOpacity: 0.13,
    glowRadius: 22,
  },
};

const AMBIENT_MOTION: Record<
  GlowIntensity,
  Pick<
    MotionScale,
    'ambient' | 'ambientOpacityFloor' | 'ambientScaleDelta' | 'ambientTravel'
  >
> = {
  calm: {
    ambient: 6800,
    ambientOpacityFloor: 0.82,
    ambientScaleDelta: 0.01,
    ambientTravel: 1.5,
  },
  balanced: {
    ambient: 5200,
    ambientOpacityFloor: 0.68,
    ambientScaleDelta: 0.03,
    ambientTravel: 4,
  },
  vivid: {
    ambient: 3800,
    ambientOpacityFloor: 0.58,
    ambientScaleDelta: 0.045,
    ambientTravel: 6,
  },
};

const SURFACE_OPACITY: Record<StudioSurface, number> = {
  carbon: 0.1,
  grid: 0.075,
  spectral: 0.14,
};

const resolveAppearance = (appearance?: Partial<StudioAppearance>): StudioAppearance => ({
  accentPalette: appearance?.accentPalette ?? DEFAULT_STUDIO_APPEARANCE.accentPalette,
  density: appearance?.density ?? DEFAULT_STUDIO_APPEARANCE.density,
  glow: appearance?.glow ?? DEFAULT_STUDIO_APPEARANCE.glow,
  surface: appearance?.surface ?? DEFAULT_STUDIO_APPEARANCE.surface,
});

const scaleSpacing = (spacing: SpacingScale, density: InterfaceDensity): SpacingScale => {
  if (density === 'comfortable') {
    return spacing;
  }
  return {
    none: 0,
    xs: Math.max(3, Math.round(spacing.xs * 0.8)),
    sm: Math.max(6, Math.round(spacing.sm * 0.8)),
    md: Math.max(9, Math.round(spacing.md * 0.8)),
    lg: Math.max(16, Math.round(spacing.lg * 0.8)),
    xl: Math.max(22, Math.round(spacing.xl * 0.8)),
    xxl: Math.max(32, Math.round(spacing.xxl * 0.8)),
  };
};

export const createThemeTokens = (
  scheme: 'light' | 'dark',
  appearance?: Partial<StudioAppearance>,
): ThemeTokens => {
  const base = TOKENS_BY_SCHEME[scheme];
  const resolvedAppearance = resolveAppearance(appearance);
  const glow = GLOW_EFFECTS[resolvedAppearance.glow];
  const ambientMotion = AMBIENT_MOTION[resolvedAppearance.glow];
  const glowSurfaceMultiplier =
    resolvedAppearance.glow === 'calm'
      ? 0.72
      : resolvedAppearance.glow === 'vivid'
        ? 1.22
        : 1;

  return {
    ...base,
    appearance: resolvedAppearance,
    colors: {
      ...base.colors,
      ...ACCENT_COLORS[resolvedAppearance.accentPalette],
    },
    spacing: scaleSpacing(base.spacing, resolvedAppearance.density),
    effects: {
      ...glow,
      surfaceTextureOpacity:
        SURFACE_OPACITY[resolvedAppearance.surface] * glowSurfaceMultiplier,
    },
    motion: {
      ...base.motion,
      ...ambientMotion,
    },
  };
};

export type ThemeIntent =
  'primary' | 'secondary' | 'tertiary' | 'success' | 'warning' | 'critical';

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
