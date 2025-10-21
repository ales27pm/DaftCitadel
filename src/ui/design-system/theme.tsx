import React, { PropsWithChildren, createContext, useContext, useMemo } from 'react';
import { ColorSchemeName, useColorScheme } from 'react-native';

import { ThemeTokens, TOKENS_BY_SCHEME } from './tokens';

export interface ThemeContextValue {
  theme: ThemeTokens;
  scheme: ColorSchemeName;
}

const DesignSystemContext = createContext<ThemeContextValue | undefined>(undefined);

export interface ThemeProviderProps {
  scheme?: ColorSchemeName;
}

export const ThemeProvider: React.FC<PropsWithChildren<ThemeProviderProps>> = ({
  children,
  scheme,
}) => {
  const systemScheme = useColorScheme() ?? 'dark';
  const resolvedScheme = (scheme ?? systemScheme) as 'light' | 'dark';

  const value = useMemo<ThemeContextValue>(() => {
    const theme = TOKENS_BY_SCHEME[resolvedScheme];
    return {
      scheme: resolvedScheme,
      theme,
    };
  }, [resolvedScheme]);

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
