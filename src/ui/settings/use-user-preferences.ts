import { useCallback, useSyncExternalStore } from 'react';

import { userPreferencesStore, type UserPreferences } from './user-preferences';

export interface UserPreferencesHandle {
  preferences: UserPreferences;
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
  return { preferences, setPreference };
};
