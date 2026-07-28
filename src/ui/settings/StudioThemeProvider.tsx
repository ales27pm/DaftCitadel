import React, { type PropsWithChildren } from 'react';

import { ThemeProvider } from '../design-system/theme';
import { useUserPreferences } from './use-user-preferences';

export const StudioThemeProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const { preferences } = useUserPreferences();

  return (
    <ThemeProvider
      appearance={{
        accentPalette: preferences.accentPalette,
        density: preferences.interfaceDensity,
        glow: preferences.glowIntensity,
        surface: preferences.studioSurface,
      }}
    >
      {children}
    </ThemeProvider>
  );
};
