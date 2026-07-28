import { useCallback, useSyncExternalStore } from 'react';

import {
  DEFAULT_USER_PREFERENCES,
  userPreferencesStore,
  type UserPreferences,
} from './user-preferences';

export interface UserPreferencesHandle {
  preferences: UserPreferences;
  resetAppearance: () => void;
  setPreference: <Key extends keyof UserPreferences>(
    key: Key,
    value: UserPreferences[Key],
  ) => void;
}

export const useUserPreferences = (): UserPreferencesHandle => {
  const preferences = useSyncExternalStore(
    userPreferencesStore.subscribe,
    userPreferencesStore.getSnapshot,
    userPreferencesStore.getSnapshot,
  );
  const setPreference = useCallback(
    <Key extends keyof UserPreferences>(key: Key, value: UserPreferences[Key]) => {
      userPreferencesStore.update({ [key]: value });
    },
    [],
  );
  const resetAppearance = useCallback(() => {
    userPreferencesStore.update({
      accentPalette: DEFAULT_USER_PREFERENCES.accentPalette,
      glowIntensity: DEFAULT_USER_PREFERENCES.glowIntensity,
      interfaceDensity: DEFAULT_USER_PREFERENCES.interfaceDensity,
      studioSurface: DEFAULT_USER_PREFERENCES.studioSurface,
    });
  }, []);
  return { preferences, resetAppearance, setPreference };
};
