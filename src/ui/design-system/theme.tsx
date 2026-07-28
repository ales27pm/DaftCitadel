import React, { PropsWithChildren, createContext, useContext, useMemo } from 'react';
import { ColorSchemeName, useColorScheme } from 'react-native';

import { type StudioAppearance, ThemeTokens, createThemeTokens } from './tokens';

export interface ThemeContextValue {
  theme: ThemeTokens;
  scheme: ColorSchemeName;
}

const DesignSystemContext = createContext<ThemeContextValue | undefined>(undefined);

export interface ThemeProviderProps {
  appearance?: Partial<StudioAppearance>;
  scheme?: ColorSchemeName;
}

export const ThemeProvider: React.FC<PropsWithChildren<ThemeProviderProps>> = ({
  appearance,
  children,
  scheme,
}) => {
  const systemScheme = useColorScheme() ?? 'dark';
  const resolvedScheme = (scheme ?? systemScheme) as 'light' | 'dark';
  const accentPalette = appearance?.accentPalette;
  const density = appearance?.density;
  const glow = appearance?.glow;
  const surface = appearance?.surface;

  const value = useMemo<ThemeContextValue>(() => {
    const theme = createThemeTokens(resolvedScheme, {
      accentPalette,
      density,
      glow,
      surface,
    });
    return {
      scheme: resolvedScheme,
      theme,
    };
  }, [accentPalette, density, glow, resolvedScheme, surface]);

  return (
    <DesignSystemContext.Provider value={value}>{children}</DesignSystemContext.Provider>
  );
};

export const useTheme = (): ThemeTokens => {
  const context = useContext(DesignSystemContext);
  if (!context) {
    throw new Error('useTheme must be used inside of a ThemeProvider');
  }
  return context.theme;
};

export const useThemeScheme = (): ColorSchemeName => {
  const context = useContext(DesignSystemContext);
  if (!context) {
    throw new Error('useThemeScheme must be used inside of a ThemeProvider');
  }
  return context.scheme;
};
