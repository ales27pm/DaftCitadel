import 'expo-sqlite/localStorage/install';

import type { PreferenceStorage } from './preference-storage.shared';

export const getPreferenceStorage = (): PreferenceStorage => {
  const storage = globalThis.localStorage;
  if (!storage) {
    throw new Error('Persistent localStorage is unavailable');
  }
  return storage;
};

export const clearPreferenceMemoryStorageForTesting = (): void => undefined;
